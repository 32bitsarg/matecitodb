const { db, flexAuth, checkPermission, quoteIdent, projectRoute } = require("../../../lib/matecito");

const SAFE_KEY = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    const { collection, filter, search, include_expired, include_deleted } = req.query;

    if (!collection) {
      return reply.code(400).send({ error: "collection is required" });
    }

    const schemaName = project?.schema_name ?? await (async () => {
      const res = await db.query(
        `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
      );
      return res.rows[0]?.schema_name;
    })();

    if (!schemaName) return reply.code(404).send({ error: "Project not found" });

    const perm = await checkPermission(schemaName, collection, "list", req, reply);
    if (!perm.allowed) return;

    const schema = quoteIdent(schemaName);
    const values = [];
    const where  = [`collection = $${values.push(collection)}`];

    if (include_expired !== "true") {
      where.push(`(expires_at IS NULL OR expires_at > NOW())`);
    }
    if (include_deleted !== "true") {
      where.push(`deleted_at IS NULL`);
    }

    // RLS
    if (perm.filterSql) {
      values.push(...perm.filterValues);
      where.push(perm.filterSql.replace(/\$\?/g, () => `$${values.length}`));
    }

    // Filters
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
      `SELECT COUNT(*)::int AS count FROM ${schema}._records WHERE ${where.join(" AND ")}`,
      values
    );

    return { count: rows[0].count, collection };
  };

  projectRoute(fastify, "GET", "/records/count", {
    preHandler: flexAuth,
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
  }, handler);
};
