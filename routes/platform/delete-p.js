const { db, requirePlatformAuth, isProjectMember, isWorkspaceMember, dropProjectSchema } = require("../../lib/matecito");

module.exports = async function (fastify) {
  fastify.delete("/delete-p/:projectId", { preHandler: requirePlatformAuth }, async (req, reply) => {
    const userId      = req.user.id;
    const { projectId } = req.params;

    const projectMembership = await isProjectMember(userId, projectId);
    if (!projectMembership) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    const workspaceRole = await isWorkspaceMember(userId, projectMembership.workspace_id);
    if (!workspaceRole || !["owner", "admin"].includes(workspaceRole.role)) {
      return reply.code(403).send({ error: "Insufficient permissions" });
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");

      const projectRes = await client.query(
        `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`,
        [projectId]
      );

      // Limpiar archivos y keys antes de eliminar el proyecto (FK constraints)
      await client.query(`DELETE FROM files    WHERE project_id = $1`, [projectId]);
      await client.query(`DELETE FROM api_keys WHERE project_id = $1`, [projectId]);

      if (projectRes.rows[0]?.schema_name) {
        await dropProjectSchema(client, projectRes.rows[0].schema_name);
      }

      await client.query(`DELETE FROM projects WHERE id = $1`, [projectId]);

      await client.query("COMMIT");
      return { ok: true };
    } catch (err) {
      await client.query("ROLLBACK");
      fastify.log.error(err);
      return reply.code(500).send({ error: "Could not delete project" });
    } finally {
      client.release();
    }
  });
};
