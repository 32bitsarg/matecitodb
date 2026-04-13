const {
  db,
  quoteIdent,
  projectRoute,
  getProjectKeyContext,
  requireProjectOrPlatformAuth,
} = require("../../../../lib/v2/auth");
const { apiError } = require("../../../../lib/v2/errors");

async function requireJwtOrServiceKey(req, reply) {
  const rawKey    = req.headers["x-matecito-key"];
  const projectId = req.params?.projectId ?? req.resolvedProject?.id;
  if (rawKey && projectId) {
    const ctx = await getProjectKeyContext(projectId, rawKey, ["service"]).catch(() => null);
    if (ctx) return;
  }
  return requireProjectOrPlatformAuth(req, reply);
}

module.exports = async function (fastify) {
  projectRoute(fastify, "PATCH", "/collections/:name", {
    preHandler: requireJwtOrServiceKey,
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          soft_delete: { type: "boolean" },
          display_name: { type: "string", maxLength: 128 },
        },
      },
    },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { name }  = req.params;

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const schema = quoteIdent(schemaName);

    const exists = await db.query(
      `SELECT 1 FROM ${schema}._collections WHERE name = $1 LIMIT 1`, [name]
    );
    if (!exists.rows[0]) return reply.code(404).send({ error: "Collection not found", code: "GEN_003" });

    const updates = [];
    const values  = [];

    if (req.body.soft_delete !== undefined) {
      values.push(req.body.soft_delete);
      updates.push(`soft_delete = $${values.length}`);
    }

    if (req.body.display_name !== undefined) {
      values.push(req.body.display_name);
      updates.push(`display_name = $${values.length}`);
    }

    if (updates.length === 0) return reply.code(400).send({ error: "Nothing to update", code: "GEN_002" });

    values.push(name);
    const { rows } = await db.query(
      `UPDATE ${schema}._collections SET ${updates.join(", ")} WHERE name = $${values.length} RETURNING *`,
      values
    );

    return { ok: true, collection: rows[0] };
  });
};
