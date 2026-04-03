const { db, requireProjectOrPlatformAuth, projectRoute } = require("../../lib/matecito");
const { invalidateProjectCache } = require("../../lib/subdomain-cache");

/**
 * GET  /settings  — ver configuración del proyecto
 * PATCH /settings  — actualizar storage_quota_mb, log_retention_days, sql_enabled, allowed_origins
 *
 * Requiere token de plataforma (owner/admin del workspace).
 */
module.exports = async function (fastify) {
  projectRoute(fastify, "GET", "/settings", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const projectId = req.params?.projectId ?? req.resolvedProject?.id;
    if (!projectId) return reply.code(400).send({ error: "projectId required" });

    const { rows } = await db.query(
      `SELECT id, name, subdomain, storage_quota_mb, log_retention_days, sql_enabled, allowed_origins, created_at
       FROM projects WHERE id = $1 LIMIT 1`,
      [projectId]
    );
    if (!rows[0]) return reply.code(404).send({ error: "Project not found" });
    return { settings: rows[0] };
  });

  projectRoute(fastify, "PATCH", "/settings", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const projectId = req.params?.projectId ?? req.resolvedProject?.id;
    if (!projectId) return reply.code(400).send({ error: "projectId required" });

    const { storage_quota_mb, log_retention_days, sql_enabled, allowed_origins } = req.body ?? {};

    if (storage_quota_mb !== undefined) {
      const q = parseInt(storage_quota_mb, 10);
      if (isNaN(q) || q < 10 || q > 50_000) {
        return reply.code(400).send({ error: "storage_quota_mb must be between 10 and 50000" });
      }
    }
    if (log_retention_days !== undefined) {
      const d = parseInt(log_retention_days, 10);
      if (isNaN(d) || d < 1 || d > 365) {
        return reply.code(400).send({ error: "log_retention_days must be between 1 and 365" });
      }
    }
    if (sql_enabled !== undefined && typeof sql_enabled !== "boolean") {
      return reply.code(400).send({ error: "sql_enabled must be a boolean" });
    }
    if (allowed_origins !== undefined && allowed_origins !== null) {
      if (!Array.isArray(allowed_origins) || allowed_origins.some(o => typeof o !== "string")) {
        return reply.code(400).send({ error: "allowed_origins must be an array of strings or null" });
      }
    }

    const { rows } = await db.query(
      `UPDATE projects SET
         storage_quota_mb   = COALESCE($1, storage_quota_mb),
         log_retention_days = COALESCE($2, log_retention_days),
         sql_enabled        = COALESCE($3, sql_enabled),
         allowed_origins    = CASE WHEN $5 THEN $4::text[] ELSE allowed_origins END
       WHERE id = $6
       RETURNING id, name, subdomain, storage_quota_mb, log_retention_days, sql_enabled, allowed_origins`,
      [
        storage_quota_mb   !== undefined ? parseInt(storage_quota_mb,   10) : null,
        log_retention_days !== undefined ? parseInt(log_retention_days, 10) : null,
        sql_enabled        !== undefined ? sql_enabled                      : null,
        allowed_origins    !== undefined ? allowed_origins                  : null,
        allowed_origins    !== undefined,
        projectId,
      ]
    );

    if (!rows[0]) return reply.code(404).send({ error: "Project not found" });

    invalidateProjectCache(projectId);

    return { ok: true, settings: rows[0] };
  });
};
