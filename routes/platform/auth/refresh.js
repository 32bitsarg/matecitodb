const { db, rotatePlatformRefreshToken } = require("../../../lib/matecito");

module.exports = async function (fastify) {
  fastify.post("/auth/refresh", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const { refresh_token } = req.body || {};

    if (!refresh_token) {
      return reply.code(400).send({ error: "refresh_token required" });
    }

    const rotated = await rotatePlatformRefreshToken(refresh_token);
    if (!rotated) {
      return reply.code(401).send({ error: "Invalid or expired refresh token" });
    }

    const userRes = await db.query(
      `SELECT id, username, name, email FROM users WHERE id = $1 LIMIT 1`,
      [rotated.userId]
    );
    const user = userRes.rows[0];
    if (!user) {
      return reply.code(401).send({ error: "User not found" });
    }

    const access_token = await fastify.jwt.sign(
      { sub: user.id, email: user.email, username: user.username, name: user.name, kind: "platform" },
      { expiresIn: "1d" }
    );

    return {
      access_token,
      refresh_token: rotated.newToken,
      expires_in: 86400,
    };
  });
};
