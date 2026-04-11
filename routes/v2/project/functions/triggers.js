// ─── Triggers CRUD (F1 — prepara F2) ────────────────────────────────────────
//
// GET    /functions/triggers         → listar triggers
// POST   /functions/triggers         → crear trigger
// DELETE /functions/triggers/:id     → eliminar
// PATCH  /functions/triggers/:id     → activar/desactivar
//
// Un trigger asocia una function a un evento de colección.
// Se dispara desde create-record / update-record / delete-record via queue.

const {
  db,
  requireProjectOrPlatformAuth,
  flexAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { ensureV2Tables } = require("../../../../lib/v2/schema");
const { apiError }       = require("../../../../lib/v2/errors");

const VALID_EVENTS = ["record.created", "record.updated", "record.deleted"];

module.exports = async function (fastify) {
  // ── GET /functions/triggers ────────────────────────────────────────────
  fastify.get("/functions/triggers", {
    preHandler: flexAuth,
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    await ensureV2Tables(schemaName);

    const schema = quoteIdent(schemaName);
    const { rows } = await db.query(
      `SELECT * FROM ${schema}._triggers ORDER BY created_at DESC`
    );

    return { triggers: rows };
  });

  // ── POST /functions/triggers ───────────────────────────────────────────
  fastify.post("/functions/triggers", {
    preHandler: requireProjectOrPlatformAuth,
    schema: {
      body: {
        type: "object",
        required: ["collection", "event", "function_name"],
        properties: {
          collection:    { type: "string", minLength: 1 },
          event:         { type: "string", enum: VALID_EVENTS },
          function_name: { type: "string", minLength: 1 },
        },
      },
    },
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { collection, event, function_name } = req.body;

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    await ensureV2Tables(schemaName);

    const schema = quoteIdent(schemaName);

    // Verify function exists
    const { rows: fnRows } = await db.query(
      `SELECT id FROM ${schema}._functions WHERE name = $1 LIMIT 1`,
      [function_name]
    );
    if (!fnRows[0]) return reply.code(400).send({ error: `Function '${function_name}' not found`, code: "GEN_002" });

    const { rows } = await db.query(
      `INSERT INTO ${schema}._triggers (collection, event, function_name)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [collection, event, function_name]
    );

    return reply.code(201).send({ trigger: rows[0] });
  });

  // ── DELETE /functions/triggers/:id ─────────────────────────────────────
  fastify.delete("/functions/triggers/:id", {
    preHandler: requireProjectOrPlatformAuth,
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { id }    = req.params;

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    await ensureV2Tables(schemaName);

    const schema = quoteIdent(schemaName);
    const { rowCount } = await db.query(
      `DELETE FROM ${schema}._triggers WHERE id = $1`,
      [id]
    );

    if (rowCount === 0) return apiError(reply, "GEN_003", "Trigger not found");

    return { deleted: id };
  });

  // ── PATCH /functions/triggers/:id ──────────────────────────────────────
  fastify.patch("/functions/triggers/:id", {
    preHandler: requireProjectOrPlatformAuth,
    schema: {
      body: {
        type: "object",
        required: ["is_active"],
        properties: {
          is_active: { type: "boolean" },
        },
      },
    },
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { id }    = req.params;
    const { is_active } = req.body;

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    await ensureV2Tables(schemaName);

    const schema = quoteIdent(schemaName);
    const { rows } = await db.query(
      `UPDATE ${schema}._triggers SET is_active = $1 WHERE id = $2 RETURNING *`,
      [is_active, id]
    );

    if (!rows[0]) return apiError(reply, "GEN_003", "Trigger not found");

    return { trigger: rows[0] };
  });
};
