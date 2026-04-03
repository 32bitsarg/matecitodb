const {
  db,
  flexAuth,
  checkPermission,
  quoteIdent,
  projectRoute,
} = require("../../../lib/matecito");

const SAFE_KEY = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

// ─── Cache ─────────────────────────────────────────

const fieldCache    = new Map();
const FIELD_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getCollectionFields(schema, collection) {
  const key    = `${schema}:${collection}`;
  const cached = fieldCache.get(key);
  if (cached && cached.exp > Date.now()) return cached.data;

  const res = await db.query(
    `SELECT name, type, options FROM ${schema}._fields WHERE collection = $1`,
    [collection]
  );

  const map = {};
  for (const row of res.rows) {
    map[row.name] = {
      type: row.type,
      options: row.options || {},
    };
  }

  fieldCache.set(key, { data: map, exp: Date.now() + FIELD_CACHE_TTL });
  return map;
}

// ─── Casting ───────────────────────────────────────

function castColumn(col, type) {
  switch (type) {
    case "number":
      return `(${col})::numeric`;
    case "date":
      return `(${col})::timestamp`;
    case "boolean":
      return `(${col})::boolean`;
    default:
      return col;
  }
}

// ─── Operadores ────────────────────────────────────

const OP_MAP = {
  eq: "=",
  neq: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  like: "LIKE",
  ilike: "ILIKE",
};

// ─── Parser básico ─────────────────────────────────

function parseFilters(query) {
  const filters = [];

  for (const key in query) {
    if (!SAFE_KEY.test(key)) continue;

    const value = query[key];
    if (typeof value !== "string") continue;

    const parts = value.split(".");
    if (parts.length < 2) continue;

    filters.push({
      key,
      op: parts[0],
      val: parts.slice(1).join("."),
    });
  }

  return filters;
}

// ─── OR parser (nivel Supabase) ────────────────────
// or=(price.gte.100,name.ilike.%cafe%)

function parseOr(orRaw) {
  if (!orRaw) return [];

  const clean = orRaw.replace(/^\(|\)$/g, "");
  return clean.split(",").map((expr) => {
    const [key, op, ...rest] = expr.split(".");
    return {
      key,
      op,
      val: rest.join("."),
    };
  });
}

// ─── SELECT parser ─────────────────────────────────

function parseSelect(select) {
  if (!select) return ["*"];
  return select.split(",").map((f) => f.trim()).filter(Boolean);
}

// ─── MAIN ──────────────────────────────────────────

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    try {
      const project = req.resolvedProject;
      const projectId = project?.id ?? req.params?.projectId;

      const {
        collection,
        select,
        or,
        page = "1",
        limit = "50",
        order = "desc",
      } = req.query;

      const ALLOWED_SORTS = ["id", "created_at", "updated_at"];
      const sort = ALLOWED_SORTS.includes(req.query.sort) ? req.query.sort : "created_at";

      if (!collection) {
        return reply.code(400).send({ error: "collection is required" });
      }

      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

      const schemaName =
        project?.schema_name ??
        (await db
          .query(`SELECT schema_name FROM projects WHERE id = $1`, [projectId])
          .then((r) => r.rows[0]?.schema_name));

      if (!schemaName) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const schema = quoteIdent(schemaName);

      const perm = await checkPermission(
        schemaName,
        collection,
        "list",
        req,
        reply
      );
      if (!perm.allowed) return;

      const fields = await getCollectionFields(schema, collection);

      const values = [];
      const where = [];

      values.push(collection);
      where.push(`r.collection = $${values.length}`);

      if (req.query.include_expired !== 'true') {
        where.push(`(r.expires_at IS NULL OR r.expires_at > NOW())`);
      }
      if (req.query.include_deleted !== 'true') {
        where.push(`r.deleted_at IS NULL`);
      }

      // ─── Filters ─────────────────────────

      const filters = parseFilters(req.query);

      for (const { key, op, val } of filters) {
        if (!fields[key]) continue;

        const col = `r.data->>'${key}'`;
        const sqlCol = castColumn(col, fields[key].type);
        const sqlOp = OP_MAP[op];

        if (!sqlOp) continue;

        values.push(val);
        where.push(`${sqlCol} ${sqlOp} $${values.length}`);
      }

      // ─── Search ──────────────────────────

      if (req.query.search) {
        const searchTerm = `%${String(req.query.search)}%`;
        values.push(searchTerm);
        where.push(`r.data::text ILIKE $${values.length}`);
      }

      // ─── OR ──────────────────────────────

      const orFilters = parseOr(or);
      if (orFilters.length) {
        const orParts = [];

        for (const { key, op, val } of orFilters) {
          if (!fields[key]) continue;

          const col = `r.data->>'${key}'`;
          const sqlCol = castColumn(col, fields[key].type);
          const sqlOp = OP_MAP[op];

          values.push(val);
          orParts.push(`${sqlCol} ${sqlOp} $${values.length}`);
        }

        if (orParts.length) {
          where.push(`(${orParts.join(" OR ")})`);
        }
      }

      // ─── SELECT ──────────────────────────

      const selectFields = parseSelect(select);

      let selectSQL = "r.*";

      if (selectFields[0] !== "*") {
        const mapped = selectFields
          .filter((f) => SAFE_KEY.test(f))
          .map((f) => `r.data->>'${f}' AS "${f}"`);

        selectSQL = mapped.length ? mapped.join(", ") : "r.*";
      }

      // ─── JOIN relaciones (simple FK) ─────

      let joins = "";
      for (const key in fields) {
        const field = fields[key];
        if (field.type === "relation" && field.options?.collection) {
          joins += `
            LEFT JOIN ${schema}._records rel_${key}
            ON rel_${key}.id = (r.data->>'${key}')::uuid
          `;
        }
      }

      const whereClause = where.length
        ? `WHERE ${where.join(" AND ")}`
        : "";

      // ─── COUNT ───────────────────────────

      const countRes = await db.query(
        `SELECT COUNT(*) FROM ${schema}._records r ${whereClause}`,
        values
      );

      // ─── DATA ────────────────────────────

      values.push(limitNum, (pageNum - 1) * limitNum);

      const dataRes = await db.query(
        `
        SELECT ${selectSQL}
        FROM ${schema}._records r
        ${joins}
        ${whereClause}
        ORDER BY r.${sort} ${order.toUpperCase()}
        LIMIT $${values.length - 1}
        OFFSET $${values.length}
        `,
        values
      );

      const total = parseInt(countRes.rows[0].count, 10);
      const pages = Math.ceil(total / limitNum);

      return {
        records: dataRes.rows,
        pagination: {
          page:        pageNum,
          limit:       limitNum,
          total,
          pages,
          next_cursor: pageNum < pages ? String(pageNum + 1) : null,
        },
      };
    } catch (err) {
      req.log.error(err);

      return reply.code(500).send({
        error: "Query failed",
        detail:
          process.env.NODE_ENV !== "production"
            ? err.message
            : undefined,
      });
    }
  };

  projectRoute(
    fastify,
    "GET",
    "/records",
    {
      preHandler: flexAuth,
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
    },
    handler
  );
};
