const {
  db,
  flexAuth,
  checkPermission,
  quoteIdent,
  projectRoute
} = require("../../../lib/matecito");

const { emitProjectEvent } = require("../../../lib/realtime");
const { fireWebhooks }     = require("../../../lib/webhooks");

const SAFE_KEY = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

// Parses SDK-style query params: ?tag=eq.alpha&value=gte.10
// Returns [{ key, op, val }] — only keys passing SAFE_KEY are included.
function parseFilters(query) {
  const filters = [];
  for (const key in query) {
    if (!SAFE_KEY.test(key)) continue;
    // skip known non-filter params
    if (['collection', 'limit', 'select', 'page', 'sort', 'order',
         'include_deleted', 'include_expired', 'search', 'or'].includes(key)) continue;

    const raw = query[key];
    if (typeof raw !== 'string') continue;

    const dotIdx = raw.indexOf('.');
    if (dotIdx <= 0) continue;

    const op  = raw.slice(0, dotIdx);
    const val = raw.slice(dotIdx + 1);

    filters.push({ key, op, val });
  }
  return filters;
}

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { id }    = req.params;

    const {
      collection,
      limit = "100",
      select
    } = req.query;

    const {
      data,
      merge = true,
      expires_at
    } = req.body;

    if (!data || typeof data !== "object") {
      return reply.code(400).send({ error: "data object required" });
    }

    const limitNum = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));

    const schemaName = project?.schema_name ?? await (async () => {
      const res = await db.query(
        `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`,
        [projectId]
      );
      return res.rows[0]?.schema_name;
    })();

    if (!schemaName) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const schema = quoteIdent(schemaName);

    // ─────────────────────────────────────────
    // EXPIRES_AT
    // ─────────────────────────────────────────
    let expiresClause = "";
    let expiresValue;

    if (expires_at !== undefined) {
      if (expires_at === null) {
        expiresClause = ", expires_at = NULL";
      } else {
        const d = new Date(expires_at);
        if (isNaN(d.getTime())) {
          return reply.code(400).send({ error: "Invalid expires_at" });
        }
        expiresClause = `, expires_at = $EXP`;
        expiresValue = d;
      }
    }

    // ─────────────────────────────────────────
    // UPDATE BY ID
    // ─────────────────────────────────────────
    if (id) {
      const existing = await db.query(
        `SELECT id, collection FROM ${schema}._records WHERE id = $1 LIMIT 1`,
        [id]
      );

      if (!existing.rows[0]) {
        return reply.code(404).send({ error: "Record not found" });
      }

      const { collection } = existing.rows[0];

      const perm = await checkPermission(schemaName, collection, "update", req, reply);
      if (!perm.allowed) return;

      const values = [];
      const dataExpr = merge ? `data || $1::jsonb` : `$1::jsonb`;

      values.push(data);
      values.push(id);

      if (expiresValue !== undefined) values.push(expiresValue);

      // RLS
      let rlsWhere = "";
      if (perm.filterSql) {
        let idx = values.length;
        values.push(...perm.filterValues);
        rlsWhere = ` AND ${perm.filterSql.replace(/\$\?/g, () => `$${++idx}`)}`;
      }

      const query = `
        UPDATE ${schema}._records
        SET data = ${dataExpr},
            updated_at = NOW()
            ${expiresClause.replace("$EXP", `$${expiresValue !== undefined ? 3 : 999}`)}
        WHERE id = $2
        ${rlsWhere}
        RETURNING *
      `;

      const result = await db.query(query, values);
      if (!result.rows[0]) return reply.code(403).send({ error: "Forbidden" });

      const { data: rowData, ...rest } = result.rows[0];
      const record = { ...rest, ...(rowData ?? {}) };

      emitProjectEvent(projectId, {
        type: "record.updated",
        projectId,
        collection,
        record,
      });

      fireWebhooks(schemaName, collection, "record.updated", { record }).catch(() => {});

      return { record };
    }

    // ─────────────────────────────────────────
    // BULK UPDATE (SUPABASE STYLE)
    // ─────────────────────────────────────────

    if (!collection) {
      return reply.code(400).send({ error: "collection required for bulk update" });
    }

    const perm = await checkPermission(schemaName, collection, "update", req, reply);
    if (!perm.allowed) return;

    // ── Build subquery WHERE (for the inner SELECT) ──────────────────────────
    // All user-supplied values go through parameterized placeholders.
    // Field keys are validated against SAFE_KEY before interpolation.
    // RLS filterSql uses $? placeholders replaced sequentially — never raw input.

    const subWhere  = [];
    const subValues = [];

    subValues.push(collection);
    subWhere.push(`collection = $${subValues.length}`);
    subWhere.push(`deleted_at IS NULL`);
    subWhere.push(`(expires_at IS NULL OR expires_at > NOW())`);

    // User filters — only allow keys that pass SAFE_KEY, values always parameterized
    const OP_MAP = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'LIKE', ilike: 'ILIKE' };
    const filters = parseFilters(req.query);
    for (const { key, op, val } of filters) {
      const sqlOp = OP_MAP[op];
      if (!sqlOp) continue;
      subValues.push(val);
      subWhere.push(`data->>'${key}' ${sqlOp} $${subValues.length}`);
    }

    // Row-level security
    if (perm.filterSql) {
      let idx = subValues.length;
      subValues.push(...perm.filterValues);
      subWhere.push(perm.filterSql.replace(/\$\?/g, () => `$${++idx}`));
    }

    subValues.push(limitNum);
    const limitIdx = subValues.length;

    const subQuery = `
      SELECT id FROM ${schema}._records
      WHERE ${subWhere.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${limitIdx}
    `;

    // ── SET clause — data expression + optional expires_at ────────────────────
    const values = [...subValues];

    values.push(data);
    const dataIdx = values.length;

    if (expiresValue !== undefined) {
      values.push(expiresValue);
    }

    const expiresSql = expiresValue !== undefined
      ? `, expires_at = $${values.length}`
      : expires_at === null
        ? `, expires_at = NULL`
        : "";

    const dataExpr = merge
      ? `data = data || $${dataIdx}::jsonb`
      : `data = $${dataIdx}::jsonb`;

    // ── Postgres-safe bulk UPDATE via subquery (no LIMIT on UPDATE) ───────────
    const query = `
      UPDATE ${schema}._records
      SET ${dataExpr},
          updated_at = NOW()
          ${expiresSql}
      WHERE id IN (${subQuery})
      RETURNING *
    `;

    const result = await db.query(query, values);

    const updatedRecords = result.rows.map(row => {
      const { data: rowData, ...rest } = row;
      return { ...rest, ...(rowData ?? {}) };
    });

    for (const record of updatedRecords) {
      emitProjectEvent(projectId, {
        type: "record.updated",
        projectId,
        collection,
        record,
      });

      fireWebhooks(schemaName, collection, "record.updated", { record }).catch(() => {});
    }

    return {
      count: updatedRecords.length,
      records: updatedRecords,
    };
  };

  projectRoute(fastify, "PATCH", "/records/:id?", {
    preHandler: flexAuth,
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, handler);
};
