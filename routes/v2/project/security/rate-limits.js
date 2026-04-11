// ─── Rate Limit Rules (Q3) ─────────────────────────────────────────────────
//
// GET    /security/rate-limits    → listar
// POST   /security/rate-limits    → crear
// DELETE /security/rate-limits/:id → eliminar

const { db, requireProjectOrPlatformAuth, flexAuth, quoteIdent, projectRoute } = require("../../../../lib/v2/auth");
const { ensureV2Tables } = require("../../../../lib/v2/schema");
const { apiError }       = require("../../../../lib/v2/errors");

module.exports = async function (fastify) {
  fastify.get("/security/rate-limits", { preHandler: flexAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const { rows } = await db.query(`SELECT * FROM ${quoteIdent(schemaName)}._rate_limit_rules ORDER BY created_at DESC`);
    return { rules: rows };
  });

  fastify.post("/security/rate-limits", { preHandler: requireProjectOrPlatformAuth, schema: { body: { type: "object", required: ["path", "max", "window_ms"], properties: { path: { type: "string" }, collection: { type: "string" }, max: { type: "integer" }, window_ms: { type: "integer" }, key_by: { type: "string" } } } } }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { path, collection, max, window_ms, key_by = "ip" } = req.body;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const { rows } = await db.query(`INSERT INTO ${quoteIdent(schemaName)}._rate_limit_rules (path, collection, max, window_ms, key_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [path, collection || null, max, window_ms, key_by]);
    return reply.code(201).send({ rule: rows[0] });
  });

  fastify.delete("/security/rate-limits/:id", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { id } = req.params;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const { rowCount } = await db.query(`DELETE FROM ${quoteIdent(schemaName)}._rate_limit_rules WHERE id=$1`, [id]);
    if (!rowCount) return apiError(reply, "GEN_003");
    return { deleted: id };
  });
};
