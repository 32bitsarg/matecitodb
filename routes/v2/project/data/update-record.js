const {
  db,
  flexAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { checkPermissionV2 }  = require("../../../../lib/v2/permissions");
const { emitProjectEvent }   = require("../../../../lib/v2/realtime");
const { enqueueWebhook, enqueueAuditLog, enqueueTrigger } = require("../../../../lib/v2/queue");
const { apiError }           = require("../../../../lib/v2/errors");
const { validateRecordData } = require("../../../../lib/v2/field-validator");
const { buildSearchVectorUpdate } = require("../../../../lib/v2/fulltext");

const SAFE_KEY = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

const OP_MAP = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'LIKE', ilike: 'ILIKE' };
const SKIP_PARAMS = new Set(['collection','limit','select','page','sort','order','include_deleted','include_expired','search','or','filter']);

// Parses SDK-style query params: ?tag=eq.alpha&value=gte.10
function parseFilters(query) {
  const filters = [];
  for (const key in query) {
    if (!SAFE_KEY.test(key) || SKIP_PARAMS.has(key)) continue;
    const raw = query[key];
    if (typeof raw !== 'string') continue;
    const dotIdx = raw.indexOf('.');
    if (dotIdx <= 0) continue;
    const op  = raw.slice(0, dotIdx);
    const val = raw.slice(dotIdx + 1);
    if (!OP_MAP[op]) continue;
    filters.push({ key, op, val });
  }
  return filters;
}

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { id }    = req.params;

    const { collection, limit = "100" } = req.query;
    const { data, merge = true, expires_at }    = req.body;

    if (!data || typeof data !== "object") {
      return reply.code(400).send({ error: "data object required", code: "GEN_002" });
    }

    const limitNum = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const schema = quoteIdent(schemaName);

    // expires_at handling
    let expiresClause = "";
    let expiresValue;

    if (expires_at !== undefined) {
      if (expires_at === null) {
        expiresClause = ", expires_at = NULL";
      } else {
        const d = new Date(expires_at);
        if (isNaN(d.getTime())) return reply.code(400).send({ error: "Invalid expires_at", code: "GEN_002" });
        expiresClause = `, expires_at = $EXP`;
        expiresValue  = d;
      }
    }

    // ── UPDATE BY ID ───────────────────────────────────────────────────────────
    if (id) {
      const { rows: existing } = await db.query(
        `SELECT id, collection FROM ${schema}._records WHERE id = $1 LIMIT 1`, [id]
      );
      if (!existing[0]) return apiError(reply, "DATA_001");

      const perm = await checkPermissionV2(schemaName, existing[0].collection, "update", req, reply);
      if (!perm.allowed) return;

      // Validate data against field schema (partial=true: skip required checks on PATCH)
      const validationError = await validateRecordData(schemaName, existing[0].collection, data, { recordId: id, partial: true });
      if (validationError) {
        return reply.code(422).send({ error: validationError.message, field: validationError.field, code: "DATA_005" });
      }

      const values    = [data, id];
      const dataExpr  = merge ? `data || $1::jsonb` : `$1::jsonb`;

      if (expiresValue !== undefined) values.push(expiresValue);

      let rlsWhere = "";
      if (perm.filterSql) {
        let rlsIdx = values.length;
        values.push(...perm.filterValues);
        rlsWhere = ` AND ${perm.filterSql.replace(/\$\?/g, () => `$${++rlsIdx}`)}`;
      }

      const expSql = expiresClause.replace("$EXP", `$${expiresValue !== undefined ? 3 : 999}`);

      const { rows } = await db.query(
        `UPDATE ${schema}._records
         SET data = ${dataExpr}, updated_at = NOW() ${expSql}
         WHERE id = $2 ${rlsWhere}
         RETURNING *`,
        values
      );

      if (!rows[0]) return apiError(reply, "PERM_001");

      // Update search_vector if collection has search_fields configured
      const searchUpdate = await buildSearchVectorUpdate(schemaName, rows[0].collection, rows[0].id, data);
      if (searchUpdate) {
        await db.query(searchUpdate.sql, searchUpdate.params).catch(() => {});
      }

      emitProjectEvent(projectId, { type: "record.updated", projectId, collection: rows[0].collection, record: rows[0] }).catch(() => {});
      enqueueWebhook(schemaName, rows[0].collection, "record.updated", { record: rows[0] });
      enqueueAuditLog(schemaName, { action: "record.updated", entity: rows[0].collection, entityId: rows[0].id, newValue: rows[0].data, performedBy: req.projectUser?.id, ip: req.ip });
      enqueueTrigger(schemaName, rows[0].collection, "record.updated", rows[0]);

      return { record: rows[0] };
    }

    // ── BULK UPDATE ────────────────────────────────────────────────────────────
    if (!collection) return reply.code(400).send({ error: "collection required for bulk update", code: "GEN_002" });

    const perm = await checkPermissionV2(schemaName, collection, "update", req, reply);
    if (!perm.allowed) return;

    const where  = [];
    const values = [];

    values.push(collection);
    where.push(`collection = $${values.length}`);
    where.push(`deleted_at IS NULL`);

    for (const { key, op, val } of parseFilters(req.query)) {
      values.push(val);
      where.push(`data->>'${key}' ${OP_MAP[op]} $${values.length}`);
    }

    if (perm.filterSql) {
      let rlsIdx = values.length;
      values.push(...perm.filterValues);
      where.push(perm.filterSql.replace(/\$\?/g, () => `$${++rlsIdx}`));
    }

    const whereClause = `WHERE ${where.join(" AND ")}`;

    values.push(data);
    const dataIdx  = values.length;
    const dataExpr = merge ? `data = data || $${dataIdx}::jsonb` : `data = $${dataIdx}::jsonb`;

    let expSql = "";
    if (expiresValue !== undefined) {
      values.push(expiresValue);
      expSql = `, expires_at = $${values.length}`;
    } else if (expires_at === null) {
      expSql = `, expires_at = NULL`;
    }

    const idSubquery = `SELECT id FROM ${schema}._records ${whereClause} LIMIT ${limitNum}`;
    const { rows } = await db.query(
      `UPDATE ${schema}._records SET ${dataExpr}, updated_at = NOW() ${expSql}
       WHERE id IN (${idSubquery}) RETURNING *`,
      values
    );

    for (const row of rows) {
      emitProjectEvent(projectId, { type: "record.updated", projectId, collection, record: row }).catch(() => {});
      enqueueWebhook(schemaName, collection, "record.updated", { record: row });
      enqueueTrigger(schemaName, collection, "record.updated", row);
    }

    const records = rows.map(row => { const { data: d, ...rest } = row; return { ...rest, ...(d ?? {}) }; });
    return { count: records.length, records };
  };

  projectRoute(fastify, "PATCH", "/records/:id?", {
    preHandler: flexAuth,
    schema: {
      body: {
        type: "object",
        required: ["data"],
        additionalProperties: true,
        properties: {
          data:       { type: "object" },
          merge:      { type: "boolean" },
          expires_at: {},
        },
      },
    },
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, handler);
};
