const { db, requirePlatformAuth } = require("../../../../lib/v2/auth");
const { apiError } = require("../../../../lib/v2/errors");

const INVITE_TTL_DAYS = 7;

module.exports = async function (fastify) {
  fastify.post("/invites/:token/accept", { preHandler: requirePlatformAuth }, async (req, reply) => {
    const userId = req.user.id;
    const token  = String(req.params.token || "").trim();

    const { rows: inviteRows } = await db.query(
      `SELECT * FROM invites WHERE token = $1 AND status = 'pending' LIMIT 1`, [token]
    );
    const invite = inviteRows[0];
    if (!invite) return apiError(reply, "GEN_003", "Invite not found or already used");

    const expiresAt = new Date(invite.created_at);
    expiresAt.setDate(expiresAt.getDate() + INVITE_TTL_DAYS);
    if (new Date() > expiresAt) return reply.code(410).send({ error: "Invite has expired", code: "GEN_003" });

    const { rows: userRows } = await db.query(`SELECT email FROM users WHERE id = $1 LIMIT 1`, [userId]);
    if (!userRows[0]) return apiError(reply, "GEN_003", "User not found");

    if (userRows[0].email.toLowerCase() !== invite.email.toLowerCase()) {
      return apiError(reply, "PERM_001", "Invite email does not match your account");
    }

    const { rows: existsRows } = await db.query(
      `SELECT 1 FROM workspace_members WHERE user_id = $1 AND workspace_id = $2 LIMIT 1`,
      [userId, invite.workspace_id]
    );
    if (existsRows[0]) {
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
