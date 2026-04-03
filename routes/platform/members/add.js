const { db, requirePlatformAuth, isWorkspaceMember, generateToken } = require("../../../lib/matecito");

module.exports = async function (fastify) {
  fastify.post("/workspaces/:workspaceId/members", { preHandler: requirePlatformAuth }, async (req, reply) => {
    const callerId = req.user.id;
    const { workspaceId } = req.params;
    const targetUserId = String(req.body?.userId || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const role = String(req.body?.role || "viewer").trim();

    if (!["owner", "admin", "developer", "viewer"].includes(role)) {
      return reply.code(400).send({ error: "Invalid role" });
    }

    const membership = await isWorkspaceMember(callerId, workspaceId);
    if (!membership || !["owner", "admin"].includes(membership.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    let userId = targetUserId;

    if (!userId && !email) {
      return reply.code(400).send({ error: "userId or email is required" });
    }

    if (!userId && email) {
      const userRes = await db.query(
        `SELECT id FROM users WHERE email = $1 LIMIT 1`,
        [email]
      );

      if (!userRes.rows[0]) {
        const token = generateToken(20);

        const inviteRes = await db.query(
          `
          INSERT INTO invites (workspace_id, email, role, token, status)
          VALUES ($1, $2, $3, $4, 'pending')
          RETURNING id, workspace_id, email, role, token, status, created_at
          `,
          [workspaceId, email, role, token]
        );

        return reply.code(201).send({
          invited: true,
          invite: inviteRes.rows[0],
        });
      }

      userId = userRes.rows[0].id;
    }

    const userExists = await db.query(
      `SELECT id, email, username, name FROM users WHERE id = $1 LIMIT 1`,
      [userId]
    );
    if (!userExists.rows[0]) {
      return reply.code(404).send({ error: "User not found" });
    }

    const result = await db.query(
      `
      INSERT INTO workspace_members (user_id, workspace_id, role)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, workspace_id)
      DO UPDATE SET role = EXCLUDED.role
      RETURNING id, user_id, workspace_id, role, created_at
      `,
      [userId, workspaceId, role]
    );

    return reply.code(201).send({ member: result.rows[0] });
  });
};
