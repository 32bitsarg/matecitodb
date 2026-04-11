const {
  db,
  flexAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { apiError } = require("../../../../lib/v2/errors");

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    const { token } = req.body ?? {};
    if (!token || typeof token !== "string") {
      return reply.code(400).send({ error: "token is required", code: "GEN_002" });
    }
    if (!req.projectUser?.id) return apiError(reply, "AUTH_001");

    const userId = req.projectUser.id;

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const schema = quoteIdent(schemaName);

    await db.query(`
      CREATE TABLE IF NOT EXISTS ${schema}._fcm_tokens (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id    text NOT NULL,
        token      text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT _fcm_tokens_token_unique UNIQUE (token)
      )
    `);

    await db.query(
      `INSERT INTO ${schema}._fcm_tokens (user_id, token, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, updated_at = now()`,
      [userId, token]
    );

    return { ok: true };
  };

  projectRoute(fastify, "POST", "/notifications/register-token", {
    preHandler: flexAuth,
    schema: {
      body: {
        type: "object",
        required: ["token"],
        additionalProperties: false,
        properties: { token: { type: "string", minLength: 1 } },
      },
    },
  }, handler);
};
