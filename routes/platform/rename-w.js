const { db, requirePlatformAuth, isWorkspaceMember } = require("../../lib/matecito");

module.exports = async function (fastify) {
  fastify.patch("/rename-w/:workspaceId", { preHandler: requirePlatformAuth }, async (req, reply) => {
    const userId      = req.user.id;
    const { workspaceId } = req.params;
    const name        = String(req.body?.name || "").trim();

    if (!name || name.length < 2) {
      return reply.code(400).send({ error: "Workspace name is required (min 2 chars)" });
    }

    const membership = await isWorkspaceMember(userId, workspaceId);
    if (!membership || !["owner", "admin"].includes(membership.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    const result = await db.query(
      `UPDATE workspaces
       SET name = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, name, slug, owner_id, created_at, updated_at`,
      [name, workspaceId]
    );

    if (!result.rows[0]) {
      return reply.code(404).send({ error: "Workspace not found" });
    }

    return { workspace: result.rows[0] };
  });
};
