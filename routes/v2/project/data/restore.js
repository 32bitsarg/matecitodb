const {
  db,
  flexAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { checkPermissionV2 } = require("../../../../lib/v2/permissions");
const { emitProjectEvent }  = require("../../../../lib/v2/realtime");
const { apiError }          = require("../../../../lib/v2/errors");

module.exports = async function (fastify) {
  // POST /records/:id/restore
  projectRoute(fastify, "POST", "/records/:id/restore", { preHandler: flexAuth }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { id }    = req.params;

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const schema = quoteIdent(schemaName);
    const { rows: existing } = await db.query(
      `SELECT id, collection FROM ${schema}._records WHERE id = $1 AND deleted_at IS NOT NULL LIMIT 1`, [id]
    );
    if (!existing[0]) return apiError(reply, "DATA_001", "Deleted record not found");

    const perm = await checkPermissionV2(schemaName, existing[0].collection, "update", req, reply);
    if (!perm.allowed) return;

    const { rows } = await db.query(
      `UPDATE ${schema}._records SET deleted_at = NULL, updated_at = NOW() WHERE id = $1 RETURNING *`, [id]
    );
    const record = rows[0];
    emitProjectEvent(projectId, { type: "record.updated", projectId, collection: record.collection, record }).catch(() => {});

    return { ok: true, record };
  });

  // DELETE /records/:id/hard
  projectRoute(fastify, "DELETE", "/records/:id/hard", { preHandler: flexAuth }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { id }    = req.params;

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const schema = quoteIdent(schemaName);
    const { rows: existing } = await db.query(
      `SELECT id, collection FROM ${schema}._records WHERE id = $1 LIMIT 1`, [id]
    );
    if (!existing[0]) return apiError(reply, "DATA_001");

    const perm = await checkPermissionV2(schemaName, existing[0].collection, "delete", req, reply);
    if (!perm.allowed) return;

    await db.query(`DELETE FROM ${schema}._records WHERE id = $1`, [id]);
    emitProjectEvent(projectId, { type: "record.deleted", projectId, collection: existing[0].collection, recordId: id }).catch(() => {});

    return { ok: true };
  });
};
