// ─── Advanced Records Query (G2 — body-based) ───────────────────────────────
//
// POST /records/query
// {
//   "collection": "posts",
//   "where": {
//     "or": [
//       { "status": { "eq": "draft" } },
//       { "status": { "eq": "review" } }
//     ],
//     "price": { "gte": 10, "lte": 100 }
//   },
//   "select": ["title", "price"],
//   "limit": 50,
//   "offset": 0,
//   "sort": "created_at",
//   "order": "desc"
// }
//
// Soporta: eq, neq, gt, gte, lt, lte, between, in, nin, null, like, ilike, has, or.

const {
  db,
  flexAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { checkPermissionV2 } = require("../../../../lib/v2/permissions");
const { apiError }          = require("../../../../lib/v2/errors");
const { parseBodyFilters, buildWhereClause } = require("../../../../lib/v2/filter-parser");

const SAFE_KEY = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

// ─── Field cache (5min TTL) ───────────────────────────────────────────────────
const _fieldCache = new Map();
async function getCollectionFields(schema, collection) {
  const key = `${schema}:${collection}`;
  const cached = _fieldCache.get(key);
  if (cached && cached.exp > Date.now()) return cached.data;

  const { rows } = await db.query(
    `SELECT name, type, options FROM ${schema}._fields WHERE collection = $1`, [collection]
  );
  const map = {};
  for (const row of rows) map[row.name] = { type: row.type, options: row.options || {} };
  _fieldCache.set(key, { data: map, exp: Date.now() + 5 * 60 * 1000 });
  return map;
}

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    const {
      collection,
      where,
      select,
      limit = 50,
      offset = 0,
      sort = "created_at",
      order = "desc",
      include_deleted,
      include_expired,
    } = req.body;

    if (!collection) return reply.code(400).send({ error: "collection is required", code: "GEN_002" });

    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const offsetNum = Math.max(0, parseInt(offset, 10) || 0);

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const perm = await checkPermissionV2(schemaName, collection, "list", req, reply);
    if (!perm.allowed) return;

    const schema = quoteIdent(schemaName);
    const fields = await getCollectionFields(schema, collection);

    // Parse body filters
    const whereObj = where || {};
    const { conditions, orConditions } = parseBodyFilters(whereObj, fields);

    // Build WHERE clause
    const values = [];
    const whereParts = [];

    values.push(collection);
    whereParts.push(`r.collection = $${values.length}`);

    if (include_deleted !== true) whereParts.push(`r.deleted_at IS NULL`);
    if (include_expired !== true) whereParts.push(`(r.expires_at IS NULL OR r.expires_at > NOW())`);

    // Advanced filters
    if (conditions.length > 0 || orConditions.length > 0) {
      const { where: filterWhere, values: filterValues } = buildWhereClause(
        conditions, orConditions, fields, values
      );
      whereParts.push(...filterWhere);
      values.push(...filterValues);
    }

    // RLS filter
    if (perm.filterSql) {
      let rlsIdx = values.length;
      values.push(...perm.filterValues);
      whereParts.push(perm.filterSql.replace(/\$\?/g, () => `$${++rlsIdx}`));
    }

    const whereClause = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

    // SELECT
    let selectSQL = "r.*";
    if (Array.isArray(select) && select.length > 0) {
      const mapped = select.filter(f => SAFE_KEY.test(f)).map(f => `r.data->>'${f}' AS "${f}"`);
      if (mapped.length) selectSQL = `r.id, r.collection, r.created_at, r.updated_at, ${mapped.join(", ")}`;
    }

    // JOIN relations
    let joins = "";
    for (const key of Object.keys(fields)) {
      if (fields[key].type === "relation" && fields[key].options?.collection) {
        joins += ` LEFT JOIN ${schema}._records rel_${key} ON rel_${key}.id = (r.data->>'${key}')::uuid`;
      }
    }

    // ORDER BY
    const allowedSorts = ["id", "created_at", "updated_at"];
    const sortCol = allowedSorts.includes(sort) ? `r.${sort}` : "r.created_at";
    const orderDir = order.toUpperCase() === "ASC" ? "ASC" : "DESC";

    // Count + Data
    values.push(limitNum, offsetNum);
    const limitIdx = values.length - 1;
    const offsetIdx = values.length;

    const [countRes, dataRes] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM ${schema}._records r ${whereClause}`, values.slice(0, -2)),
      db.query(
        `SELECT ${selectSQL} FROM ${schema}._records r ${joins} ${whereClause}
         ORDER BY ${sortCol} ${orderDir}, r.id ${orderDir}
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        values
      ),
    ]);

    const total = parseInt(countRes.rows[0].count, 10);

    return {
      collection,
      total,
      limit: limitNum,
      offset: offsetNum,
      records: dataRes.rows,
    };
  };

  projectRoute(fastify, "POST", "/records/query", {
    preHandler: flexAuth,
    schema: {
      body: {
        type: "object",
        required: ["collection"],
        properties: {
          collection:       { type: "string" },
          where:            { type: "object" },
          select:           { type: "array", items: { type: "string" } },
          limit:            { type: "integer", minimum: 1, maximum: 200 },
          offset:           { type: "integer", minimum: 0 },
          sort:             { type: "string", enum: ["id", "created_at", "updated_at"] },
          order:            { type: "string", enum: ["asc", "desc"] },
          include_deleted:  { type: "boolean" },
          include_expired:  { type: "boolean" },
        },
      },
    },
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
  }, handler);
};
