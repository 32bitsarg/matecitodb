const {
  db,
  quoteIdent,
  projectRoute,
  requireProjectOrPlatformAuth,
} = require("../../../../lib/v2/auth");
const { apiError } = require("../../../../lib/v2/errors");

const SAFE_ROLE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

async function ensureRoleTables(s) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${s}._roles (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name        TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${s}._user_roles (
      user_id     TEXT NOT NULL,
      role        TEXT NOT NULL,
      assigned_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, role)
    )
  `);
}

async function resolveSchema(req) {
  const project    = req.resolvedProject;
  const projectId  = project?.id ?? req.params?.projectId;
  const schemaName = project?.schema_name ?? (await db.query(
    `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
  )).rows[0]?.schema_name;
  return { schemaName, projectId };
}

module.exports = async function (fastify) {
  // GET /auth/roles
  projectRoute(fastify, "GET", "/auth/roles", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const { schemaName } = await resolveSchema(req);
    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    const s = quoteIdent(schemaName);
    await ensureRoleTables(s);
    const { rows } = await db.query(`SELECT id, name, description, created_at FROM ${s}._roles ORDER BY name`);
    return { roles: rows };
  });

  // POST /auth/roles  { name, description? }
  projectRoute(fastify, "POST", "/auth/roles", {
    preHandler: requireProjectOrPlatformAuth,
    schema: {
      body: {
        type: "object",
        required: ["name"],
        additionalProperties: false,
        properties: {
          name:        { type: "string", minLength: 1, maxLength: 64 },
          description: { type: "string", maxLength: 256 },
        },
      },
    },
  }, async (req, reply) => {
    const { schemaName } = await resolveSchema(req);
    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const { name, description } = req.body;
    if (!SAFE_ROLE.test(name)) return reply.code(400).send({ error: "Invalid role name", code: "GEN_002" });

    const s = quoteIdent(schemaName);
    await ensureRoleTables(s);

    const { rows } = await db.query(
      `INSERT INTO ${s}._roles (name, description) VALUES ($1, $2)
       ON CONFLICT (name) DO NOTHING
       RETURNING id, name, description, created_at`,
      [name, description ?? null]
    );
    if (!rows[0]) return reply.code(409).send({ error: "Role already exists", code: "GEN_004" });
    return reply.code(201).send({ role: rows[0] });
  });

  // DELETE /auth/roles/:roleName
  projectRoute(fastify, "DELETE", "/auth/roles/:roleName", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const { schemaName } = await resolveSchema(req);
    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    const s = quoteIdent(schemaName);
    await ensureRoleTables(s);
    await db.query(`DELETE FROM ${s}._user_roles WHERE role = $1`, [req.params.roleName]);
    const { rows } = await db.query(`DELETE FROM ${s}._roles WHERE name = $1 RETURNING id`, [req.params.roleName]);
    if (!rows[0]) return apiError(reply, "GEN_003", "Role not found");
    return { ok: true };
  });

  // GET /auth/users/:userId/roles
  projectRoute(fastify, "GET", "/auth/users/:userId/roles", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const { schemaName } = await resolveSchema(req);
    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    const s = quoteIdent(schemaName);
    await ensureRoleTables(s);
    const { rows } = await db.query(
      `SELECT role, assigned_at FROM ${s}._user_roles WHERE user_id = $1 ORDER BY assigned_at`,
      [req.params.userId]
    );
    return { roles: rows.map(r => r.role), details: rows };
  });

  // POST /auth/users/:userId/roles  { role }
  projectRoute(fastify, "POST", "/auth/users/:userId/roles", {
    preHandler: requireProjectOrPlatformAuth,
    schema: {
      body: {
        type: "object",
        required: ["role"],
        additionalProperties: false,
        properties: { role: { type: "string", minLength: 1, maxLength: 64 } },
      },
    },
  }, async (req, reply) => {
    const { schemaName } = await resolveSchema(req);
    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    const s = quoteIdent(schemaName);
    await ensureRoleTables(s);

    const { role } = req.body;
    const roleExists = await db.query(`SELECT 1 FROM ${s}._roles WHERE name = $1 LIMIT 1`, [role]);
    if (!roleExists.rows[0]) return apiError(reply, "GEN_003", `Role '${role}' not found`);

    await db.query(
      `INSERT INTO ${s}._user_roles (user_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.params.userId, role]
    );
    return { ok: true, user_id: req.params.userId, role };
  });

  // DELETE /auth/users/:userId/roles/:roleName
  projectRoute(fastify, "DELETE", "/auth/users/:userId/roles/:roleName", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const { schemaName } = await resolveSchema(req);
    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    const s = quoteIdent(schemaName);
    await ensureRoleTables(s);
    const { rows } = await db.query(
      `DELETE FROM ${s}._user_roles WHERE user_id = $1 AND role = $2 RETURNING user_id`,
      [req.params.userId, req.params.roleName]
    );
    if (!rows[0]) return apiError(reply, "GEN_003", "Role assignment not found");
    return { ok: true };
  });
};
