const { db, quoteIdent, projectRoute, checkPermission, flexAuth } = require("../../../lib/matecito");
const { emitProjectEvent } = require("../../../lib/realtime");

const MAX_OPS = 50;

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    const { operations } = req.body ?? {};

    if (!Array.isArray(operations) || operations.length === 0) {
      return reply.code(400).send({ error: "operations must be a non-empty array" });
    }

    if (operations.length > MAX_OPS) {
      return reply.code(400).send({ error: `Max ${MAX_OPS} operations per batch` });
    }

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

    // Pre-cargar collections para ops que no la incluyen (evita N+1)
    const missingCollectionIds = operations
      .filter(op => (op.op === "update" || op.op === "delete") && !op.collection && op.id)
      .map(op => op.id);

    const collectionMap = new Map();
    if (missingCollectionIds.length > 0) {
      const lookup = await db.query(
        `SELECT id, collection FROM ${schema}._records WHERE id = ANY($1)`,
        [missingCollectionIds]
      );
      for (const row of lookup.rows) collectionMap.set(row.id, row.collection);
    }

    // Sacar un cliente dedicado del pool para la transacción
    const client = await db.connect();
    const results = [];

    try {
      await client.query("BEGIN");

      for (const op of operations) {
        if (op.op === "insert") {
          const { collection, data } = op;
          if (!collection || typeof data !== "object" || data === null) {
            await client.query("ROLLBACK");
            return reply.code(400).send({ error: "insert op requires collection and data" });
          }

          const perm = await checkPermission(schemaName, collection, "create", req, reply);
          if (!perm.allowed) { await client.query("ROLLBACK"); return; }

          const res = await client.query(
            `INSERT INTO ${schema}._records (collection, data) VALUES ($1, $2) RETURNING *`,
            [collection, JSON.stringify(data)]
          );
          const record = res.rows[0];
          results.push({ ok: true, record });
          emitProjectEvent(projectId, { type: "record.created", collection, record });

        } else if (op.op === "update") {
          const { id, data, merge } = op;
          if (!id || typeof data !== "object" || data === null) {
            await client.query("ROLLBACK");
            return reply.code(400).send({ error: "update op requires id and data" });
          }

          let collection = op.collection ?? collectionMap.get(id);

          if (!collection) {
            await client.query("ROLLBACK");
            return reply.code(404).send({ error: `Record ${id} not found` });
          }

          const perm = await checkPermission(schemaName, collection, "update", req, reply);
          if (!perm.allowed) { await client.query("ROLLBACK"); return; }

          const dataExpr = merge ? `data || $1::jsonb` : `$1::jsonb`;
          const params = [JSON.stringify(data), id];
          let rlsWhere = "";
          if (perm.filterSql) {
            let rlsIdx = params.length;
            params.push(...perm.filterValues);
            rlsWhere = ` AND ${perm.filterSql.replace(/\$\?/g, () => `$${++rlsIdx}`)}`;
          }
          const res = await client.query(
            `UPDATE ${schema}._records SET data = ${dataExpr}, updated_at = NOW() WHERE id = $2${rlsWhere} RETURNING *`,
            params
          );

          if (res.rows.length === 0) {
            results.push({ ok: false, error: `Record ${id} not found` });
          } else {
            const record = res.rows[0];
            results.push({ ok: true, record });
            emitProjectEvent(projectId, { type: "record.updated", collection: record.collection, record });
          }

        } else if (op.op === "delete") {
          const { id } = op;
          if (!id) {
            await client.query("ROLLBACK");
            return reply.code(400).send({ error: "delete op requires id" });
          }

          let collection = op.collection ?? collectionMap.get(id);

          if (!collection) {
            await client.query("ROLLBACK");
            return reply.code(404).send({ error: `Record ${id} not found` });
          }

          const perm = await checkPermission(schemaName, collection, "delete", req, reply);
          if (!perm.allowed) { await client.query("ROLLBACK"); return; }

          const delParams = [id];
          let rlsWhere = "";
          if (perm.filterSql) {
            let rlsIdx = delParams.length;
            delParams.push(...perm.filterValues);
            rlsWhere = ` AND ${perm.filterSql.replace(/\$\?/g, () => `$${++rlsIdx}`)}`;
          }
          const res = await client.query(
            `DELETE FROM ${schema}._records WHERE id = $1${rlsWhere} RETURNING id, collection`, delParams
          );

          if (res.rows.length === 0) {
            results.push({ ok: false, error: `Record ${id} not found` });
          } else {
            const deleted = res.rows[0];
            results.push({ ok: true, recordId: deleted.id });
            emitProjectEvent(projectId, { type: "record.deleted", collection: deleted.collection, recordId: deleted.id });
          }

        } else {
          await client.query("ROLLBACK");
          return reply.code(400).send({ error: `Unknown op: ${op.op}` });
        }
      }

      await client.query("COMMIT");
      return reply.code(200).send({ results });

    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  };

  projectRoute(fastify, "POST", "/batch", {
    preHandler: flexAuth,
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, handler);
};
