# Matebase API v2 — Roadmap Fase 2
### Análisis competitivo vs Supabase · Firebase · InsForge

> Todo bajo `/api/v2/`. `/api/v1` no se toca.
> Fases A–E anteriores: **100% implementadas**.
> Este documento cubre la **siguiente ronda de features**.

---

## Estado actual

| Feature | Fase | Estado |
|---|---|---|
| **G1** Full-text search | G | ✅ Implementado |
| **I1** Remote Config / Feature Flags | I | ✅ Implementado |
| **G2** Filtros avanzados (OR, range, null, arrays) | G | ✅ Implementado |
| **J2** Notification Center | J | ✅ Implementado |
| **F1** Functions lite | F | ✅ Implementado |
| **F2** Triggers | F | ✅ Implementado |
| **H1** AI Model Gateway | H | ✅ Implementado |
| **I2** Event Analytics | I | ✅ Implementado |
| **J1** App Check | J | ✅ Implementado |
| **K1** MCP Server nativo | K | ✅ Implementado |
| **G3** Vector search | G | ✅ Implementado (requiere pgvector) |
| **H2** AI Schema gen | H | ✅ Implementado |
| **K3** Logs en tiempo real | K | ✅ Implementado |
| **K2** API Playground | K | ✅ Implementado |

---

## Resumen ejecutivo

| Competidor | Ventaja de ellos | Nuestra respuesta |
|---|---|---|
| Supabase | Edge Functions, pg_vector, Realtime Presence | Functions lite, Full-text search, Presence |
| Firebase | Remote Config, Analytics, App Check | Feature Flags, Event tracking, Request signing |
| InsForge | Model Gateway, MCP nativo, AI schemas | AI Gateway, MCP server, Semantic search |

---

## Fase F — Server-Side Logic (sin deploy, sin Docker)

### F1. Functions lite — código JS ejecutado server-side

**Problema:** Los devs necesitan lógica de negocio que no quieren exponer en el cliente. Supabase tiene Edge Functions (requiere Deno deploy). Nosotros lo hacemos sin infraestructura extra.

**Solución:** Guardar snippets de JS en DB, ejecutarlos en `vm.runInNewContext` sandboxeado con timeout y contexto limitado.

**Archivos a crear:**
- `lib/v2/function-runner.js` — sandbox con `vm`, timeout configurable, contexto inyectado
- `routes/v2/project/functions/index.js` — CRUD de functions
- `routes/v2/project/functions/invoke.js` — ejecución

**Tabla nueva en schema del proyecto:**
```sql
CREATE TABLE IF NOT EXISTS _functions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  code        TEXT NOT NULL,           -- JS code string
  timeout_ms  INTEGER DEFAULT 5000,
  is_public   BOOLEAN DEFAULT FALSE,   -- si false, requiere auth
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS _function_logs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  function_id  UUID REFERENCES _functions(id) ON DELETE CASCADE,
  status       TEXT NOT NULL,          -- 'ok' | 'error' | 'timeout'
  duration_ms  INTEGER,
  result       JSONB,
  error        TEXT,
  invoked_by   TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
```

**Endpoints:**
```
GET    /functions              → listar functions del proyecto
POST   /functions              → crear function
GET    /functions/:name        → detalle + código
PATCH  /functions/:name        → actualizar código/config
DELETE /functions/:name        → eliminar
POST   /functions/:name/invoke → ejecutar (body = args del context)
GET    /functions/:name/logs   → últimas N ejecuciones
```

**Contexto disponible dentro del sandbox:**
```js
// El código de la function recibe:
{
  args,          // body del request
  user,          // req.projectUser (id, email, roles)
  db: {          // acceso a datos del propio proyecto
    query: async (collection, filter) => [...],
    create: async (collection, data) => record,
    update: async (collection, id, data) => record,
    delete: async (collection, id) => void,
  },
  fetch,         // fetch nativo (Node 18+)
  env: {         // variables de entorno declaradas por el proyecto
    MY_API_KEY: "xxx"
  }
}
// Debe retornar un valor serializable
```

**Ejemplo de function:**
```js
// "calcular-descuento"
const { precio, cupon } = args;
const cupones = await db.query("cupones", { codigo: cupon });
if (!cupones.length) throw new Error("Cupón inválido");
const descuento = cupones[0].data.porcentaje;
return { precio_final: precio * (1 - descuento / 100) };
```

