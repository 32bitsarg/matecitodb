const { db, requireProjectOrPlatformAuth, quoteIdent, projectRoute, getProjectKeyContext } = require("../../../lib/matecito");

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
  const project = req.resolvedProject;
  const projectId = project?.id ?? req.params?.projectId;
  const schemaName = project?.schema_name ?? (await db.query(
    `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`,
    [projectId]
  )).rows[0]?.schema_name;
  return { schemaName, projectId };
}

module.exports = async function (fastify) {
  // GET /collections/:collection/fields
  projectRoute(fastify, "GET", "/collections/:collection/fields", { preHandler: requireJwtOrServiceKey }, async (req, reply) => {
    const { schemaName } = await resolveSchema(req);
    if (!schemaName) return reply.code(404).send({ error: "Project not found" });

    const s = quoteIdent(schemaName);
    const { collection } = req.params;

    const result = await db.query(
      `SELECT * FROM ${s}._fields WHERE collection = $1 ORDER BY created_at ASC`,
      [collection]
    );
    return { fields: result.rows };
  });

  // POST /collections/:collection/fields
  projectRoute(fastify, "POST", "/collections/:collection/fields", { preHandler: requireJwtOrServiceKey }, async (req, reply) => {
    const { schemaName } = await resolveSchema(req);
    if (!schemaName) return reply.code(404).send({ error: "Project not found" });

    const s = quoteIdent(schemaName);
    const { collection } = req.params;
    const { name, type = "text", required = false, options = {} } = req.body ?? {};

    if (!name) return reply.code(400).send({ error: "name is required" });

    const result = await db.query(
      `INSERT INTO ${s}._fields (collection, name, type, required, options)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [collection, name, type, required, options]
    );
    return reply.code(201).send({ field: result.rows[0] });
  });

  // PATCH /collections/:collection/fields/:fieldId
  projectRoute(fastify, "PATCH", "/collections/:collection/fields/:fieldId", { preHandler: requireJwtOrServiceKey }, async (req, reply) => {
    const { schemaName } = await resolveSchema(req);
    if (!schemaName) return reply.code(404).send({ error: "Project not found" });

    const s = quoteIdent(schemaName);
    const { collection, fieldId } = req.params;
    const { name, type, required, options } = req.body ?? {};

    const existing = await db.query(
      `SELECT * FROM ${s}._fields WHERE id = $1 AND collection = $2`,
      [fieldId, collection]
    );
    if (!existing.rows[0]) return reply.code(404).send({ error: "Field not found" });

    const updated = await db.query(
      `UPDATE ${s}._fields SET
        name     = COALESCE($1, name),
        type     = COALESCE($2, type),
        required = COALESCE($3, required),
        options  = COALESCE($4, options)
       WHERE id = $5 AND collection = $6
       RETURNING *`,
      [name ?? null, type ?? null, required ?? null, options ? JSON.stringify(options) : null, fieldId, collection]
    );
    return { field: updated.rows[0] };
  });

  // DELETE /collections/:collection/fields/:fieldId
  projectRoute(fastify, "DELETE", "/collections/:collection/fields/:fieldId", { preHandler: requireJwtOrServiceKey }, async (req, reply) => {
    const { schemaName } = await resolveSchema(req);
    if (!schemaName) return reply.code(404).send({ error: "Project not found" });

    const s = quoteIdent(schemaName);
    const { collection, fieldId } = req.params;

    await db.query(
      `DELETE FROM ${s}._fields WHERE id = $1 AND collection = $2`,
      [fieldId, collection]
    );
    return reply.code(204).send();
  });
};
