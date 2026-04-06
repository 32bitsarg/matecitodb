/**
 * POST /notifications/register-token
 * Registers (or refreshes) the FCM token for the authenticated user.
 * Body: { token: string }
 */
const { db, flexAuth, quoteIdent, projectRoute } = require("../../../lib/matecito");

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    try {
      const project = req.resolvedProject;
      const projectId = project?.id ?? req.params?.projectId;

      const { token } = req.body ?? {};
      if (!token || typeof token !== "string") {
        return reply.code(400).send({ error: "token is required" });
      }

      if (!req.projectUser?.id) {
        return reply.code(401).send({ error: "Authentication required" });
      }

      const userId = req.projectUser.id;

      const schemaName =
        project?.schema_name ??
        (await db.query(`SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]))
          .rows[0]?.schema_name;

      if (!schemaName) return reply.code(404).send({ error: "Project not found" });

      const schema = quoteIdent(schemaName);

      // Ensure the table exists (idempotent)
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${schema}._fcm_tokens (
          id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id    text NOT NULL,
          token      text NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT _fcm_tokens_token_unique UNIQUE (token)
        )
      `);

      // Upsert: if token already exists update user_id + timestamp,
      // else insert. Also remove any old token belonging to this user
      // on a different device is kept — one user can have multiple tokens.
      await db.query(
        `INSERT INTO ${schema}._fcm_tokens (user_id, token, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (token) DO UPDATE
           SET user_id = EXCLUDED.user_id, updated_at = now()`,
        [userId, token]
      );

      return reply.code(200).send({ ok: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: "Internal server error" });
    }
  };

  projectRoute(fastify, "POST", "/notifications/register-token", { preHandler: flexAuth }, handler);
};
