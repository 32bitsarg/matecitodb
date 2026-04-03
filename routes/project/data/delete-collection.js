const {
  db,
  requireProjectOrPlatformAuth,
  quoteIdent,
  projectRoute
} = require("../../../lib/matecito");

const { emitProjectEvent } = require("../../../lib/realtime");
const { fireWebhooks }     = require("../../../lib/webhooks");

const SAFE_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { name }  = req.params;

    const { force = "false" } = req.query;

    if (!SAFE_NAME.test(name)) {
      return reply.code(400).send({ error: "Invalid collection name" });
    }

    const schemaName = project?.schema_name ?? await (async () => {
      const res = await db.query(
        `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`,
        [projectId]
      );
      return res.rows[0]?.schema_name;
    })();

    if (!schemaName) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const schema = quoteIdent(schemaName);

    // Verificar existencia
    const exists = await db.query(
      `SELECT name FROM ${schema}._collections WHERE name = $1 LIMIT 1`,
      [name]
    );

    if (!exists.rows[0]) {
      return reply.code(404).send({ error: "Collection not found" });
    }

    // Contar registros
    const countRes = await db.query(
      `SELECT COUNT(*)::int AS count FROM ${schema}._records WHERE collection = $1`,
      [name]
    );

    const count = countRes.rows[0].count;

    // Protección: no borrar si tiene datos sin force
    if (count > 0 && force !== "true") {
      return reply.code(400).send({
        error: "Collection has records",
        hint: "Use ?force=true to delete anyway",
        count
      });
    }

    const client = await db.connect();

    try {
      await client.query("BEGIN");

      // 🔥 borrar todo lo relacionado
      await client.query(`DELETE FROM ${schema}._records     WHERE collection = $1`, [name]);
      await client.query(`DELETE FROM ${schema}._fields      WHERE collection = $1`, [name]);
      await client.query(`DELETE FROM ${schema}._permissions WHERE collection = $1`, [name]);
      await client.query(`DELETE FROM ${schema}._webhooks    WHERE collection = $1`, [name]);

      // colección
      await client.query(
        `DELETE FROM ${schema}._collections WHERE name = $1`,
        [name]
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    // eventos
    emitProjectEvent(projectId, {
      type: "collection.deleted",
      projectId,
      collection: name
    });

    fireWebhooks(schemaName, name, "collection.deleted", {
      collection: name
    }).catch(() => {});

    return {
      ok: true,
      collection: name,
      deleted_records: count
    };
  };

  projectRoute(
    fastify,
    "DELETE",
    "/collections/:name",
    { preHandler: requireProjectOrPlatformAuth },
    handler
  );
};
