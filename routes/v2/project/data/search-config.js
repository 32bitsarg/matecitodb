// ─── Search config endpoint ───────────────────────────────────────────────────
//
// POST /collections/:name/search-config
// { "search_fields": ["title", "body", "tags"] }
//
// Configura qué campos se indexan en el search_vector de la colección.
// También reindexa los registros existentes.

const {
  db,
  flexAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { checkPermissionV2 } = require("../../../../lib/v2/permissions");
const { apiError }          = require("../../../../lib/v2/errors");
const { buildSearchVectorExpr, SUPPORTED_LANGUAGES } = require("../../../../lib/v2/fulltext");

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { name }  = req.params;
    const { search_fields, lang = "simple" } = req.body;

    if (!name) return reply.code(400).send({ error: "collection name is required", code: "GEN_002" });
    if (!Array.isArray(search_fields)) {
      return reply.code(400).send({ error: "search_fields must be an array", code: "GEN_002" });
    }

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const perm = await checkPermissionV2(schemaName, name, "update", req, reply);
    if (!perm.allowed) return;

    const schema = quoteIdent(schemaName);

    // Verificar que la colección existe
    const { rows: colRows } = await db.query(
      `SELECT 1 FROM ${schema}._collections WHERE name = $1 LIMIT 1`, [name]
    );
    if (!colRows[0]) return apiError(reply, "GEN_003", `Collection '${name}' not found`);

    const safeLang = SUPPORTED_LANGUAGES.has(lang) ? lang : "simple";

    // Actualizar search_fields en _collections
    await db.query(
      `UPDATE ${schema}._collections SET search_fields = $1 WHERE name = $2`,
      [search_fields, name]
    );

    // Reindexar registros existentes
    const vectorExpr = buildSearchVectorExpr(search_fields);
    if (vectorExpr !== "NULL") {
      await db.query(
        `UPDATE ${schema}._records
         SET search_vector = to_tsvector($1, ${vectorExpr})
         WHERE collection = $2`,
        [safeLang, name]
      );
    }

    return {
      collection: name,
      search_fields,
      language: safeLang,
      message: "Search config updated. Existing records reindexed.",
    };
  };

  projectRoute(fastify, "POST", "/collections/:name/search-config", {
    preHandler: flexAuth,
    schema: {
      body: {
        type: "object",
        required: ["search_fields"],
        properties: {
          search_fields: { type: "array", items: { type: "string" } },
          lang: { type: "string", enum: [...SUPPORTED_LANGUAGES] },
        },
      },
    },
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, handler);
};
