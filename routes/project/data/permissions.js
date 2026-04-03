const { db, requireProjectOrPlatformAuth, quoteIdent, projectRoute, invalidatePermCache } = require("../../../lib/matecito");

const VALID_OPERATIONS  = ["list", "get", "create", "update", "delete"];
const VALID_ACCESS      = ["public", "auth", "service", "nobody"];
const VALID_FILTER_RULE = /^[a-zA-Z_][a-zA-Z0-9_]*:\{\{auth\.(id|email|username)\}\}$/;

async function resolveSchema(req) {
  const project = req.resolvedProject;
  const projectId = project?.id ?? req.params?.projectId;
  const schemaName = project?.schema_name ?? (await db.query(
    `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
  )).rows[0]?.schema_name;
  return schemaName;
}

module.exports = async function (fastify) {
  // GET /permissions/:collection — list permissions for a collection
  projectRoute(fastify, "GET", "/permissions/:collection", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const schemaName = await resolveSchema(req);
    if (!schemaName) return reply.code(404).send({ error: "Project not found" });
    const s = quoteIdent(schemaName);
    const { collection } = req.params;

    const res = await db.query(
      `SELECT operation, access, filter_rule FROM ${s}._permissions WHERE collection = $1`, [collection]
    );

    const map = {};
    for (const op of VALID_OPERATIONS) map[op] = { access: "auth", filter_rule: null };
    for (const row of res.rows) map[row.operation] = { access: row.access, filter_rule: row.filter_rule ?? null };

    return { collection, permissions: map };
  });

  // PATCH /permissions/:collection  { permissions: { list: { access, filter_rule? }, ... } }
  projectRoute(fastify, "PATCH", "/permissions/:collection", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const schemaName = await resolveSchema(req);
    if (!schemaName) return reply.code(404).send({ error: "Project not found" });
    const s = quoteIdent(schemaName);
    const { collection } = req.params;
    const { permissions } = req.body ?? {};

    if (!permissions) return reply.code(400).send({ error: "permissions object required" });

    for (const [op, val] of Object.entries(permissions)) {
      if (!VALID_OPERATIONS.includes(op)) continue;
      // Support both { access, filter_rule } and plain string shorthand
      const access      = typeof val === "string" ? val : val?.access;
      const filter_rule = typeof val === "object" ? (val?.filter_rule ?? null) : null;
      if (!VALID_ACCESS.includes(access)) continue;
      if (filter_rule !== null && !VALID_FILTER_RULE.test(filter_rule)) {
        return reply.code(400).send({ error: `Invalid filter_rule format for operation "${op}". Expected: "fieldName:{{auth.id|email|username}}"` });
      }
      await db.query(
        `INSERT INTO ${s}._permissions (collection, operation, access, filter_rule)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (collection, operation) DO UPDATE SET access = EXCLUDED.access, filter_rule = EXCLUDED.filter_rule`,
        [collection, op, access, filter_rule]
      );
    }

    invalidatePermCache(schemaName, collection);
    return { message: "Permissions updated." };
  });

  // GET /permissions — list all permissions grouped by collection
  projectRoute(fastify, "GET", "/permissions", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const schemaName = await resolveSchema(req);
    if (!schemaName) return reply.code(404).send({ error: "Project not found" });
    const s = quoteIdent(schemaName);

    const collections = await db.query(`SELECT name FROM ${s}._collections ORDER BY created_at DESC`);
    const perms = await db.query(`SELECT collection, operation, access, filter_rule FROM ${s}._permissions`);

    const map = {};
    for (const col of collections.rows) {
      map[col.name] = {};
      for (const op of VALID_OPERATIONS) map[col.name][op] = { access: "auth", filter_rule: null };
    }
    for (const row of perms.rows) {
      if (map[row.collection]) map[row.collection][row.operation] = { access: row.access, filter_rule: row.filter_rule ?? null };
    }

    return { permissions: map };
  });
};
