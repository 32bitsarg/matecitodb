const bcrypt = require("bcryptjs");
const { db, getProjectByAnonKey, quoteIdent, projectRoute, createProjectRefreshToken, logAuthEvent, generateToken, sendProjectEmail } = require("../../../lib/matecito");

async function sendVerificationEmail(project, userId, email, projectName, loginUrl) {
  const s          = quoteIdent(project.schema_name);
  const token      = generateToken(32);
  const expiresAt  = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

  try {
    await db.query(`CREATE TABLE IF NOT EXISTS ${s}._email_verifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES ${s}._auth_users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMP NOT NULL,
      used_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await db.query(
      `INSERT INTO ${s}._email_verifications (user_id, token, expires_at) VALUES ($1, $2, $3)`,
      [userId, token, expiresAt]
    );
  } catch { return; }

  const verifyUrl = `${loginUrl ? new URL(loginUrl).origin : ""}/auth/verify-email?token=${token}`;

  sendProjectEmail(project.schema_name, projectName, {
    to:              email,
    templateName:    "email_verification",
    vars:            { "user.email": email, "verify_url": verifyUrl, "login_url": loginUrl || "" },
    fallbackSubject: `Verificá tu email — ${projectName}`,
    fallbackHtml:    `<p>Hola, verificá tu cuenta haciendo click aquí: <a href="${verifyUrl}">${verifyUrl}</a></p>`,
  });
}

async function resolveProject(req, reply) {
  if (req.resolvedProject) {
    const anonKey = String(req.headers["x-matecito-key"] || "").trim();
    if (!anonKey) {
      reply.code(401).send({ error: "x-matecito-key required" });
      return null;
    }
    if (req.resolvedProject.anon_key !== anonKey) {
      reply.code(403).send({ error: "Invalid project key" });
      return null;
    }
    return req.resolvedProject;
  }

  const projectId = req.params?.projectId;
  const anonKey   = String(req.headers["x-matecito-key"] || "").trim();

  if (!projectId || !anonKey) {
    reply.code(400).send({ error: "projectId and x-matecito-key required" });
    return null;
  }

  const project = await getProjectByAnonKey(projectId, anonKey);
  if (!project) {
    reply.code(403).send({ error: "Invalid project key" });
    return null;
  }

  return project;
}


module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project = await resolveProject(req, reply);
    if (!project) return;

    const email     = String(req.body?.email     || "").trim().toLowerCase();
    const username  = String(req.body?.username  || "").trim();
    const name      = String(req.body?.name      || "").trim();
    const password  = String(req.body?.password  || "");
    const login_url = String(req.body?.login_url || "").trim();

    if (!email || !password) {
      return reply.code(400).send({ error: "email and password are required" });
    }
    if (password.length < 8) {
      return reply.code(400).send({ error: "Password must be at least 8 characters" });
    }

    const schema = quoteIdent(project.schema_name);

    const exists = await db.query(
      `SELECT 1 FROM ${schema}._auth_users WHERE email = $1 LIMIT 1`,
      [email]
    );
    if (exists.rows[0]) {
      return reply.code(409).send({ error: "User already exists" });
    }

    const hash = await bcrypt.hash(password, 10);

    const result = await db.query(
      `INSERT INTO ${schema}._auth_users (email, username, name, password_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, username, name, avatar_seed, avatar_url, created_at`,
      [email, username || null, name || null, hash]
    );
    const user = result.rows[0];

    const [access_token, refresh_token] = await Promise.all([
      fastify.jwt.sign(
        { sub: user.id, pid: project.id, kind: "project", email: user.email, username: user.username, name: user.name },
        { expiresIn: "1d" }
      ),
      createProjectRefreshToken(project.schema_name, user.id),
    ]);

    logAuthEvent(project.schema_name, { event: "register", userId: user.id, ip: req.ip, status: 201 });

    // Crear token de verificación y enviar email (en segundo plano, no bloquea)
    const projectRow = await db.query(`SELECT name FROM projects WHERE id = $1 LIMIT 1`, [project.id]);
    const projectName = projectRow.rows[0]?.name ?? "App";
    sendVerificationEmail(project, user.id, email, projectName, login_url);

    return reply.code(201).send({ access_token, refresh_token, expires_in: 86400, user, email_verified: false });
  };

  projectRoute(fastify, "POST", "/auth/register", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, handler);
};
