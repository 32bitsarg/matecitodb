const { db, flexAuth, checkPermission, quoteIdent, projectRoute } = require("../../../lib/matecito");
const { emitProjectEvent } = require("../../../lib/realtime");
const { fireWebhooks }     = require("../../../lib/webhooks");

/**
 * POST /records/upsert
 * Body: { collection, data, onConflict: "fieldName" | ["field1","field2"], expires_at? }
 *
 * Si ya existe un registro con data->>'fieldName' = value → UPDATE (merge)
 * Si no → INSERT
 */
module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    const { collection, data, onConflict, expires_at } = req.body ?? {};

    if (!collection)  return reply.code(400).send({ error: "collection is required" });
    if (!data || typeof data !== "object") return reply.code(400).send({ error: "data must be an object" });
    if (!onConflict)  return reply.code(400).send({ error: "onConflict field is required" });

    const conflictFields = Array.isArray(onConflict) ? onConflict : [onConflict];
    for (const field of conflictFields) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) {
        return reply.code(400).send({ error: `onConflict field name '${field}' is invalid` });
      }
    }

    let expiresAt = null;
    if (expires_at) {
      expiresAt = new Date(expires_at);
      if (isNaN(expiresAt.getTime())) return reply.code(400).send({ error: "expires_at must be a valid ISO date" });
    }

    const schemaName = project?.schema_name ?? await (async () => {
      const res = await db.query(`SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]);
      return res.rows[0]?.schema_name;
    })();

    if (!schemaName) return reply.code(404).send({ error: "Project not found" });

    const schema = quoteIdent(schemaName);

    const colExists = await db.query(`SELECT 1 FROM ${schema}._collections WHERE name = $1 LIMIT 1`, [collection]);
    if (!colExists.rows[0]) return reply.code(404).send({ error: `Collection '${collection}' not found` });

    // Build lookup condition from conflict fields
    const lookupWhere = [];
    const lookupValues = [collection];
    for (const field of conflictFields) {
      const val = data[field];
      if (val === undefined) return reply.code(400).send({ error: `onConflict field '${field}' not found in data` });
      lookupValues.push(String(val));
      lookupWhere.push(`data->>'${field}' = $${lookupValues.length}`);
    }

    const existing = await db.query(
      `SELECT id FROM ${schema}._records WHERE collection = $1 AND deleted_at IS NULL AND ${lookupWhere.join(" AND ")} LIMIT 1`,
      lookupValues
    );

    let record;
    let eventType;

    if (existing.rows[0]) {
      // UPDATE — check permission
      const perm = await checkPermission(schemaName, collection, "update", req, reply);
      if (!perm.allowed) return;

      const res = await db.query(
        `UPDATE ${schema}._records
         SET data = data || $1::jsonb, updated_at = NOW()${expiresAt ? ", expires_at = $3" : ""}
         WHERE id = $2
         RETURNING *`,
        expiresAt ? [data, existing.rows[0].id, expiresAt] : [data, existing.rows[0].id]
      );
      record    = res.rows[0];
      eventType = "record.updated";
    } else {
      // INSERT — check permission
      const perm = await checkPermission(schemaName, collection, "create", req, reply);
      if (!perm.allowed) return;

      const res = await db.query(
        `INSERT INTO ${schema}._records (collection, data, expires_at) VALUES ($1, $2, $3) RETURNING *`,
        [collection, data, expiresAt]
      );
      record    = res.rows[0];
      eventType = "record.created";
    }

    emitProjectEvent(projectId, { type: eventType, projectId, collection, record });
    fireWebhooks(schemaName, collection, eventType, { record }).catch(() => {});

    return reply.code(existing.rows[0] ? 200 : 201).send({ record, upserted: !existing.rows[0] });
  };

  projectRoute(fastify, "POST", "/records/upsert", {
    preHandler: flexAuth,
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, handler);
};
