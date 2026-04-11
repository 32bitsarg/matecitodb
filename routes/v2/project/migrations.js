const { db, flexAuth, requireProjectOrPlatformAuth, quoteIdent, projectRoute } = require("../../../../lib/v2/auth");
const { ensureV2Tables } = require("../../../../lib/v2/schema");
const { apiError }       = require("../../../../lib/v2/errors");

async function logMigration(schemaName, operation, collection, field, prevState, nextState, performedBy, ip) {
  const schema = quoteIdent(schemaName);
  const { rows } = await db.query(`SELECT COALESCE(MAX(version), 0) + 1 AS next_ver FROM ${schema}._schema_migrations`);
  const version = rows[0].next_ver;
  await db.query(`INSERT INTO ${schema}._schema_migrations (version, operation, collection, field, prev_state, next_state, performed_by, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [version, operation, collection || null, field || null, prevState ? JSON.stringify(prevState) : null, nextState ? JSON.stringify(nextState) : null, performedBy || null, ip || null]);
  return version;
}

module.exports = async function (fastify) {
  fastify.get("/schema/migrations", { preHandler: flexAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { limit = "50" } = req.query;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const { rows } = await db.query(`SELECT * FROM ${quoteIdent(schemaName)}._schema_migrations ORDER BY version DESC LIMIT $1`, [parseInt(limit, 10) || 50]);
    return { migrations: rows };
  });

  fastify.get("/schema/migrations/:version", { preHandler: flexAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { version } = req.params;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const { rows } = await db.query(`SELECT * FROM ${quoteIdent(schemaName)}._schema_migrations WHERE version=$1`, [version]);
    if (!rows[0]) return apiError(reply, "GEN_003");
    return { migration: rows[0] };
  });

  fastify.post("/schema/migrations/:version/rollback", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { version } = req.params;
    const schemaName = project?.schema_name ?? (await db.query(`SELECT schema_name FROM projects WHERE id=$1`, [projectId])).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003");
    await ensureV2Tables(schemaName);
    const schema = quoteIdent(schemaName);
    const { rows } = await db.query(`SELECT * FROM ${schema}._schema_migrations WHERE version=$1`, [version]);
    if (!rows[0]) return apiError(reply, "GEN_003");
    const mig = rows[0];
    let result = { action: "no_auto_rollback", note: "Manual intervention may be required" };
    try {
      if (mig.operation === "create_collection" && !mig.prev_state) {
        await db.query(`DELETE FROM ${schema}._collections WHERE name=$1`, [mig.collection]);
        result = { action: "removed_collection", collection: mig.collection };
      }
    } catch (err) {
      return reply.code(400).send({ error: `Rollback failed: ${err.message}` });
    }
    return { rolled_back: parseInt(version, 10), result };
  });
};

module.exports.logMigration = logMigration;
