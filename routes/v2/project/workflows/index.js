// ─── Workflows CRUD (N1) ───────────────────────────────────────────────────
//
// GET    /workflows                        → listar
// GET    /workflows/:name                  → detalle
// GET    /workflows/:name/history?record_id= → historial
// GET    /records/:id/workflow-state       → estado actual + transiciones

const { db, flexAuth, quoteIdent, projectRoute } = require("../../../../lib/v2/auth");
const { ensureV2Tables } = require("../../../../lib/v2/schema");
const { apiError }       = require("../../../../lib/v2/errors");
const { findWorkflow, getWorkflowState } = require("../../../../lib/v2/workflow-engine");

module.exports = async function (fastify) {
  // GET /workflows
  fastify.get("/workflows", { preHandler: flexAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const { rows } = await db.query(`SELECT id, name, collection, field, is_active, created_at FROM ${quoteIdent(schemaName)}._workflows ORDER BY created_at DESC`);
    return { workflows: rows };
  });

  // GET /workflows/:name
  fastify.get("/workflows/:name", { preHandler: flexAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { name } = req.params;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const { rows } = await db.query(`SELECT * FROM ${quoteIdent(schemaName)}._workflows WHERE name=$1`, [name]);
    if (!rows[0]) return apiError(reply, "GEN_003");
    return { workflow: rows[0] };
  });

  // GET /workflows/:name/history
  fastify.get("/workflows/:name/history", { preHandler: flexAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { name } = req.params;
    const { record_id } = req.query;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const schema = quoteIdent(schemaName);
    const { rows: wf } = await db.query(`SELECT id FROM ${schema}._workflows WHERE name=$1`, [name]);
    if (!wf[0]) return apiError(reply, "GEN_003");
    const where = [`workflow_id = $1`];
    const values = [wf[0].id];
    if (record_id) { values.push(record_id); where.push(`record_id = $${values.length}`); }
    const { rows } = await db.query(`SELECT * FROM ${schema}._workflow_history WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 50`, values);
    return { history: rows };
  });

  // GET /records/:id/workflow-state
  fastify.get("/records/:id/workflow-state", { preHandler: flexAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { id } = req.params;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const schema = quoteIdent(schemaName);
    const { rows: records } = await db.query(`SELECT collection, data FROM ${schema}._records WHERE id=$1`, [id]);
    if (!records[0]) return apiError(reply, "GEN_003");
    const record = records[0];
    const workflow = await findWorkflow(schemaName, record.collection);
    if (!workflow) return apiError(reply, "GEN_003", "No workflow for this collection");
    const userRoles = req.projectUser?.roles || [];
    const state = await getWorkflowState(schemaName, workflow, id, record, userRoles);
    return state;
  });
};
