const {
  db,
  flexAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { checkPermissionV2 } = require("../../../../lib/v2/permissions");
const { apiError }          = require("../../../../lib/v2/errors");

const SAFE_KEY = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    const { collection, filter, search, include_expired, include_deleted } = req.query;

    if (!collection) return reply.code(400).send({ error: "collection is required", code: "GEN_002" });

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const perm = await checkPermissionV2(schemaName, collection, "list", req, reply);
    if (!perm.allowed) return;

    const schema = quoteIdent(schemaName);
    const values = [];
    const where  = [`collection = $${values.push(collection)}`];

    if (include_expired !== "true") where.push(`(expires_at IS NULL OR expires_at > NOW())`);
    if (include_deleted !== "true") where.push(`deleted_at IS NULL`);

    if (perm.filterSql) {
      let rlsIdx = values.length;
      values.push(...perm.filterValues);
      where.push(perm.filterSql.replace(/\$\?/g, () => `$${++rlsIdx}`));
    }

    const rawFilters = Array.isArray(filter) ? filter : (filter ? [filter] : []);
    for (const entry of rawFilters.slice(0, 10)) {
      const idx = String(entry).indexOf(":");
      if (idx <= 0) continue;
      const key = entry.slice(0, idx).trim();
      const val = entry.slice(idx + 1).trim();
      if (!SAFE_KEY.test(key)) continue;
      values.push(val);
      where.push(`data->>'${key}' = $${values.length}`);
    }

    if (search?.trim()) {
      values.push(`%${search.trim()}%`);
      where.push(`data::text ILIKE $${values.length}`);
    }

    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS count FROM ${schema}._records WHERE ${where.join(" AND ")}`, values
    );

    return { count: rows[0].count, collection };
  };

  projectRoute(fastify, "GET", "/records/count", {
    preHandler: flexAuth,
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
  }, handler);
};