**Seguridad:**
- `vm.runInNewContext` con `contextCodeGeneration: { strings: false, wasm: false }`
- Timeout duro via `vm.runInThisContext` + `Promise.race` con timeout
- Sin acceso a `require`, `process`, `fs`, `__dirname`
- Rate limit: 30 invocaciones / minuto por proyecto
- Max código: 50KB. Max resultado: 1MB

**Variables de entorno para functions:**
```
GET    /functions/env              → listar keys (sin valores)
POST   /functions/env              → crear/actualizar { key, value }
DELETE /functions/env/:key         → eliminar
```

---

### F2. Triggers — functions que se ejecutan automáticamente

**Problema:** Necesitamos lógica que corra cuando se crea/actualiza/elimina un registro, sin que el cliente haga nada.

**Solución:** Tabla `_triggers` que asocia una function a un evento de colección. Ejecutado desde el queue de workers.

**Archivos a crear/modificar:**
- `routes/v2/project/functions/triggers.js`
- `lib/v2/queue.js` — agregar `enqueueTrigger`, ejecutar function runner post-operación

**Tabla nueva:**
```sql
CREATE TABLE IF NOT EXISTS _triggers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection    TEXT NOT NULL,
  event         TEXT NOT NULL,    -- 'record.created' | 'record.updated' | 'record.deleted'
  function_name TEXT NOT NULL,
  is_active     BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
```

**Endpoints:**
```
GET    /functions/triggers         → listar triggers
POST   /functions/triggers         → crear trigger { collection, event, function_name }
DELETE /functions/triggers/:id     → eliminar trigger
PATCH  /functions/triggers/:id     → activar/desactivar
```

**Flujo:**
1. `create-record.js` → INSERT → `enqueueAuditLog` + `enqueueTrigger(schemaName, collection, 'record.created', record)`
2. Queue worker busca triggers activos para `(collection, event)` en `_triggers`
3. Ejecuta la function con contexto `{ args: { record, prev_record }, user: null, db }`

---

## Fase G — Búsqueda y datos avanzados

### G1. Full-text search nativo

**Problema:** No hay búsqueda de texto. Los devs necesitan Algolia/Elasticsearch o hacen `ILIKE` manually.

**Solución:** `GET /records/search?collection=&q=` usando columna `tsvector` en PostgreSQL. Sin dependencias externas.

**Archivos a crear:**
- `routes/v2/project/data/search.js`

**Cómo funciona:**
```sql
-- Al crear/actualizar un registro, los campos tipo 'text' se indexan:
UPDATE _records
SET search_vector = to_tsvector('spanish', data->>'title' || ' ' || data->>'body')
WHERE id = $1;

-- La búsqueda:
SELECT *, ts_rank(search_vector, query) AS rank
FROM _records, to_tsquery('spanish', $1) AS query
WHERE collection = $2
  AND search_vector @@ query
ORDER BY rank DESC
LIMIT $3;
```

**Cambios en esquema:**
```sql
ALTER TABLE _records ADD COLUMN IF NOT EXISTS search_vector tsvector;
CREATE INDEX IF NOT EXISTS idx_records_search ON _records USING gin(search_vector);
```

**Columna `search_fields` en `_collections`:**
```sql
ALTER TABLE _collections ADD COLUMN IF NOT EXISTS search_fields TEXT[];
-- e.g. ['title', 'body', 'tags'] — cuáles campos text se indexan
```

**Endpoints:**
```
GET  /records/search?collection=posts&q=javascript+async&limit=20&lang=spanish
POST /collections/:name/search-config  { search_fields: ['title', 'body'] }
```

**Respuesta:**
```json
{
  "collection": "posts",
  "query": "javascript async",
  "total": 12,
  "results": [
    { "id": "...", "data": {...}, "_score": 0.82 }
  ]
}
```

**Idiomas soportados:** `spanish`, `english`, `french`, `german`, `portuguese`, `simple`

**Integración con create/update:**
- `create-record.js` y `update-record.js` actualizan `search_vector` después del INSERT/UPDATE
- Solo si `_collections.search_fields` está configurado para esa colección

---

### G2. Filtros avanzados — OR, rangos, arrays, null checks

**Problema:** El sistema de filtros actual solo soporta `AND` implícito con un operador por campo. No hay `OR`, `IN`, `BETWEEN`, `IS NULL`, búsqueda en arrays.

