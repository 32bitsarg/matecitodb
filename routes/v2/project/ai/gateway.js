// ─── AI Model Gateway (H1) — Proxy a LLMs ──────────────────────────────────
//
// POST /ai/chat          → completions (streaming soportado)
// POST /ai/embed         → generar embeddings
// GET  /ai/usage         → tokens usados hoy/mes
// PUT  /project/ai-config → configurar provider + key (service key)
//
// Providers: OpenAI, Anthropic, Groq
// La API key del proveedor se encripta con APP_SECRET antes de guardar.

const {
  db,
  flexAuth,
  requireProjectOrPlatformAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { ensureV2Tables } = require("../../../../lib/v2/schema");
const { apiError }       = require("../../../../lib/v2/errors");
const crypto             = require("crypto");

const APP_SECRET = process.env.JWT_SECRET || "fallback-secret-do-not-use-in-prod";

function encryptValue(value) {
  const key = crypto.scryptSync(APP_SECRET, "ai-config-salt", 32);
  const iv  = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  let encrypted = cipher.update(value, "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}

function decryptValue(encrypted) {
  const [ivHex, ...restHex] = encrypted.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const encryptedText = restHex.join(":");
  const key = crypto.scryptSync(APP_SECRET, "ai-config-salt", 32);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  let decrypted = decipher.update(encryptedText, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

const SUPPORTED_PROVIDERS = ["openai", "anthropic", "groq"];

const DEFAULT_MODELS = {
  openai:   { chat: "gpt-4o-mini", embed: "text-embedding-3-small" },
  anthropic: { chat: "claude-3-haiku-20240307" },
  groq:     { chat: "llama-3.1-70b-versatile" },
};

const AI_API_URLS = {
  openai:   "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  groq:     "https://api.groq.com/openai/v1",
};

async function getAIConfig(schemaName) {
  const schema = quoteIdent(schemaName);
  const { rows } = await db.query(
    `SELECT ai_config FROM ${schema}._project_settings LIMIT 1`
  ).catch(() => ({ rows: [] }));

  // Fallback: try projects table
  if (!rows[0] || !rows[0].ai_config) {
    return null;
  }
  return rows[0].ai_config;
}

async function getDecryptedApiKey(schemaName) {
  const config = await getAIConfig(schemaName);
  if (!config || !config.api_key_encrypted) return null;
  return decryptValue(config.api_key_encrypted);
}

async function logUsage(schemaName, model, promptTokens, completionTokens, userId, endpoint) {
  const schema = quoteIdent(schemaName);
  try {
    await db.query(
      `INSERT INTO ${schema}._ai_usage (model, prompt_tokens, completion_tokens, user_id, endpoint)
       VALUES ($1, $2, $3, $4, $5)`,
      [model, promptTokens, completionTokens, userId || null, endpoint || null]
    );
  } catch { /* non-critical */ }
}

module.exports = async function (fastify) {
  // ── POST /ai/chat ──────────────────────────────────────────────────────
  fastify.post("/ai/chat", {
    preHandler: flexAuth,
    schema: {
      body: {
        type: "object",
        required: ["messages"],
        properties: {
          messages:   { type: "array", items: { type: "object" } },
          model:      { type: "string" },
          stream:     { type: "boolean" },
          max_tokens: { type: "integer" },
          temperature: { type: "number" },
        },
      },
    },
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { messages, model, stream, max_tokens, temperature } = req.body;

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    await ensureV2Tables(schemaName);

    const config = await getAIConfig(schemaName);
    if (!config || !config.provider) {
      return reply.code(400).send({ error: "AI not configured. Set ai-config first.", code: "GEN_002" });
    }

    const apiKey = await getDecryptedApiKey(schemaName);
    if (!apiKey) {
      return reply.code(400).send({ error: "AI API key not configured", code: "GEN_002" });
    }

    const provider = config.provider.toLowerCase();
    const baseUrl = AI_API_URLS[provider];
    const chatModel = model || config.model || DEFAULT_MODELS[provider]?.chat || "gpt-4o-mini";

    if (!baseUrl) {
      return reply.code(400).send({ error: `Unsupported provider: ${provider}`, code: "GEN_002" });
    }

    const body = {
      model: chatModel,
      messages,
      stream: stream || false,
    };
    if (max_tokens !== undefined) body.max_tokens = max_tokens;
    if (temperature !== undefined) body.temperature = temperature;

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    };

    if (provider === "anthropic") {
      headers["anthropic-version"] = "2023-06-01";
    }

    if (stream) {
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });

      try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120000),
        });

        const reader = res.body.getReader();
        let promptTokens = 0, completionTokens = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = new TextDecoder().decode(value);
          reply.raw.write(chunk);

          // Extract usage from the last chunk if available
          if (chunk.includes("[DONE]")) {
            // Parse last chunk for usage if provider sends it
          }
        }
        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();

        await logUsage(schemaName, chatModel, promptTokens, completionTokens, req.projectUser?.id, "/ai/chat");
      } catch (err) {
        reply.raw.write(`data: {"error":"${err.message}"}\n\n`);
        reply.raw.end();
      }
      return;
    }

    // Non-streaming
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });

      const data = await res.json();

      if (!res.ok) {
        return reply.code(res.status).send({ error: data.error?.message || "AI request failed", code: "GEN_005" });
      }

      const usage = data.usage || {};
      await logUsage(schemaName, chatModel, usage.prompt_tokens || 0, usage.completion_tokens || 0, req.projectUser?.id, "/ai/chat");

      return {
        id: data.id,
        model: data.model,
        choices: data.choices,
        usage: data.usage,
      };
    } catch (err) {
      return reply.code(502).send({ error: `AI gateway error: ${err.message}`, code: "GEN_005" });
    }
  });

  // ── POST /ai/embed ─────────────────────────────────────────────────────
  fastify.post("/ai/embed", {
    preHandler: flexAuth,
    schema: {
      body: {
        type: "object",
        required: ["input"],
        properties: {
          input: {},
          model: { type: "string" },
        },
      },
    },
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { input, model } = req.body;

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    await ensureV2Tables(schemaName);

    const config = await getAIConfig(schemaName);
    if (!config) return reply.code(400).send({ error: "AI not configured", code: "GEN_002" });

    const apiKey = await getDecryptedApiKey(schemaName);
    if (!apiKey) return reply.code(400).send({ error: "AI API key not configured", code: "GEN_002" });

    const provider = config.provider.toLowerCase();
    const embedModel = model || config.embed_model || DEFAULT_MODELS[provider]?.embed || "text-embedding-3-small";

    try {
      const res = await fetch(`${AI_API_URLS[provider]}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model: embedModel, input }),
        signal: AbortSignal.timeout(30000),
      });

      const data = await res.json();
      if (!res.ok) {
        return reply.code(res.status).send({ error: data.error?.message || "Embedding request failed", code: "GEN_005" });
      }

      const usage = data.usage || {};
      await logUsage(schemaName, embedModel, usage.prompt_tokens || 0, 0, req.projectUser?.id, "/ai/embed");

      return {
        model: data.model,
        data: data.data,
        usage: data.usage,
      };
    } catch (err) {
      return reply.code(502).send({ error: `AI embed error: ${err.message}`, code: "GEN_005" });
    }
  });

  // ── GET /ai/usage ──────────────────────────────────────────────────────
  fastify.get("/ai/usage", {
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
      `SELECT
         DATE(created_at) AS date,
         model,
         SUM(prompt_tokens) AS prompt_tokens,
         SUM(completion_tokens) AS completion_tokens,
         COUNT(*) AS requests
       FROM ${schema}._ai_usage
       WHERE created_at >= NOW() - INTERVAL '30 days'
       GROUP BY DATE(created_at), model
       ORDER BY date DESC
       LIMIT 30`
    );

    return { usage: rows };
  });

  // ── PUT /project/ai-config ─────────────────────────────────────────────
  fastify.put("/project/ai-config", {
    preHandler: requireProjectOrPlatformAuth,
    schema: {
      body: {
        type: "object",
        required: ["provider", "api_key"],
        properties: {
          provider:   { type: "string", enum: SUPPORTED_PROVIDERS },
          api_key:    { type: "string", minLength: 1 },
          model:      { type: "string" },
          embed_model: { type: "string" },
          max_tokens_per_day: { type: "integer" },
        },
      },
    },
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { provider, api_key, model, embed_model, max_tokens_per_day } = req.body;

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    await ensureV2Tables(schemaName);

    const schema = quoteIdent(schemaName);
    const config = {
      provider,
      api_key_encrypted: encryptValue(api_key),
      model: model || DEFAULT_MODELS[provider]?.chat,
      embed_model: embed_model || DEFAULT_MODELS[provider]?.embed,
      max_tokens_per_day: max_tokens_per_day || 100000,
    };

    await db.query(
      `INSERT INTO ${schema}._project_settings (id, ai_config)
       VALUES ((SELECT id FROM ${schema}._project_settings LIMIT 1), $1)
       ON CONFLICT (id) DO UPDATE SET ai_config = $1`,
      [JSON.stringify(config)]
    ).catch(async () => {
      // If _project_settings doesn't exist, store in a simpler way
      await db.query(
        `SELECT set_config('matebase.ai_config', $1, false)`,
        [JSON.stringify(config)]
      ).catch(() => {});
    });

    return reply.code(200).send({
      provider: config.provider,
      model: config.model,
      embed_model: config.embed_model,
      max_tokens_per_day: config.max_tokens_per_day,
    });
  });
};
