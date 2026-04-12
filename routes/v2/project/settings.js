const {
  db,
  requireProjectOrPlatformAuth,
  projectRoute,
} = require("../../../lib/v2/auth");
const { invalidateProjectCache } = require("../../../lib/subdomain-cache");
const { apiError } = require("../../../lib/v2/errors");

module.exports = async function (fastify) {
  // GET /settings
  projectRoute(fastify, "GET", "/settings", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const projectId = req.params?.projectId ?? req.resolvedProject?.id;
    if (!projectId) return reply.code(400).send({ error: "projectId required", code: "GEN_002" });

    const { rows } = await db.query(
      `SELECT id, name, subdomain, storage_quota_mb, log_retention_days, sql_enabled, allowed_origins,
              COALESCE(llms_txt_public, false) AS llms_txt_public, created_at
       FROM projects WHERE id = $1 LIMIT 1`,
      [projectId]
    );
    if (!rows[0]) return apiError(reply, "GEN_003", "Project not found");
    return { settings: rows[0] };
  });

  // PATCH /settings
  projectRoute(fastify, "PATCH", "/settings", {
    preHandler: requireProjectOrPlatformAuth,
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          storage_quota_mb:   { type: "integer", minimum: 10, maximum: 50000 },
          log_retention_days: { type: "integer", minimum: 1, maximum: 365 },
          sql_enabled:        { type: "boolean" },
          allowed_origins:    { oneOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] },
          llms_txt_public:    { type: "boolean" },
        },
      },
    },
  }, async (req, reply) => {
    const projectId = req.params?.projectId ?? req.resolvedProject?.id;
    if (!projectId) return reply.code(400).send({ error: "projectId required", code: "GEN_002" });

    const { storage_quota_mb, log_retention_days, sql_enabled, allowed_origins, llms_txt_public } = req.body ?? {};

    // Ensure the column exists (idempotent — runs once per project)
    await db.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS llms_txt_public BOOLEAN DEFAULT FALSE`).catch(() => {});

    const { rows } = await db.query(
      `UPDATE projects SET
         storage_quota_mb   = COALESCE($1, storage_quota_mb),
         log_retention_days = COALESCE($2, log_retention_days),
         sql_enabled        = COALESCE($3, sql_enabled),
         allowed_origins    = CASE WHEN $5 THEN $4::text[] ELSE allowed_origins END,
         llms_txt_public    = COALESCE($7, llms_txt_public)
       WHERE id = $6
       RETURNING id, name, subdomain, storage_quota_mb, log_retention_days, sql_enabled, allowed_origins,
                 COALESCE(llms_txt_public, false) AS llms_txt_public`,
      [
        storage_quota_mb   !== undefined ? storage_quota_mb   : null,
        log_retention_days !== undefined ? log_retention_days : null,
        sql_enabled        !== undefined ? sql_enabled        : null,
        allowed_origins    !== undefined ? allowed_origins    : null,
        allowed_origins    !== undefined,
        projectId,
        llms_txt_public    !== undefined ? llms_txt_public    : null,
      ]
    );

    if (!rows[0]) return apiError(reply, "GEN_003", "Project not found");

    invalidateProjectCache(projectId);
    return { ok: true, settings: rows[0] };
  });
};
