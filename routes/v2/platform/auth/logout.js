const { db, requirePlatformAuth } = require("../../../../lib/v2/auth");
const { body: bodySchema } = require("../../../../lib/v2/validators");

module.exports = async function (fastify) {
  fastify.post("/auth/logout", {
    preHandler: requirePlatformAuth,
    schema: { body: bodySchema.logout },
  }, async (req, reply) => {
    const { refresh_token } = req.body ?? {};

    if (refresh_token) {
      await db.query(
        `UPDATE refresh_tokens
         SET revoked_at = NOW()
         WHERE token = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [refresh_token, req.user.id]
      );
    }

    return { ok: true };
  });
};
