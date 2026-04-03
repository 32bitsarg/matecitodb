const { db, requireProjectOrPlatformAuth, quoteIdent, projectRoute } = require("../../../lib/matecito");

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { name }  = req.params;
    const newName   = String(req.body?.name || "").trim();

    if (!newName) return reply.code(400).send({ error: "New name required" });
    if (newName === name) return reply.code(400).send({ error: "New name must be different" });

    const schemaName = project?.schema_name ?? await (async () => {
      const res = await db.query(
        `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`,
        [projectId]
      );
      return res.rows[0]?.schema_name;
    })();

    if (!schemaName) return reply.code(404).send({ error: "Project not found" });

    const schema = quoteIdent(schemaName);

    const exists = await db.query(
      `SELECT 1 FROM ${schema}._collections WHERE name = $1 LIMIT 1`,
      [name]
    );
    if (!exists.rows[0]) return reply.code(404).send({ error: "Collection not found" });

    const collision = await db.query(
      `SELECT 1 FROM ${schema}._collections WHERE name = $1 LIMIT 1`,
      [newName]
    );
    if (collision.rows[0]) return reply.code(409).send({ error: "Collection name already taken" });

    // Rename collection + update all records that reference it
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE ${schema}._collections SET name = $1 WHERE name = $2`,
        [newName, name]
      );
      await client.query(
        `UPDATE ${schema}._records SET collection = $1 WHERE collection = $2`,
        [newName, name]
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    return { ok: true, collection: { name: newName } };
  };

  projectRoute(fastify, "PATCH", "/collections/:name", { preHandler: requireProjectOrPlatformAuth }, handler);
};
