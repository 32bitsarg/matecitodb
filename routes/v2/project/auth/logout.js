const {
  db,
  quoteIdent,
  requireProjectAuth,
  projectRoute,
  logAuthEvent,
} = require("../../../../lib/v2/auth");
const { body: bodySchema } = require("../../../../lib/v2/validators");

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const authUser  = req.projectUser;
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    if (authUser.pid !== projectId) return reply.code(401).send({ error: "Unauthorized", code: "AUTH_001" });

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (schemaName) {
      const { refresh_token } = req.body ?? {};
      if (refresh_token) {
        const schema = quoteIdent(schemaName);
        await db.query(
          `UPDATE ${schema}._refresh_tokens
           SET revoked_at = NOW()
           WHERE token = $1 AND user_id = $2 AND revoked_at IS NULL`,
          [refresh_token, authUser.id]
        );
      }
      logAuthEvent(schemaName, { event: "logout", userId: authUser.id, ip: req.ip, status: 200 });
    }

    return { ok: true };
  };

  projectRoute(fastify, "POST", "/auth/logout", {
    preHandler: requireProjectAuth,
    schema: { body: bodySchema.logout },
  }, handler);
};
