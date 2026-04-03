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
    const { id }    = req.params;

    const {
      collection,
      filter,
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
      const record = result.rows[0];

      if (!record) return reply.code(403).send({ error: "Forbidden" });

      emitProjectEvent(projectId, {
        type: "record.updated",
        projectId,
        collection,
        record
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

    const where = [];
    const values = [];

    values.push(collection);
    where.push(`collection = $${values.length}`);
    where.push(`deleted_at IS NULL`);

    // filters
    const filters = parseFilters(filter);
    for (const { key, val } of filters) {
      const col = `data->>'${key}'`;
      values.push(val);
      where.push(`${col} = $${values.length}`);
    }

    // RLS
    if (perm.filterSql) {
      let idx = values.length;
      values.push(...perm.filterValues);
      where.push(perm.filterSql.replace(/\$\?/g, () => `$${++idx}`));
    }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // data expression
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

    const query = `
      UPDATE ${schema}._records
      SET ${dataExpr},
          updated_at = NOW()
          ${expiresSql}
      ${whereClause}
      LIMIT ${limitNum}
      RETURNING *
    `;

    const result = await db.query(query, values);

    for (const row of result.rows) {
      emitProjectEvent(projectId, {
        type: "record.updated",
        projectId,
        collection,
        record: row
      });

      fireWebhooks(schemaName, collection, "record.updated", {
        record: row
      }).catch(() => {});
    }

    return {
      count: result.rows.length,
      records: select ? result.rows : undefined
    };
  };

  projectRoute(fastify, "PATCH", "/records/:id?", {
    preHandler: flexAuth,
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, handler);
};
