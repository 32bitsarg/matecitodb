const crypto = require("crypto");
const {
  db,
  requireProjectOrPlatformAuth,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { apiError } = require("../../../../lib/v2/errors");

const VALID_EVENTS = new Set(["record.created", "record.updated", "record.deleted", "*"]);
const MAX_WEBHOOKS = 20;

async function resolveSchema(req) {
  const project    = req.resolvedProject;
  const projectId  = project?.id ?? req.params?.projectId;
  const schemaName = project?.schema_name ?? (await db.query(
    `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
  )).rows[0]?.schema_name;
  return { schemaName, projectId };
}

module.exports = async function (fastify) {
  // GET /webhooks
  projectRoute(fastify, "GET", "/webhooks", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const { schemaName } = await resolveSchema(req);
    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const s = quoteIdent(schemaName);
    const { rows } = await db.query(
      `SELECT id, collection, event, url, enabled, filter_rule, created_at FROM ${s}._webhooks ORDER BY created_at DESC`
    );
    return { webhooks: rows };
  });

  // POST /webhooks
  projectRoute(fastify, "POST", "/webhooks", {
    preHandler: requireProjectOrPlatformAuth,
    schema: {
      body: {
        type: "object",
        required: ["url"],
        additionalProperties: false,
        properties: {
          collection:  { type: "string", default: "*" },
          event:       { type: "string", enum: [...VALID_EVENTS], default: "*" },
          url:         { type: "string", format: "uri", maxLength: 2048 },
          secret:      { type: "string", maxLength: 256 },
          filter_rule: { type: "string", maxLength: 512 },
        },
      },
    },
  }, async (req, reply) => {
    const { schemaName } = await resolveSchema(req);
    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const s = quoteIdent(schemaName);
    const { collection = "*", event = "*", url, secret, filter_rule } = req.body;

    const { rows: count } = await db.query(`SELECT COUNT(*)::int AS n FROM ${s}._webhooks`);
    if (count[0].n >= MAX_WEBHOOKS) {
      return reply.code(400).send({ error: `Maximum ${MAX_WEBHOOKS} webhooks per project`, code: "GEN_002" });
    }

    const { rows } = await db.query(
      `INSERT INTO ${s}._webhooks (collection, event, url, secret, filter_rule)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, collection, event, url, enabled, filter_rule, created_at`,
      [collection, event, url, secret || null, filter_rule || null]
    );
    return reply.code(201).send({ webhook: rows[0] });
  });

  // PATCH /webhooks/:webhookId
  projectRoute(fastify, "PATCH", "/webhooks/:webhookId", {
    preHandler: requireProjectOrPlatformAuth,
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          url:        { type: "string", format: "uri", maxLength: 2048 },
          secret:     { type: "string" },
          enabled:    { type: "boolean" },
          collection: { type: "string" },
          event:      { type: "string", enum: [...VALID_EVENTS] },
        },
      },
    },
  }, async (req, reply) => {
    const { schemaName } = await resolveSchema(req);
    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const s = quoteIdent(schemaName);
    const { webhookId } = req.params;
    const { url, secret, enabled, collection, event } = req.body ?? {};

    const { rows } = await db.query(
      `UPDATE ${s}._webhooks SET
         url        = COALESCE($1, url),
         secret     = CASE WHEN $2::text IS NOT NULL THEN $2 ELSE secret END,
         enabled    = COALESCE($3, enabled),
         collection = COALESCE($4, collection),
         event      = COALESCE($5, event)
       WHERE id = $6
       RETURNING id, collection, event, url, enabled, created_at`,
      [url ?? null, secret ?? null, enabled ?? null, collection ?? null, event ?? null, webhookId]
    );

    if (!rows[0]) return apiError(reply, "GEN_003", "Webhook not found");
    return { webhook: rows[0] };
  });

  // DELETE /webhooks/:webhookId
  projectRoute(fastify, "DELETE", "/webhooks/:webhookId", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const { schemaName } = await resolveSchema(req);
    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const s = quoteIdent(schemaName);
    const { rows } = await db.query(`DELETE FROM ${s}._webhooks WHERE id = $1 RETURNING id`, [req.params.webhookId]);
    if (!rows[0]) return apiError(reply, "GEN_003", "Webhook not found");
    return { ok: true };
  });

  // POST /webhooks/:webhookId/test
  projectRoute(fastify, "POST", "/webhooks/:webhookId/test", {
    preHandler: requireProjectOrPlatformAuth,
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const { schemaName } = await resolveSchema(req);
    if (!schemaName) return apiError(reply, "GEN_003", "Project not found");

    const s = quoteIdent(schemaName);
    const { rows } = await db.query(
      `SELECT id, url, secret, collection, event FROM ${s}._webhooks WHERE id = $1 LIMIT 1`,
      [req.params.webhookId]
    );
    if (!rows[0]) return apiError(reply, "GEN_003", "Webhook not found");

    const hook = rows[0];
    const body = JSON.stringify({
      event:      hook.event === "*" ? "record.created" : hook.event,
      collection: hook.collection === "*" ? "example" : hook.collection,
      record: {
        id:         "00000000-0000-0000-0000-000000000000",
        collection: hook.collection === "*" ? "example" : hook.collection,
        data:       { _test: true, message: "This is a test payload from Matebase" },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      timestamp: new Date().toISOString(),
      _test: true,
    });

    const headers = {
      "Content-Type":      "application/json",
      "X-Matecito-Event":  "test",
      "X-Matecito-Schema": schemaName,
    };

    if (hook.secret) {
      const sig = crypto.createHmac("sha256", hook.secret).update(body).digest("hex");
      headers["X-Matecito-Signature"] = `sha256=${sig}`;
    }

    const start = Date.now();
    try {
      const res = await fetch(hook.url, {
        method:  "POST",
        headers,
        body,
        signal:  AbortSignal.timeout(10_000),
      });
      return {
        ok:          res.ok,
        status:      res.status,
        response_ms: Date.now() - start,
        url:         hook.url,
      };
    } catch (err) {
      return {
        ok:          false,
        status:      null,
        response_ms: Date.now() - start,
        url:         hook.url,
        error:       err.message,
      };
    }
  });
};
