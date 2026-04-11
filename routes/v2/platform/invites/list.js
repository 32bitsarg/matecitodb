const { db, requirePlatformAuth, isWorkspaceMember } = require("../../../../lib/v2/auth");
const { apiError } = require("../../../../lib/v2/errors");

module.exports = async function (fastify) {
  fastify.get("/workspaces/:workspaceId/invites", { preHandler: requirePlatformAuth }, async (req, reply) => {
    const userId          = req.user.id;
    const { workspaceId } = req.params;

    const membership = await isWorkspaceMember(userId, workspaceId);
    if (!membership || !["owner", "admin"].includes(membership.role)) {
      return apiError(reply, "PERM_001");
    }

    const { rows } = await db.query(
      `SELECT id, email, role, token, status, created_at FROM invites
       WHERE workspace_id = $1 ORDER BY created_at DESC`,
      [workspaceId]
    );
    return { invites: rows };
  });

  fastify.get("/invites/:token", async (req, reply) => {
    const token = String(req.params.token || "").trim();

    const { rows } = await db.query(
      `SELECT i.id, i.email, i.role, i.status, i.created_at, w.name AS workspace_name
       FROM invites i JOIN workspaces w ON w.id = i.workspace_id
       WHERE i.token = $1 LIMIT 1`,
      [token]
    );

    const invite = rows[0];
    if (!invite || invite.status !== "pending") return apiError(reply, "GEN_003", "Invite not found or already used");

    const expiresAt = new Date(invite.created_at);
    expiresAt.setDate(expiresAt.getDate() + 7);
    if (new Date() > expiresAt) return reply.code(410).send({ error: "Invite has expired", code: "GEN_003" });

    return { invite: { email: invite.email, role: invite.role, workspace_name: invite.workspace_name } };
  });

  fastify.delete("/invites/:inviteId", { preHandler: requirePlatformAuth }, async (req, reply) => {
    const userId      = req.user.id;
    const { inviteId } = req.params;

    const { rows } = await db.query(`SELECT workspace_id FROM invites WHERE id = $1 LIMIT 1`, [inviteId]);
    if (!rows[0]) return apiError(reply, "GEN_003", "Invite not found");

    const membership = await isWorkspaceMember(userId, rows[0].workspace_id);
    if (!membership || !["owner", "admin"].includes(membership.role)) return apiError(reply, "PERM_001");

    await db.query(`DELETE FROM invites WHERE id = $1`, [inviteId]);
    return { ok: true };
  });
};
