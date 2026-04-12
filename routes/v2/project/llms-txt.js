// ─── llms.txt (K2) — AI agent context file ───────────────────────────────────
//
// GET /llms.txt  → returns a plain-text Markdown description of the project's
//                  schema, SDK surface, and MCP integration for AI agents
//                  (Claude, Cursor, GPT, etc.)
//
// Standard: https://llmstxt.org
//
// Access control:
//   - If project.llms_txt_public = true  → anyone can access (no key required)
//   - If project.llms_txt_public = false → requires valid anon or service key
//     (x-matecito-key header or ?key= query param)

const { db, quoteIdent, projectRoute, flexAuth } = require("../../../../lib/v2/auth");

module.exports = async function (fastify) {
  projectRoute(fastify, "GET", "/llms.txt", {}, async (req, reply) => {
    const project    = req.resolvedProject;
    const projectId  = project?.id ?? req.params?.projectId;

    // ── Access control ─────────────────────────────────────────────────────
    // Check if llms_txt_public is enabled for this project
    const isPublic = project?.llms_txt_public ?? (await db.query(
      `SELECT COALESCE(llms_txt_public, false) AS llms_txt_public FROM projects WHERE id = $1 LIMIT 1`,
      [projectId]
    ).then(r => r.rows[0]?.llms_txt_public).catch(() => false));

    if (!isPublic) {
      // Require a valid API key (anon or service)
      const rawKey = req.headers["x-matecito-key"] || req.query?.key;
      if (!rawKey) {
        return reply
          .code(401)
          .header("WWW-Authenticate", 'Bearer realm="matecito"')
          .send({
            error: "This project's llms.txt is private. Provide a valid API key via x-matecito-key header, or enable public access in project Settings.",
            hint: "Settings → Configuración Avanzada → Hacer llms.txt público",
          });
      }

      // Validate the key belongs to this project
      const { rows: keyRows } = await db.query(
        `SELECT id FROM api_keys WHERE key = $1 AND project_id = $2 AND revoked_at IS NULL LIMIT 1`,
        [rawKey, projectId]
      ).catch(() => ({ rows: [] }));

      if (!keyRows[0]) {
        return reply.code(403).send({ error: "Invalid or revoked API key." });
      }
    }
    // ── End access control ─────────────────────────────────────────────────
    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name, name, subdomain FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    const projectName    = project?.name    ?? (await db.query(`SELECT name    FROM projects WHERE id=$1 LIMIT 1`, [projectId])).rows[0]?.name    ?? "Matecito Project";
    const projectSubdomain = project?.subdomain ?? (await db.query(`SELECT subdomain FROM projects WHERE id=$1 LIMIT 1`, [projectId])).rows[0]?.subdomain ?? "";
    const baseUrl        = `https://${projectSubdomain}.matecito.dev`;

    // Fetch schema, forms, functions in parallel
    let collections = [], fields = [], forms = [], functions = [];
    if (schemaName) {
      const s = quoteIdent(schemaName);
      [collections, fields, forms, functions] = await Promise.all([
        db.query(`SELECT name FROM ${s}._collections ORDER BY name`).then(r => r.rows).catch(() => []),
        db.query(`SELECT collection, name, type, required FROM ${s}._fields ORDER BY collection, name`).then(r => r.rows).catch(() => []),
        db.query(`SELECT name, collection FROM ${s}._forms ORDER BY name`).then(r => r.rows).catch(() => []),
        db.query(`SELECT name FROM ${s}._functions ORDER BY name`).then(r => r.rows).catch(() => []),
      ]);
    }

    // Build schema section
    const schemaLines = [];
    for (const col of collections) {
      const colFields = fields.filter(f => f.collection === col.name);
      schemaLines.push(`### ${col.name}`);
      if (colFields.length) {
        for (const f of colFields) {
          schemaLines.push(`- \`${f.name}\` (${f.type}${f.required ? ", required" : ""})`);
        }
      } else {
        schemaLines.push("- *(no fields defined)*");
      }
      schemaLines.push("");
    }

    // Build forms section
    const formsLines = forms.length
      ? forms.map(f => [
          `### ${f.name}`,
          `- Collection: \`${f.collection}\``,
          `- Public URL: \`POST ${baseUrl}/f/${f.name}\``,
          `- SDK: \`db.forms.submitPublic('${f.name}', { ...fields })\``,
          "",
        ].join("\n"))
      : ["*(no forms defined)*", ""];

    // Build functions section
    const fnLines = functions.length
      ? functions.map(f => `- \`${f.name}\` — \`db.functions.invoke('${f.name}', { ...args })\``)
      : ["*(no functions defined)*"];

    const md = `# ${projectName}

> **Base URL:** ${baseUrl}
> **API Version:** v2
> **SDK:** \`npm install matecitodb\` (JS/TS) or \`matecitodb_flutter\` (Flutter/Dart)
> **Generated:** ${new Date().toISOString()}

---

## SDK Initialization

\`\`\`ts
import { createClient } from 'matecitodb'

const db = createClient('${baseUrl}', {
  apiKey: 'YOUR_ANON_KEY',  // from dashboard → Connect
  apiVersion: 'v2',
})
\`\`\`

---

## Authentication

\`\`\`ts
await db.auth.signUp(email, password)
await db.auth.signIn(email, password)
await db.auth.signOut()
await db.auth.getMe()          // { user }
await db.auth.refreshSession()
\`\`\`

---

## Collections & Schema

${schemaLines.join("\n") || "*(no collections defined yet)*"}

---

## Data Operations

\`\`\`ts
// Read
const { data } = await db.from('collection').get()
const { data } = await db.from('collection').where('field', '=', value).get()
const { data } = await db.from('collection').limit(20).offset(0).get()
const { data } = await db.from('collection').orderBy('created_at', 'desc').get()

// Write
const { data } = await db.from('collection').create({ field: value })
const { data } = await db.from('collection').update(id, { field: value })
await db.from('collection').delete(id)

// Realtime
db.from('collection').subscribe((event) => console.log(event))

// Batch (atomic)
const result = await db.batch()
  .atomic()
  .insert('orders', { product_id: 'p1', qty: 2 })
  .update('p1', { stock: 98 }, { collection: 'products' })
  .execute()
\`\`\`

---

## Storage

\`\`\`ts
await db.storage.upload(file, { bucket: 'default' })
await db.storage.list()
await db.storage.delete(id)
await db.storage.getSignedUrl(id)
\`\`\`

---

## Notifications

\`\`\`ts
// Push (requires Firebase config)
await db.notifications.registerToken(fcmToken)
await db.notifications.send({ userIds: ['user-1'], title: 'Hello', body: 'World' })

// In-app
await db.notifications.sendInApp({ userIds: ['user-1'], title: 'Hello', type: 'info' })
await db.notifications.listMy({ limit: 20 })
await db.notifications.unreadCount()
await db.notifications.markAsRead(id)
await db.notifications.readAll()
\`\`\`

---

## Server Functions

${fnLines.join("\n")}

\`\`\`ts
const { data } = await db.functions.invoke('functionName', { arg1: 'value' })
\`\`\`

---

## Analytics

\`\`\`ts
await db.analytics.track('page_view', { url: '/home', userId: 'u1' })
const { data } = await db.analytics.getEvents({ from: '2024-01-01', to: '2024-12-31' })
const { data } = await db.analytics.getFunnel({ steps: ['signup', 'onboarding', 'purchase'] })
\`\`\`

---

## AI Gateway

\`\`\`ts
const { data } = await db.ai.chat({
  messages: [{ role: 'user', content: 'Hello' }]
})
const { data } = await db.ai.embed({ input: 'text to embed' })
const { data } = await db.ai.getUsage()
\`\`\`

---

## Remote Config (Feature Flags)

\`\`\`ts
const { data } = await db.remoteConfig.getAll()
const { data } = await db.remoteConfig.get('feature_flag_key')
\`\`\`

---

## Forms

${formsLines.join("\n")}

---

## Geo

\`\`\`ts
const { data } = await db.geo.near('stores', lat, lng, { radiusKm: 5 })
const { data } = await db.geo.bounds('stores', { north, south, east, west })
const { data } = await db.geo.batchDistance('stores', { lat, lng }, ['id1', 'id2'])
\`\`\`

---

## Sync (Offline-first)

\`\`\`ts
const { data } = await db.sync.pull({ collection: 'todos', since: lastSyncTimestamp })
await db.sync.push({ collection: 'todos', changes: localChanges, conflictStrategy: 'server_wins' })
\`\`\`

---

## Security

\`\`\`ts
await db.security.listIpRules()
await db.security.addIpRule({ ip: '1.2.3.4', action: 'allow' })
await db.security.listRateLimits()
\`\`\`

---

## Cache

\`\`\`ts
await db.cache.setRule({ collection: 'products', ttl: 300 })
await db.cache.listRules()
await db.cache.invalidate('products')
\`\`\`

---

## Schema Introspection

\`\`\`ts
const { data } = await db.schema.introspect()    // full schema
const { data } = await db.schema.migrations()    // migration history
const { data } = await db.schema.explain(query)  // query explain
\`\`\`

---

## SQL (raw)

\`\`\`ts
const { data } = await db.sql.query('SELECT * FROM _records WHERE collection = $1', ['posts'])
\`\`\`

---

## MCP Integration (AI Agents)

Connect any MCP-compatible AI agent directly to this project's live data:

- **WebSocket URL:** \`wss://${projectSubdomain}.matecito.dev/api/v2/project/mcp\`
- **Auth header:** \`x-matecito-key: YOUR_SERVICE_KEY\`
- **Protocol:** JSON-RPC 2.0 over WebSocket (MCP spec 2024-11-05)

**Available tools (17):**
list_collections, query_records, create_record, update_record, delete_record,
get_schema, run_function, list_users, send_notification, invoke_function,
track_event, get_storage_files, list_forms, get_form_submissions,
get_project_config, list_api_keys, get_project_stats

**Claude Code config** (add to \`.claude/settings.json\`):
\`\`\`json
{
  "mcpServers": {
    "matecito-${projectSubdomain}": {
      "transport": "websocket",
      "url": "wss://${projectSubdomain}.matecito.dev/api/v2/project/mcp",
      "headers": { "x-matecito-key": "YOUR_SERVICE_KEY" }
    }
  }
}
\`\`\`
`;

    return reply
      .type("text/plain; charset=utf-8")
      .header("Cache-Control", "public, max-age=300")
      .send(md);
  });
};
