const { db, requireProjectOrPlatformAuth, quoteIdent, projectRoute } = require("../../../lib/matecito");

const VALID_EVENTS     = new Set(["record.created", "record.updated", "record.deleted", "*"]);
const MAX_WEBHOOKS     = 20;

async function resolveSchema(req) {
  const project   = req.resolvedProject;
  const projectId = project?.id ?? req.params?.projectId;
  const schemaName = project?.schema_name ?? (await db.query(
    `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
  )).rows[0]?.schema_name;
  return { schemaName, projectId };
}

module.exports = async function (fastify) {
  // GET /webhooks — listar todos
  projectRoute(fastify, "GET", "/webhooks", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const { schemaName } = await resolveSchema(req);
    if (!schemaName) return reply.code(404).send({ error: "Project not found" });
    const s = quoteIdent(schemaName);

    const { rows } = await db.query(
      `SELECT id, collection, event, url, enabled, created_at FROM ${s}._webhooks ORDER BY created_at DESC`
    );
    return { webhooks: rows };
  });

  // POST /webhooks — crear webhook
  projectRoute(fastify, "POST", "/webhooks", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const { schemaName } = await resolveSchema(req);
    if (!schemaName) return reply.code(404).send({ error: "Project not found" });
    const s = quoteIdent(schemaName);

    const { collection = "*", event = "*", url, secret } = req.body ?? {};

    if (!url || typeof url !== "string") {
      return reply.code(400).send({ error: "url is required" });
    }
    if (!url.startsWith("https://") && !url.startsWith("http://")) {
      return reply.code(400).send({ error: "url must start with http:// or https://" });
    }
    if (!VALID_EVENTS.has(event)) {
      return reply.code(400).send({ error: `event must be one of: ${[...VALID_EVENTS].join(", ")}` });
    }

    // Límite de webhooks por proyecto
    const { rows: count } = await db.query(`SELECT COUNT(*)::int AS n FROM ${s}._webhooks`);
    if (count[0].n >= MAX_WEBHOOKS) {
      return reply.code(400).send({ error: `Maximum ${MAX_WEBHOOKS} webhooks per project` });
    }

    const { rows } = await db.query(
      `INSERT INTO ${s}._webhooks (collection, event, url, secret)
       VALUES ($1, $2, $3, $4)
       RETURNING id, collection, event, url, enabled, created_at`,
      [collection, event, url, secret || null]
    );
    return reply.code(201).send({ webhook: rows[0] });
  });

  // PATCH /webhooks/:id — habilitar/deshabilitar o actualizar URL
  projectRoute(fastify, "PATCH", "/webhooks/:webhookId", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const { schemaName } = await resolveSchema(req);
    if (!schemaName) return reply.code(404).send({ error: "Project not found" });
    const s = quoteIdent(schemaName);

    const { webhookId } = req.params;
    const { url, secret, enabled, collection, event } = req.body ?? {};

    if (event !== undefined && !VALID_EVENTS.has(event)) {
      return reply.code(400).send({ error: `event must be one of: ${[...VALID_EVENTS].join(", ")}` });
    }

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

    if (!rows[0]) return reply.code(404).send({ error: "Webhook not found" });
    return { webhook: rows[0] };
  });

  // DELETE /webhooks/:id
  projectRoute(fastify, "DELETE", "/webhooks/:webhookId", { preHandler: requireProjectOrPlatformAuth }, async (req, reply) => {
    const { schemaName } = await resolveSchema(req);
    if (!schemaName) return reply.code(404).send({ error: "Project not found" });
    const s = quoteIdent(schemaName);

    const { webhookId } = req.params;
    const { rows } = await db.query(
      `DELETE FROM ${s}._webhooks WHERE id = $1 RETURNING id`, [webhookId]
    );
    if (!rows[0]) return reply.code(404).send({ error: "Webhook not found" });
    return { ok: true };
  });
};
