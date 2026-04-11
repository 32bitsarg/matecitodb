const { db, requirePlatformAuth, isWorkspaceMember } = require("../../../../lib/v2/auth");
const { apiError } = require("../../../../lib/v2/errors");

const VALID_ROLES = ["owner", "admin", "developer", "viewer"];

module.exports = async function (fastify) {
  fastify.patch("/workspaces/:workspaceId/members/:userId", {
    preHandler: requirePlatformAuth,
    schema: {
      body: {
        type: "object",
        required: ["role"],
        additionalProperties: false,
        properties: { role: { type: "string", enum: VALID_ROLES } },
      },
    },
  }, async (req, reply) => {
    const callerId        = req.user.id;
    const { workspaceId, userId } = req.params;
    const role            = String(req.body.role || "").trim();

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
      return apiError(reply, "GEN_001", "Cannot change owner role");
    }

    const { rows: updated } = await db.query(
      `UPDATE workspace_members SET role = $1 WHERE workspace_id = $2 AND user_id = $3
       RETURNING id, user_id, workspace_id, role, created_at`,
      [role, workspaceId, userId]
    );
    return { member: updated[0] };
  });
};
