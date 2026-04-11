const {
  db,
  quoteIdent,
  rotateProjectRefreshToken,
  getProjectKeyContext,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { body: bodySchema } = require("../../../../lib/v2/validators");
const { apiError } = require("../../../../lib/v2/errors");

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const { refresh_token } = req.body;

    let schemaName, projectId;

    if (req.resolvedProject) {
      schemaName = req.resolvedProject.schema_name;
      projectId  = req.resolvedProject.id;
    } else {
      const ctx = await getProjectKeyContext(req.params?.projectId, req.headers["x-matecito-key"]);
      if (!ctx) return apiError(reply, "AUTH_001");
      schemaName = ctx.schema_name;
      projectId  = ctx.project_id;
    }

    const rotated = await rotateProjectRefreshToken(schemaName, refresh_token);
    if (!rotated) return apiError(reply, "AUTH_006");

    const schema  = quoteIdent(schemaName);
    const { rows } = await db.query(
      `SELECT id, email, username, name FROM ${schema}._auth_users WHERE id = $1 LIMIT 1`,
      [rotated.userId]
    );
    if (!rows[0]) return apiError(reply, "AUTH_001");

    const user = rows[0];
    const access_token = await fastify.jwt.sign(
      { sub: user.id, pid: projectId, kind: "project", email: user.email, username: user.username, name: user.name },
      { expiresIn: "1d" }
    );

    return { access_token, refresh_token: rotated.newToken, expires_in: 86400 };
  };

  projectRoute(fastify, "POST", "/auth/refresh", {
    schema: { body: bodySchema.refresh },
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
  }, handler);
};
