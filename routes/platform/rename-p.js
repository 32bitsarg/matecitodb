const { db, requirePlatformAuth, isProjectMember, isWorkspaceMember } = require("../../lib/matecito");

const DOMAIN = process.env.DOMAIN || "matecito.dev";

module.exports = async function (fastify) {
  fastify.patch("/rename-p/:projectId", { preHandler: requirePlatformAuth }, async (req, reply) => {
    const userId      = req.user.id;
    const { projectId } = req.params;
    const name        = String(req.body?.name || "").trim();

    if (!name || name.length < 2) {
      return reply.code(400).send({ error: "Project name is required (min 2 chars)" });
    }

    const projectMembership = await isProjectMember(userId, projectId);
    if (!projectMembership) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    const workspaceMembership = await isWorkspaceMember(userId, projectMembership.workspace_id);
    if (!workspaceMembership || !["owner", "admin"].includes(workspaceMembership.role)) {
      return reply.code(403).send({ error: "Insufficient permissions" });
    }

    const result = await db.query(
      `UPDATE projects
       SET name = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, workspace_id, name, subdomain, schema_name, created_at, updated_at`,
      [name, projectId]
    );

    if (!result.rows[0]) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const project = result.rows[0];
    return {
      project: {
        ...project,
        url: `https://${project.subdomain}.${DOMAIN}`,
      },
    };
  });
};
