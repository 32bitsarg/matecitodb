const {
  db,
  flexAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { checkPermissionV2 } = require("../../../../lib/v2/permissions");
const { emitProjectEvent }  = require("../../../../lib/v2/realtime");
const { enqueueWebhook, enqueueAuditLog, enqueueTrigger } = require("../../../../lib/v2/queue");
const { apiError }          = require("../../../../lib/v2/errors");

const SAFE_KEY = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

function parseFilters(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map(entry => {
    const colonIdx = String(entry).indexOf(":");
    if (colonIdx <= 0) return null;
    const key = entry.slice(0, colonIdx).trim();
    const val = entry.slice(colonIdx + 1).trim();
    if (!SAFE_KEY.test(key)) return null;
    return { key, val };
  }).filter(Boolean);
}

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { id }    = req.params;

    const { collection, filter, limit = "100" } = req.query;
    const limitNum = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const schema = quoteIdent(schemaName);

    // ── DELETE BY ID ───────────────────────────────────────────────────────────
    if (id) {
      const { rows: existing } = await db.query(
        `SELECT r.id, r.collection, c.soft_delete
         FROM ${schema}._records r
         LEFT JOIN ${schema}._collections c ON c.name = r.collection
         WHERE r.id = $1 AND r.deleted_at IS NULL LIMIT 1`,
        [id]
      );
      if (!existing[0]) return apiError(reply, "DATA_001");

      const { collection: col, soft_delete } = existing[0];
      const perm = await checkPermissionV2(schemaName, col, "delete", req, reply);
      if (!perm.allowed) return;

      if (perm.filterSql) {
        let rlsIdx = 1;
        const filterSql = perm.filterSql.replace(/\$\?/g, () => `$${++rlsIdx}`);
        const check = await db.query(
          `SELECT 1 FROM ${schema}._records WHERE id = $1 AND ${filterSql} LIMIT 1`,
          [id, ...perm.filterValues]
        );
        if (!check.rows[0]) return apiError(reply, "PERM_001");
      }

      let result;
      if (soft_delete) {
        result = await db.query(
          `UPDATE ${schema}._records SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`, [id]
        );
      } else {
        result = await db.query(
          `DELETE FROM ${schema}._records WHERE id = $1 RETURNING *`, [id]
        );
      }

      emitProjectEvent(projectId, { type: "record.deleted", projectId, collection: col, recordId: id }).catch(() => {});
      enqueueWebhook(schemaName, col, "record.deleted", { recordId: id });
      enqueueAuditLog(schemaName, { action: "record.deleted", entity: col, entityId: id, prevValue: result.rows[0]?.data, performedBy: req.projectUser?.id, ip: req.ip });
      enqueueTrigger(schemaName, col, "record.deleted", result.rows[0]);

      return { record: result.rows[0] };
    }

    // ── BULK DELETE ────────────────────────────────────────────────────────────
    if (!collection) return reply.code(400).send({ error: "collection is required for bulk delete", code: "GEN_002" });

    const perm = await checkPermissionV2(schemaName, collection, "delete", req, reply);
    if (!perm.allowed) return;

    const where  = [];
    const values = [];

    values.push(collection);
    where.push(`collection = $${values.length}`);
    where.push(`deleted_at IS NULL`);

    for (const { key, val } of parseFilters(filter)) {
      values.push(val);
      where.push(`data->>'${key}' = $${values.length}`);
    }

    if (perm.filterSql) {
      let rlsIdx = values.length;
      values.push(...perm.filterValues);
      where.push(perm.filterSql.replace(/\$\?/g, () => `$${++rlsIdx}`));
    }

    const whereClause = `WHERE ${where.join(" AND ")}`;

    const colInfo = await db.query(
      `SELECT soft_delete FROM ${schema}._collections WHERE name = $1 LIMIT 1`, [collection]
    );
    const softDelete = colInfo.rows[0]?.soft_delete;

    const idSubquery = `SELECT id FROM ${schema}._records ${whereClause} LIMIT ${limitNum}`;
    const query = softDelete
      ? `UPDATE ${schema}._records SET deleted_at = NOW(), updated_at = NOW() WHERE id IN (${idSubquery}) RETURNING *`
      : `DELETE FROM ${schema}._records WHERE id IN (${idSubquery}) RETURNING *`;

    const { rows } = await db.query(query, values);

    for (const row of rows) {
      emitProjectEvent(projectId, { type: "record.deleted", projectId, collection, recordId: row.id }).catch(() => {});
      enqueueWebhook(schemaName, collection, "record.deleted", { recordId: row.id });
      enqueueTrigger(schemaName, collection, "record.deleted", row);
    }

    return { count: rows.length };
  };

  projectRoute(fastify, "DELETE", "/records/:id?", {
    preHandler: flexAuth,
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, handler);
};
