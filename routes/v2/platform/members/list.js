const { db, requirePlatformAuth, isWorkspaceMember } = require("../../../../lib/v2/auth");
const { apiError } = require("../../../../lib/v2/errors");

module.exports = async function (fastify) {
  fastify.get("/workspaces/:workspaceId/members", { preHandler: requirePlatformAuth }, async (req, reply) => {
    const userId          = req.user.id;
    const { workspaceId } = req.params;

    const membership = await isWorkspaceMember(userId, workspaceId);
    if (!membership) return apiError(reply, "PERM_001");

    const { rows } = await db.query(
      `SELECT wm.user_id, wm.role, u.username, u.name, u.email, u.avatar_seed, u.avatar_url, wm.created_at
       FROM workspace_members wm JOIN users u ON u.id = wm.user_id
       WHERE wm.workspace_id = $1 ORDER BY wm.created_at ASC`,
      [workspaceId]
    );
    return { members: rows };
  });
};
