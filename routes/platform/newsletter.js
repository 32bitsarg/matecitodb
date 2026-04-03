const { db } = require("../../lib/matecito");

module.exports = async function (fastify) {
  // Crear tabla si no existe al cargar el módulo
  await db.query(`
    CREATE TABLE IF NOT EXISTS newsletter_subscribers (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email      TEXT NOT NULL UNIQUE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // POST /api/platform/newsletter
  fastify.post(
    "/newsletter",
    {
      config: { rateLimit: { max: 5, timeWindow: "10 minutes" } },
      schema: {
        body: {
          type: "object",
          required: ["email"],
          properties: {
            email: { type: "string", format: "email", maxLength: 254 },
          },
        },
      },
    },
    async (req, reply) => {
      const { email } = req.body;

      const { rows } = await db.query(
        `INSERT INTO newsletter_subscribers (email)
         VALUES ($1)
         ON CONFLICT (email) DO NOTHING
         RETURNING id`,
        [email]
      );

      if (rows.length === 0) {
        // Ya estaba suscripto — responder igual para no revelar info
        return reply.code(200).send({ ok: true });
      }

      return reply.code(201).send({ ok: true });
    }
  );
};
