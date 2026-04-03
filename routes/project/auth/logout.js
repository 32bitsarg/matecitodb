const { db, quoteIdent, requireProjectAuth, getProjectKeyContext, projectRoute, logAuthEvent } = require("../../../lib/matecito");

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const { refresh_token } = req.body || {};
    const authUser  = req.projectUser;
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    if (authUser.pid !== projectId) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const schemaName = project?.schema_name ?? await (async () => {
      const res = await db.query(
        `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`,
        [projectId]
      );
      return res.rows[0]?.schema_name;
    })();

    if (schemaName) {
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

  projectRoute(fastify, "POST", "/auth/logout", { preHandler: requireProjectAuth }, handler);
};
