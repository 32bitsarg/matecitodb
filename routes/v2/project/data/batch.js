const {
  db,
  flexAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { checkPermissionV2 }  = require("../../../../lib/v2/permissions");
const { emitProjectEvent }   = require("../../../../lib/v2/realtime");
const { enqueueWebhook, enqueueTrigger } = require("../../../../lib/v2/queue");
const { apiError }           = require("../../../../lib/v2/errors");
const { validateRecordData } = require("../../../../lib/v2/field-validator");
const { buildSearchVectorUpdate } = require("../../../../lib/v2/fulltext");

const MAX_OPS = 50;

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    const { operations } = req.body;
    const { dry_run, atomic } = req.query;
    const isDryRun  = dry_run === "true";
    const isAtomic  = atomic === "true";

    if (!Array.isArray(operations) || operations.length === 0) {
      return reply.code(400).send({ error: "operations must be a non-empty array", code: "GEN_002" });
    }
    const maxOps = isDryRun ? 10000 : (isAtomic ? 1000 : MAX_OPS);
    if (operations.length > maxOps) {
      return reply.code(400).send({ error: `Max ${maxOps} operations for this mode`, code: "GEN_002" });
    }

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const schema = quoteIdent(schemaName);

    // Pre-load collections for update/delete ops that need them
    const missingIds = operations
      .filter(op => (op.op === "update" || op.op === "delete") && !op.collection && op.id)
      .map(op => op.id);

    const collectionMap = new Map();
    if (missingIds.length > 0) {
      const { rows } = await db.query(
        `SELECT id, collection FROM ${schema}._records WHERE id = ANY($1)`, [missingIds]
      );
      for (const row of rows) collectionMap.set(row.id, row.collection);
    }

    // ── DRY RUN: validate all, write nothing ──────────────────────────────
    if (isDryRun) {
      const results = [];
      const errors = [];
      for (let i = 0; i < operations.length; i++) {
        const op = operations[i];
        try {
          if (op.op === "insert") {
            if (!op.collection || typeof op.data !== "object" || op.data === null) {
              errors.push({ index: i, field: "collection", message: "insert op requires collection and data" });
              continue;
            }
            const perm = await checkPermissionV2(schemaName, op.collection, "create", req, reply);
            if (!perm.allowed) { errors.push({ index: i, field: "permission", message: "not allowed" }); continue; }
            const ve = await validateRecordData(schemaName, op.collection, op.data);
            if (ve) { errors.push({ index: i, field: ve.field, message: ve.message }); continue; }
            results.push({ index: i, valid: true, op: "insert", collection: op.collection });
          } else if (op.op === "update") {
            if (!op.id || typeof op.data !== "object" || op.data === null) {
              errors.push({ index: i, field: "id", message: "update op requires id and data" });
              continue;
            }
            const collection = op.collection ?? collectionMap.get(op.id);
            if (!collection) { errors.push({ index: i, field: "collection", message: "collection not found for id" }); continue; }
            const perm = await checkPermissionV2(schemaName, collection, "update", req, reply);
            if (!perm.allowed) { errors.push({ index: i, field: "permission", message: "not allowed" }); continue; }
            const ve = await validateRecordData(schemaName, collection, op.data, { recordId: op.id, partial: true });
            if (ve) { errors.push({ index: i, field: ve.field, message: ve.message }); continue; }
            results.push({ index: i, valid: true, op: "update", id: op.id });
          } else if (op.op === "delete") {
            if (!op.id) { errors.push({ index: i, field: "id", message: "delete op requires id" }); continue; }
            const collection = op.collection ?? collectionMap.get(op.id);
            if (!collection) { errors.push({ index: i, field: "collection", message: "collection not found for id" }); continue; }
            const perm = await checkPermissionV2(schemaName, collection, "delete", req, reply);
            if (!perm.allowed) { errors.push({ index: i, field: "permission", message: "not allowed" }); continue; }
            results.push({ index: i, valid: true, op: "delete", id: op.id });
          } else {
            errors.push({ index: i, field: "op", message: `Unknown op: ${op.op}` });
          }
        } catch (err) {
          errors.push({ index: i, field: "_", message: err.message });
        }
      }
      return { dry_run: true, valid: results.length, invalid: errors.length, errors };
    }

    // ── ATOMIC: single transaction, rollback on any error ─────────────────
    const client = await db.connect();
    const results = [];

    try {
      if (isAtomic) await client.query("BEGIN");

      for (const op of operations) {
        if (op.op === "insert") {
          const { collection, data } = op;
          if (!collection || typeof data !== "object" || data === null) {
            if (isAtomic) { await client.query("ROLLBACK"); }
            return reply.code(400).send({ error: "insert op requires collection and data", code: "GEN_002" });
          }
          const perm = await checkPermissionV2(schemaName, collection, "create", req, reply);
          if (!perm.allowed) { if (isAtomic) { await client.query("ROLLBACK"); } return; }

          const ve = await validateRecordData(schemaName, collection, data);
          if (ve) { if (isAtomic) { await client.query("ROLLBACK"); } return reply.code(422).send({ error: ve.message, field: ve.field, code: "DATA_005" }); }

          const { rows } = await client.query(
            `INSERT INTO ${schema}._records (collection, data) VALUES ($1, $2) RETURNING *`,
            [collection, JSON.stringify(data)]
          );
          results.push({ ok: true, record: rows[0] });
          emitProjectEvent(projectId, { type: "record.created", collection, record: rows[0] }).catch(() => {});
          enqueueWebhook(schemaName, collection, "record.created", { record: rows[0] });
          enqueueTrigger(schemaName, collection, "record.created", rows[0]);

          const sv = await buildSearchVectorUpdate(schemaName, collection, rows[0].id, data);
          if (sv) await client.query(sv.sql, sv.params).catch(() => {});

        } else if (op.op === "update") {
          const { id, data, merge } = op;
          if (!id || typeof data !== "object" || data === null) {
            if (isAtomic) { await client.query("ROLLBACK"); }
            return reply.code(400).send({ error: "update op requires id and data", code: "GEN_002" });
          }
          const collection = op.collection ?? collectionMap.get(id);
          if (!collection) {
            if (isAtomic) { await client.query("ROLLBACK"); }
            return apiError(reply, "DATA_001");
          }
          const perm = await checkPermissionV2(schemaName, collection, "update", req, reply);
          if (!perm.allowed) { if (isAtomic) { await client.query("ROLLBACK"); } return; }

          const ve = await validateRecordData(schemaName, collection, data, { recordId: id, partial: true });
          if (ve) { if (isAtomic) { await client.query("ROLLBACK"); } return reply.code(422).send({ error: ve.message, field: ve.field, code: "DATA_005" }); }

          const dataExpr = (merge !== false) ? `data || $1::jsonb` : `$1::jsonb`;
          const params   = [JSON.stringify(data), id];
          let rlsWhere   = "";
          if (perm.filterSql) {
            let rlsIdx = params.length;
            params.push(...perm.filterValues);
            rlsWhere = ` AND ${perm.filterSql.replace(/\$\?/g, () => `$${++rlsIdx}`)}`;
          }
          const { rows } = await client.query(
            `UPDATE ${schema}._records SET data = ${dataExpr}, updated_at = NOW() WHERE id = $2 ${rlsWhere} RETURNING *`,
            params
          );
          if (!rows[0]) {
            if (isAtomic) { await client.query("ROLLBACK"); return reply.code(404).send({ error: `Record ${id} not found or forbidden`, code: "DATA_001" }); }
            results.push({ ok: false, error: `Record ${id} not found or forbidden` });
          } else {
            results.push({ ok: true, record: rows[0] });
            emitProjectEvent(projectId, { type: "record.updated", collection: rows[0].collection, record: rows[0] }).catch(() => {});
            enqueueWebhook(schemaName, rows[0].collection, "record.updated", { record: rows[0] });
            enqueueTrigger(schemaName, rows[0].collection, "record.updated", rows[0]);

            const sv = await buildSearchVectorUpdate(schemaName, collection, rows[0].id, data);
            if (sv) await client.query(sv.sql, sv.params).catch(() => {});
          }

        } else if (op.op === "delete") {
          const { id } = op;
          if (!id) {
            if (isAtomic) { await client.query("ROLLBACK"); }
            return reply.code(400).send({ error: "delete op requires id", code: "GEN_002" });
          }
          const collection = op.collection ?? collectionMap.get(id);
          if (!collection) {
            if (isAtomic) { await client.query("ROLLBACK"); }
            return apiError(reply, "DATA_001");
          }
          const perm = await checkPermissionV2(schemaName, collection, "delete", req, reply);
          if (!perm.allowed) { if (isAtomic) { await client.query("ROLLBACK"); } return; }

          const params = [id];
          let rlsWhere = "";
          if (perm.filterSql) {
            let rlsIdx = params.length;
            params.push(...perm.filterValues);
            rlsWhere = ` AND ${perm.filterSql.replace(/\$\?/g, () => `$${++rlsIdx}`)}`;
          }
          const { rows } = await client.query(
            `DELETE FROM ${schema}._records WHERE id = $1 ${rlsWhere} RETURNING id, collection`, params
          );
          if (!rows[0]) {
            if (isAtomic) { await client.query("ROLLBACK"); return reply.code(404).send({ error: `Record ${id} not found or forbidden`, code: "DATA_001" }); }
            results.push({ ok: false, error: `Record ${id} not found or forbidden` });
          } else {
            results.push({ ok: true, recordId: rows[0].id });
            emitProjectEvent(projectId, { type: "record.deleted", collection: rows[0].collection, recordId: rows[0].id }).catch(() => {});
            enqueueWebhook(schemaName, rows[0].collection, "record.deleted", { recordId: rows[0].id });
            enqueueTrigger(schemaName, rows[0].collection, "record.deleted", rows[0]);
          }

        } else {
          if (isAtomic) { await client.query("ROLLBACK"); }
          return reply.code(400).send({ error: `Unknown op: ${op.op}`, code: "GEN_002" });
        }
      }

      if (isAtomic) await client.query("COMMIT");
      return isAtomic ? { ok: true, inserted: results.filter(r => r.ok).length, atomic: true } : { results };

    } catch (err) {
      if (isAtomic) await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  };

  projectRoute(fastify, "POST", "/batch", {
    preHandler: flexAuth,
    schema: {
      body: {
        type: "object",
        required: ["operations"],
        additionalProperties: false,
        properties: {
          operations: {
            type: "array",
            maxItems: MAX_OPS,
            items: {
              type: "object",
              required: ["op"],
              properties: {
                op:         { type: "string", enum: ["insert", "update", "delete"] },
                collection: { type: "string" },
                id:         { type: "string" },
                data:       { type: "object" },
                merge:      { type: "boolean" },
              },
            },
          },
        },
      },
    },
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, handler);
};
