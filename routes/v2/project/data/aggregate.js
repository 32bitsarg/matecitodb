const {
  db,
  flexAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { checkPermissionV2 } = require("../../../../lib/v2/permissions");
const { apiError }          = require("../../../../lib/v2/errors");

const SAFE_KEY = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const OP_MAP   = { eq: "=", neq: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "LIKE", ilike: "ILIKE" };

module.exports = async function (fastify) {
  projectRoute(fastify, "GET", "/records/aggregate", {
    preHandler: flexAuth,
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    const { collection, group_by, sum, avg, min, max, search } = req.query;
    const count = req.query.count !== "false";

    if (!collection) return reply.code(400).send({ error: "collection is required", code: "GEN_002" });

    // Validate field names
    for (const field of [group_by, sum, avg, min, max].filter(Boolean)) {
      if (!SAFE_KEY.test(field)) return reply.code(400).send({ error: `Invalid field name: ${field}`, code: "GEN_002" });
    }

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const perm = await checkPermissionV2(schemaName, collection, "list", req, reply);
    if (!perm.allowed) return;

    const schema = quoteIdent(schemaName);

    // ── Build WHERE ───────────────────────────────────────────────────────────
    const where  = [];
    const values = [collection];
    where.push(`r.collection = $1`);
    where.push(`r.deleted_at IS NULL`);
    where.push(`(r.expires_at IS NULL OR r.expires_at > NOW())`);

    // Query-string filters (field.op:value)
    for (const [key, raw] of Object.entries(req.query)) {
      if (!SAFE_KEY.test(key)) continue;
      if (["collection", "group_by", "sum", "avg", "min", "max", "count", "search"].includes(key)) continue;
      if (typeof raw !== "string") continue;
      const dotIdx = raw.indexOf(".");
      if (dotIdx <= 0) continue;
      const op  = raw.slice(0, dotIdx);
      const val = raw.slice(dotIdx + 1);
      if (!OP_MAP[op]) continue;
      values.push(val);
      where.push(`r.data->>'${key}' ${OP_MAP[op]} $${values.length}`);
    }

    // Full-text search
    if (search) {
      values.push(`%${String(search)}%`);
      where.push(`r.data::text ILIKE $${values.length}`);
    }

    // RLS filter
    if (perm.filterSql) {
      let rlsIdx = values.length;
      values.push(...perm.filterValues);
      where.push(perm.filterSql.replace(/\$\?/g, () => `$${++rlsIdx}`));
    }

    const whereClause = `WHERE ${where.join(" AND ")}`;

    // ── Build SELECT ──────────────────────────────────────────────────────────
    const selects = [];
    const groupBySql = group_by ? `r.data->>'${group_by}'` : null;

    if (groupBySql) selects.push(`${groupBySql} AS "group"`);
    if (count)      selects.push(`COUNT(*)::bigint AS count`);
    if (sum)        selects.push(`SUM((r.data->>'${sum}')::numeric) AS sum_${sum}`);
    if (avg)        selects.push(`AVG((r.data->>'${avg}')::numeric) AS avg_${avg}`);
    if (min)        selects.push(`MIN((r.data->>'${min}')::numeric) AS min_${min}`);
    if (max)        selects.push(`MAX((r.data->>'${max}')::numeric) AS max_${max}`);

    if (selects.length === 0) {
      selects.push(`COUNT(*)::bigint AS count`);
    }

    const groupByClause = groupBySql ? `GROUP BY ${groupBySql}` : "";
    const orderClause   = groupBySql ? `ORDER BY ${groupBySql} ASC NULLS LAST` : "";

    const sql = `
      SELECT ${selects.join(", ")}
      FROM ${schema}._records r
      ${whereClause}
      ${groupByClause}
      ${orderClause}
      LIMIT 500
    `;

    const { rows } = await db.query(sql, values);

    return {
      collection,
      group_by: group_by ?? null,
      results:  rows,
    };
  });
};
