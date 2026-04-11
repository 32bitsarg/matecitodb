const { db, requirePlatformAuth, isWorkspaceMember } = require("../../../../lib/v2/auth");
const { apiError } = require("../../../../lib/v2/errors");

module.exports = async function (fastify) {
  fastify.delete("/workspaces/:workspaceId/members/:userId", { preHandler: requirePlatformAuth }, async (req, reply) => {
    const callerId        = req.user.id;
    const { workspaceId, userId } = req.params;

    const callerMembership = await isWorkspaceMember(callerId, workspaceId);
    if (!callerMembership || !["owner", "admin"].includes(callerMembership.role)) {
      return apiError(reply, "PERM_001");
    }

    const { rows } = await db.query(
      `SELECT wm.role, w.owner_id FROM workspace_members wm
       JOIN workspaces w ON w.id = wm.workspace_id
       WHERE wm.workspace_id = $1 AND wm.user_id = $2 LIMIT 1`,
      [workspaceId, userId]
    );
    if (!rows[0]) return apiError(reply, "GEN_003", "Member not found");
    if (rows[0].owner_id === userId || rows[0].role === "owner") {
      return apiError(reply, "GEN_001", "Cannot remove workspace owner");
    }

    await db.query(`DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, userId]);
    return { ok: true };
  });
};
