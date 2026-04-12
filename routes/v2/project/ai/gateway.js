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
const { ensureV2Tables, ensureChatHistory } = require("../../../../lib/v2/schema");
const { apiError }       = require("../../../../lib/v2/errors");
const crypto             = require("crypto");

const APP_SECRET         = process.env.JWT_SECRET         || "fallback-secret-do-not-use-in-prod";
const PLATFORM_GROQ_KEY  = process.env.PLATFORM_GROQ_KEY  || null;
const PLATFORM_FREE_MODEL = "llama-3.1-8b-instant";   // fastest/cheapest on Groq free tier
const PLATFORM_FREE_LIMIT = 50;                        // req/day per project on platform key

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

const SUPPORTED_PROVIDERS = ["openai", "anthropic", "groq", "gemini"];

const DEFAULT_MODELS = {
  openai:    { chat: "gpt-4o-mini",              embed: "text-embedding-3-small" },
  anthropic: { chat: "claude-3-haiku-20240307" },
  groq:      { chat: "llama-3.3-70b-versatile" },
  gemini:    { chat: "gemini-1.5-flash",         embed: "text-embedding-004" },
};

const AI_API_URLS = {
  openai:    "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  groq:      "https://api.groq.com/openai/v1",
  gemini:    "https://generativelanguage.googleapis.com/v1beta/openai",
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

// Returns { apiKey, provider, model, isPlatform }
// Falls back to platform Groq key if project has no config.
async function resolveAICredentials(schemaName, overrideModel) {
  const config = await getAIConfig(schemaName);
  const hasOwnKey = config?.api_key_encrypted;

  if (hasOwnKey) {
    const provider = config.provider.toLowerCase();
    return {
      apiKey:     decryptValue(config.api_key_encrypted),
      provider,
      model:      overrideModel || config.model || DEFAULT_MODELS[provider]?.chat,
      isPlatform: false,
    };
  }

  // No project key — use platform free tier (Groq) if available
  if (PLATFORM_GROQ_KEY) {
    return {
      apiKey:     PLATFORM_GROQ_KEY,
      provider:   "groq",
      model:      PLATFORM_FREE_MODEL,
      isPlatform: true,
    };
  }

  return null;
}

async function checkPlatformRateLimit(schemaName) {
  // Count today's platform-key requests for this project
  const schema = quoteIdent(schemaName);
  const { rows } = await db.query(
    `SELECT COUNT(*) AS cnt FROM ${schema}._ai_usage
     WHERE endpoint = '/ai/chat:platform' AND created_at >= CURRENT_DATE`
  ).catch(() => ({ rows: [{ cnt: 0 }] }));
  return parseInt(rows[0].cnt) < PLATFORM_FREE_LIMIT;
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
  // projectRoute already imported from auth — registers both /:projectId/path and /path
  const pr = (method, path, opts, handler) => projectRoute(fastify, method.toUpperCase(), path, opts, handler);

  // ── POST /ai/chat ──────────────────────────────────────────────────────
  pr("post", "/ai/chat", {
    preHandler: flexAuth,
    schema: {
      body: {
        type: "object",
        required: ["messages"],
        properties: {
          messages:    { type: "array", items: { type: "object" } },
          model:       { type: "string" },
          stream:      { type: "boolean" },
          max_tokens:  { type: "integer" },
          temperature: { type: "number" },
          session_id:  { type: "string" },
        },
      },
    },
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;
    const { messages, model, stream, max_tokens, temperature, session_id } = req.body;
    const sessionId = session_id || "default";

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    await ensureChatHistory(schemaName);

    const creds = await resolveAICredentials(schemaName, model);
    if (!creds) {
      return reply.code(400).send({
        error: "AI not configured. Add your API key in the AI Gateway settings, or contact the platform admin.",
        code: "GEN_002",
      });
    }

    if (creds.isPlatform) {
      const allowed = await checkPlatformRateLimit(schemaName);
      if (!allowed) {
        return reply.code(429).send({
          error: `Free tier limit reached (${PLATFORM_FREE_LIMIT} req/day). Configure your own API key for unlimited usage.`,
          code: "RATE_LIMIT",
          hint: "Dashboard → AI Gateway → Config",
        });
      }
    }

    const { apiKey, provider } = creds;
    const baseUrl   = AI_API_URLS[provider];
    const chatModel = creds.model;
    const endpoint  = creds.isPlatform ? "/ai/chat:platform" : "/ai/chat";

    // ── Build system prompt with project context ───────────────────────────
    const schema = quoteIdent(schemaName);
    const [projRes, colRes, fieldRes, fnRes] = await Promise.all([
      db.query(`SELECT name, subdomain FROM projects WHERE id = $1 LIMIT 1`, [projectId]),
      db.query(`SELECT name FROM ${schema}._collections ORDER BY name`).catch(() => ({ rows: [] })),
      db.query(`SELECT collection, name, type, required FROM ${schema}._fields ORDER BY collection, name`).catch(() => ({ rows: [] })),
      db.query(`SELECT name FROM ${schema}._functions ORDER BY name`).catch(() => ({ rows: [] })),
    ]);

    const proj       = projRes.rows[0] ?? {};
    const projectUrl = proj.subdomain ? `https://${proj.subdomain}.matecito.dev` : "";

    const collectionsText = colRes.rows.length
      ? colRes.rows.map(c => {
          const fields = fieldRes.rows.filter(f => f.collection === c.name);
          const fStr   = fields.length
            ? fields.map(f => `    - ${f.name} (${f.type}${f.required ? ", required" : ""})`).join("\n")
            : "    - (sin fields definidos)";
          return `  - ${c.name}\n${fStr}`;
        }).join("\n")
      : "  (sin colecciones creadas aún)";

    const functionsText = fnRes.rows.length
      ? fnRes.rows.map(f => `  - ${f.name}`).join("\n")
      : "  (sin functions)";

    const systemPrompt = `Sos el asistente de desarrollo del proyecto "${proj.name ?? "Matecito"}" en Matecito BaaS.

## Tu rol
Ayudás al developer a:
- Usar el SDK matecitodb (JS/TS) y matecitodb_flutter (Flutter/Dart)
- Entender y operar las colecciones y datos de ESTE proyecto
- Escribir server functions, queries, reglas de permisos
- Integrar features: auth, storage, realtime, notificaciones, AI, forms, analytics, geo, sync

## Contexto de ESTE proyecto
- Nombre: ${proj.name ?? "-"}
- Base URL: ${projectUrl}
- SDK init: \`createClient('${projectUrl}', { apiKey: 'YOUR_ANON_KEY', apiVersion: 'v2' })\`

## Colecciones y schema
${collectionsText}

## Server Functions
${functionsText}

## Reglas
- SOLO hablás de este proyecto. Nunca mencionés ni inferís datos de otros proyectos.
- Si te preguntan por datos de otro proyecto: respondé "Solo tengo acceso al contexto de este proyecto."
- No ejecutás código real ni accedés a la DB directamente — solo generás código y explicaciones.
- Respondé en español salvo que el dev escriba en otro idioma.
- Sé conciso. Priorizá snippets de código sobre explicaciones largas.`;

    // Strip any system messages from client (security: prevent prompt injection)
    const userMessages = messages.filter((m) => m.role !== "system");

    const body = {
      model: chatModel,
      messages: [{ role: "system", content: systemPrompt }, ...userMessages],
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

        await logUsage(schemaName, chatModel, promptTokens, completionTokens, req.projectUser?.id, endpoint);
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
      await logUsage(schemaName, chatModel, usage.prompt_tokens || 0, usage.completion_tokens || 0, req.projectUser?.id, endpoint);

      // Count remaining free-tier requests for this project today
      let remainingToday = null;
      if (creds.isPlatform) {
        const { rows: usageRows } = await db.query(
          `SELECT COUNT(*) AS cnt FROM ${quoteIdent(schemaName)}._ai_usage
           WHERE endpoint = '/ai/chat:platform' AND created_at >= CURRENT_DATE`
        ).catch(() => ({ rows: [{ cnt: 0 }] }));
        remainingToday = Math.max(0, PLATFORM_FREE_LIMIT - parseInt(usageRows[0].cnt));
      }

      // Persist chat history (fire-and-forget)
      const assistantContent = data.choices?.[0]?.message?.content || "";
      const lastUserMsg = userMessages[userMessages.length - 1];
      if (lastUserMsg && assistantContent) {
        const sch = quoteIdent(schemaName);
        db.query(
          `INSERT INTO ${sch}._ai_chat_history (session_id, role, content, model) VALUES ($1,$2,$3,$4),($1,$5,$6,$4)`,
          [sessionId, lastUserMsg.role, lastUserMsg.content, chatModel, "assistant", assistantContent]
        ).catch(() => {});
      }

      return {
        id: data.id,
        model: data.model,
        choices: data.choices,
        usage: data.usage,
        ...(creds.isPlatform ? { platform_free: true, remaining_today: remainingToday } : {}),
      };
    } catch (err) {
      return reply.code(502).send({ error: `AI gateway error: ${err.message}`, code: "GEN_005" });
    }
  });

  // ── POST /ai/embed ─────────────────────────────────────────────────────
  pr("post", "/ai/embed", {
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

  // ── GET /ai/history ───────────────────────────────────────────────────
  pr("get", "/ai/history", { preHandler: flexAuth }, async (req, reply) => {
    const project    = req.resolvedProject;
    const projectId  = project?.id ?? req.params?.projectId;
    const sessionId  = req.query?.session_id || "default";
    const limit      = Math.min(parseInt(req.query?.limit || "100"), 200);

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    await ensureChatHistory(schemaName);
    const sch = quoteIdent(schemaName);

    const { rows } = await db.query(
      `SELECT id, session_id, role, content, model, created_at
       FROM ${sch}._ai_chat_history
       WHERE session_id = $1
       ORDER BY created_at ASC
       LIMIT $2`,
      [sessionId, limit]
    ).catch(() => ({ rows: [] }));

    // Also return remaining free-tier count
    let remainingToday = null;
    if (PLATFORM_GROQ_KEY) {
      const { rows: usageRows } = await db.query(
        `SELECT COUNT(*) AS cnt FROM ${sch}._ai_usage
         WHERE endpoint = '/ai/chat:platform' AND created_at >= CURRENT_DATE`
      ).catch(() => ({ rows: [{ cnt: 0 }] }));
      remainingToday = Math.max(0, PLATFORM_FREE_LIMIT - parseInt(usageRows[0].cnt));
    }

    return { messages: rows, remaining_today: remainingToday };
  });

  // ── DELETE /ai/history ─────────────────────────────────────────────────
  pr("delete", "/ai/history", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const project    = req.resolvedProject;
    const projectId  = project?.id ?? req.params?.projectId;
    const sessionId  = req.query?.session_id || "default";

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;
    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const sch = quoteIdent(schemaName);
    await db.query(`DELETE FROM ${sch}._ai_chat_history WHERE session_id = $1`, [sessionId]).catch(() => {});
    return { ok: true };
  });

  // ── GET /ai/usage ──────────────────────────────────────────────────────
  pr("get", "/ai/usage", {
    preHandler: flexAuth,
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");
    await ensureChatHistory(schemaName);

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
  pr("put", "/project/ai-config", {
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
      `INSERT INTO ${schema}._project_settings (ai_config)
       VALUES ($1)
       ON CONFLICT (id) DO UPDATE SET ai_config = EXCLUDED.ai_config`,
      [JSON.stringify(config)]
    ).catch(async () => {
      // _project_settings may not exist yet — run ensureV2Tables and retry once
      await ensureV2Tables(schemaName).catch(() => {});
      await db.query(
        `INSERT INTO ${schema}._project_settings (ai_config)
         VALUES ($1)
         ON CONFLICT (id) DO UPDATE SET ai_config = EXCLUDED.ai_config`,
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
