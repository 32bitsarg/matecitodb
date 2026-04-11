const { db, rotatePlatformRefreshToken } = require("../../../../lib/v2/auth");
const { body: bodySchema } = require("../../../../lib/v2/validators");
const { apiError } = require("../../../../lib/v2/errors");

module.exports = async function (fastify) {
  fastify.post("/auth/refresh", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    schema: { body: bodySchema.refresh },
  }, async (req, reply) => {
    const { refresh_token } = req.body;

    const rotated = await rotatePlatformRefreshToken(refresh_token);
    if (!rotated) return apiError(reply, "AUTH_002");

    const userRes = await db.query(
      `SELECT id, username, name, email FROM users WHERE id = $1 LIMIT 1`,
      [rotated.userId]
    );
    const user = userRes.rows[0];
    if (!user) return apiError(reply, "AUTH_001");

    const access_token = await fastify.jwt.sign(
      { sub: user.id, email: user.email, username: user.username, name: user.name, kind: "platform" },
      { expiresIn: "1d" }
    );

    return { access_token, refresh_token: rotated.newToken, expires_in: 86400 };
  });
};
