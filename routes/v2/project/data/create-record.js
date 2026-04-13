const {
  db,
  flexAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { checkPermissionV2 }   = require("../../../../lib/v2/permissions");
const { emitProjectEvent }    = require("../../../../lib/v2/realtime");
const { enqueueWebhook, enqueueAuditLog, enqueueTrigger } = require("../../../../lib/v2/queue");
const { apiError }            = require("../../../../lib/v2/errors");
const { validateRecordData }  = require("../../../../lib/v2/field-validator");
const { buildSearchVectorUpdate } = require("../../../../lib/v2/fulltext");

const SAFE_KEY = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

function castValue(type, value) {
  if (value === null || value === undefined) return null;
  switch (type) {
    case "number": {
      const num = Number(value);
      if (isNaN(num)) throw new Error("Invalid number");
      return num;
    }
    case "boolean":
      if (value === "true"  || value === true)  return true;
      if (value === "false" || value === false) return false;
      throw new Error("Invalid boolean");
    case "date": {
      const d = new Date(value);
      if (isNaN(d.getTime())) throw new Error("Invalid date");
      return d.toISOString();
    }
    case "json":    return value;
    case "text":
    default:        return String(value);
  }
}

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    const { collection, data, expires_at } = req.body;

    let expiresAt = null;
    if (expires_at) {
      expiresAt = new Date(expires_at);
      if (isNaN(expiresAt.getTime())) return reply.code(400).send({ error: "expires_at must be valid ISO date", code: "GEN_002" });
      if (expiresAt <= new Date())    return reply.code(400).send({ error: "expires_at must be in the future", code: "GEN_002" });
    }

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const perm = await checkPermissionV2(schemaName, collection, "create", req, reply);
    if (!perm.allowed) return;

    const schema = quoteIdent(schemaName);

    const colExists = await db.query(
      `SELECT 1 FROM ${schema}._collections WHERE name = $1 LIMIT 1`, [collection]
    );
    if (!colExists.rows[0]) return apiError(reply, "GEN_003", `Collection '${collection}' not found`);

    const { rows: fieldRows } = await db.query(
      `SELECT name, type, required FROM ${schema}._fields WHERE collection = $1`, [collection]
    );
    const fieldsMap = new Map(fieldRows.map(f => [f.name, f]));

    // ── Auto-detect campos nuevos ─────────────────────────────────────────────
    function inferType(value) {
      if (value === null || value === undefined) return "text";
      if (typeof value === "boolean") return "bool";
      if (typeof value === "number")  return "number";
      if (typeof value === "object")  return "json";
      if (typeof value === "string") {
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return "email";
        if (/^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]+)?$/.test(value)) return "date";
      }
      return "text";
    }

    const newFields = [];
    for (const [key, value] of Object.entries(data)) {
      if (!SAFE_KEY.test(key) || fieldsMap.has(key)) continue;
      const type = inferType(value);
      newFields.push({ name: key, type });
    }

    if (newFields.length > 0) {
      const placeholders = newFields.map((_, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3})`).join(", ");
      const params = [collection];
      for (const f of newFields) {
        params.push(f.name, f.type);
        fieldsMap.set(f.name, { name: f.name, type: f.type, required: false });
      }
      await db.query(
        `INSERT INTO ${schema}._fields (collection, name, type) VALUES ${placeholders} ON CONFLICT (collection, name) DO NOTHING`,
        params
      );
    }

    // ── Castear + validar ─────────────────────────────────────────────────────
    const cleanData = {};
    for (const [key, value] of Object.entries(data)) {
      if (!SAFE_KEY.test(key)) continue;
      const field = fieldsMap.get(key);
      if (!field) continue;
      try {
        cleanData[key] = castValue(field.type, value);
      } catch (err) {
        return reply.code(400).send({ error: `Invalid value for field '${key}': ${err.message}`, code: "GEN_002" });
      }
    }

    // Full field validation (type, constraints, unique, relations)
    const validationError = await validateRecordData(schemaName, collection, cleanData);
    if (validationError) {
      return reply.code(422).send({ error: validationError.message, field: validationError.field, code: "DATA_005" });
    }

    if (req.projectUser?.id) cleanData.created_by = req.projectUser.id;
    cleanData.created_at = new Date().toISOString();

    const { rows } = await db.query(
      `INSERT INTO ${schema}._records (collection, data, expires_at) VALUES ($1, $2, $3) RETURNING *`,
      [collection, cleanData, expiresAt]
    );

    const { data: rowData, ...rest } = rows[0];
    const record = { ...rest, ...(rowData ?? {}) };

    // Update search_vector if collection has search_fields configured
    const searchUpdate = await buildSearchVectorUpdate(schemaName, collection, record.id, cleanData);
    if (searchUpdate) {
      await db.query(searchUpdate.sql, searchUpdate.params).catch(() => {});
    }

    emitProjectEvent(projectId, { type: "record.created", projectId, collection, record }).catch(() => {});
    enqueueWebhook(schemaName, collection, "record.created", { record });
    enqueueAuditLog(schemaName, { action: "record.created", entity: collection, entityId: record.id, newValue: record.data, performedBy: req.projectUser?.id, ip: req.ip });
    enqueueTrigger(schemaName, collection, "record.created", record);

    return reply.code(201).send({ record });
  };

  projectRoute(fastify, "POST", "/records", {
    preHandler: flexAuth,
    schema: {
      body: {
        type: "object",
        required: ["collection", "data"],
        additionalProperties: true,
        properties: {
          collection: { type: "string", minLength: 1, maxLength: 64 },
          data:       { type: "object" },
          expires_at: { type: "string" },
        },
      },
    },
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, handler);
};
