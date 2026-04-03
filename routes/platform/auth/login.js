const bcrypt = require("bcryptjs");
const { db, createPlatformRefreshToken } = require("../../../lib/matecito");

module.exports = async function (fastify) {
  fastify.post("/auth/login", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const email    = String(req.body?.email    || "").trim().toLowerCase();
    const password = String(req.body?.password || "");

    if (!email || !password) {
      return reply.code(400).send({ error: "email and password are required" });
    }

    const result = await db.query(
      `SELECT id, username, name, email, password_hash, avatar_seed, avatar_url, created_at
       FROM users WHERE email = $1 LIMIT 1`,
      [email]
    );

    const user = result.rows[0];
    if (!user) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    const ok = await bcrypt.compare(password, user.password_hash || "");
    if (!ok) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    const [access_token, refresh_token] = await Promise.all([
      fastify.jwt.sign(
        { sub: user.id, email: user.email, username: user.username, name: user.name, kind: "platform" },
        { expiresIn: "1d" }
      ),
      createPlatformRefreshToken(user.id),
    ]);

    delete user.password_hash;

    return { access_token, refresh_token, expires_in: 86400, user };
  });
};
