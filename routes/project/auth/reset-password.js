const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { db, quoteIdent, projectRoute, sendProjectEmail } = require("../../../lib/matecito");

module.exports = async function (fastify) {
  // POST /auth/request-reset  { email, reset_url_base? }
  projectRoute(fastify, "POST", "/auth/request-reset", {
    config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name, name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return reply.code(404).send({ error: "Project not found" });
    const s = quoteIdent(schemaName);

    const { email, reset_url_base } = req.body ?? {};
    if (!email) return reply.code(400).send({ error: "email is required" });

    const user = await db.query(
      `SELECT id, email FROM ${s}._auth_users WHERE email = $1 LIMIT 1`, [email]
    );
    // Always return 200 to avoid user enumeration
    if (!user.rows[0]) return { message: "If that email exists, a reset link has been sent." };

    const token    = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Invalida tokens anteriores pendientes
    await db.query(
      `UPDATE ${s}._password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`,
      [user.rows[0].id]
    );
    await db.query(
      `INSERT INTO ${s}._password_resets (user_id, token, expires_at) VALUES ($1, $2, $3)`,
      [user.rows[0].id, token, expiresAt]
    );

    const projectRow  = await db.query(`SELECT name FROM projects WHERE id = $1 LIMIT 1`, [projectId]);
    const projectName = projectRow.rows[0]?.name ?? "App";
    const resetLink   = reset_url_base ? `${reset_url_base}?token=${token}` : token;

    sendProjectEmail(schemaName, projectName, {
      to:              user.rows[0].email,
      templateName:    "password_reset",
      vars:            { "user.email": user.rows[0].email, "reset_url": resetLink },
      fallbackSubject: `Restablecé tu contraseña — ${projectName}`,
      fallbackHtml:    `<p>Hacé click aquí para restablecer tu contraseña: <a href="${resetLink}">${resetLink}</a><br>Este enlace expira en 1 hora.</p>`,
    });

    // En dev, devolver el token si no hay SMTP para facilitar el testing
    if (process.env.NODE_ENV !== "production") {
      return { message: "If that email exists, a reset link has been sent.", _dev_token: token };
    }
    return { message: "If that email exists, a reset link has been sent." };
  });

  // POST /auth/reset-password  { token, password }
  projectRoute(fastify, "POST", "/auth/reset-password", {
    config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return reply.code(404).send({ error: "Project not found" });
    const s = quoteIdent(schemaName);

    const { token, password } = req.body ?? {};
    if (!token || !password) return reply.code(400).send({ error: "token and password are required" });
    if (password.length < 8) return reply.code(400).send({ error: "password must be at least 8 characters" });

    const reset = await db.query(
      `SELECT * FROM ${s}._password_resets
       WHERE token = $1 AND expires_at > NOW() AND used_at IS NULL
       LIMIT 1`,
      [token]
    );
    if (!reset.rows[0]) return reply.code(400).send({ error: "Invalid or expired token" });

    const hash   = await bcrypt.hash(password, 12);
    const userId = reset.rows[0].user_id;

    await db.query(`UPDATE ${s}._auth_users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
      [hash, userId]);
    await db.query(`UPDATE ${s}._password_resets SET used_at = NOW() WHERE id = $1`,
      [reset.rows[0].id]);
    await db.query(
      `UPDATE ${s}._refresh_tokens SET revoked_at = NOW()
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId]
    );

    return { message: "Password updated successfully." };
  });
};
