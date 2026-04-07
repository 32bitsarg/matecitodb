/**
 * POST /notifications/send
 * Sends a push notification to one or more users (by user_id).
 * Requires a valid project API key or authenticated user.
 *
 * Body:
 * {
 *   user_ids: string[],        // target users
 *   title:    string,
 *   body:     string,
 *   data?:    Record<string, string>  // optional extra payload
 * }
 */
const { db, flexAuth, quoteIdent, projectRoute } = require("../../../lib/matecito");
const { sendToTokens } = require("../../../lib/fcm");

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    try {
      const project = req.resolvedProject;
      const projectId = project?.id ?? req.params?.projectId;

      const { user_ids, title, body, data } = req.body ?? {};

      if (!Array.isArray(user_ids) || user_ids.length === 0) {
        return reply.code(400).send({ error: "user_ids must be a non-empty array" });
      }
      if (!title || !body) {
        return reply.code(400).send({ error: "title and body are required" });
      }
      const isBroadcastCheck = user_ids.length === 1 && user_ids[0] === '*';
      if (!isBroadcastCheck && user_ids.length > 1000) {
        return reply.code(400).send({ error: "Maximum 1000 user_ids per request" });
      }

      const schemaName =
        project?.schema_name ??
        (await db.query(`SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]))
          .rows[0]?.schema_name;

      if (!schemaName) return reply.code(404).send({ error: "Project not found" });

      const schema = quoteIdent(schemaName);

      // Load project-specific Firebase credentials
      let projectCredentials = null;
      try {
        const cfgRes = await db.query(`SELECT credentials FROM ${schema}._fcm_config LIMIT 1`);
        if (cfgRes.rows[0]) projectCredentials = cfgRes.rows[0].credentials;
      } catch { /* tabla no existe → usar credenciales globales */ }

      // Check _fcm_tokens table exists
      const tableExists = await db.query(
        `SELECT 1 FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = '_fcm_tokens' LIMIT 1`,
        [schemaName]
      );
      if (!tableExists.rows[0]) {
        return reply.code(200).send({ successCount: 0, failureCount: 0, reason: "no_tokens_registered" });
      }

      // Fetch tokens — '*' means broadcast to all users
      const isBroadcast = user_ids.length === 1 && user_ids[0] === '*';
      const tokensRes = isBroadcast
        ? await db.query(`SELECT token FROM ${schema}._fcm_tokens`)
        : await db.query(
            `SELECT token FROM ${schema}._fcm_tokens WHERE user_id IN (${user_ids.map((_, i) => `$${i + 1}`).join(", ")})`,
            user_ids
          );

      const tokens = tokensRes.rows.map((r) => r.token);
      if (tokens.length === 0) {
        return reply.code(200).send({ successCount: 0, failureCount: 0, reason: "no_tokens_found" });
      }

      const result = await sendToTokens(tokens, { title, body }, data ?? {}, projectCredentials);
      fastify.log.info({ fcmResult: result }, "FCM send result");

      // Clean up invalid tokens
      if (result.invalidTokens.length > 0) {
        const inv = result.invalidTokens.map((_, i) => `$${i + 1}`).join(", ");
        await db
          .query(`DELETE FROM ${schema}._fcm_tokens WHERE token IN (${inv})`, result.invalidTokens)
          .catch(() => {});
      }

      return reply.code(200).send({
        successCount: result.successCount,
        failureCount: result.failureCount,
        errors:       result.errors ?? [],
      });
    } catch (err) {
      if (err.message?.includes("FCM not configured")) {
        return reply.code(503).send({ error: err.message });
      }
      fastify.log.error(err);
      return reply.code(500).send({ error: "Internal server error" });
    }
  };

  projectRoute(fastify, "POST", "/notifications/send", { preHandler: flexAuth }, handler);
};
