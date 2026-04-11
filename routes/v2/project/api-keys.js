const {
  db,
  requireProjectOrPlatformAuth,
  generateToken,
  projectRoute,
} = require("../../../lib/v2/auth");
const { invalidateProjectCache } = require("../../../lib/subdomain-cache");
const { apiError } = require("../../../lib/v2/errors");

const VALID_SCOPES = ["read", "write", "*"];

module.exports = async function (fastify) {
  // GET /api-keys
  projectRoute(fastify, "GET", "/api-keys", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const projectId = req.params?.projectId ?? req.resolvedProject?.id;
    if (!projectId) return reply.code(400).send({ error: "projectId required", code: "GEN_002" });

    const { rows } = await db.query(
      `SELECT id, key, type, scopes, created_at
       FROM api_keys WHERE project_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC`,
      [projectId]
    );
    return { keys: rows };
  });

  // POST /api-keys
  projectRoute(fastify, "POST", "/api-keys", {
    preHandler: requireProjectOrPlatformAuth,
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          scopes: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
          type:   { type: "string", default: "custom" },
        },
      },
    },
  }, async (req, reply) => {
    const projectId = req.params?.projectId ?? req.resolvedProject?.id;
    if (!projectId) return reply.code(400).send({ error: "projectId required", code: "GEN_002" });

    const { scopes, type = "custom" } = req.body ?? {};

    let normalizedScopes = null;
    if (scopes != null) {
      const arr = Array.isArray(scopes) ? scopes : [scopes];
      for (const s of arr) {
        if (!VALID_SCOPES.includes(s)) {
          return reply.code(400).send({ error: `Invalid scope '${s}'. Valid: ${VALID_SCOPES.join(", ")}`, code: "GEN_002" });
        }
      }
      normalizedScopes = arr;
    }

    const key = `cust_${generateToken(32)}`;
    const { rows } = await db.query(
      `INSERT INTO api_keys (project_id, key, type, scopes) VALUES ($1, $2, $3, $4)
       RETURNING id, key, type, scopes, created_at`,
      [projectId, key, type, normalizedScopes]
    );

    invalidateProjectCache(projectId);
    return reply.code(201).send({ key: rows[0] });
  });

  // DELETE /api-keys/:id
  projectRoute(fastify, "DELETE", "/api-keys/:id", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const projectId = req.params?.projectId ?? req.resolvedProject?.id;
    const { id }    = req.params;

    const { rows } = await db.query(
      `UPDATE api_keys SET revoked_at = NOW()
       WHERE id = $1 AND project_id = $2 AND revoked_at IS NULL RETURNING id`,
      [id, projectId]
    );
    if (!rows[0]) return apiError(reply, "GEN_003", "Key not found or already revoked");

    invalidateProjectCache(projectId);
    return { ok: true };
  });
};
