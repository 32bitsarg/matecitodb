const { db, quoteIdent, rotateProjectRefreshToken, getProjectKeyContext, projectRoute } = require("../../../lib/matecito");

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const { refresh_token } = req.body || {};

    if (!refresh_token) {
      return reply.code(400).send({ error: "refresh_token required" });
    }

    // Resolver proyecto (por subdomain o projectId + api key)
    let schemaName, projectId;

    if (req.resolvedProject) {
      schemaName = req.resolvedProject.schema_name;
      projectId  = req.resolvedProject.id;
    } else {
      const rawKey = req.headers["x-matecito-key"];
      const pid    = req.params?.projectId;
      const ctx    = await getProjectKeyContext(pid, rawKey);
      if (!ctx) return reply.code(401).send({ error: "Invalid project key" });
      schemaName = ctx.schema_name;
      projectId  = ctx.project_id;
    }

    const rotated = await rotateProjectRefreshToken(schemaName, refresh_token);
    if (!rotated) {
      return reply.code(401).send({ error: "Invalid or expired refresh token" });
    }

    const schema  = quoteIdent(schemaName);
    const userRes = await db.query(
      `SELECT id, email, username, name FROM ${schema}._auth_users WHERE id = $1 LIMIT 1`,
      [rotated.userId]
    );
    const user = userRes.rows[0];
    if (!user) return reply.code(401).send({ error: "User not found" });

    const access_token = await fastify.jwt.sign(
      { sub: user.id, pid: projectId, kind: "project", email: user.email, username: user.username, name: user.name },
      { expiresIn: "1d" }
    );

    return {
      access_token,
      refresh_token: rotated.newToken,
      expires_in:    86400,
    };
  };

  projectRoute(fastify, "POST", "/auth/refresh", handler);
};
