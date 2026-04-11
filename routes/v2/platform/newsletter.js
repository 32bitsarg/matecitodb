const { db } = require("../../../lib/v2/auth");

module.exports = async function (fastify) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS newsletter_subscribers (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email      TEXT NOT NULL UNIQUE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  fastify.post("/newsletter", {
    config: { rateLimit: { max: 5, timeWindow: "10 minutes" } },
    schema: {
      body: {
        type: "object",
        required: ["email"],
        additionalProperties: false,
        properties: {
          email: { type: "string", format: "email", maxLength: 254 },
        },
      },
    },
  }, async (req, reply) => {
    const { email } = req.body;

    const { rows } = await db.query(
      `INSERT INTO newsletter_subscribers (email) VALUES ($1)
       ON CONFLICT (email) DO NOTHING RETURNING id`,
      [email]
    );

    return reply.code(rows.length > 0 ? 201 : 200).send({ ok: true });
  });
};
