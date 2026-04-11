const {
  db,
  requireProjectOrPlatformAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { invalidatePermCache, logPermissionChange } = require("../../../../lib/v2/permissions");
const { apiError } = require("../../../../lib/v2/errors");
const { ensureV2Tables } = require("../../../../lib/v2/schema");

const VALID_OPERATIONS = ["list", "get", "create", "update", "delete"];
const VALID_ACCESS     = ["public", "auth", "service", "nobody"];

// v2: extended filter_rule format supports eq/neq/in operators
// Valid patterns:
//   "fieldName:{{auth.id}}"                    (v1 compat — eq)
//   "fieldName.eq:{{auth.id}}"                 (explicit eq)
//   "fieldName.neq:banned"                     (neq)
//   "fieldName.in:admin,moderator"             (in, literal values)
const VALID_FILTER_RULE = /^[a-zA-Z_][a-zA-Z0-9_]*(\.(eq|neq|in))?:(.+)$/;

async function resolveSchema(req) {
  const project    = req.resolvedProject;
  const projectId  = project?.id ?? req.params?.projectId;
  const schemaName = project?.schema_name ?? (await db.query(
    `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
  )).rows[0]?.schema_name;
  return { schemaName, projectId };
}

module.exports = async function (fastify) {
  // GET /permissions/:collection
  projectRoute(fastify, "GET", "/permissions/:collection", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const { schemaName } = await resolveSchema(req);
    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const { collection } = req.params;
    const s = quoteIdent(schemaName);

    const { rows } = await db.query(
      `SELECT operation, access, filter_rule FROM ${s}._permissions WHERE collection = $1`, [collection]
    );

    const map = {};
    for (const op of VALID_OPERATIONS) map[op] = { access: "auth", filter_rule: null };
    for (const row of rows) map[row.operation] = { access: row.access, filter_rule: row.filter_rule ?? null };

    return { collection, permissions: map };
  });

  // PATCH /permissions/:collection
  projectRoute(fastify, "PATCH", "/permissions/:collection", {
    preHandler: requireProjectOrPlatformAuth,
    schema: {
      body: {
        type: "object",
        required: ["permissions"],
        additionalProperties: false,
        properties: {
          permissions: { type: "object" },
        },
      },
    },
  }, async (req, reply) => {
    const { schemaName } = await resolveSchema(req);
    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const { collection } = req.params;
    const { permissions } = req.body;
    const s = quoteIdent(schemaName);

    await ensureV2Tables(schemaName).catch(() => {});

    // Capture prev for audit log
    const { rows: prev } = await db.query(
      `SELECT operation, access, filter_rule FROM ${s}._permissions WHERE collection = $1`, [collection]
    );
    const prevMap = {};
    for (const row of prev) prevMap[row.operation] = { access: row.access, filter_rule: row.filter_rule ?? null };

    for (const [op, val] of Object.entries(permissions)) {
      if (!VALID_OPERATIONS.includes(op)) continue;
      const access      = typeof val === "string" ? val : val?.access;
      const filter_rule = typeof val === "object"  ? (val?.filter_rule ?? null) : null;

      if (!VALID_ACCESS.includes(access)) continue;
      if (filter_rule !== null && !VALID_FILTER_RULE.test(filter_rule)) {
        return reply.code(400).send({
          error: `Invalid filter_rule for "${op}". Expected: "field[.op]:value|{{auth.id|email|username}}"`,
          code: "GEN_002",
        });
      }

      await db.query(
        `INSERT INTO ${s}._permissions (collection, operation, access, filter_rule)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (collection, operation) DO UPDATE
           SET access = EXCLUDED.access, filter_rule = EXCLUDED.filter_rule`,
        [collection, op, access, filter_rule]
      );
    }

    await invalidatePermCache(schemaName, collection);

    // Audit log
    const { rows: newRows } = await db.query(
      `SELECT operation, access, filter_rule FROM ${s}._permissions WHERE collection = $1`, [collection]
    );
    const newMap = {};
    for (const row of newRows) newMap[row.operation] = { access: row.access, filter_rule: row.filter_rule ?? null };

    logPermissionChange(schemaName, {
      collection,
      prevValue:   prevMap,
      newValue:    newMap,
      performedBy: req.user?.id ?? req.projectUser?.id ?? null,
      ip:          req.ip,
    }).catch(() => {});

    return { ok: true, permissions: newMap };
  });

  // GET /permissions — all collections
  projectRoute(fastify, "GET", "/permissions", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const { schemaName } = await resolveSchema(req);
    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const s = quoteIdent(schemaName);

    const [colRes, permRes] = await Promise.all([
      db.query(`SELECT name FROM ${s}._collections ORDER BY created_at DESC`),
      db.query(`SELECT collection, operation, access, filter_rule FROM ${s}._permissions`),
    ]);

    const map = {};
    for (const col of colRes.rows) {
      map[col.name] = {};
      for (const op of VALID_OPERATIONS) map[col.name][op] = { access: "auth", filter_rule: null };
    }
    for (const row of permRes.rows) {
      if (map[row.collection]) map[row.collection][row.operation] = { access: row.access, filter_rule: row.filter_rule ?? null };
    }

    return { permissions: map };
  });
};
