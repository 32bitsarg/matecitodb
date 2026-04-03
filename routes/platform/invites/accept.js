const { db, requirePlatformAuth } = require("../../../lib/matecito");

const INVITE_TTL_DAYS = 7;

module.exports = async function (fastify) {
  fastify.post("/invites/:token/accept", { preHandler: requirePlatformAuth }, async (req, reply) => {
    const userId = req.user.id;
    const token  = String(req.params.token || "").trim();

    const inviteRes = await db.query(
      `SELECT * FROM invites WHERE token = $1 AND status = 'pending' LIMIT 1`,
      [token]
    );
    const invite = inviteRes.rows[0];

    if (!invite) {
      return reply.code(404).send({ error: "Invite not found or already used" });
    }

    // Verificar expiración (7 días desde creación)
    const expiresAt = new Date(invite.created_at);
    expiresAt.setDate(expiresAt.getDate() + INVITE_TTL_DAYS);
    if (new Date() > expiresAt) {
      return reply.code(410).send({ error: "Invite has expired" });
    }

    const userRes = await db.query(
      `SELECT email FROM users WHERE id = $1 LIMIT 1`,
      [userId]
    );
    if (!userRes.rows[0]) {
      return reply.code(404).send({ error: "User not found" });
    }

    if (userRes.rows[0].email.toLowerCase() !== invite.email.toLowerCase()) {
      return reply.code(403).send({ error: "Invite email does not match your account" });
    }

    const exists = await db.query(
      `SELECT 1 FROM workspace_members WHERE user_id = $1 AND workspace_id = $2 LIMIT 1`,
      [userId, invite.workspace_id]
    );
    if (exists.rows[0]) {
      await db.query(`UPDATE invites SET status = 'accepted' WHERE id = $1`, [invite.id]);
      return { ok: true, alreadyMember: true };
    }

    await db.query(
      `INSERT INTO workspace_members (user_id, workspace_id, role) VALUES ($1, $2, $3)`,
      [userId, invite.workspace_id, invite.role]
    );
    await db.query(`UPDATE invites SET status = 'accepted' WHERE id = $1`, [invite.id]);

    return { ok: true };
  });
};
