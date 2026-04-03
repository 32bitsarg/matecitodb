const { db, requirePlatformAuth, isWorkspaceMember } = require("../../../lib/matecito");

module.exports = async function (fastify) {
  fastify.delete("/workspaces/:workspaceId/members/:userId", { preHandler: requirePlatformAuth }, async (req, reply) => {
    const callerId = req.user.id;
    const { workspaceId, userId } = req.params;

    const callerMembership = await isWorkspaceMember(callerId, workspaceId);
    if (!callerMembership || !["owner", "admin"].includes(callerMembership.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    const targetRes = await db.query(
      `
      SELECT wm.role, w.owner_id
      FROM workspace_members wm
      JOIN workspaces w ON w.id = wm.workspace_id
      WHERE wm.workspace_id = $1 AND wm.user_id = $2
      LIMIT 1
      `,
      [workspaceId, userId]
    );

    const target = targetRes.rows[0];
    if (!target) {
      return reply.code(404).send({ error: "Member not found" });
    }

    if (target.owner_id === userId || target.role === "owner") {
      return reply.code(400).send({ error: "Cannot remove workspace owner" });
    }

    await db.query(
      `DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId]
    );

    return { ok: true };
  });
};
