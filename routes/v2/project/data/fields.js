const {
  db,
  requireProjectOrPlatformAuth,
  quoteIdent,
  projectRoute,
  getProjectKeyContext,
} = require("../../../../lib/v2/auth");
const { apiError } = require("../../../../lib/v2/errors");

async function requireJwtOrServiceKey(req, reply) {
  const rawKey    = req.headers["x-matecito-key"];
  const projectId = req.params?.projectId ?? req.resolvedProject?.id;
  if (rawKey && projectId) {
    const ctx = await getProjectKeyContext(projectId, rawKey, ["service"]).catch(() => null);
    if (ctx) return;
  }
  return requireProjectOrPlatformAuth(req, reply);
}

async function resolveSchema(req) {
  const project    = req.resolvedProject;
  const projectId  = project?.id ?? req.params?.projectId;
  const schemaName = project?.schema_name ?? (await db.query(
    `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
  )).rows[0]?.schema_name;
  return { schemaName, projectId };
}

module.exports = async function (fastify) {
  // GET /collections/:collection/fields
  projectRoute(fastify, "GET", "/collections/:collection/fields", { preHandler: requireJwtOrServiceKey }, async (req, reply) => {
    const { schemaName } = await resolveSchema(req);
    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const s = quoteIdent(schemaName);
    const { collection } = req.params;

    const { rows } = await db.query(
      `SELECT * FROM ${s}._fields WHERE collection = $1 ORDER BY created_at ASC`, [collection]
    );
    return { fields: rows };
  });

  // POST /collections/:collection/fields
  projectRoute(fastify, "POST", "/collections/:collection/fields", {
    preHandler: requireJwtOrServiceKey,
    schema: {
      body: {
        type: "object",
        required: ["name"],
        additionalProperties: false,
        properties: {
          name:     { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-zA-Z_][a-zA-Z0-9_]*$" },
          type:     { type: "string", enum: ["text", "number", "boolean", "date", "json", "relation"], default: "text" },
          required: { type: "boolean", default: false },
          options:  { type: "object", default: {} },
        },
      },
    },
  }, async (req, reply) => {
    const { schemaName } = await resolveSchema(req);
    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const s = quoteIdent(schemaName);
    const { collection } = req.params;
    const { name, type = "text", required = false, options = {} } = req.body;

    const { rows } = await db.query(
      `INSERT INTO ${s}._fields (collection, name, type, required, options)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [collection, name, type, required, options]
    );
    return reply.code(201).send({ field: rows[0] });
  });

  // PATCH /collections/:collection/fields/:fieldId
  projectRoute(fastify, "PATCH", "/collections/:collection/fields/:fieldId", {
    preHandler: requireJwtOrServiceKey,
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          name:     { type: "string", minLength: 1, maxLength: 64 },
          type:     { type: "string", enum: ["text", "number", "boolean", "date", "json", "relation"] },
          required: { type: "boolean" },
          options:  { type: "object" },
        },
      },
    },
  }, async (req, reply) => {
    const { schemaName } = await resolveSchema(req);
    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const s = quoteIdent(schemaName);
    const { collection, fieldId } = req.params;
    const { name, type, required, options } = req.body ?? {};

    const existing = await db.query(
      `SELECT * FROM ${s}._fields WHERE id = $1 AND collection = $2`, [fieldId, collection]
    );
    if (!existing.rows[0]) return apiError(reply, "GEN_003", "Field not found");

    const { rows } = await db.query(
      `UPDATE ${s}._fields SET
         name     = COALESCE($1, name),
         type     = COALESCE($2, type),
         required = COALESCE($3, required),
         options  = COALESCE($4, options)
       WHERE id = $5 AND collection = $6 RETURNING *`,
      [name ?? null, type ?? null, required ?? null, options ? JSON.stringify(options) : null, fieldId, collection]
    );
    return { field: rows[0] };
  });

  // DELETE /collections/:collection/fields/:fieldId
  projectRoute(fastify, "DELETE", "/collections/:collection/fields/:fieldId", {
    preHandler: requireJwtOrServiceKey,
  }, async (req, reply) => {
    const { schemaName } = await resolveSchema(req);
    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const s = quoteIdent(schemaName);
    const { collection, fieldId } = req.params;

    await db.query(`DELETE FROM ${s}._fields WHERE id = $1 AND collection = $2`, [fieldId, collection]);
    return reply.code(204).send();
  });
};
