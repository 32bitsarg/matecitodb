const { db, flexAuth, checkPermission, quoteIdent, projectRoute } = require("../../../lib/matecito");
const { emitProjectEvent } = require("../../../lib/realtime");
const { fireWebhooks }     = require("../../../lib/webhooks");

const SAFE_KEY = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

function parseFilters(raw) {
  if (!raw) return [];

  const list = Array.isArray(raw) ? raw : [raw];
  const result = [];

  for (const entry of list) {
    const colonIdx = String(entry).indexOf(":");
    if (colonIdx <= 0) continue;

    const key = entry.slice(0, colonIdx).trim();
    const val = entry.slice(colonIdx + 1).trim();

    if (!SAFE_KEY.test(key)) continue;

    result.push({ key, val });
  }

  return result;
}

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    const { id } = req.params;

    const {
      collection,
      filter,
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

    const where = [];
    const values = [];

    values.push(collection);
    where.push(`collection = $${values.length}`);

    where.push(`deleted_at IS NULL`);

    // filtros simples (tipo eq)
    const filters = parseFilters(filter);
    for (const { key, val } of filters) {
      const col = `data->>'${key}'`;
      values.push(val);
      where.push(`${col} = $${values.length}`);
    }

    // RLS
    if (perm.filterSql) {
      let rlsIdx = values.length;
      values.push(...perm.filterValues);
      where.push(perm.filterSql.replace(/\$\?/g, () => `$${++rlsIdx}`));
    }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // detectar soft delete
    const colInfo = await db.query(
      `SELECT soft_delete FROM ${schema}._collections WHERE name = $1 LIMIT 1`,
      [collection]
    );

    const softDelete = colInfo.rows[0]?.soft_delete;

    let query;

    if (softDelete) {
      query = `
        UPDATE ${schema}._records
        SET deleted_at = NOW(), updated_at = NOW()
        ${whereClause}
        LIMIT ${limitNum}
        RETURNING *
      `;
    } else {
      query = `
        DELETE FROM ${schema}._records
        ${whereClause}
        LIMIT ${limitNum}
        RETURNING *
      `;
    }

    const result = await db.query(query, values);

    for (const row of result.rows) {
      emitProjectEvent(projectId, {
        type: "record.deleted",
        projectId,
        collection,
        recordId: row.id
      });

      fireWebhooks(schemaName, collection, "record.deleted", {
        recordId: row.id
      }).catch(() => {});
    }

    return {
      count: result.rows.length,
      records: select ? result.rows : undefined
    };
  };

  projectRoute(fastify, "DELETE", "/records/:id?", {
    preHandler: flexAuth,
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, handler);
};
