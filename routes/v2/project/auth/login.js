const bcrypt = require("bcryptjs");
const {
  db,
  getProjectByAnonKey,
  quoteIdent,
  projectRoute,
  createProjectRefreshToken,
  logAuthEvent,
} = require("../../../../lib/v2/auth");
const { body: bodySchema } = require("../../../../lib/v2/validators");
const { apiError } = require("../../../../lib/v2/errors");

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

    const email    = String(req.body.email    || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const schema   = quoteIdent(project.schema_name);

    const { rows } = await db.query(
      `SELECT id, email, username, name, password_hash, avatar_seed, avatar_url, email_verified, created_at
       FROM ${schema}._auth_users WHERE email = $1 LIMIT 1`,
      [email]
    );

    const user = rows[0];
    if (!user) {
      logAuthEvent(project.schema_name, { event: "login", userId: null, ip: req.ip, status: 401 });
      return apiError(reply, "AUTH_003");
    }

    const ok = await bcrypt.compare(password, user.password_hash || "");
    if (!ok) {
      logAuthEvent(project.schema_name, { event: "login", userId: user.id, ip: req.ip, status: 401 });
      return apiError(reply, "AUTH_003");
    }

    delete user.password_hash;

    // Load user roles for JWT
    let roles = [];
    try {
      const s = quoteIdent(project.schema_name);
      const rolesRes = await db.query(
        `SELECT role FROM ${s}._user_roles WHERE user_id = $1`, [user.id]
      );
      roles = rolesRes.rows.map(r => r.role);
    } catch { /* _user_roles may not exist yet */ }

    const [access_token, refresh_token] = await Promise.all([
      fastify.jwt.sign(
        { sub: user.id, pid: project.id, kind: "project", email: user.email, username: user.username, name: user.name, roles },
        { expiresIn: "1d" }
      ),
      createProjectRefreshToken(project.schema_name, user.id),
    ]);

    logAuthEvent(project.schema_name, { event: "login", userId: user.id, ip: req.ip, status: 200 });

    return { access_token, refresh_token, expires_in: 86400, user };
  };

  projectRoute(fastify, "POST", "/auth/login", {
    schema: { body: bodySchema.login },
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, handler);
};