**Solución:** Nuevo formato de filtros en `list-records` y agregaciones.

**Operadores nuevos a agregar:**
```
campo.gt:valor        → campo > valor
campo.gte:valor       → campo >= valor
campo.lt:valor        → campo < valor
campo.lte:valor       → campo <= valor
campo.between:1,100   → campo BETWEEN 1 AND 100
campo.in:a,b,c        → campo IN ('a','b','c')
campo.nin:a,b         → campo NOT IN ('a','b')
campo.null:true       → campo IS NULL
campo.null:false      → campo IS NOT NULL
campo.like:patr%      → campo ILIKE 'patr%'
campo.has:valor       → campo (array jsonb) @> '["valor"]'
```

**Filtros OR (body param nuevo):**
```
GET /records?collection=posts&filter[0][or][0]=status.eq:draft&filter[0][or][1]=status.eq:review
```

O via body en un futuro endpoint:
```
POST /records/query
{
  "collection": "posts",
  "where": {
    "or": [
      { "status": { "eq": "draft" } },
      { "status": { "eq": "review" } }
    ]
  }
}
```

**Archivos a modificar:**
- `lib/v2/filter-parser.js` — nuevo módulo centralizado de parseo de filtros (extraer de list-records)
- `routes/v2/project/data/list-records.js` — usar nuevo filter-parser
- `routes/v2/project/data/aggregate.js` — usar nuevo filter-parser

---

### G3. Vector search / Semantic search

**Problema:** InsForge lo tiene. Supabase lo tiene via pgvector. Nosotros no.

**Solución:** Tipo de campo `vector` en `_fields`, índice `ivfflat` via `pgvector`, endpoint de búsqueda semántica.

**Dependencia en PostgreSQL:** extensión `pgvector` (ya disponible en pg 15+).

**Archivos a crear:**
- `routes/v2/project/data/vector-search.js`

