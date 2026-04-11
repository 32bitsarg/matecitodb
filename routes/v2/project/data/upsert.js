const {
  db,
  flexAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { checkPermissionV2 }  = require("../../../../lib/v2/permissions");
const { emitProjectEvent }   = require("../../../../lib/v2/realtime");
const { enqueueWebhook, enqueueTrigger }     = require("../../../../lib/v2/queue");
const { apiError }           = require("../../../../lib/v2/errors");
const { validateRecordData } = require("../../../../lib/v2/field-validator");
const { buildSearchVectorUpdate } = require("../../../../lib/v2/fulltext");

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    const { collection, data, onConflict, expires_at } = req.body ?? {};

    if (!collection || !data || typeof data !== "object" || !onConflict) {
      return reply.code(400).send({ error: "collection, data, and onConflict are required", code: "GEN_002" });
    }

    const conflictFields = Array.isArray(onConflict) ? onConflict : [onConflict];
    for (const field of conflictFields) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) {
        return reply.code(400).send({ error: `onConflict field name '${field}' is invalid`, code: "GEN_002" });
      }
    }

    let expiresAt = null;
    if (expires_at) {
      expiresAt = new Date(expires_at);
      if (isNaN(expiresAt.getTime())) return reply.code(400).send({ error: "expires_at must be a valid ISO date", code: "GEN_002" });
    }

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const schema = quoteIdent(schemaName);

    const colExists = await db.query(
      `SELECT 1 FROM ${schema}._collections WHERE name = $1 LIMIT 1`, [collection]
    );
    if (!colExists.rows[0]) return apiError(reply, "GEN_003", `Collection '${collection}' not found`);

    const lookupWhere  = [];
    const lookupValues = [collection];
    for (const field of conflictFields) {
      const val = data[field];
      if (val === undefined) return reply.code(400).send({ error: `onConflict field '${field}' not found in data`, code: "GEN_002" });
      lookupValues.push(String(val));
      lookupWhere.push(`data->>'${field}' = $${lookupValues.length}`);
    }

    const existing = await db.query(
      `SELECT id FROM ${schema}._records WHERE collection = $1 AND deleted_at IS NULL AND ${lookupWhere.join(" AND ")} LIMIT 1`,
      lookupValues
    );

    let record, eventType;

    // Validate data
    const validationError = await validateRecordData(schemaName, collection, data, {
      recordId: existing.rows[0]?.id,
      partial:  !!existing.rows[0],
    });
    if (validationError) {
      return reply.code(422).send({ error: validationError.message, field: validationError.field, code: "DATA_005" });
    }

    if (existing.rows[0]) {
      const perm = await checkPermissionV2(schemaName, collection, "update", req, reply);
      if (!perm.allowed) return;

      const { rows } = await db.query(
        `UPDATE ${schema}._records
         SET data = data || $1::jsonb, updated_at = NOW() ${expiresAt ? ", expires_at = $3" : ""}
         WHERE id = $2 RETURNING *`,
        expiresAt ? [data, existing.rows[0].id, expiresAt] : [data, existing.rows[0].id]
      );
      record    = rows[0];
      eventType = "record.updated";
    } else {
      const perm = await checkPermissionV2(schemaName, collection, "create", req, reply);
      if (!perm.allowed) return;

      const { rows } = await db.query(
        `INSERT INTO ${schema}._records (collection, data, expires_at) VALUES ($1, $2, $3) RETURNING *`,
        [collection, data, expiresAt]
      );
      record    = rows[0];
      eventType = "record.created";
    }

    emitProjectEvent(projectId, { type: eventType, projectId, collection, record }).catch(() => {});
    enqueueWebhook(schemaName, collection, eventType, { record });

    // Update search_vector if collection has search_fields configured
    const searchUpdate = await buildSearchVectorUpdate(schemaName, collection, record.id, data);
    if (searchUpdate) {
      await db.query(searchUpdate.sql, searchUpdate.params).catch(() => {});
    }

    // Fire triggers
    enqueueTrigger(schemaName, collection, eventType, record);

    return reply.code(existing.rows[0] ? 200 : 201).send({ record, upserted: !existing.rows[0] });
  };

  projectRoute(fastify, "POST", "/records/upsert", {
    preHandler: flexAuth,
    schema: {
      body: {
        type: "object",
        required: ["collection", "data", "onConflict"],
        additionalProperties: false,
        properties: {
          collection:  { type: "string" },
          data:        { type: "object" },
          onConflict:  {},
          expires_at:  { type: "string" },
        },
      },
    },
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, handler);
};
