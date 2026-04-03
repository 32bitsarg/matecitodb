const { db, quoteIdent, projectRoute } = require("../../../lib/matecito");

module.exports = async function (fastify) {
  // GET /auth/verify-email?token=xxx
  projectRoute(fastify, "GET", "/auth/verify-email", {
    config: { rateLimit: { max: 20, timeWindow: "5 minutes" } },
  }, async (req, reply) => {
    const project    = req.resolvedProject;
    const projectId  = project?.id ?? req.params?.projectId;
    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return reply.code(404).send({ error: "Project not found" });

    const token = String(req.query?.token || "").trim();
    if (!token) return reply.code(400).send({ error: "token is required" });

    const s = quoteIdent(schemaName);

    // Crear tabla si el proyecto fue creado antes de esta feature
    await db.query(`CREATE TABLE IF NOT EXISTS ${s}._email_verifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES ${s}._auth_users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMP NOT NULL,
      used_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    const row = await db.query(
      `SELECT id, user_id, expires_at, used_at FROM ${s}._email_verifications WHERE token = $1 LIMIT 1`,
      [token]
    );

    if (!row.rows[0]) return reply.code(400).send({ error: "Invalid token" });
    if (row.rows[0].used_at) return reply.code(400).send({ error: "Token already used" });
    if (new Date(row.rows[0].expires_at) < new Date()) return reply.code(400).send({ error: "Token expired" });

    await db.query(
      `UPDATE ${s}._email_verifications SET used_at = NOW() WHERE id = $1`,
      [row.rows[0].id]
    );

    // Marcar email como verificado en _auth_users (columna agregada lazily)
    await db.query(
      `ALTER TABLE ${s}._auth_users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE`
    ).catch(() => {});
    await db.query(
      `ALTER TABLE ${s}._auth_users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMP`
    ).catch(() => {});
    await db.query(
      `UPDATE ${s}._auth_users SET email_verified = TRUE, email_verified_at = NOW() WHERE id = $1`,
      [row.rows[0].user_id]
    );

    return { ok: true, user_id: row.rows[0].user_id };
  });

  // POST /auth/resend-verification  { email }
  projectRoute(fastify, "POST", "/auth/resend-verification", {
    config: { rateLimit: { max: 3, timeWindow: "10 minutes" } },
  }, async (req, reply) => {
    const project    = req.resolvedProject;
    const projectId  = project?.id ?? req.params?.projectId;

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return reply.code(404).send({ error: "Project not found" });

    const email    = String(req.body?.email    || "").trim().toLowerCase();
    const userId   = String(req.body?.userId   || req.body?.user_id || "").trim();
    const loginUrl = String(req.body?.login_url || "").trim();
    if (!email && !userId) return reply.code(400).send({ error: "email or userId is required" });

    const s = quoteIdent(schemaName);

    const userRes = userId
      ? await db.query(`SELECT id, email FROM ${s}._auth_users WHERE id = $1 LIMIT 1`, [userId])
      : await db.query(`SELECT id, email FROM ${s}._auth_users WHERE email = $1 LIMIT 1`, [email]);
    if (!userRes.rows[0]) return { ok: true };

    // Verificar si ya está verificado
    const verified = await db.query(
      `SELECT 1 FROM ${s}._email_verifications WHERE user_id = $1 AND used_at IS NOT NULL LIMIT 1`,
      [userRes.rows[0].id]
    ).catch(() => ({ rows: [] }));
    if (verified.rows[0]) return reply.code(400).send({ error: "Email already verified" });

    // Importar helpers de register para reutilizar el flujo
    const { generateToken, sendProjectEmail } = require("../../../lib/matecito");

    await db.query(`CREATE TABLE IF NOT EXISTS ${s}._email_verifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES ${s}._auth_users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMP NOT NULL,
      used_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    const token     = generateToken(32);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await db.query(
      `INSERT INTO ${s}._email_verifications (user_id, token, expires_at) VALUES ($1, $2, $3)`,
      [userRes.rows[0].id, token, expiresAt]
    );

    const projectRow  = await db.query(`SELECT name FROM projects WHERE id = $1 LIMIT 1`, [projectId]);
    const projectName = projectRow.rows[0]?.name ?? "App";
    const toEmail     = userRes.rows[0].email; // resolved from DB, works for both email and userId lookup
    const verifyUrl   = loginUrl ? `${new URL(loginUrl).origin}/auth/verify-email?token=${token}` : token;

    sendProjectEmail(schemaName, projectName, {
      to:              toEmail,
      templateName:    "email_verification",
      vars:            { "user.email": toEmail, "verify_url": verifyUrl },
      fallbackSubject: `Verificá tu email — ${projectName}`,
      fallbackHtml:    `<p>Hacé click para verificar tu email: <a href="${verifyUrl}">${verifyUrl}</a></p>`,
    });

    return { ok: true };
  });
};
