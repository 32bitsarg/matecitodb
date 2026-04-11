// ─── Functions CRUD (F1) ─────────────────────────────────────────────────────
//
// GET    /functions       → listar functions del proyecto
// POST   /functions       → crear function
// GET    /functions/:name → detalle
// PATCH  /functions/:name → actualizar
// DELETE /functions/:name → eliminar

const {
  db,
  flexAuth,
  requireProjectOrPlatformAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { ensureV2Tables } = require("../../../../lib/v2/schema");
const { apiError }       = require("../../../../lib/v2/errors");

const VALID_NAME = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;

module.exports = async function (fastify) {
  // ── GET /functions ─────────────────────────────────────────────────────
  fastify.get("/functions", {
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
      `SELECT id, name, description, timeout_ms, is_public, created_at, updated_at
       FROM ${schema}._functions ORDER BY created_at DESC`
    );

    return { functions: rows };
  });

  // ── POST /functions ────────────────────────────────────────────────────
  fastify.post("/functions", {
    preHandler: requireProjectOrPlatformAuth,
    schema: {
      body: {
        type: "object",
        required: ["name", "code"],
        properties: {
          name:        { type: "string", pattern: VALID_NAME.source },
          description: { type: "string" },
          code:        { type: "string", minLength: 1, maxLength: 51200 },
          timeout_ms:  { type: "integer", minimum: 100, maximum: 30000 },
          is_public:   { type: "boolean" },
        },
      },
    },
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { name, description, code, timeout_ms = 5000, is_public = false } = req.body;

    if (!VALID_NAME.test(name)) {
      return reply.code(400).send({ error: "Invalid function name. Must match: " + VALID_NAME.source, code: "GEN_002" });
    }

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    await ensureV2Tables(schemaName);

    const schema = quoteIdent(schemaName);

    try {
      const { rows } = await db.query(
        `INSERT INTO ${schema}._functions (name, description, code, timeout_ms, is_public)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, description, timeout_ms, is_public, created_at, updated_at`,
        [name, description || null, code, timeout_ms, is_public]
      );

      return reply.code(201).send({ function: rows[0] });
    } catch (err) {
      if (err.code === "23505") {
        return reply.code(409).send({ error: `Function '${name}' already exists`, code: "GEN_002" });
      }
      throw err;
    }
  });

  // ── GET /functions/:name ───────────────────────────────────────────────
  fastify.get("/functions/:name", {
    preHandler: flexAuth,
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { name }  = req.params;

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    await ensureV2Tables(schemaName);

    const schema = quoteIdent(schemaName);
    const { rows } = await db.query(
      `SELECT * FROM ${schema}._functions WHERE name = $1 LIMIT 1`,
      [name]
    );

    if (!rows[0]) return apiError(reply, "GEN_003", `Function '${name}' not found`);

    // Only return code if user is auth'd or function is public
    const fn = rows[0];
    if (!fn.is_public && !req.projectUser && !req.platformUser) {
      return apiError(reply, "PERM_001");
    }

    return { function: fn };
  });

  // ── PATCH /functions/:name ─────────────────────────────────────────────
  fastify.patch("/functions/:name", {
    preHandler: requireProjectOrPlatformAuth,
    schema: {
      body: {
        type: "object",
        properties: {
          description: { type: "string" },
          code:        { type: "string", minLength: 1, maxLength: 51200 },
          timeout_ms:  { type: "integer", minimum: 100, maximum: 30000 },
          is_public:   { type: "boolean" },
        },
      },
    },
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { name }  = req.params;
    const { description, code, timeout_ms, is_public } = req.body;

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    await ensureV2Tables(schemaName);

    const schema = quoteIdent(schemaName);

    const updates = [];
    const values = [];

    if (description !== undefined) { values.push(description); updates.push(`description = $${values.length}`); }
    if (code !== undefined)        { values.push(code);        updates.push(`code = $${values.length}`); }
    if (timeout_ms !== undefined)  { values.push(timeout_ms);  updates.push(`timeout_ms = $${values.length}`); }
    if (is_public !== undefined)   { values.push(is_public);   updates.push(`is_public = $${values.length}`); }

    if (updates.length === 0) return reply.code(400).send({ error: "No fields to update", code: "GEN_002" });

    values.push(name);
    const { rows } = await db.query(
      `UPDATE ${schema}._functions SET ${updates.join(", ")}, updated_at = NOW()
       WHERE name = $${values.length}
       RETURNING id, name, description, timeout_ms, is_public, created_at, updated_at`,
      values
    );

    if (!rows[0]) return apiError(reply, "GEN_003", `Function '${name}' not found`);

    return { function: rows[0] };
  });

  // ── DELETE /functions/:name ────────────────────────────────────────────
  fastify.delete("/functions/:name", {
    preHandler: requireProjectOrPlatformAuth,
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { name }  = req.params;

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    await ensureV2Tables(schemaName);

    const schema = quoteIdent(schemaName);
    const { rowCount } = await db.query(
      `DELETE FROM ${schema}._functions WHERE name = $1`,
      [name]
    );

    if (rowCount === 0) return apiError(reply, "GEN_003", `Function '${name}' not found`);

    return { deleted: name };
  });
};
