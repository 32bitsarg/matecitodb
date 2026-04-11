// ─── Full-text search endpoint ────────────────────────────────────────────────
//
// GET /records/search?collection=posts&q=javascript+async&limit=20&lang=spanish
//
// Usa tsvector + ts_rank de PostgreSQL. Sin dependencias externas.

const {
  db,
  flexAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { checkPermissionV2 } = require("../../../../lib/v2/permissions");
const { apiError }          = require("../../../../lib/v2/errors");
const { searchRecords, SUPPORTED_LANGUAGES } = require("../../../../lib/v2/fulltext");

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    const { collection, q, limit = "20", lang = "simple" } = req.query;

    if (!collection) return reply.code(400).send({ error: "collection is required", code: "GEN_002" });
    if (!q)          return reply.code(400).send({ error: "q (search query) is required", code: "GEN_002" });

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const perm = await checkPermissionV2(schemaName, collection, "list", req, reply);
    if (!perm.allowed) return;

    const opts = {
      limit: parseInt(limit, 10) || 20,
      lang: SUPPORTED_LANGUAGES.has(lang) ? lang : "simple",
      rlsFilterSql: perm.filterSql,
      rlsFilterValues: perm.filterValues,
      include_deleted: req.query.include_deleted,
      include_expired: req.query.include_expired,
    };

    const { results, total } = await searchRecords(schemaName, collection, q, opts);

    return {
      collection,
      query: q,
      total,
      results,
    };
  };

  projectRoute(fastify, "GET", "/records/search", {
    preHandler: flexAuth,
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
  }, handler);
};
