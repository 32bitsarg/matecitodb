const {
  db,
  requireProjectOrPlatformAuth,
  quoteIdent,
  projectRoute,
  getProjectKeyContext,
} = require("../../../../lib/v2/auth");
const { apiError } = require("../../../../lib/v2/errors");

const SAFE_KEY    = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const VALID_TYPES = new Set(["text", "number", "boolean", "date", "json", "relation"]);

async function requireJwtOrServiceKey(req, reply) {
  const rawKey    = req.headers["x-matecito-key"];
  const projectId = req.params?.projectId ?? req.resolvedProject?.id;
  if (rawKey && projectId) {
    const ctx = await getProjectKeyContext(projectId, rawKey, ["service"]).catch(() => null);
    if (ctx) return;
  }
  return requireProjectOrPlatformAuth(req, reply);
}

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    const name        = String(req.body?.collection || req.body?.name || "").trim();
    const fields      = Array.isArray(req.body?.fields) ? req.body.fields : [];
    const soft_delete = Boolean(req.body?.soft_delete ?? false);

    if (!name) return reply.code(400).send({ error: "name is required", code: "GEN_002" });
    if (!SAFE_KEY.test(name)) return reply.code(400).send({ error: "Invalid collection name", code: "GEN_002" });

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const schema = quoteIdent(schemaName);

    const exists = await db.query(
      `SELECT 1 FROM ${schema}._collections WHERE name = $1 LIMIT 1`, [name]
    );
    if (exists.rows[0]) return reply.code(409).send({ error: "Collection already exists", code: "GEN_004" });

    const client = await db.connect();

    try {
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO ${schema}._collections (name, soft_delete) VALUES ($1, $2)`, [name, soft_delete]
      );

      const seen = new Set();
      for (const f of fields) {
        const fname    = String(f.name || "").trim();
        const ftype    = String(f.type || "text").trim();
        const required = Boolean(f.required);

        if (!SAFE_KEY.test(fname)) throw new Error(`Invalid field name '${fname}'`);
        if (!VALID_TYPES.has(ftype)) throw new Error(`Invalid type '${ftype}'`);
        if (seen.has(fname)) throw new Error(`Duplicate field '${fname}'`);
        seen.add(fname);

        await client.query(
          `INSERT INTO ${schema}._fields (collection, name, type, required) VALUES ($1, $2, $3, $4)`,
          [name, fname, ftype, required]
        );
      }

      // Default permissions
      for (const op of ["list", "get", "create", "update", "delete"]) {
        await client.query(
          `INSERT INTO ${schema}._permissions (collection, operation, access) VALUES ($1, $2, 'auth')`,
          [name, op]
        );
      }

      await client.query("COMMIT");

      return reply.code(201).send({ ok: true, collection: { name, soft_delete, fields } });

    } catch (err) {
      await client.query("ROLLBACK");
      return reply.code(400).send({ error: err.message || "Failed to create collection", code: "GEN_004" });
    } finally {
      client.release();
    }
  };

  projectRoute(fastify, "POST", "/collections", {
    preHandler: requireJwtOrServiceKey,
    schema: {
      body: {
        type: "object",
        required: ["name"],
        additionalProperties: false,
        properties: {
          name:        { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-zA-Z_][a-zA-Z0-9_]*$" },
          collection:  { type: "string" },
          soft_delete: { type: "boolean", default: false },
          fields: {
            type: "array",
            items: {
              type: "object",
              required: ["name"],
              properties: {
                name:     { type: "string" },
                type:     { type: "string", default: "text" },
                required: { type: "boolean", default: false },
              },
            },
          },
        },
      },
    },
  }, handler);
};
