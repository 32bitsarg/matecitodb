const { requirePlatformAuth } = require("../../../lib/v2/auth");
const { listMigrations }      = require("../../../lib/v2/migrations");

module.exports = async function (fastify) {
  fastify.get("/migrations", { preHandler: requirePlatformAuth }, async (req, reply) => {
    const rows = await listMigrations();
    return { migrations: rows, count: rows.length };
  });
};
