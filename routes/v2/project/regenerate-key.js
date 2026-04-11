const {
  db,
  requireProjectOrPlatformAuth,
  generateToken,
  projectRoute,
} = require("../../../lib/v2/auth");
const { invalidateProjectCache } = require("../../../lib/subdomain-cache");
const { apiError } = require("../../../lib/v2/errors");

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const projectId = req.params?.projectId ?? req.resolvedProject?.id;
    if (!projectId) return reply.code(400).send({ error: "projectId required", code: "GEN_002" });

    const client = await db.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `UPDATE api_keys SET revoked_at = NOW() WHERE project_id = $1 AND revoked_at IS NULL`, [projectId]
      );

      const anonKey    = `anon_${generateToken(24)}`;
      const serviceKey = `srv_${generateToken(32)}`;

      await client.query(
        `INSERT INTO api_keys (project_id, key, type) VALUES ($1, $2, 'anon'), ($1, $3, 'service')`,
        [projectId, anonKey, serviceKey]
      );

      await client.query("COMMIT");

      invalidateProjectCache(projectId);

      return { ok: true, api_keys: { anon: anonKey, service: serviceKey } };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  };

  projectRoute(fastify, "POST", "/regenerate-key", { preHandler: requireProjectOrPlatformAuth }, handler);
};
