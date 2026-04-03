const {
  db,
  flexAuth,
  checkPermission,
  quoteIdent,
  projectRoute
} = require("../../../lib/matecito");

const { emitProjectEvent } = require("../../../lib/realtime");
const { fireWebhooks } = require("../../../lib/webhooks");

const SAFE_KEY = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

function castValue(type, value) {
  if (value === null || value === undefined) return null;

  switch (type) {
    case "number":
      const num = Number(value);
      if (isNaN(num)) throw new Error("Invalid number");
      return num;

    case "boolean":
      if (value === "true" || value === true) return true;
      if (value === "false" || value === false) return false;
      throw new Error("Invalid boolean");

    case "date":
      const d = new Date(value);
      if (isNaN(d.getTime())) throw new Error("Invalid date");
      return d.toISOString();

    case "json":
      return value;

    case "text":
    default:
      return String(value);
  }
}

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    try {
      const project = req.resolvedProject;
      const projectId = project?.id ?? req.params?.projectId;

      let { collection, data, expires_at } = req.body;

      if (!collection) {
        return reply.code(400).send({ error: "Collection required" });
      }

      if (typeof data !== "object" || Array.isArray(data)) {
        return reply.code(400).send({ error: "data must be an object" });
      }

      // ─── expires_at ─────────────────────────────

      let expiresAt = null;
      if (expires_at) {
        expiresAt = new Date(expires_at);
        if (isNaN(expiresAt.getTime())) {
          return reply.code(400).send({ error: "expires_at must be valid ISO date" });
        }
        if (expiresAt <= new Date()) {
          return reply.code(400).send({ error: "expires_at must be in the future" });
        }
      }

      // ─── schema ─────────────────────────────

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

      // ─── permisos ─────────────────────────────

      const perm = await checkPermission(schemaName, collection, "create", req, reply);
      if (!perm.allowed) return;

      const schema = quoteIdent(schemaName);

      // ─── validar colección ─────────────────────

      const colExists = await db.query(
        `SELECT 1 FROM ${schema}._collections WHERE name = $1 LIMIT 1`,
        [collection]
      );

      if (!colExists.rows[0]) {
        return reply.code(404).send({ error: `Collection '${collection}' not found` });
      }

      // ─── obtener fields ─────────────────────

      const fieldsRes = await db.query(
        `SELECT name, type, required FROM ${schema}._fields WHERE collection = $1`,
        [collection]
      );

      const fieldsMap = new Map();
      for (const f of fieldsRes.rows) {
        fieldsMap.set(f.name, f);
      }

      // ─── validar + castear data ─────────────

      const cleanData = {};

      for (const [key, value] of Object.entries(data)) {
        if (!SAFE_KEY.test(key)) continue;

        const field = fieldsMap.get(key);

        // campo no definido → ignorar (o podrías rechazar)
        if (!field) continue;

        try {
          cleanData[key] = castValue(field.type, value);
        } catch (err) {
          return reply.code(400).send({
            error: `Invalid value for field '${key}': ${err.message}`
          });
        }
      }

      // ─── required fields ─────────────────────

      for (const field of fieldsRes.rows) {
        if (field.required && cleanData[field.name] == null) {
          return reply.code(400).send({
            error: `Field '${field.name}' is required`
          });
        }
      }

      // ─── metadata automática ────────────────

      if (req.projectUser?.id) {
        cleanData.created_by = req.projectUser.id;
      }

      cleanData.created_at = new Date().toISOString();

      // ─── insert ─────────────────────────────

      const result = await db.query(
        `INSERT INTO ${schema}._records (collection, data, expires_at)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [collection, cleanData, expiresAt]
      );

      const record = result.rows[0];

      // ─── realtime + webhooks ───────────────

      emitProjectEvent(projectId, {
        type: "record.created",
        projectId,
        collection,
        record
      });

      fireWebhooks(schemaName, collection, "record.created", { record }).catch(() => {});

      return reply.code(201).send({ record });

    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: "Internal server error" });
    }
  };

  projectRoute(
    fastify,
    "POST",
    "/records",
    {
      preHandler: flexAuth,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    handler
  );
};
