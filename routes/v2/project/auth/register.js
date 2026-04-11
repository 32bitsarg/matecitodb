const bcrypt = require("bcryptjs");
const {
  db,
  getProjectByAnonKey,
  quoteIdent,
  projectRoute,
  createProjectRefreshToken,
  logAuthEvent,
  generateToken,
} = require("../../../../lib/v2/auth");
const { createEmailVerificationToken } = require("../../../../lib/v2/auth");
const { body: bodySchema } = require("../../../../lib/v2/validators");
const { apiError } = require("../../../../lib/v2/errors");
const { enqueueEmail } = require("../../../../lib/v2/queue");
const { ensureV2Tables } = require("../../../../lib/v2/schema");

async function resolveProject(req, reply) {
  if (req.resolvedProject) {
    const anonKey = String(req.headers["x-matecito-key"] || "").trim();
    if (!anonKey) { reply.code(401).send({ error: "x-matecito-key required", code: "PROJ_004" }); return null; }
    if (req.resolvedProject.anon_key !== anonKey) { reply.code(403).send({ error: "Invalid project key", code: "PROJ_005" }); return null; }
    return req.resolvedProject;
  }
  const projectId = req.params?.projectId;
  const anonKey   = String(req.headers["x-matecito-key"] || "").trim();
  if (!projectId || !anonKey) { reply.code(400).send({ error: "projectId and x-matecito-key required", code: "PROJ_003" }); return null; }
  const project = await getProjectByAnonKey(projectId, anonKey);
  if (!project) { reply.code(403).send({ error: "Invalid project key", code: "PROJ_005" }); return null; }
  return project;
}

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project = await resolveProject(req, reply);
    if (!project) return;

    const email     = String(req.body.email    || "").trim().toLowerCase();
    const username  = String(req.body.username || "").trim();
    const name      = String(req.body.name     || "").trim();
    const password  = String(req.body.password || "");
    const login_url = String(req.body.login_url || "").trim();

    const schema = quoteIdent(project.schema_name);

    const exists = await db.query(
      `SELECT 1 FROM ${schema}._auth_users WHERE email = $1 LIMIT 1`, [email]
    );
    if (exists.rows[0]) return apiError(reply, "AUTH_007");

    const hash = await bcrypt.hash(password, 10);

    const { rows } = await db.query(
      `INSERT INTO ${schema}._auth_users (email, username, name, password_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, username, name, avatar_seed, avatar_url, created_at`,
      [email, username || null, name || null, hash]
    );
    const user = rows[0];

    const [access_token, refresh_token] = await Promise.all([
      fastify.jwt.sign(
        { sub: user.id, pid: project.id, kind: "project", email: user.email, username: user.username, name: user.name },
        { expiresIn: "1d" }
      ),
      createProjectRefreshToken(project.schema_name, user.id),
    ]);

    logAuthEvent(project.schema_name, { event: "register", userId: user.id, ip: req.ip, status: 201 });

    // Email de verificación (v2: token hasheado)
    await ensureV2Tables(project.schema_name).catch(() => {});
    const projectRow  = await db.query(`SELECT name FROM projects WHERE id = $1 LIMIT 1`, [project.id]);
    const projectName = projectRow.rows[0]?.name ?? "App";

    createEmailVerificationToken(project.schema_name, user.id)
      .then(rawToken => {
        const verifyUrl = login_url
          ? `${new URL(login_url).origin}/auth/verify-email?token=${rawToken}`
          : rawToken;
        enqueueEmail(project.schema_name, projectName, {
          to:              email,
          templateName:    "email_verification",
          vars:            { "user.email": email, "verify_url": verifyUrl, "login_url": login_url },
          fallbackSubject: `Verificá tu email — ${projectName}`,
          fallbackHtml:    `<p>Verificá tu cuenta: <a href="${verifyUrl}">${verifyUrl}</a></p>`,
        });
      })
      .catch(err => req.log.warn({ step: "send_verification", error: err.message }));

    return reply.code(201).send({ access_token, refresh_token, expires_in: 86400, user, email_verified: false });
  };

  projectRoute(fastify, "POST", "/auth/register", {
    schema: { body: bodySchema.register },
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, handler);
};
