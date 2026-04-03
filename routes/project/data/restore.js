const { db, flexAuth, checkPermission, quoteIdent, projectRoute } = require("../../../lib/matecito");
const { emitProjectEvent } = require("../../../lib/realtime");

/**
 * POST /records/:id/restore  — restaura un registro con soft delete
 * DELETE /records/:id/hard   — elimina físicamente (incluso en colecciones con soft delete)
 */
module.exports = async function (fastify) {
  // Restore
  projectRoute(fastify, "POST", "/records/:id/restore", { preHandler: flexAuth }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { id }    = req.params;

    const schemaName = project?.schema_name ?? await (async () => {
      const res = await db.query(`SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]);
      return res.rows[0]?.schema_name;
    })();
    if (!schemaName) return reply.code(404).send({ error: "Project not found" });

    const schema = quoteIdent(schemaName);
    const existing = await db.query(
      `SELECT id, collection FROM ${schema}._records WHERE id = $1 AND deleted_at IS NOT NULL LIMIT 1`, [id]
    );
    if (!existing.rows[0]) return reply.code(404).send({ error: "Deleted record not found" });

    const perm = await checkPermission(schemaName, existing.rows[0].collection, "update", req, reply);
    if (!perm.allowed) return;

    const res = await db.query(
      `UPDATE ${schema}._records SET deleted_at = NULL, updated_at = NOW() WHERE id = $1 RETURNING *`, [id]
    );
    const record = res.rows[0];
    emitProjectEvent(projectId, { type: "record.updated", projectId, collection: record.collection, record });

    return { ok: true, record };
  });

  // Hard delete
  projectRoute(fastify, "DELETE", "/records/:id/hard", { preHandler: flexAuth }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { id }    = req.params;

    const schemaName = project?.schema_name ?? await (async () => {
      const res = await db.query(`SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]);
      return res.rows[0]?.schema_name;
    })();
    if (!schemaName) return reply.code(404).send({ error: "Project not found" });

    const schema   = quoteIdent(schemaName);
    const existing = await db.query(
      `SELECT id, collection FROM ${schema}._records WHERE id = $1 LIMIT 1`, [id]
    );
    if (!existing.rows[0]) return reply.code(404).send({ error: "Record not found" });

    const perm = await checkPermission(schemaName, existing.rows[0].collection, "delete", req, reply);
    if (!perm.allowed) return;

    await db.query(`DELETE FROM ${schema}._records WHERE id = $1`, [id]);
    emitProjectEvent(projectId, {
      type: "record.deleted", projectId, collection: existing.rows[0].collection, recordId: id,
    });

    return { ok: true };
  });
};
