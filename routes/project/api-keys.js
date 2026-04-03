const { db, requireProjectOrPlatformAuth, generateToken, projectRoute } = require("../../lib/matecito");
const { invalidateProjectCache } = require("../../lib/subdomain-cache");

const VALID_SCOPES = ["read", "write", "*"];

/**
 * GET  /api-keys          — list all active custom API keys
 * POST /api-keys          — create a custom key with optional scopes
 * DELETE /api-keys/:id    — revoke a custom key
 */
module.exports = async function (fastify) {
  // List
  projectRoute(fastify, "GET", "/api-keys", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const projectId = req.params?.projectId ?? req.resolvedProject?.id;
    if (!projectId) return reply.code(400).send({ error: "projectId required" });

    const res = await db.query(
      `SELECT id, key, type, scopes, created_at
       FROM api_keys
       WHERE project_id = $1 AND revoked_at IS NULL
       ORDER BY created_at DESC`,
      [projectId]
    );
    return { keys: res.rows };
  });

  // Create custom key
  projectRoute(fastify, "POST", "/api-keys", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const projectId = req.params?.projectId ?? req.resolvedProject?.id;
    if (!projectId) return reply.code(400).send({ error: "projectId required" });

    const { scopes, type = "custom" } = req.body ?? {};

    let normalizedScopes = null;
    if (scopes != null) {
      const arr = Array.isArray(scopes) ? scopes : [scopes];
      for (const s of arr) {
        if (!VALID_SCOPES.includes(s)) {
          return reply.code(400).send({ error: `Invalid scope '${s}'. Valid: ${VALID_SCOPES.join(", ")}` });
        }
      }
      normalizedScopes = arr;
    }

    const key = `cust_${generateToken(32)}`;

    const res = await db.query(
      `INSERT INTO api_keys (project_id, key, type, scopes) VALUES ($1, $2, $3, $4) RETURNING id, key, type, scopes, created_at`,
      [projectId, key, type, normalizedScopes]
    );

    invalidateProjectCache(projectId);

    return reply.code(201).send({ key: res.rows[0] });
  });

  // Revoke
  projectRoute(fastify, "DELETE", "/api-keys/:id", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const projectId = req.params?.projectId ?? req.resolvedProject?.id;
    const { id }    = req.params;

    const res = await db.query(
      `UPDATE api_keys SET revoked_at = NOW()
       WHERE id = $1 AND project_id = $2 AND revoked_at IS NULL
       RETURNING id`,
      [id, projectId]
    );

    if (!res.rows[0]) return reply.code(404).send({ error: "Key not found or already revoked" });

    invalidateProjectCache(projectId);
    return { ok: true };
  });
};
