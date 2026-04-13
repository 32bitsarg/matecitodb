const {
  db,
  requireProjectOrPlatformAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { apiError } = require("../../../../lib/v2/errors");

const SAFE_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { name }  = req.params;
    const newName   = String(req.body?.name || "").trim();
    const softDelete = req.body?.soft_delete;

    // soft_delete-only update (no rename needed)
    if (!newName && softDelete !== undefined) {
      const schemaName = project?.schema_name ?? (await db.query(
        `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
      )).rows[0]?.schema_name;
      if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
      const schema = quoteIdent(schemaName);
      const { rows } = await db.query(
        `UPDATE ${schema}._collections SET soft_delete = $1 WHERE name = $2 RETURNING *`,
        [softDelete, name]
      );
      if (!rows[0]) return apiError(reply, "GEN_003", "Collection not found");
      return { ok: true, collection: rows[0] };
    }

    if (!newName) return reply.code(400).send({ error: "New name required", code: "GEN_002" });
    if (newName === name) return reply.code(400).send({ error: "New name must be different", code: "GEN_002" });
    if (!SAFE_NAME.test(newName)) return reply.code(400).send({ error: "Invalid collection name", code: "GEN_002" });

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const schema = quoteIdent(schemaName);

    const exists = await db.query(`SELECT 1 FROM ${schema}._collections WHERE name = $1 LIMIT 1`, [name]);
    if (!exists.rows[0]) return apiError(reply, "GEN_003", "Collection not found");

    const collision = await db.query(`SELECT 1 FROM ${schema}._collections WHERE name = $1 LIMIT 1`, [newName]);
    if (collision.rows[0]) return reply.code(409).send({ error: "Collection name already taken", code: "AUTH_007" });

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE ${schema}._collections SET name = $1 WHERE name = $2`, [newName, name]);
      await client.query(`UPDATE ${schema}._records     SET collection = $1 WHERE collection = $2`, [newName, name]);
      await client.query(`UPDATE ${schema}._fields      SET collection = $1 WHERE collection = $2`, [newName, name]);
      await client.query(`UPDATE ${schema}._permissions SET collection = $1 WHERE collection = $2`, [newName, name]);
      await client.query(`UPDATE ${schema}._webhooks    SET collection = $1 WHERE collection = $2`, [newName, name]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    return { ok: true, collection: { name: newName } };
  };

  projectRoute(fastify, "PATCH", "/collections/:name", {
    preHandler: requireProjectOrPlatformAuth,
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          name:        { type: "string", minLength: 1, maxLength: 64 },
          soft_delete: { type: "boolean" },
        },
      },
    },
  }, handler);
};
