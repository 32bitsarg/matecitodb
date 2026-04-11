const {
  db,
  flexAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { checkPermissionV2 } = require("../../../../lib/v2/permissions");
const { apiError }          = require("../../../../lib/v2/errors");
const { populateRecords }   = require("../../../../lib/v2/populate");
const {
  parseQueryFilters,
  buildWhereClause,
  castColumn,
  SQL_OPERATORS,
} = require("../../../../lib/v2/filter-parser");

const SAFE_KEY  = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const OP_MAP    = { eq: "=", neq: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "LIKE", ilike: "ILIKE" };

// ─── Field cache (5min TTL) ───────────────────────────────────────────────────
const _fieldCache = new Map();
async function getCollectionFields(schema, collection) {
  const key    = `${schema}:${collection}`;
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

// ─── Cursor-based pagination helpers ─────────────────────────────────────────
// cursor = base64(JSON { sort, order, val, id })
function encodeCursor(sort, order, val, id) {
  return Buffer.from(JSON.stringify({ sort, order, val, id })).toString("base64url");
}
function decodeCursor(cursor) {
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString());
  } catch {
    return null;
  }
}

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    const {
      collection,
      select,
      or,
      cursor,
      populate,
      limit   = "50",
      order   = "desc",
      search,
    } = req.query;

    const ALLOWED_SORTS = ["id", "created_at", "updated_at"];
    const sort = ALLOWED_SORTS.includes(req.query.sort) ? req.query.sort : "created_at";

    if (!collection) return reply.code(400).send({ error: "collection is required", code: "GEN_002" });

    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const perm = await checkPermissionV2(schemaName, collection, "list", req, reply);
    if (!perm.allowed) return;

    const schema = quoteIdent(schemaName);
    const fields = await getCollectionFields(schema, collection);

    const values = [];
    const where  = [];

    values.push(collection);
    where.push(`r.collection = $${values.length}`);

    if (req.query.include_expired !== "true") where.push(`(r.expires_at IS NULL OR r.expires_at > NOW())`);
    if (req.query.include_deleted !== "true") where.push(`r.deleted_at IS NULL`);

    // ── Advanced filter parser (G2) ──────────────────────────────────────
    // Support: campo.gt:10, campo.in:a,b, campo.null:true, campo.has:val, OR, etc.
    const { conditions, orConditions } = parseQueryFilters(req.query, fields);

    if (conditions.length > 0 || orConditions.length > 0) {
      const { where: filterWhere, values: filterValues } = buildWhereClause(
        conditions, orConditions, fields, values
      );
      where.push(...filterWhere);
      values.push(...filterValues);
    }

    // Legacy filters (backward compatible: campo.op:valor with old OP_MAP)
    for (const key of Object.keys(req.query)) {
      if (!SAFE_KEY.test(key)) continue;
      if (key === "or") continue;
      if (!fields[key]) continue;
      const value = req.query[key];
      if (typeof value !== "string") continue;
      const dotIdx = value.indexOf(".");
      if (dotIdx <= 0) continue;
      const op  = value.slice(0, dotIdx);
      const val = value.slice(dotIdx + 1);
      if (!OP_MAP[op]) continue;
      // Skip if already handled by new parser
      if (SQL_OPERATORS[op]) continue;
      const col = castColumn(`r.data->>'${key}'`, fields[key].type);
      values.push(val);
      where.push(`${col} ${OP_MAP[op]} $${values.length}`);
    }

    // Full-text search
    if (search) {
      values.push(`%${String(search)}%`);
      where.push(`r.data::text ILIKE $${values.length}`);
    }

    // Legacy OR filters (backward compatible: or=key1.op1:val1,key2.op2:val2)
    if (or) {
      const orParsed = parseQueryFilters({ or: Array.isArray(or) ? or : [or] }, fields);
      if (orParsed.orConditions.length > 0) {
        const { where: orWhere, values: orValues } = buildWhereClause(
          [], orParsed.orConditions, fields, values
        );
        where.push(...orWhere);
        values.push(...orValues);
      }
    }

    // RLS filter
    if (perm.filterSql) {
      let rlsIdx = values.length;
      values.push(...perm.filterValues);
      where.push(perm.filterSql.replace(/\$\?/g, () => `$${++rlsIdx}`));
    }

    // Cursor pagination
    const cursorData = cursor ? decodeCursor(cursor) : null;
    if (cursorData) {
      const sortCol = `r.${ALLOWED_SORTS.includes(cursorData.sort) ? cursorData.sort : "created_at"}`;
      const op      = (cursorData.order ?? order).toLowerCase() === "asc" ? ">" : "<";
      values.push(cursorData.val, cursorData.id);
      where.push(`(${sortCol} ${op} $${values.length - 1} OR (${sortCol} = $${values.length - 1} AND r.id ${op} $${values.length}))`);
    }

    // SELECT
    let selectSQL = "r.*";
    if (select) {
      const mapped = String(select).split(",").map(f => f.trim()).filter(f => SAFE_KEY.test(f))
        .map(f => `r.data->>'${f}' AS "${f}"`);
      if (mapped.length) selectSQL = `r.id, r.collection, r.created_at, r.updated_at, ${mapped.join(", ")}`;
    }

    // JOIN relations
    let joins = "";
    for (const key of Object.keys(fields)) {
      if (fields[key].type === "relation" && fields[key].options?.collection) {
        joins += ` LEFT JOIN ${schema}._records rel_${key} ON rel_${key}.id = (r.data->>'${key}')::uuid`;
      }
    }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const orderDir    = order.toUpperCase() === "ASC" ? "ASC" : "DESC";

    // Count (without cursor clause for accurate total)
    const countValues = values.slice(0, cursorData ? values.length - 2 : values.length);
    const countWhere  = cursorData
      ? whereClause.split(" AND ").slice(0, -1).join(" AND ").replace(/^WHERE /, "WHERE ")
      : whereClause;

    values.push(limitNum);
    const limitIdx = values.length;

    const [countRes, dataRes] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM ${schema}._records r ${countWhere}`, countValues),
      db.query(
        `SELECT ${selectSQL} FROM ${schema}._records r ${joins} ${whereClause}
         ORDER BY r.${sort} ${orderDir}, r.id ${orderDir} LIMIT $${limitIdx}`,
        values
      ),
    ]);

    const total = parseInt(countRes.rows[0].count, 10);
    let records = dataRes.rows;

    // Populate relations if requested
    if (populate) {
      const fieldsArray = Object.entries(fields).map(([name, f]) => ({ name, ...f }));
      records = await populateRecords(schemaName, fieldsArray, records, populate);
    }

    let nextCursor = null;

    if (records.length === limitNum) {
      const last = records[records.length - 1];
      nextCursor = encodeCursor(sort, order, last[sort], last.id);
    }

    return {
      records,
      pagination: {
        limit:       limitNum,
        total,
        next_cursor: nextCursor,
        has_more:    nextCursor !== null,
      },
    };
  };

  projectRoute(fastify, "GET", "/records", {
    preHandler: flexAuth,
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
  }, handler);
};
