const { db, requirePlatformAuth, isWorkspaceMember } = require("../../../lib/matecito");

module.exports = async function (fastify) {
  // GET /workspaces/:workspaceId/invites — listar invitaciones del workspace
  fastify.get("/workspaces/:workspaceId/invites", { preHandler: requirePlatformAuth }, async (req, reply) => {
    const userId      = req.user.id;
    const { workspaceId } = req.params;

    const membership = await isWorkspaceMember(userId, workspaceId);
    if (!membership || !["owner", "admin"].includes(membership.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    const result = await db.query(
      `SELECT id, email, role, token, status, created_at
       FROM invites
       WHERE workspace_id = $1
       ORDER BY created_at DESC`,
      [workspaceId]
    );

    return { invites: result.rows };
  });

  // GET /invites/:token — info de una invitación (para la UI de accept)
  fastify.get("/invites/:token", async (req, reply) => {
    const token = String(req.params.token || "").trim();

    const result = await db.query(
      `SELECT i.id, i.email, i.role, i.status, i.created_at, w.name AS workspace_name
       FROM invites i
       JOIN workspaces w ON w.id = i.workspace_id
       WHERE i.token = $1 LIMIT 1`,
      [token]
    );

    const invite = result.rows[0];
    if (!invite || invite.status !== "pending") {
      return reply.code(404).send({ error: "Invite not found or already used" });
    }

    // Verificar expiración sin revelar el token
    const expiresAt = new Date(invite.created_at);
    expiresAt.setDate(expiresAt.getDate() + 7);
    if (new Date() > expiresAt) {
      return reply.code(410).send({ error: "Invite has expired" });
    }

    return {
      invite: {
        email:          invite.email,
        role:           invite.role,
        workspace_name: invite.workspace_name,
      },
    };
  });

  // DELETE /invites/:inviteId — cancelar una invitación
  fastify.delete("/invites/:inviteId", { preHandler: requirePlatformAuth }, async (req, reply) => {
    const userId      = req.user.id;
    const { inviteId } = req.params;

    const inviteRes = await db.query(
      `SELECT i.workspace_id FROM invites i WHERE i.id = $1 LIMIT 1`,
      [inviteId]
    );
    const invite = inviteRes.rows[0];
    if (!invite) return reply.code(404).send({ error: "Invite not found" });

    const membership = await isWorkspaceMember(userId, invite.workspace_id);
    if (!membership || !["owner", "admin"].includes(membership.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    await db.query(`DELETE FROM invites WHERE id = $1`, [inviteId]);

    return { ok: true };
  });
};
