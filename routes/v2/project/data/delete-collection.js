const {
  db,
  requireProjectOrPlatformAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { emitProjectEvent } = require("../../../../lib/v2/realtime");
const { enqueueWebhook }   = require("../../../../lib/v2/queue");
const { apiError }         = require("../../../../lib/v2/errors");

const SAFE_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { name }  = req.params;
    const { force = "false" } = req.query;

    if (!SAFE_NAME.test(name)) return reply.code(400).send({ error: "Invalid collection name", code: "GEN_002" });

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const schema = quoteIdent(schemaName);

    const exists = await db.query(`SELECT 1 FROM ${schema}._collections WHERE name = $1 LIMIT 1`, [name]);
    if (!exists.rows[0]) return apiError(reply, "GEN_003", "Collection not found");

    const { rows: countRows } = await db.query(
      `SELECT COUNT(*)::int AS count FROM ${schema}._records WHERE collection = $1`, [name]
    );
    const count = countRows[0].count;

    if (count > 0 && force !== "true") {
      return reply.code(400).send({ error: "Collection has records", hint: "Use ?force=true to delete anyway", count, code: "GEN_002" });
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM ${schema}._records     WHERE collection = $1`, [name]);
      await client.query(`DELETE FROM ${schema}._fields      WHERE collection = $1`, [name]);
      await client.query(`DELETE FROM ${schema}._permissions WHERE collection = $1`, [name]);
      await client.query(`DELETE FROM ${schema}._webhooks    WHERE collection = $1`, [name]);
      await client.query(`DELETE FROM ${schema}._collections WHERE name = $1`, [name]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    emitProjectEvent(projectId, { type: "collection.deleted", projectId, collection: name }).catch(() => {});
    enqueueWebhook(schemaName, name, "collection.deleted", { collection: name });

    return { ok: true, collection: name, deleted_records: count };
  };

  projectRoute(fastify, "DELETE", "/collections/:name", { preHandler: requireProjectOrPlatformAuth }, handler);
};
