const {
  db,
  flexAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { sendToTokens } = require("../../../../lib/fcm");
const { ensureV2Tables } = require("../../../../lib/v2/schema");
const { emitProjectEvent } = require("../../../../lib/v2/realtime");
const { apiError }     = require("../../../../lib/v2/errors");

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    const { user_ids, title, body, data } = req.body ?? {};

    if (!Array.isArray(user_ids) || user_ids.length === 0) {
      return reply.code(400).send({ error: "user_ids must be a non-empty array", code: "GEN_002" });
    }
    if (!title || !body) {
      return reply.code(400).send({ error: "title and body are required", code: "GEN_002" });
    }
    const isBroadcast = user_ids.length === 1 && user_ids[0] === "*";
    if (!isBroadcast && user_ids.length > 1000) {
      return reply.code(400).send({ error: "Maximum 1000 user_ids per request", code: "GEN_002" });
    }

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    await ensureV2Tables(schemaName);

    const schema = quoteIdent(schemaName);

    let projectCredentials = null;
    try {
      const cfgRes = await db.query(`SELECT credentials FROM ${schema}._fcm_config ORDER BY updated_at DESC NULLS LAST LIMIT 1`);
      if (cfgRes.rows[0]) projectCredentials = cfgRes.rows[0].credentials;
    } catch { /* no FCM config table → use global credentials */ }

    const tableExists = await db.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = '_fcm_tokens' LIMIT 1`,
      [schemaName]
    );
    if (!tableExists.rows[0]) {
      return { successCount: 0, failureCount: 0, reason: "no_tokens_registered" };
    }

    const tokensRes = isBroadcast
      ? await db.query(`SELECT token FROM ${schema}._fcm_tokens`)
      : await db.query(
          `SELECT token FROM ${schema}._fcm_tokens WHERE user_id IN (${user_ids.map((_, i) => `$${i + 1}`).join(", ")})`,
          user_ids
        );

    const tokens = tokensRes.rows.map(r => r.token);
    if (tokens.length === 0) return { successCount: 0, failureCount: 0, reason: "no_tokens_found" };

    const result = await sendToTokens(tokens, { title, body }, data ?? {}, projectCredentials);
    fastify.log.info({ fcmResult: result }, "FCM send result");

    if (result.invalidTokens.length > 0) {
      const inv = result.invalidTokens.map((_, i) => `$${i + 1}`).join(", ");
      await db.query(`DELETE FROM ${schema}._fcm_tokens WHERE token IN (${inv})`, result.invalidTokens).catch(() => {});
    }

    // Also persist in _notifications for in-app visibility
    if (tableExists.rows[0]) {
      const targetUsers = isBroadcast
        ? (await db.query(`SELECT user_id FROM ${schema}._fcm_tokens`)).rows.map(r => r.user_id)
        : user_ids;

      const uniqueUsers = [...new Set(targetUsers)];
      for (const userId of uniqueUsers.slice(0, 1000)) {
        try {
          const { rows } = await db.query(
            `INSERT INTO ${schema}._notifications (user_id, title, body, type, data)
             VALUES ($1, $2, $3, 'info', $4) RETURNING id`,
            [userId, title, body, JSON.stringify(data || {})]
          );
          emitProjectEvent(projectId, {
            type: "notification.created",
            userId,
            notification: { id: rows[0].id, title, body, data },
          }).catch(() => {});
        } catch { /* skip individual failures */ }
      }
    }

    return { successCount: result.successCount, failureCount: result.failureCount, errors: result.errors ?? [] };
  };

  projectRoute(fastify, "POST", "/notifications/send", {
    preHandler: flexAuth,
    schema: {
      body: {
        type: "object",
        required: ["user_ids", "title", "body"],
        additionalProperties: false,
        properties: {
          user_ids: { type: "array", items: { type: "string" }, minItems: 1 },
          title:    { type: "string", minLength: 1 },
          body:     { type: "string", minLength: 1 },
          data:     { type: "object" },
        },
      },
    },
  }, handler);
};
