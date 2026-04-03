const { db, requirePlatformAuth, isWorkspaceMember, dropProjectSchema } = require("../../lib/matecito");

module.exports = async function (fastify) {
  fastify.delete("/delete-w/:workspaceId", { preHandler: requirePlatformAuth }, async (req, reply) => {
    const userId      = req.user.id;
    const { workspaceId } = req.params;

    const membership = await isWorkspaceMember(userId, workspaceId);
    if (!membership) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    if (membership.role !== "owner") {
      return reply.code(403).send({ error: "Only owner can delete workspace" });
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");

      const projectsRes = await client.query(
        `SELECT id, schema_name FROM projects WHERE workspace_id = $1`,
        [workspaceId]
      );

      for (const project of projectsRes.rows) {
        // Eliminar archivos del proyecto (tabla pública)
        await client.query(`DELETE FROM files WHERE project_id = $1`, [project.id]);
        await client.query(`DELETE FROM api_keys WHERE project_id = $1`, [project.id]);

        if (project.schema_name) {
          await dropProjectSchema(client, project.schema_name);
        }
      }

      await client.query(`DELETE FROM projects         WHERE workspace_id = $1`, [workspaceId]);
      await client.query(`DELETE FROM workspace_members WHERE workspace_id = $1`, [workspaceId]);
      await client.query(`DELETE FROM invites           WHERE workspace_id = $1`, [workspaceId]);
      await client.query(`DELETE FROM workspaces        WHERE id = $1`, [workspaceId]);

      await client.query("COMMIT");
      return { ok: true };
    } catch (err) {
      await client.query("ROLLBACK");
      fastify.log.error(err);
      return reply.code(500).send({ error: "Could not delete workspace" });
    } finally {
      client.release();
    }
  });
};
