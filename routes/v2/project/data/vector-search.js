// ─── Vector Search (G3) — Semantic Search via pgvector ─────────────────────
//
// POST /records/vector/upsert   → guardar embedding para un record
// POST /records/vector/search   → buscar por embedding o por texto natural
//
// Requiere extensión pgvector en PostgreSQL.
// Si no está disponible, los endpoints devuelven error informativo.

const {
  db,
  flexAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { checkPermissionV2 } = require("../../../../lib/v2/permissions");
const { ensureV2Tables } = require("../../../../lib/v2/schema");
const { apiError }       = require("../../../../lib/v2/errors");

const EMBEDDING_DIM = 1536; // OpenAI default

let vectorExtensionChecked = false;
let vectorAvailable = false;

async function checkVectorExtension(client) {
  if (vectorExtensionChecked) return vectorAvailable;
  try {
    const { rows } = await client.query(
      `SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`
    );
    vectorAvailable = rows.length > 0;
    if (vectorAvailable) {
      await client.query(`CREATE EXTENSION IF NOT EXISTS vector`).catch(() => {});
    }
  } catch { vectorAvailable = false; }
  vectorExtensionChecked = true;
  return vectorAvailable;
}

module.exports = async function (fastify) {
  // ── POST /records/vector/upsert ────────────────────────────────────────
  fastify.post("/records/vector/upsert", {
    preHandler: requireProjectOrPlatformAuth,
    schema: {
      body: {
        type: "object",
        required: ["collection", "id", "embedding"],
        properties: {
          collection: { type: "string" },
          id:         { type: "string" },
          embedding:  { type: "array", items: { type: "number" } },
        },
      },
    },
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { collection, id, embedding } = req.body;

    if (!await checkVectorExtension(db)) {
      return reply.code(501).send({ error: "pgvector extension not available. Install it: CREATE EXTENSION vector;", code: "GEN_005" });
    }

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    await ensureV2Tables(schemaName);

    const schema = quoteIdent(schemaName);

    // Ensure embedding column exists
    await db.query(`
      ALTER TABLE ${schema}._records ADD COLUMN IF NOT EXISTS embedding vector(${EMBEDDING_DIM})
    `).catch(() => {});

    // Create ivfflat index if not exists
    await db.query(`
      CREATE INDEX IF NOT EXISTS ${schemaName}_records_embedding_idx
      ON ${schema}._records USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)
    `).catch(() => {});

    await db.query(
      `UPDATE ${schema}._records SET embedding = $1 WHERE id = $2 AND collection = $3`,
      [`[${embedding.join(",")}]`, id, collection]
    );

    return { ok: true, id, collection };
  });

  // ── POST /records/vector/search ────────────────────────────────────────
  fastify.post("/records/vector/search", {
    preHandler: flexAuth,
    schema: {
      body: {
        type: "object",
        properties: {
          collection: { type: "string" },
          embedding:  { type: "array", items: { type: "number" } },
          query:      { type: "string" },
          limit:      { type: "integer", default: 10 },
          threshold:  { type: "number", default: 0.8 },
        },
      },
    },
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { collection, embedding, query, limit = 10, threshold = 0.8 } = req.body;

    if (!collection) return reply.code(400).send({ error: "collection is required", code: "GEN_002" });
    if (!embedding && !query) return reply.code(400).send({ error: "embedding or query is required", code: "GEN_002" });

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const perm = await checkPermissionV2(schemaName, collection, "list", req, reply);
    if (!perm.allowed) return;

    let searchEmbedding = embedding;

    // If query text provided but no embedding, use AI Gateway to generate it
    if (query && !embedding) {
      // Try to generate embedding via configured AI provider
      const settingsRows = await db.query(
        `SELECT ai_config FROM ${quoteIdent(schemaName)}._project_settings LIMIT 1`
      ).catch(() => ({ rows: [] }));

      if (settingsRows[0]?.ai_config?.api_key_encrypted) {
        // The client should have generated the embedding themselves
        return reply.code(400).send({
          error: "When using query text, generate the embedding via /ai/embed first and pass it as embedding parameter",
          code: "GEN_002",
        });
      }
    }

    if (!await checkVectorExtension(db)) {
      return reply.code(501).send({ error: "pgvector extension not available", code: "GEN_005" });
    }

    const schema = quoteIdent(schemaName);

    const limitNum = Math.min(100, Math.max(1, limit));

    const values = [collection, `[${searchEmbedding.join(",")}]`, threshold, limitNum];

    const { rows } = await db.query(
      `SELECT id, data, 1 - (embedding <=> $2::vector) AS _similarity
       FROM ${schema}._records
       WHERE collection = $1
         AND embedding IS NOT NULL
         AND 1 - (embedding <=> $2::vector) >= $3
         AND deleted_at IS NULL
       ORDER BY _similarity DESC
       LIMIT $4`,
      values
    );

    return {
      collection,
      results: rows.map(r => ({
        id: r.id,
        data: r.data,
        _similarity: parseFloat(r._similarity),
      })),
    };
  });
};
