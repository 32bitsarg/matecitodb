// ─── Collection Aliases (Q4) ───────────────────────────────────────────────
//
// GET    /collections/:name/aliases
// POST   /collections/:name/aliases
// DELETE /collections/:name/aliases/:alias

const { db, flexAuth, requireProjectOrPlatformAuth, quoteIdent, projectRoute } = require("../../../../lib/v2/auth");
const { ensureV2Tables } = require("../../../../lib/v2/schema");
const { apiError }       = require("../../../../lib/v2/errors");

module.exports = async function (fastify) {
  fastify.get("/collections/:name/aliases", { preHandler: flexAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { name } = req.params;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const { rows } = await db.query(`SELECT * FROM ${quoteIdent(schemaName)}._collection_aliases WHERE collection = $1 ORDER BY created_at DESC`, [name]);
    return { collection: name, aliases: rows };
  });

  fastify.post("/collections/:name/aliases", { preHandler: requireProjectOrPlatformAuth, schema: { body: { type: "object", required: ["alias"], properties: { alias: { type: "string" }, expires_at: { type: "string" } } } } }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { name } = req.params;
    const { alias, expires_at } = req.body;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const schema = quoteIdent(schemaName);
    const { rows } = await db.query(`INSERT INTO ${schema}._collection_aliases (alias, collection, expires_at) VALUES ($1, $2, $3) RETURNING *`, [alias, name, expires_at || null]);
    return reply.code(201).send({ alias: rows[0] });
  });

  fastify.delete("/collections/:name/aliases/:alias", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { name, alias } = req.params;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const { rowCount } = await db.query(`DELETE FROM ${quoteIdent(schemaName)}._collection_aliases WHERE alias = $1`, [alias]);
    if (!rowCount) return apiError(reply, "GEN_003");
    return { deleted: alias };
  });
};
