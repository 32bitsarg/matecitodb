const { db, requirePlatformAuth, isWorkspaceMember, generateToken } = require("../../../lib/matecito");

module.exports = async function (fastify) {
  fastify.post("/workspaces/:workspaceId/invites", { preHandler: requirePlatformAuth }, async (req, reply) => {
    const userId = req.user.id;
    const { workspaceId } = req.params;
    const email = String(req.body?.email || "").trim().toLowerCase();
    const role = String(req.body?.role || "viewer").trim();

    if (!email) {
      return reply.code(400).send({ error: "email is required" });
    }

    if (!["owner", "admin", "developer", "viewer"].includes(role)) {
      return reply.code(400).send({ error: "Invalid role" });
    }

    const membership = await isWorkspaceMember(userId, workspaceId);
    if (!membership || !["owner", "admin"].includes(membership.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    const token = generateToken(20);

    const result = await db.query(
      `
      INSERT INTO invites (workspace_id, email, role, token, status)
      VALUES ($1, $2, $3, $4, 'pending')
      RETURNING id, workspace_id, email, role, token, status, created_at
      `,
      [workspaceId, email, role, token]
    );

    return reply.code(201).send({ invite: result.rows[0] });
  });
};
