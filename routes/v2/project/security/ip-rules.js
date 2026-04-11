// ─── IP Rules (Q2) ─────────────────────────────────────────────────────────
//
// GET    /security/ip-rules        → listar
// POST   /security/ip-rules        → crear
// DELETE /security/ip-rules/:id    → eliminar
// PATCH  /security/ip-rules/:id    → activar/desactivar
// POST   /security/ip-rules/test   → testear IP

const { db, requireProjectOrPlatformAuth, flexAuth, quoteIdent, projectRoute } = require("../../../../lib/v2/auth");
const { ensureV2Tables } = require("../../../../lib/v2/schema");
const { apiError }       = require("../../../../lib/v2/errors");
const { evaluateIP, invalidateCache } = require("../../../../lib/v2/ip-guard");

module.exports = async function (fastify) {
  fastify.get("/security/ip-rules", { preHandler: flexAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const { rows } = await db.query(`SELECT * FROM ${quoteIdent(schemaName)}._ip_rules ORDER BY created_at DESC`);
    return { rules: rows };
  });

  fastify.post("/security/ip-rules", { preHandler: requireProjectOrPlatformAuth, schema: { body: { type: "object", required: ["type", "cidr"], properties: { type: { type: "string", enum: ["allow", "block"] }, cidr: { type: "string" }, description: { type: "string" } } } } }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { type, cidr, description } = req.body;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const { rows } = await db.query(`INSERT INTO ${quoteIdent(schemaName)}._ip_rules (type, cidr, description) VALUES ($1,$2,$3) RETURNING *`, [type, cidr, description || null]);
    invalidateCache(schemaName);
    return reply.code(201).send({ rule: rows[0] });
  });

  fastify.delete("/security/ip-rules/:id", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { id } = req.params;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const { rowCount } = await db.query(`DELETE FROM ${quoteIdent(schemaName)}._ip_rules WHERE id=$1`, [id]);
    if (!rowCount) return apiError(reply, "GEN_003");
    invalidateCache(schemaName);
    return { deleted: id };
  });

  fastify.patch("/security/ip-rules/:id", { preHandler: requireProjectOrPlatformAuth, schema: { body: { type: "object", required: ["is_active"], properties: { is_active: { type: "boolean" } } } } }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { id } = req.params;
    const { is_active } = req.body;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const { rows } = await db.query(`UPDATE ${quoteIdent(schemaName)}._ip_rules SET is_active=$1 WHERE id=$2 RETURNING *`, [is_active, id]);
    if (!rows[0]) return apiError(reply, "GEN_003");
    invalidateCache(schemaName);
    return { rule: rows[0] };
  });

  fastify.post("/security/ip-rules/test", { preHandler: requireProjectOrPlatformAuth, schema: { body: { type: "object", required: ["ip"], properties: { ip: { type: "string" } } } } }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { ip } = req.body;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const result = await evaluateIP(schemaName, ip);
    return result;
  });
};
