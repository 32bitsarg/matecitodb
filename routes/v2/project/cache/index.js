// ─── Cache Rules (Q1) ──────────────────────────────────────────────────────
//
// GET    /cache/rules          → listar
// POST   /cache/rules          → crear
// DELETE /cache/rules/:id      → eliminar
// POST   /cache/rules/:id/purge → invalidar
// GET    /cache/stats          → estadísticas

const { db, requireProjectOrPlatformAuth, flexAuth, quoteIdent, projectRoute } = require("../../../../lib/v2/auth");
const { ensureV2Tables } = require("../../../../lib/v2/schema");
const { apiError }       = require("../../../../lib/v2/errors");
const cache              = require("../../../../lib/v2/response-cache");

module.exports = async function (fastify) {
  fastify.get("/cache/rules", { preHandler: flexAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const { rows } = await db.query(`SELECT * FROM ${quoteIdent(schemaName)}._cache_rules ORDER BY created_at DESC`);
    return { rules: rows };
  });

  fastify.post("/cache/rules", { preHandler: requireProjectOrPlatformAuth, schema: { body: { type: "object", required: ["collection", "ttl_seconds"], properties: { collection: { type: "string" }, ttl_seconds: { type: "integer" }, vary_by: { type: "array" } } } } }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { collection, ttl_seconds, vary_by } = req.body;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const { rows } = await db.query(`INSERT INTO ${quoteIdent(schemaName)}._cache_rules (collection, ttl_seconds, vary_by) VALUES ($1,$2,$3) RETURNING *`, [collection, ttl_seconds, JSON.stringify(vary_by || [])]);
    return reply.code(201).send({ rule: rows[0] });
  });

  fastify.delete("/cache/rules/:id", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { id } = req.params;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const { rows: rules } = await db.query(`SELECT collection FROM ${quoteIdent(schemaName)}._cache_rules WHERE id=$1`, [id]);
    if (!rules[0]) return apiError(reply, "GEN_003");
    await db.query(`DELETE FROM ${quoteIdent(schemaName)}._cache_rules WHERE id=$1`, [id]);
    await cache.purgeCollection(schemaName, rules[0].collection);
    return { deleted: id };
  });

  fastify.post("/cache/rules/:id/purge", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { id } = req.params;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const { rows: rules } = await db.query(`SELECT collection FROM ${quoteIdent(schemaName)}._cache_rules WHERE id=$1`, [id]);
    if (!rules[0]) return apiError(reply, "GEN_003");
    await cache.purgeCollection(schemaName, rules[0].collection);
    return { purged: rules[0].collection };
  });

  fastify.get("/cache/stats", { preHandler: flexAuth }, async (req, reply) => cache.getStats());
};
