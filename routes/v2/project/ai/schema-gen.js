// ─── AI Schema Generation (H2) ─────────────────────────────────────────────
//
// POST /ai/schema        → describir en lenguaje natural → sugiere schema
// POST /ai/schema/apply  → aplica el schema sugerido
//
// Usa el AI Gateway configurado para generar el schema.

const {
  db,
  requireProjectOrPlatformAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { ensureV2Tables } = require("../../../../lib/v2/schema");
const { apiError }       = require("../../../../lib/v2/errors");
const crypto             = require("crypto");

const APP_SECRET = process.env.JWT_SECRET || "fallback-secret-do-not-use-in-prod";

function encryptValue(value) {
  const key = crypto.scryptSync(APP_SECRET, "ai-schema-gen-salt", 32);
  const iv  = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  let encrypted = cipher.update(value, "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}

function decryptValueSchema(value) {
  const [ivHex, ...restHex] = value.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const encryptedText = restHex.join(":");
  const key = crypto.scryptSync(APP_SECRET, "ai-schema-gen-salt", 32);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  let decrypted = decipher.update(encryptedText, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

async function getDecryptedApiKey(schemaName) {
  const schema = quoteIdent(schemaName);
  const { rows } = await db.query(
    `SELECT ai_config FROM ${schema}._project_settings LIMIT 1`
  ).catch(() => ({ rows: [] }));

  if (!rows[0] || !rows[0].ai_config?.api_key_encrypted) return null;
  return decryptValueSchema(rows[0].ai_config.api_key_encrypted);
}

const SYSTEM_PROMPT = `You are a database schema designer. Given a description of an application, design a complete collection and field schema.

Response ONLY with valid JSON in this exact format:
{
  "collections": [
    {
      "name": "collection_name",
      "fields": [
        { "name": "field_name", "type": "text|number|boolean|date|json|relation", "required": true|false }
      ],
      "permissions": { "list": "public", "get": "public", "create": "auth", "update": "auth", "delete": "service" }
    }
  ]
}

Rules:
- Collection names: lowercase, plural, snake_case
- Field names: lowercase, snake_case
- Types: text, number, boolean, date, json, relation
- Always include created_by, created_at fields
- Permissions: public, auth, service, nobody`;

module.exports = async function (fastify) {
  // ── POST /ai/schema ────────────────────────────────────────────────────
  fastify.post("/ai/schema", {
    preHandler: requireProjectOrPlatformAuth,
    schema: {
      body: {
        type: "object",
        required: ["description"],
        properties: {
          description: { type: "string", minLength: 10 },
        },
      },
    },
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { description } = req.body;

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const apiKey = await getDecryptedApiKey(schemaName);
    if (!apiKey) return reply.code(400).send({ error: "AI not configured. Set ai-config first.", code: "GEN_002" });

    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: description },
          ],
          temperature: 0.3,
        }),
        signal: AbortSignal.timeout(30000),
      });

      const data = await res.json();
      if (!res.ok) {
        return reply.code(res.status).send({ error: data.error?.message || "AI request failed" });
      }

      let parsed;
      try {
        const content = data.choices[0].message.content;
        // Extract JSON from markdown if wrapped
        const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(jsonMatch ? jsonMatch[1] || jsonMatch[0] : content);
      } catch {
        return reply.code(502).send({ error: "AI returned invalid JSON schema" });
      }

      return {
        suggested_collections: parsed.collections || [],
        apply_url: "POST /ai/schema/apply",
      };
    } catch (err) {
      return reply.code(502).send({ error: `AI schema error: ${err.message}` });
    }
  });

  // ── POST /ai/schema/apply ──────────────────────────────────────────────
  fastify.post("/ai/schema/apply", {
    preHandler: requireProjectOrPlatformAuth,
    schema: {
      body: {
        type: "object",
        required: ["collections"],
        properties: {
          collections: {
            type: "array",
            items: {
              type: "object",
              required: ["name", "fields"],
              properties: {
                name: { type: "string" },
                fields: { type: "array" },
                permissions: { type: "object" },
              },
            },
          },
        },
      },
    },
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { collections } = req.body;

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    await ensureV2Tables(schemaName);

    const schema = quoteIdent(schemaName);
    const results = [];

    for (const col of collections) {
      try {
        // Create collection
        const perm = col.permissions || { list: "public", get: "public", create: "auth", update: "auth", delete: "service" };

        await db.query(
          `INSERT INTO ${schema}._collections (name, permissions) VALUES ($1, $2)`,
          [col.name, JSON.stringify(perm)]
        );

        // Create fields
        for (const field of (col.fields || [])) {
          await db.query(
            `INSERT INTO ${schema}._fields (collection, name, type, required)
             VALUES ($1, $2, $3, $4)`,
            [col.name, field.name, field.type || "text", field.required || false]
          );
        }

        // Create default permissions
        const ops = ["list", "get", "create", "update", "delete"];
        for (const op of ops) {
          await db.query(
            `INSERT INTO ${schema}._permissions (collection, operation, access_level)
             VALUES ($1, $2, $3)`,
            [col.name, op, perm[op] || "auth"]
          );
        }

        results.push({ collection: col.name, status: "created" });
      } catch (err) {
        results.push({ collection: col.name, status: "error", error: err.message });
      }
    }

    return reply.code(201).send({ created: results.filter(r => r.status === "created").length, results });
  });
};