**Cambios en schema:**
```sql
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE _records ADD COLUMN IF NOT EXISTS embedding vector(1536);
CREATE INDEX IF NOT EXISTS idx_records_embedding
  ON _records USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

**Endpoints:**
```
POST /records/vector/upsert   { collection, id, embedding: [0.1, 0.2, ...] }
POST /records/vector/search   { collection, embedding: [...], limit: 10, threshold: 0.8 }
```

**Respuesta:**
```json
{
  "results": [
    { "id": "...", "data": {...}, "_similarity": 0.94 }
  ]
}
```

**Integración con AI Gateway (F3):**
- Si el proyecto tiene configurado un AI provider, puede hacer:
  ```
  POST /records/vector/search  { collection, query: "texto natural", limit: 10 }
  ```
  → Matebase genera el embedding via AI Gateway y luego busca

---

## Fase H — AI Gateway

### H1. Model Gateway — proxy a LLMs

**Problema:** Los devs tienen que manejar API keys de OpenAI/Anthropic en el cliente (inseguro) o construir su propio proxy.

**Solución:** El dev configura su API key en el proyecto. El cliente llama a Matebase que reenvía al LLM. Logs de uso incluidos.

**Archivos a crear:**
- `routes/v2/project/ai/gateway.js`
- `lib/v2/ai-providers.js` — adaptadores para OpenAI, Anthropic, Groq

**Configuración del proyecto:**
```sql
ALTER TABLE projects ADD COLUMN IF NOT EXISTS ai_config JSONB;
-- {
--   "provider": "openai",
--   "api_key_encrypted": "...",   -- encriptado con PROJECT_SECRET
--   "model": "gpt-4o-mini",
--   "max_tokens_per_day": 100000
-- }
```

**Endpoints:**
```
POST /ai/chat              → completions (streaming soportado)
POST /ai/embed             → generar embeddings
GET  /ai/usage             → tokens usados hoy/mes
PUT  /project/ai-config    → configurar provider + key (solo platform admin o service key)
```

**Request:**
```json
POST /ai/chat
{
  "messages": [
    { "role": "system", "content": "Eres un asistente de soporte." },
    { "role": "user", "content": "¿Cómo reseteo mi contraseña?" }
  ],
  "stream": false,
  "max_tokens": 500
}
```

**Seguridad:**
- La API key del proveedor se encripta antes de guardar en DB (AES-256 con `APP_SECRET`)
- El cliente nunca ve la API key real
- Rate limit: configurable por proyecto (default 60 req/min)
- Tracking de tokens: se guarda en `_ai_usage` para billing awareness

**Tabla de uso:**
```sql
CREATE TABLE IF NOT EXISTS _ai_usage (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model         TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  user_id       TEXT,
  endpoint      TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
```

**Providers soportados:**
- OpenAI (`gpt-4o`, `gpt-4o-mini`, `text-embedding-3-small`)
- Anthropic (`claude-haiku-4-5`, `claude-sonnet-4-6`)
- Groq (`llama-3.1-70b`, `mixtral-8x7b`)

---

### H2. AI-assisted schema generation

**Problema:** Crear colecciones + fields + permisos es tedioso. El dev sabe qué quiere pero no cómo estructurarlo.

**Solución:** Describir en lenguaje natural → Matebase sugiere el schema completo.

**Endpoint:**
```
POST /ai/schema
{
  "description": "Una app de delivery: restaurantes, menús, pedidos, clientes y repartidores"
}
```

**Respuesta:**
```json
{
  "suggested_collections": [
    {
      "name": "restaurants",
      "fields": [
        { "name": "name", "type": "text", "required": true },
        { "name": "address", "type": "text" },
        { "name": "rating", "type": "number", "min": 0, "max": 5 }
      ],
      "permissions": { "list": "public", "get": "public", "create": "service", "update": "auth", "delete": "service" }
    }
  ],
  "apply_url": "POST /ai/schema/apply"
}
```

```
POST /ai/schema/apply   { collections: [...] }   → crea todo de una vez
```

---

## Fase I — Remote Config y Analytics

### I1. Feature Flags / Remote Config

**Problema:** Los devs hardcodean flags en el cliente. Cambiar un flag requiere un deploy.

**Solución:** `GET /config/:key` devuelve valor configurable en tiempo real. Sin deploy.

**Archivos a crear:**
- `routes/v2/project/config/index.js`

**Tabla nueva:**
```sql
CREATE TABLE IF NOT EXISTS _remote_config (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key         TEXT NOT NULL UNIQUE,
  value       JSONB NOT NULL,
  description TEXT,
  is_public   BOOLEAN DEFAULT TRUE,   -- si false, requiere auth
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_by  TEXT
);
```

**Endpoints:**
```
GET    /config                    → todos los configs públicos (cacheado 60s)
GET    /config/:key               → valor de un config
PUT    /config/:key               → crear/actualizar { value, description, is_public }
DELETE /config/:key               → eliminar
```

**Respuesta:**
```json
GET /config/maintenance_mode
{ "key": "maintenance_mode", "value": false, "updated_at": "2026-04-10T..." }
```

**Casos de uso:**
- Feature flags (`nuevo_checkout: true`)
- Config de app (`max_upload_mb: 10`, `welcome_message: "Hola!"`)
- Kill switch (`api_v1_enabled: false`)
- A/B config (`checkout_variant: "B"`)

**Cache:** 60s en memoria (evitar hit a DB en cada request del cliente móvil).

---

### I2. Event Analytics

**Problema:** Los devs necesitan saber qué hacen sus usuarios. Firebase Analytics requiere SDK nativo. Nosotros lo hacemos con una línea de fetch.

**Solución:** `POST /analytics/track` + queries de agregación con filtros por fecha.

**Archivos a crear:**
- `routes/v2/project/analytics/index.js`

**Tabla nueva:**
```sql
CREATE TABLE IF NOT EXISTS _analytics_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event       TEXT NOT NULL,
  user_id     TEXT,
  session_id  TEXT,
  properties  JSONB DEFAULT '{}',
  ip          TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analytics_event ON _analytics_events(event, created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_user  ON _analytics_events(user_id, created_at);
```

**Endpoints:**
```
POST /analytics/track
{
  "event": "button_clicked",
  "session_id": "sess_abc",
  "properties": { "button": "checkout", "page": "/cart" }
}

GET /analytics/events?from=2026-04-01&to=2026-04-10&group_by=event
GET /analytics/events?event=button_clicked&group_by=properties.button
GET /analytics/funnel?steps=page_viewed,item_added,checkout_started,purchase_completed&from=...
GET /analytics/users/:userId/events?limit=50
```

**Respuesta aggregate:**
```json
{
  "from": "2026-04-01",
  "to": "2026-04-10",
  "results": [
    { "event": "button_clicked", "count": 4521, "unique_users": 312 },
    { "event": "purchase_completed", "count": 87, "unique_users": 85 }
  ]
}
```

**Rate limit en track:** 1000 eventos / minuto por proyecto (bulk endpoint para SDKs).

---

## Fase J — Seguridad avanzada

### J1. App Check — protección anti-bots en endpoints públicos

**Problema:** Endpoints públicos como `/auth/register` y `/auth/magic-link` son vulnerables a bots que crean cuentas masivamente. El rate limit por IP es bypasseable con proxies.

**Solución:** Token firmado por el cliente requerido en endpoints configurables. Similar a reCAPTCHA pero sin Google.

**Archivos a crear:**
- `lib/v2/app-check.js` — genera y valida challenge tokens
- `routes/v2/project/auth/app-check.js`

**Flujo:**
1. Cliente hace `GET /auth/app-check/challenge` → recibe `{ challenge, expires_in: 60 }`
2. Cliente resuelve el challenge (prueba de trabajo mínima: hash SHA-256 del challenge + nonce hasta cumplir dificultad)
3. Cliente envía `X-App-Check-Token: xxx` en cada request público
4. Servidor valida el token antes de procesar

**Tabla:**
```sql
CREATE TABLE IF NOT EXISTS _app_check_tokens (
  token      TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  ip         TEXT
);
```

**Endpoints:**
```
GET  /auth/app-check/challenge          → { challenge: "hex32", expires_in: 60 }
POST /auth/app-check/verify             → { token: "hex64" } → { ok: true, app_token: "jwt-corto" }
```

**Configuración del proyecto:**
```
POST /project/settings
{ "app_check_required": true, "app_check_difficulty": 4 }
```

---

### J2. Notification Center — notificaciones in-app

**Problema:** FCM cubre push pero no hay sistema de notificaciones in-app (como el campañita de GitHub).

**Solución:** Cola de notificaciones por usuario accesible via REST y WebSocket.

**Archivos a crear:**
- `routes/v2/project/notifications/index.js`

**Tabla nueva:**
```sql
CREATE TABLE IF NOT EXISTS _notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  type        TEXT DEFAULT 'info',   -- 'info' | 'success' | 'warning' | 'error'
  data        JSONB DEFAULT '{}',
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notif_user ON _notifications(user_id, created_at DESC);
```

**Endpoints:**
```
POST   /notifications                        → enviar notificación a un usuario (service key)
POST   /notifications/broadcast              → enviar a múltiples usuarios o todos
GET    /notifications/me                     → mis notificaciones (paginadas, cursor-based)
GET    /notifications/me/unread-count        → número de no leídas
PATCH  /notifications/:id/read               → marcar como leída
PATCH  /notifications/me/read-all            → marcar todas como leídas
DELETE /notifications/:id                    → eliminar
```

**Realtime:**
- Cuando se crea una notificación para `user_id`, se emite via WebSocket al canal `_notifications:{userId}`
- El cliente puede subscribirse a `{ type: "subscribe", collection: "_notifications", filter: { user_id: "mi-id" } }`

---

## Fase K — Developer Experience avanzado

### K1. MCP Server nativo

**Problema:** InsForge lo ofrece. Claude Code, Cursor y otros agentes de AI pueden conectarse a un MCP server para leer/escribir datos directamente sin REST.

**Solución:** Exponer cada proyecto como un MCP server válido (protocolo JSON-RPC sobre stdio o HTTP SSE).

**Archivos a crear:**
- `routes/v2/project/mcp/index.js` — endpoint SSE `GET /mcp`
- `lib/v2/mcp-server.js` — implementación del protocolo MCP

**Tools que expone el MCP:**
```
list_collections         → GET /collections
query_records            → GET /records?collection=&filter=
create_record            → POST /records
update_record            → PATCH /records/:id
delete_record            → DELETE /records/:id
get_schema               → GET /schema
run_function             → POST /functions/:name/invoke
```

**URL de conexión para el agente:**
```
mcp: https://api.matebase.dev/v2/p/PROJECT_ID/mcp
headers: { Authorization: "Bearer SERVICE_KEY" }
```

---

### K2. API Playground (REST explorer)

**Problema:** El dev tiene que usar curl/Postman para probar su API. Supabase tiene el Table Editor. Nosotros podemos exponer algo liviano.

**Solución:** Endpoint que devuelve una UI HTML mínima (similar a Swagger UI pero temática) para explorar la API del proyecto.

**Archivos a crear:**
- `routes/v2/project/playground.js` — sirve HTML estático generado dinámicamente con el schema del proyecto

**URL:** `GET /playground` → HTML con formularios para cada colección y endpoint de auth.

---

### K3. Logs en tiempo real

**Problema:** No hay forma de ver qué queries se están ejecutando, qué errores ocurren, sin acceso al servidor.

**Solución:** Endpoint SSE que streameea logs de requests del proyecto en tiempo real.

**Archivos a crear:**
- `routes/v2/project/logs/stream.js` — SSE endpoint

**Tabla:**
```sql
CREATE TABLE IF NOT EXISTS _request_logs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  method       TEXT,
  path         TEXT,
  status       INTEGER,
  duration_ms  INTEGER,
  user_id      TEXT,
  ip           TEXT,
  error        TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
```

**Endpoints:**
```
GET /logs/stream          → SSE stream de logs en tiempo real (requiere service key)
GET /logs                 → últimos N logs (paginados)
GET /logs/errors          → solo errores (status >= 400)
```

---

## Roadmap visual por prioridad

```
IMPACTO
  │
  │  [H1] AI Gateway ✅       [F1] Functions ✅
  │  [G1] Full-text ✅        [I1] Remote Config ✅
  │  [J2] Notification ✅     [G2] Filtros ✅
  │
  │  [F2] Triggers ✅          [I2] Analytics ✅
  │  [K1] MCP Server ✅        [J1] App Check ✅
  │
  │  [G3] Vector ✅            [H2] AI Schema ✅
  │  [K3] Logs ✅              [K2] Playground ✅
  │
  └──────────────────────────────────────────────────
                                              ESFUERZO →
       Bajo          Medio           Alto
```

### Orden de implementación recomendado

| # | Feature | Estado |
|---|---------|--------|
| 1 | **G1** Full-text search | ✅ HECHO |
| 2 | **I1** Remote Config / Feature Flags | ✅ HECHO |
| 3 | **G2** Filtros avanzados (OR, range, null) | ✅ HECHO |
| 4 | **J2** Notification Center | ✅ HECHO |
| 5 | **F1** Functions lite | ✅ HECHO |
| 6 | **F2** Triggers | ✅ HECHO |
| 7 | **H1** AI Model Gateway | ✅ HECHO |
| 8 | **I2** Event Analytics | ✅ HECHO |
| 9 | **J1** App Check | ✅ HECHO |
| 10 | **K1** MCP Server nativo | ✅ HECHO |
| 11 | **G3** Vector search | ✅ HECHO (requiere pgvector) |
| 12 | **H2** AI Schema gen | ✅ HECHO |
| 13 | **K3** Logs en tiempo real | ✅ HECHO |
| 14 | **K2** API Playground | ✅ HECHO |

**🎉 Roadmap Fase 2 completo — 14/14 features implementadas.**

---

## Dependencias nuevas a instalar

| Paquete | Para qué | Fase |
|---------|---------|------|
| *(ninguna nueva por ahora)* | Full-text search usa PostgreSQL nativo | G1 |
| *(ninguna nueva)* | Remote Config usa DB existente | I1 |
| `node-fetch` o `undici` | AI Gateway — ya disponible en Node 18+ como `fetch` nativo | H1 |

> **Nota:** pgvector (G3) es una extensión de PostgreSQL, no un paquete npm.  
> Verificar: `SELECT * FROM pg_available_extensions WHERE name = 'vector';`

---

## Tablas nuevas — resumen

| Tabla | Fase | Propósito |
|-------|------|-----------|
| `_functions` | F1 | Código JS serverless por proyecto |
| `_function_logs` | F1 | Historial de ejecuciones |
| `_function_env` | F1 | Variables de entorno de functions |
| `_triggers` | F2 | Asociar functions a eventos de colección |
| `_remote_config` | I1 | Feature flags y configuración dinámica |
| `_analytics_events` | I2 | Tracking de eventos de usuario |
| `_ai_usage` | H1 | Tokens consumidos por LLM |
| `_app_check_tokens` | J1 | Challenge tokens anti-bot |
| `_notifications` | J2 | Notificaciones in-app por usuario |
| `_request_logs` | K3 | Logs de requests del proyecto |

---

*Fecha de creación: 2026-04-10*  
*Basado en análisis competitivo: Supabase, Firebase, InsForge*
