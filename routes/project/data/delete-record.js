const { db, flexAuth, checkPermission, quoteIdent, projectRoute } = require("../../../lib/matecito");
const { emitProjectEvent } = require("../../../lib/realtime");
const { fireWebhooks }     = require("../../../lib/webhooks");

const SAFE_KEY = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

const OP_MAP = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'LIKE', ilike: 'ILIKE' };

function parseFilters(query) {
  const filters = [];
  const SKIP = new Set(['collection','limit','select','page','sort','order','include_deleted','include_expired','search','or']);
  for (const key in query) {
    if (!SAFE_KEY.test(key) || SKIP.has(key)) continue;
    const raw = query[key];
    if (typeof raw !== 'string') continue;
    const dotIdx = raw.indexOf('.');
    if (dotIdx <= 0) continue;
    filters.push({ key, op: raw.slice(0, dotIdx), val: raw.slice(dotIdx + 1) });
  }
  return filters;
}

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    const { id } = req.params;

    const {
      collection,
      limit = "100",
      select
    } = req.query;

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
    // DELETE BY ID (modo clásico)
    // ─────────────────────────────────────────
    if (id) {
      const existing = await db.query(
        `SELECT r.id, r.collection, c.soft_delete
         FROM ${schema}._records r
         LEFT JOIN ${schema}._collections c ON c.name = r.collection
         WHERE r.id = $1 AND r.deleted_at IS NULL LIMIT 1`,
        [id]
      );

      if (!existing.rows[0]) {
        return reply.code(404).send({ error: "Record not found" });
      }

      const { collection, soft_delete } = existing.rows[0];

      const perm = await checkPermission(schemaName, collection, "delete", req, reply);
      if (!perm.allowed) return;

      // RLS
      if (perm.filterSql) {
        let rlsIdx = 1;
        const filterSql = perm.filterSql.replace(/\$\?/g, () => `$${++rlsIdx}`);

        const check = await db.query(
          `SELECT 1 FROM ${schema}._records WHERE id = $1 AND ${filterSql} LIMIT 1`,
          [id, ...perm.filterValues]
        );

        if (!check.rows[0]) {
          return reply.code(403).send({ error: "Forbidden" });
        }
      }

      let result;

      if (soft_delete) {
        result = await db.query(
          `UPDATE ${schema}._records
           SET deleted_at = NOW(), updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [id]
        );
      } else {
        result = await db.query(
          `DELETE FROM ${schema}._records
           WHERE id = $1
           RETURNING *`,
          [id]
        );
      }

      const record = result.rows[0];

      emitProjectEvent(projectId, { type: "record.deleted", projectId, collection, recordId: id });
      fireWebhooks(schemaName, collection, "record.deleted", { recordId: id }).catch(() => {});

      return { record };
    }

    // ─────────────────────────────────────────
    // BULK DELETE (modo supabase)
    // ─────────────────────────────────────────

    if (!collection) {
      return reply.code(400).send({ error: "collection is required for bulk delete" });
    }

    const perm = await checkPermission(schemaName, collection, "delete", req, reply);
    if (!perm.allowed) return;

    // ── Build subquery WHERE ──────────────────────────────────────────────────
    const subWhere  = [];
    const subValues = [];

    subValues.push(collection);
    subWhere.push(`collection = $${subValues.length}`);
    subWhere.push(`deleted_at IS NULL`);
    subWhere.push(`(expires_at IS NULL OR expires_at > NOW())`);

    const filters = parseFilters(req.query);
    for (const { key, op, val } of filters) {
      const sqlOp = OP_MAP[op];
      if (!sqlOp) continue;
      subValues.push(val);
      subWhere.push(`data->>'${key}' ${sqlOp} $${subValues.length}`);
    }

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

    // ── detectar soft delete ──────────────────────────────────────────────────
    const colInfo = await db.query(
      `SELECT soft_delete FROM ${schema}._collections WHERE name = $1 LIMIT 1`,
      [collection]
    );
    const softDelete = colInfo.rows[0]?.soft_delete;

    // ── Postgres-safe bulk DELETE/soft-delete via subquery ────────────────────
    const query = softDelete
      ? `UPDATE ${schema}._records
         SET deleted_at = NOW(), updated_at = NOW()
         WHERE id IN (${subQuery})
         RETURNING id`
      : `DELETE FROM ${schema}._records
         WHERE id IN (${subQuery})
         RETURNING id`;

    const result = await db.query(query, subValues);

    for (const row of result.rows) {
      emitProjectEvent(projectId, {
        type: "record.deleted",
        projectId,
        collection,
        recordId: row.id,
      });
      fireWebhooks(schemaName, collection, "record.deleted", { recordId: row.id }).catch(() => {});
    }

    return {
      count: result.rows.length,
      deleted: result.rows.map(r => r.id),
    };
  };

  projectRoute(fastify, "DELETE", "/records/:id?", {
    preHandler: flexAuth,
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, handler);
};
