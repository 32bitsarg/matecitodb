# Matebase API v2 — Roadmap Fase 3
### Features que nos diferencian de Supabase, Firebase e InsForge

> Todo bajo `/api/v2/`. Sin tocar v1.  
> Fase 2: **14/14 features implementadas**.  
> Este documento cubre la Fase 3 — diferenciación real.

---

## Estado

| Feature | Fase | Estado |
|---|---|---|
| **L1** Cron jobs declarativos | L | ✅ Implementado |
| **L2** Forms públicos | L | ✅ Implementado |
| **M1** Geo queries (sin PostGIS) | M | ✅ Implementado |
| **M2** Email logs + template preview | M | ✅ Implementado |
| **N1** Workflows / State machines | N | ✅ Implementado |
| **N2** Computed fields | N | ✅ Implementado |
| **O1** Project branching | O | ✅ Implementado |
| **O2** Sync offline lite | O | ✅ Implementado |
| **P1** Webhook retry + Dead Letter Queue | P | ✅ Implementado |
| **P2** Invitation links de auth | P | ✅ Implementado |
| **P3** Data masking por rol | P | ✅ Implementado |
| **P4** Schema migration history | P | ✅ Implementado |
| **Q1** Response caching por colección | Q | ✅ Implementado |
| **Q2** IP allowlist / blocklist | Q | ✅ Implementado |
| **Q3** Rate limit configurable por endpoint | Q | ✅ Implementado |
| **Q4** Collection aliases / API versioning | Q | ✅ Implementado |
| **R1** Orgs / Multi-tenancy dentro del proyecto | R | ✅ Implementado |
| **R2** Bulk dry-run y atomic batch | R | ✅ Implementado |
| **R3** Query explain / optimizer hints | R | ✅ Implementado |

**19/19 features implementadas ✅**

---

## SDK v4.0

El SDK `matecitodb` fue actualizado a **v4.0.0** con soporte completo para v2:

```ts
// v1 (default, sin cambios — compatibilidad total)
const db = createClient({ url: 'https://...', apiKey: 'mk_...' })

// v2 (nuevas features)
const db = createClient({ url: 'https://...', apiKey: 'mk_...', apiVersion: 'v2' })

// Nuevos módulos v2
db.functions.list()
db.functions.invoke('my-fn', { arg: 1 })
db.remoteConfig.getAll()
db.analytics.track('page_view')
db.ai.chat([{ role: 'user', content: 'Hello' }])
db.geo.near('places', -34.6, -58.4, { radius_km: 5 })
db.workflows.getState('orders', 'record-id')
db.orgs.myOrgs()
db.sync.pull('tasks', lastSyncTime)
db.forms.list()
db.auth.magicLink('user@example.com')
db.auth.totp.setup()
db.auth.roles.list()
db.auth.invitations.create({ email: 'new@user.com', role: 'editor' })
db.notifications.listMy()
db.batch().insert('posts', data).atomic().execute()
db.from('posts').searchFullText('hello world')
db.from('posts').between('price', 10, 100).isNull('deleted_at').get()
```

---

## Fase L — Quick wins de alto impacto

### L1. Cron Jobs declarativos

**Problema:** Todo proyecto necesita tareas periódicas. Las soluciones actuales son GitHub Actions (require repo), Heroku Scheduler (pago), cron en el VPS propio (frágil), o armar un setInterval hardcodeado. Supabase lo tiene solo en plan pago (>$25/mes). Firebase no lo tiene.

**Nuestra solución:** El dev crea un cron que ejecuta una Function del proyecto, con expresión cron estándar, timezone, y logs de cada ejecución.

**Archivos a crear:**
- `routes/v2/project/functions/crons.js` — CRUD de crons
- `lib/v2/cron-runner.js` — parser de expresiones cron + loop de ejecución + distribución por proyecto

**Tabla nueva:**
```sql
CREATE TABLE IF NOT EXISTS _crons (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL UNIQUE,
  cron_expr     TEXT NOT NULL,          -- "0 3 * * *" (min hora dia mes weekday)
  function_name TEXT NOT NULL,
  timezone      TEXT DEFAULT 'UTC',
  is_active     BOOLEAN DEFAULT TRUE,
  last_run_at   TIMESTAMPTZ,
  next_run_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
```

**Endpoints:**
```
GET    /functions/crons              → listar crons del proyecto
POST   /functions/crons              → crear cron
PATCH  /functions/crons/:name        → actualizar expr/timezone/activo
DELETE /functions/crons/:name        → eliminar
POST   /functions/crons/:name/run    → ejecutar manualmente (no cambia next_run_at)
GET    /functions/crons/:name/logs   → últimas ejecuciones (usa _function_logs)
```

**Request de creación:**
```json
{
  "name": "cleanup-expired-sessions",
  "cron_expr": "0 3 * * *",
  "function_name": "cleanup-sessions",
  "timezone": "America/Buenos_Aires"
}
```

**Respuesta:**
```json
{
  "id": "uuid",
  "name": "cleanup-expired-sessions",
  "cron_expr": "0 3 * * *",
  "timezone": "America/Buenos_Aires",
  "next_run_at": "2026-04-12T06:00:00Z",
  "is_active": true
}
```

**Implementación del runner (`lib/v2/cron-runner.js`):**
- Un `setInterval` cada 60 segundos revisa todos los crons activos de todos los proyectos
- `next_run_at` se precalcula al crear/actualizar el cron
- Al ejecutar: actualiza `last_run_at`, calcula y escribe `next_run_at`, invoca la Function en su sandbox
- Soporta expresiones: `* * * * *` (minuto hora dia-mes mes dia-semana)
- Parser propio (no dependencia externa) — 5 campos estándar
- Timezone: convierte `next_run_at` a UTC para almacenar y comparar

**Seguridad:**
- Max 10 crons por proyecto (configurable por plan)
- Timeout máximo igual al de la function (default 5s, configurable hasta 30s para crons)
- Si falla 3 veces seguidas → `is_active = false`, notificación al owner

**Casos de uso reales:**
- Limpiar sesiones expiradas cada noche
- Enviar resumen diario por email a usuarios
- Sync con API externa cada hora
- Generar reportes semanales

---

### L2. Forms públicos — endpoint para recibir submissions sin SDK

**Problema:** Cada app tiene formularios de contacto, newsletters, encuestas, registros. Las soluciones actuales son Formspree ($16/mes), Typeform (caro), o implementar el backend manualmente. Nuestros propios devs necesitan manejar esto sin exponer keys.

**Nuestra solución:** El dev crea un Form desde la API. El usuario final hace `POST` a una URL pública sin auth. Matebase valida, guarda en una colección, envía emails configurables.

**Archivos a crear:**
- `routes/v2/project/forms/index.js` — CRUD de forms
- `routes/v2/project/forms/submit.js` — endpoint público de submission

**Tabla nueva:**
```sql
CREATE TABLE IF NOT EXISTS _forms (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT NOT NULL UNIQUE,
  collection          TEXT NOT NULL,       -- colección donde guardar submissions
  fields              JSONB NOT NULL,      -- schema de campos aceptados
  require_app_check   BOOLEAN DEFAULT FALSE,
  send_confirmation   BOOLEAN DEFAULT FALSE,
  confirmation_email_field TEXT,           -- campo del form que tiene el email del usuario
  confirmation_template    TEXT,           -- nombre del email template
  notify_email        TEXT,                -- email del dev para recibir notificación
  redirect_url        TEXT,                -- URL a la que redirigir después del submit (si viene de HTML form)
  is_active           BOOLEAN DEFAULT TRUE,
  submit_count        INTEGER DEFAULT 0,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);
```

**Endpoints:**
```
GET    /forms                        → listar forms del proyecto
POST   /forms                        → crear form
GET    /forms/:name                  → detalle del form
PATCH  /forms/:name                  → actualizar
DELETE /forms/:name                  → eliminar
GET    /forms/:name/submissions      → ver submissions (requiere auth)

POST   /f/:formId                    → submission pública (sin auth requerida)
```

**Creación de un form:**
```json
POST /forms
{
  "name": "contacto",
  "collection": "contact_submissions",
  "fields": [
    { "name": "email",   "type": "email",   "required": true },
    { "name": "name",    "type": "text",    "required": true, "maxLength": 100 },
    { "name": "message", "type": "text",    "required": true, "maxLength": 2000 },
    { "name": "subject", "type": "select",  "options": ["soporte", "ventas", "otro"] }
  ],
  "send_confirmation": true,
  "confirmation_email_field": "email",
  "confirmation_template": "form-confirmation",
  "notify_email": "admin@miapp.com",
  "redirect_url": "https://miapp.com/gracias"
}
```

**Uso desde HTML puro (zero JS):**
```html
<form action="https://api.matebase.dev/v2/p/PROJECT_ID/f/contacto" method="POST">
  <input name="name" required />
  <input name="email" type="email" required />
  <textarea name="message"></textarea>
  <button type="submit">Enviar</button>
</form>
```

**Uso desde JS/fetch:**
```js
await fetch(`https://api.matebase.dev/v2/p/PROJECT_ID/f/contacto`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Juan", email: "j@x.com", message: "Hola" })
});
```

**Comportamiento del submit (`POST /f/:formId`):**
1. Detectar `Content-Type`: JSON o `application/x-www-form-urlencoded` (HTML forms)
2. Validar campos contra schema del form
3. Guardar en `_records` de la colección configurada
4. Si `send_confirmation`: enviar email al `confirmation_email_field`
5. Si `notify_email`: enviar notificación al dev
6. Si `redirect_url` y el request viene de un form HTML (Accept: text/html): redirigir 302
7. Si es JSON: devolver `{ ok: true, id: "submission-id" }`

**Rate limit:** 5 submissions / minuto por IP por form (configurable).

**Integración con App Check:** Si `require_app_check: true`, el submit requiere `X-App-Check-Token`.

---

## Fase M — Datos enriquecidos

### M1. Geo queries — búsqueda por proximidad sin PostGIS

**Problema:** Delivery, marketplaces, inmuebles, eventos — todos necesitan "buscar cerca de mí". PostGIS es una extensión pesada. Firebase tiene GeoFirestore pero con SDK propio y complejo. Supabase requiere PostGIS + SQL raw.

**Nuestra solución:** Tipo de campo `geopoint` + endpoints de geo query usando Haversine en SQL puro. Sin extensiones PostgreSQL extra.

**Archivos a crear:**
- `routes/v2/project/data/geo.js`
- `lib/v2/geo.js` — fórmula Haversine en SQL, validaciones

**Cambios en schema:**
```sql
-- Índice en campos de geolocalización para queries eficientes
-- Los campos lat/lng se guardan en data JSONB, pero creamos índice funcional:
CREATE INDEX IF NOT EXISTS idx_records_geo
  ON _records (collection, ((data->>'_lat')::float), ((data->>'_lng')::float))
  WHERE data->>'_lat' IS NOT NULL;
```

**Nuevo tipo de campo en `_fields`:** `geopoint`
- Guarda `{ lat: -34.6, lng: -58.4 }` en el campo del data
- Al guardar, extrae y normaliza a `_lat` y `_lng` para indexar
- Validación: lat entre -90 y 90, lng entre -180 y 180

**Endpoints:**
```
GET /records/geo/nearby
  ?collection=restaurants
  &lat=-34.6037
  &lng=-58.3816
  &radius_km=5
  &limit=20
  &filter=category.eq:pizza        ← filtros normales también aplican
  &sort=distance                   ← ordenar por distancia (default)

GET /records/geo/bounds
  ?collection=restaurants
  &north=-34.5
  &south=-34.7
  &east=-58.3
  &west=-58.5
  → registros dentro del bounding box

POST /records/geo/batch-distance
{
  "collection": "warehouses",
  "origin": { "lat": -34.6, "lng": -58.4 },
  "ids": ["uuid1", "uuid2", "uuid3"]
}
→ [{ "id": "uuid1", "distance_km": 2.3, "data": {...} }]
```

**Query Haversine en SQL:**
```sql
SELECT *,
  6371 * 2 * ASIN(SQRT(
    POWER(SIN(RADIANS(($1::float - (data->>'_lat')::float) / 2)), 2) +
    COS(RADIANS($1::float)) * COS(RADIANS((data->>'_lat')::float)) *
    POWER(SIN(RADIANS(($2::float - (data->>'_lng')::float) / 2)), 2)
  )) AS distance_km
FROM _records
WHERE collection = $3
  AND data->>'_lat' IS NOT NULL
  AND (data->>'_lat')::float BETWEEN $1 - ($4/111.0) AND $1 + ($4/111.0)
  AND (data->>'_lng')::float BETWEEN $2 - ($4/(111.0*COS(RADIANS($1)))) AND $2 + ($4/(111.0*COS(RADIANS($1))))
HAVING distance_km <= $4
ORDER BY distance_km
LIMIT $5
```

**Respuesta:**
```json
{
  "collection": "restaurants",
  "origin": { "lat": -34.6037, "lng": -58.3816 },
  "radius_km": 5,
  "total": 8,
  "results": [
    {
      "id": "uuid",
      "distance_km": 0.87,
      "data": { "name": "Pizza Roma", "category": "pizza", "location": { "lat": -34.61, "lng": -58.39 } }
    }
  ]
}
```

---

### M2. Email logs + Template preview + Variables tipadas

**Problema:** Los devs configuran email templates pero no tienen forma de previsualizarlos sin enviar un email real. No hay historial de emails enviados. Los templates son strings ciegos sin saber qué variables existen.

**Archivos a crear/modificar:**
- `routes/v2/project/email-templates.js` — ya existe, agregar endpoints nuevos
- `routes/v2/project/email-logs.js`

**Tabla nueva:**
```sql
CREATE TABLE IF NOT EXISTS _email_logs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template     TEXT,
  to_email     TEXT NOT NULL,
  subject      TEXT,
  status       TEXT NOT NULL,   -- 'sent' | 'failed' | 'bounced'
  error        TEXT,
  opened_at    TIMESTAMPTZ,
  clicked_at   TIMESTAMPTZ,
  metadata     JSONB DEFAULT '{}',
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_logs_to  ON _email_logs(to_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_logs_tpl ON _email_logs(template, created_at DESC);
```

**Endpoints nuevos:**
```
POST /email-templates/:name/preview
  Body: { "variables": { "name": "Juan", "amount": 150, "link": "https://..." } }
  → { "subject": "Tu pedido #123", "html": "<html>...", "text": "..." }
  (renderiza el template con las variables, NO envía email)

POST /email-templates/:name/send-test
  Body: { "to": "dev@ejemplo.com", "variables": { "name": "Test" } }
  → envía email real de prueba y loguea en _email_logs

GET  /email-logs
  ?to=email@...&template=welcome&status=failed&from=2026-04-01&limit=50
  → historial paginado

GET  /email-logs/stats
  ?from=2026-04-01&to=2026-04-10
  → { sent: 1240, failed: 3, open_rate: 0.42, click_rate: 0.18 }

GET  /email-templates/:name/variables
  → analiza el template y lista las variables usadas: ["name", "amount", "link"]
```

**Mejora en templates — variables tipadas:**
```json
PATCH /email-templates/welcome
{
  "subject": "Bienvenido {{name}}",
  "html": "<h1>Hola {{name}}, tu cuenta está activa</h1>",
  "variables": {
    "name":   { "type": "string", "required": true, "example": "Juan" },
    "amount": { "type": "number", "required": false, "example": 150 }
  }
}
```

**Tracking de apertura (opcional):** Si el proyecto configura `email_tracking: true`, Matebase inyecta un pixel 1x1 en el HTML para detectar opens.

---

## Fase N — Lógica de negocio declarativa

### N1. Workflows / State machines

**Problema:** El 80% de las apps tienen ciclos de estado: pedidos, tickets, publicaciones, contratos. Hoy el dev implementa esa lógica en el cliente o en Functions manuales, sin garantías de que las transiciones sean válidas.

**Nuestra solución:** Estado como dato + reglas de transición declarativas. Matebase valida, ejecuta side-effects y notifica. **Ningún BaaS tiene esto.**

**Archivos a crear:**
- `routes/v2/project/workflows/index.js` — CRUD de workflows
- `lib/v2/workflow-engine.js` — validador de transiciones + ejecutor de side-effects

**Tabla nueva:**
```sql
CREATE TABLE IF NOT EXISTS _workflows (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  collection  TEXT NOT NULL,
  field       TEXT NOT NULL,            -- campo del record que tiene el estado
  definition  JSONB NOT NULL,           -- estados + transiciones
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS _workflow_history (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id  UUID REFERENCES _workflows(id),
  record_id    TEXT NOT NULL,
  from_state   TEXT NOT NULL,
  to_state     TEXT NOT NULL,
  triggered_by TEXT,              -- user_id que hizo el cambio
  metadata     JSONB DEFAULT '{}',
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
```

**Creación de un workflow:**
```json
POST /workflows
{
  "name": "ciclo-pedido",
  "collection": "orders",
  "field": "status",
  "definition": {
    "initial": "draft",
    "states": ["draft", "confirmed", "preparing", "shipped", "delivered", "cancelled", "refunded"],
    "transitions": [
      {
        "from": "draft",
        "to": "confirmed",
        "guard": "total.gt:0",
        "roles": [],
        "on_enter": "send-confirmation-email"
      },
      {
        "from": "confirmed",
        "to": "preparing",
        "guard": null,
        "roles": ["admin", "staff"],
        "on_enter": null
      },
      {
        "from": "preparing",
        "to": "shipped",
        "roles": ["admin", "staff"],
        "on_enter": "notify-shipped"
      },
      {
        "from": "shipped",
        "to": "delivered",
        "roles": ["admin"],
        "on_enter": "complete-order"
      },
      {
        "from": ["draft", "confirmed"],
        "to": "cancelled",
        "roles": ["admin", "owner"],
        "on_enter": "send-cancellation"
      },
      {
        "from": "delivered",
        "to": "refunded",
        "roles": ["admin"],
        "on_enter": "process-refund"
      }
    ]
  }
}
```

**Integración con update-record:**
- Cuando se hace `PATCH /records/:id` y el campo `status` cambia, el workflow engine intercepta
- Valida: ¿la transición `from → to` está permitida?
- Valida: ¿el usuario tiene el rol requerido?
- Evalúa guard (mismo formato que RLS filters)
- Si todo ok: aplica el UPDATE, escribe en `_workflow_history`, ejecuta `on_enter` (Function)
- Si no ok: `400 { error: "Transition not allowed", code: "WF_001", allowed_transitions: [...] }`

**Endpoints adicionales:**
```
GET /workflows                           → listar workflows
GET /workflows/:name                     → detalle + definición
GET /workflows/:name/history?record_id=  → historial de transiciones de un registro
GET /records/:id/workflow-state          → estado actual + transiciones permitidas para el usuario
```

**Respuesta de `GET /records/:id/workflow-state`:**
```json
{
  "current_state": "confirmed",
  "allowed_transitions": [
    { "to": "preparing", "label": "Iniciar preparación" },
    { "to": "cancelled", "label": "Cancelar" }
  ],
  "history": [
    { "from": "draft", "to": "confirmed", "at": "2026-04-10T12:00:00Z", "by": "user_uuid" }
  ]
}
```

---

### N2. Computed fields — campos calculados server-side

**Problema:** Campos como `total = price * quantity`, `full_name = first_name + last_name`, `age = years_since(birth_date)` se recalculan en el cliente o requieren triggers manuales. Si hay múltiples clientes (web, mobile, API) cada uno tiene que implementar la lógica.

**Nuestra solución:** Campo tipo `computed` en el schema — definido una vez, siempre consistente.

**Archivos a crear/modificar:**
- `lib/v2/field-validator.js` — detectar campos computed, no permitir escritura directa
- `lib/v2/computed-fields.js` — evaluador de fórmulas

**Nuevo tipo en `_fields`:** `computed`
```json
POST /collections/order_items/fields
{
  "name": "subtotal",
  "type": "computed",
  "formula": "price * quantity",
  "depends_on": ["price", "quantity"],
  "result_type": "number"
}
```

**Fórmulas soportadas:**

| Fórmula | Resultado |
|---------|----------|
| `price * quantity` | número |
| `first_name + " " + last_name` | texto |
| `upper(email)` | texto |
| `date_diff_days(created_at, NOW())` | número |
| `length(description)` | número |
| `coalesce(nickname, first_name)` | texto |
| `IF(total > 1000, "premium", "standard")` | texto |
| `ROUND(price * 1.21, 2)` | número |

**Implementación:**
- El evaluador parsea la fórmula y la convierte a SQL expression
- Se agrega como columna generada: `ALTER TABLE _records ADD COLUMN IF NOT EXISTS _computed_subtotal NUMERIC GENERATED ALWAYS AS (CASE WHEN ...) STORED`
- O se recalcula en cada UPDATE si el campo está en `depends_on`
- Los campos computed se incluyen automáticamente en las respuestas
- No se pueden escribir directamente → error `DATA_006: Field is computed`

---

## Fase O — Infraestructura avanzada

### O1. Project branching — ambientes sin costo extra

**Problema:** Tener dev/staging/prod requiere pagar 3 proyectos en Supabase ($75+/mes). En Matebase son 3 schemas en la misma instancia PostgreSQL.

**Archivos a crear:**
- `routes/v2/platform/projects/branch.js`

**Endpoints:**
```
POST /projects/:id/branch
{
  "name": "staging",
  "copy_schema": true,   // copia collections, fields, permissions, functions, workflows
  "copy_data": false,    // no copia _records (solo estructura)
  "copy_users": false
}
→ { "branch_project_id": "uuid", "schema_name": "proj_abc_staging" }

GET  /projects/:id/branches          → listar branches del proyecto
POST /projects/:id/branch/diff       → diferencias de schema entre branch y origen
POST /projects/:id/branch/merge      → aplica cambios de schema del branch al proyecto origen
DELETE /projects/:id/branches/:name  → eliminar branch
```

**Qué se copia en `copy_schema: true`:**
- `_collections` + `_fields` + `_permissions`
- `_functions` + `_triggers` + `_crons`
- `_workflows`
- `_email_templates`
- `_webhooks`
- `_remote_config`
- `_forms`

**Qué NO se copia:**
- `_records` (a menos que `copy_data: true`)
- `_auth_users` (a menos que `copy_users: true`)
- `_audit_log`, `_email_logs`, `_analytics_events`
- API keys (el branch tiene las propias)

**Merge de schema (staging → prod):**
- Compara `_collections` y `_fields` entre los dos schemas
- Genera un diff: colecciones nuevas, campos nuevos, campos eliminados, cambios de tipo
- Aplica de forma no destructiva: agrega columnas nuevas, no elimina las existentes sin confirmación explícita
- Devuelve reporte de cambios aplicados

---

### O2. Sync offline lite — delta sync para apps mobile

**Problema:** Firebase Firestore es el rey en offline sync pero tiene vendor lock-in total, NoSQL, y SDK pesado. Las apps mobile necesitan funcionar sin internet.

**Nuestra solución:** API de delta sync — el cliente descarga cambios desde un timestamp, trabaja offline, sube cambios en batch. Sin SDK especial, solo REST.

**Archivos a crear:**
- `routes/v2/project/data/sync.js`

**Endpoints:**
```
GET  /records/sync?collection=tasks&since=1712500000000&limit=500
→ todos los cambios (creados, actualizados, eliminados) desde ese timestamp

POST /records/sync/push
{
  "collection": "tasks",
  "changes": [
    { "op": "create", "local_id": "local-uuid-1", "data": {...}, "client_ts": 1712599000000 },
    { "op": "update", "id": "server-uuid", "data": {...}, "client_ts": 1712599000000 },
    { "op": "delete", "id": "server-uuid", "client_ts": 1712599000000 }
  ]
}
→ {
    "results": [
      { "local_id": "local-uuid-1", "server_id": "server-uuid", "status": "created" },
      { "id": "server-uuid", "status": "updated" },
      { "id": "server-uuid", "status": "deleted" }
    ],
    "conflicts": [
      { "id": "uuid", "reason": "updated_by_other", "server_record": {...}, "your_data": {...} }
    ],
    "server_time": 1712600000000
  }
```

**Schema changes para sync:**
```sql
ALTER TABLE _records
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;         -- soft delete para sync

CREATE INDEX IF NOT EXISTS idx_records_sync
  ON _records(collection, updated_at DESC);
```

**Estrategia de conflictos (configurable por colección):**
- `last_write_wins` — el más reciente gana (default)
- `server_wins` — el servidor siempre gana
- `client_wins` — el cliente siempre gana
- `manual` — devuelve el conflicto, el cliente decide

**Respuesta de `GET /records/sync`:**
```json
{
  "collection": "tasks",
  "since": 1712500000000,
  "server_time": 1712600000000,
  "has_more": false,
  "changes": {
    "created": [{ "id": "...", "data": {...}, "updated_at": "..." }],
    "updated": [{ "id": "...", "data": {...}, "updated_at": "..." }],
    "deleted": ["uuid1", "uuid2"]
  }
}
```

**El flujo del cliente:**
```
1. Primera vez: GET /records/sync?collection=tasks&since=0  → descarga todo
2. Guarda server_time localmente
3. Trabaja offline — cambios van a una queue local
4. Reconecta: POST /records/sync/push { changes: [...] }
5. GET /records/sync?since={último_server_time} → bajar cambios de otros
6. Repetir desde 3
```

---

---

## Fase P — Confiabilidad y seguridad de datos

### P1. Webhook retry + Dead Letter Queue

**Problema:** Si el endpoint del cliente falla, el evento se pierde silenciosamente. El dev no se entera hasta que un usuario se queja. Es uno de los pain points más frecuentes en producción.

**Archivos a crear/modificar:**
- `lib/v2/queue.js` — agregar lógica de retry con backoff exponencial
- `routes/v2/project/data/webhooks.js` — agregar endpoints de DLQ

**Tabla nueva:**
```sql
CREATE TABLE IF NOT EXISTS _webhook_attempts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id   UUID NOT NULL,
  payload      JSONB NOT NULL,
  status       TEXT NOT NULL,        -- 'pending' | 'success' | 'failed' | 'dead'
  attempt      INTEGER DEFAULT 1,
  next_retry   TIMESTAMPTZ,
  response_status INTEGER,
  response_body   TEXT,
  error        TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_attempts_retry
  ON _webhook_attempts(next_retry) WHERE status = 'pending';
```

**Estrategia de retry (backoff exponencial):**
```
Intento 1 → inmediato
Intento 2 → 1 minuto después
Intento 3 → 5 minutos después
Intento 4 → 15 minutos después
Intento 5 → 1 hora después
Intento 6 → 6 horas después
→ Si falla 6 veces: status = 'dead' (Dead Letter Queue)
```

**Endpoints nuevos:**
```
GET  /webhooks/dlq                   → listar webhooks muertos (paginado)
GET  /webhooks/dlq/:id               → detalle de un intento fallido con payload y error
POST /webhooks/dlq/:id/retry         → reintentar manualmente un evento muerto
POST /webhooks/dlq/retry-all         → reintentar todos los muertos de un webhook
DELETE /webhooks/dlq/:id             → descartar evento muerto
GET  /webhooks/:id/attempts          → historial de intentos de un webhook
```

**Scheduler integration:** El cron runner interno revisa `_webhook_attempts WHERE status='pending' AND next_retry <= NOW()` cada minuto y ejecuta los pendientes.

**Notificación al dev:** Si un webhook entra en DLQ, enviar email al `notify_email` del proyecto (si configurado).

---

### P2. Invitation links — onboarding de usuarios sin fricción

**Problema:** El flujo actual para invitar usuarios es: crear cuenta → asignar rol manualmente. Son 2 requests y el dev tiene que manejar el email de invitación. Esto se hace en el 100% de las apps con acceso controlado.

**Archivos a crear:**
- `routes/v2/project/auth/invitations.js`

**Tabla nueva:**
```sql
CREATE TABLE IF NOT EXISTS _invitations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL,
  role        TEXT,
  token       TEXT NOT NULL UNIQUE,   -- hashed SHA-256
  invited_by  TEXT,
  expires_at  TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
```

**Endpoints:**
```
POST /auth/invitations
{
  "email": "nuevo@usuario.com",
  "role": "editor",
  "expires_in": "7d",
  "redirect_url": "https://miapp.com/bienvenido"
}
→ { "id": "uuid", "invite_url": "https://api.../v2/p/PID/auth/invitations/accept?token=xxx" }

GET  /auth/invitations              → listar invitaciones (pendientes/aceptadas/expiradas)
GET  /auth/invitations/:id          → detalle
DELETE /auth/invitations/:id        → revocar invitación
POST /auth/invitations/:id/resend   → reenviar email

GET  /auth/invitations/accept?token=xxx
→ Si el email ya tiene cuenta: loguea y asigna rol
→ Si no tiene cuenta: redirige al register con email pre-llenado y token en URL
→ Al completar registro: asigna el rol automáticamente
```

**Flujo completo:**
1. Dev hace `POST /auth/invitations { email, role: "editor" }`
2. Matebase envía email con link al usuario
3. Usuario hace click → si ya tiene cuenta queda logueado con el rol; si no, completa registro y queda con el rol
4. Dev ve `accepted_at` actualizado en la invitación

**Rate limit:** 20 invitaciones / hora por proyecto.

---

### P3. Data masking por rol

**Problema:** Compliance, GDPR, soporte técnico — hay campos que deben ser visibles solo para ciertos roles. Hoy requiere dos colecciones separadas o filtrado manual en el cliente.

**Archivos a crear/modificar:**
- `lib/v2/data-masker.js` — aplicar masks a la respuesta según el rol del usuario
- `routes/v2/project/data/list-records.js` — llamar al masker post-query
- `routes/v2/project/data/get-record.js` — ídem

**Configuración en `_fields`:**
```json
PATCH /collections/users/fields/phone
{
  "mask": {
    "strategy": "partial",      -- 'partial' | 'full' | 'hash' | 'redact'
    "pattern": "***-***-####",  -- solo para 'partial'
    "visible_to_roles": ["admin", "support"]
  }
}
```

**Estrategias de masking:**

| Strategy | Input | Output |
|----------|-------|--------|
| `partial` | `+54 9 11 1234-5678` | `+54 9 ** ****-5678` |
| `full` | `secreto@email.com` | `[REDACTED]` |
| `hash` | `dni-12345678` | `sha256:a3f9...` |
| `redact` | cualquier valor | `null` |

**Implementación:**
- Al serializar la respuesta, `data-masker.js` recibe el record y `req.projectUser.roles`
- Por cada campo con `mask` definido: verifica si `roles` incluye alguno de `visible_to_roles`
- Si no: aplica la estrategia de masking antes de devolver
- Transparente para el cliente: el campo sigue existiendo, solo su valor cambia
- Los campos masked no son filtrables ni buscables cuando el usuario no tiene acceso

---

### P4. Schema migration history

**Problema:** El dev elimina un campo en producción por error. No hay rollback. No hay registro de quién hizo el cambio ni cuándo. En Supabase tampoco hay esto — es una oportunidad.

**Archivos a crear/modificar:**
- `routes/v2/project/data/fields.js` — registrar cambios en `_schema_migrations`
- `routes/v2/project/data/create-collection.js` — ídem
- `routes/v2/project/data/delete-collection.js` — ídem
- `routes/v2/project/migrations.js` — endpoint de historial

**Tabla nueva:**
```sql
CREATE TABLE IF NOT EXISTS _schema_migrations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version      INTEGER NOT NULL,
  operation    TEXT NOT NULL,      -- 'create_collection' | 'drop_collection' | 'add_field' | 'remove_field' | 'alter_field'
  collection   TEXT,
  field        TEXT,
  prev_state   JSONB,              -- snapshot del estado anterior
  next_state   JSONB,              -- snapshot del nuevo estado
  performed_by TEXT,              -- user_id del platform user
  ip           TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
```

**Endpoints:**
```
GET /schema/migrations              → historial completo (paginado)
GET /schema/migrations/:version     → detalle de un cambio
POST /schema/migrations/:version/rollback
→ Intenta revertir el cambio (add_field → remove_field, etc.)
→ Solo rollback seguro: no recupera datos eliminados, solo estructura
```

**Ejemplo de historial:**
```json
{
  "version": 42,
  "operation": "remove_field",
  "collection": "users",
  "field": "phone",
  "prev_state": { "name": "phone", "type": "text", "required": false },
  "next_state": null,
  "performed_by": "admin@empresa.com",
  "created_at": "2026-04-11T14:30:00Z"
}
```

---

## Fase Q — Performance y control operacional

### Q1. Response caching por colección

**Problema:** `GET /records?collection=products` en una tienda puede llamarse 50,000 veces por hora. La respuesta cambia solo cuando hay un write. Sin cache, cada request golpea la DB.

**Archivos a crear:**
- `lib/v2/response-cache.js` — cache en Redis (si disponible) o in-memory con invalidación por write
- `routes/v2/project/cache/index.js` — CRUD de reglas de cache

**Tabla nueva:**
```sql
CREATE TABLE IF NOT EXISTS _cache_rules (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection   TEXT NOT NULL,
  ttl_seconds  INTEGER NOT NULL DEFAULT 60,
  vary_by      TEXT[] DEFAULT '{}',    -- [] = no vary, ['user'] = by user, ['role'] = by role
  is_active    BOOLEAN DEFAULT TRUE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
```

**Endpoints:**
```
GET    /cache/rules                  → listar reglas activas
POST   /cache/rules                  → crear regla { collection, ttl_seconds, vary_by }
DELETE /cache/rules/:id              → eliminar regla
POST   /cache/rules/:id/purge        → invalidar cache de esa colección ahora
GET    /cache/stats                  → hits/misses/keys actuales
```

**Configuración:**
```json
POST /cache/rules
{
  "collection": "products",
  "ttl_seconds": 300,
  "vary_by": []         // misma respuesta para todos
}

POST /cache/rules
{
  "collection": "user_feed",
  "ttl_seconds": 30,
  "vary_by": ["user"]   // cache separado por user_id
}
```

**Integración:**
- En `list-records.js`: antes de la query, verificar si hay regla activa y si el cache existe → devolver directo
- En `create-record.js`, `update-record.js`, `delete-record.js`: invalidar cache de la colección
- Cache key: `cache:{schemaName}:{collection}:{vary_value}:{query_hash}`

---

### Q2. IP allowlist / blocklist por proyecto

**Problema:** Clientes B2B, sistemas internos, APIs críticas necesitan restricción por IP. Sin esto el dev necesita un proxy externo o firewall.

**Archivos a crear:**
- `routes/v2/project/security/ip-rules.js`
- `lib/v2/ip-guard.js` — middleware que evalúa las reglas

**Tabla nueva:**
```sql
CREATE TABLE IF NOT EXISTS _ip_rules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type        TEXT NOT NULL,        -- 'allow' | 'block'
  cidr        TEXT NOT NULL,        -- '192.168.1.0/24' o '10.0.0.1/32'
  description TEXT,
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
```

**Endpoints:**
```
GET    /security/ip-rules           → listar reglas
POST   /security/ip-rules           → crear regla { type, cidr, description }
DELETE /security/ip-rules/:id       → eliminar regla
PATCH  /security/ip-rules/:id       → activar/desactivar

POST   /security/ip-rules/test      → { ip: "1.2.3.4" } → { allowed: true/false, matched_rule: {...} }
```

**Lógica de evaluación:**
1. Si hay reglas `allow`: solo IPs que matcheen alguna regla allow pueden pasar → resto bloqueado
2. Si solo hay reglas `block`: todas las IPs pasan excepto las que matcheen
3. Sin reglas: todas las IPs permitidas
4. Las reglas se cachean en memoria 60s (evitar DB en cada request)
5. Si bloqueado: `403 { error: "IP not allowed", code: "SEC_001" }`

---

### Q3. Rate limit configurable por colección/endpoint

**Problema:** El rate limit actual es global por proyecto. El dev no puede decir "este endpoint de registro acepta 3 req/min por IP pero el de búsqueda acepta 100".

**Archivos a crear/modificar:**
- `routes/v2/project/security/rate-limits.js`
- `index.js` — leer reglas custom de DB al procesar cada request de proyecto

**Tabla nueva:**
```sql
CREATE TABLE IF NOT EXISTS _rate_limit_rules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  path        TEXT NOT NULL,        -- '/auth/register' | '/records' (glob soportado)
  collection  TEXT,                 -- si aplica solo a una colección
  max         INTEGER NOT NULL,
  window_ms   INTEGER NOT NULL,     -- en milisegundos
  key_by      TEXT DEFAULT 'ip',    -- 'ip' | 'user' | 'api_key'
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
```

**Endpoints:**
```
GET    /security/rate-limits         → listar reglas custom
POST   /security/rate-limits         → crear regla
DELETE /security/rate-limits/:id     → eliminar
```

**Ejemplos:**
```json
{ "path": "/auth/register",    "max": 3,   "window_ms": 60000,   "key_by": "ip" }
{ "path": "/records",          "collection": "products", "max": 200, "window_ms": 60000, "key_by": "user" }
{ "path": "/functions/*/invoke", "max": 30, "window_ms": 60000,  "key_by": "api_key" }
```

---

### Q4. Collection aliases — migración sin downtime

**Problema:** Renombrar una colección de `users` a `profiles` rompe todos los clientes que ya están en producción. El dev necesita un período de transición.

**Archivos a crear/modificar:**
- `routes/v2/project/data/list-collection.js` — resolver alias antes de procesar
- `routes/v2/project/data/aliases.js`

**Tabla nueva:**
```sql
CREATE TABLE IF NOT EXISTS _collection_aliases (
  alias       TEXT PRIMARY KEY,
  collection  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ,         -- NULL = permanente
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
```

**Endpoints:**
```
GET    /collections/:name/aliases    → listar aliases de una colección
POST   /collections/:name/aliases    → crear alias { alias, expires_at }
DELETE /collections/:name/aliases/:alias → eliminar alias
```

**Comportamiento:**
- En cualquier endpoint que reciba `?collection=users`, si `users` es un alias de `profiles`, se resuelve transparentemente
- El header `X-Resolved-Collection: profiles` indica al cliente que se usó un alias
- Al expirar el alias (scheduler), se elimina automáticamente

---

## Fase R — Arquitectura multi-tenant avanzada

### R1. Orgs / Workspaces dentro de un proyecto

**Problema:** Apps SaaS donde cada cliente (empresa) ve solo sus propios datos. Hoy requiere `filter_rule: userId.eq:{{auth.id}}` en cada colección, que filtra por usuario pero no por organización.

**Archivos a crear:**
- `routes/v2/project/auth/orgs.js`
- `lib/v2/org-context.js` — middleware que inyecta `req.projectOrg`

**Tablas nuevas:**
```sql
CREATE TABLE IF NOT EXISTS _orgs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS _org_members (
  org_id      UUID REFERENCES _orgs(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  role        TEXT DEFAULT 'member',   -- 'owner' | 'admin' | 'member'
  joined_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (org_id, user_id)
);
```

**Endpoints:**
```
POST   /auth/orgs                    → crear organización
GET    /auth/orgs/me                 → orgs del usuario autenticado
GET    /auth/orgs/:slug              → detalle de una org (requiere ser miembro)
PATCH  /auth/orgs/:slug              → actualizar (requiere rol owner/admin)
DELETE /auth/orgs/:slug              → eliminar

GET    /auth/orgs/:slug/members      → listar miembros
POST   /auth/orgs/:slug/members      → agregar miembro { userId, role }
PATCH  /auth/orgs/:slug/members/:userId → cambiar rol
DELETE /auth/orgs/:slug/members/:userId → quitar miembro
```

**RLS integration:** Nueva variable `{{auth.org_id}}` disponible en filter_rules:
```json
{ "operation": "list", "access": "auth", "filter_rule": "org_id.eq:{{auth.org_id}}" }
```

El JWT incluye `org_id` cuando el usuario hace request con header `X-Org-Slug: acme`.

**Campo automático `_org_id`:** Si la colección tiene una regla con `{{auth.org_id}}`, Matebase inyecta automáticamente `_org_id` en cada INSERT sin que el cliente lo envíe.

---

### R2. Bulk dry-run y atomic batch con rollback garantizado

**Problema:** `POST /records/batch` existe pero si el registro #300 de 500 falla, los primeros 299 ya se insertaron. Para imports críticos (contabilidad, inventario) esto es inaceptable.

**Archivos a modificar:**
- `routes/v2/project/data/batch.js` — agregar soporte para `?dry_run=true` y `?atomic=true`

**Mejoras al endpoint existente:**

```
POST /records/batch?dry_run=true
→ Valida TODOS los registros (field validator, permisos, unique constraints)
→ NO escribe nada en DB
→ { "valid": 498, "invalid": 2, "errors": [{ "index": 12, "field": "email", "message": "..." }] }

POST /records/batch?atomic=true
→ Ejecuta todo en una única transacción PostgreSQL
→ Si cualquier operación falla: ROLLBACK completo, nada se escribe
→ { "ok": true, "inserted": 500 }  o  { "ok": false, "error": "...", "rolled_back": true }
```

**Límites:**
- `dry_run`: hasta 10,000 registros
- `atomic`: hasta 1,000 registros (transacción más grande = más riesgoso para el lock)

---

### R3. Query explain — optimizador de queries

**Problema:** El dev no sabe si su query está usando índices o haciendo un seq scan de 1M de registros. Sin acceso directo a PostgreSQL no puede usar `EXPLAIN ANALYZE`.

**Archivos a crear:**
- `routes/v2/project/data/explain.js`

**Endpoint:**
```
POST /records/explain
{
  "collection": "orders",
  "filter": "status.eq:pending&user_id.eq:uuid",
  "sort": "created_at",
  "order": "desc"
}
```

**Respuesta:**
```json
{
  "collection": "orders",
  "estimated_rows": 4200,
  "uses_index": true,
  "index_name": "idx_records_collection",
  "plan_type": "Index Scan",
  "warnings": [],
  "suggestions": [
    "Consider adding a GIN index on data->>'status' if this query runs frequently"
  ],
  "raw_plan": "Index Scan using idx_records_collection..."
}
```

**Seguridad:** Solo disponible con service key o para platform admins. No expone nombres internos de tablas.

---

## Resumen completo de Fase 3

### Todas las features (19 total)

| ID | Feature | Grupo | Esfuerzo | Prioridad |
|----|---------|-------|----------|-----------|
| L1 | Cron jobs declarativos | Quick wins | Bajo | 🔴 1 |
| L2 | Forms públicos | Quick wins | Bajo | 🔴 2 |
| M2 | Email logs + preview | Datos enriq. | Bajo | 🔴 3 |
| P2 | Invitation links | Confiabilidad | Bajo | 🔴 4 |
| P1 | Webhook retry + DLQ | Confiabilidad | Medio | 🟠 5 |
| P4 | Schema migration history | Confiabilidad | Bajo | 🟠 6 |
| M1 | Geo queries | Datos enriq. | Medio | 🟠 7 |
| Q2 | IP allowlist/blocklist | Performance | Bajo | 🟠 8 |
| Q1 | Response caching | Performance | Medio | 🟠 9 |
| P3 | Data masking por rol | Confiabilidad | Medio | 🟡 10 |
| N2 | Computed fields | Lógica decl. | Medio | 🟡 11 |
| Q3 | Rate limit por endpoint | Performance | Medio | 🟡 12 |
| Q4 | Collection aliases | Performance | Bajo | 🟡 13 |
| R2 | Bulk dry-run + atomic | Multi-tenant | Bajo | 🟡 14 |
| N1 | Workflows / State machines | Lógica decl. | Alto | 🔵 15 |
| O1 | Project branching | Infra | Medio | 🔵 16 |
| R1 | Orgs / Multi-tenancy | Multi-tenant | Alto | 🔵 17 |
| R3 | Query explain | Multi-tenant | Medio | 🔵 18 |
| O2 | Sync offline lite | Infra | Alto | 🔵 19 |

### Archivos a crear (completo)

| Archivo | Feature |
|---------|---------|
| `routes/v2/project/functions/crons.js` | L1 |
| `lib/v2/cron-runner.js` | L1 |
| `routes/v2/project/forms/index.js` | L2 |
| `routes/v2/project/forms/submit.js` | L2 |
| `routes/v2/project/email-logs.js` | M2 |
| `routes/v2/project/auth/invitations.js` | P2 |
| `routes/v2/project/data/geo.js` | M1 |
| `lib/v2/geo.js` | M1 |
| `routes/v2/project/security/ip-rules.js` | Q2 |
| `lib/v2/ip-guard.js` | Q2 |
| `lib/v2/response-cache.js` | Q1 |
| `routes/v2/project/cache/index.js` | Q1 |
| `lib/v2/data-masker.js` | P3 |
| `lib/v2/computed-fields.js` | N2 |
| `routes/v2/project/security/rate-limits.js` | Q3 |
| `routes/v2/project/data/aliases.js` | Q4 |
| `routes/v2/project/workflows/index.js` | N1 |
| `lib/v2/workflow-engine.js` | N1 |
| `routes/v2/platform/projects/branch.js` | O1 |
| `routes/v2/project/auth/orgs.js` | R1 |
| `lib/v2/org-context.js` | R1 |
| `routes/v2/project/data/explain.js` | R3 |
| `routes/v2/project/data/sync.js` | O2 |
| `routes/v2/project/migrations.js` | P4 |

### Archivos a modificar

| Archivo | Cambio |
|---------|--------|
| `lib/v2/queue.js` | P1 — retry logic + DLQ |
| `routes/v2/project/data/webhooks.js` | P1 — endpoints DLQ |
| `routes/v2/project/data/fields.js` | P4 — registrar en _schema_migrations |
| `routes/v2/project/data/list-records.js` | P3 masking + Q1 cache + Q4 aliases |
| `routes/v2/project/data/get-record.js` | P3 masking |
| `routes/v2/project/data/create-record.js` | N2 computed + Q1 invalidate cache |
| `routes/v2/project/data/update-record.js` | N1 workflow + N2 computed + Q1 cache |
| `routes/v2/project/data/delete-record.js` | Q1 invalidate cache |
| `routes/v2/project/data/batch.js` | R2 dry_run + atomic |
| `routes/v2/project/email-templates.js` | M2 preview + send-test |
| `lib/v2/scheduler.js` | L1 cron runner + P1 retry checker |
| `lib/v2/auth.js` | R1 org_id en JWT |
| `index.js` | Registrar todas las rutas nuevas + Q2 ip-guard middleware |

### Sin dependencias npm nuevas

Todo usa PostgreSQL nativo + Node 18+ nativo. No hay packages nuevos.

---

## Dashboard — Fase futura (post API)

> Una vez que la API esté completa, el dashboard puede agregar interfaces visuales sobre estas features:

- **Workflow editor drag & drop** — nodos de estados conectados con flechas, configuración visual de guards y side-effects
- **Form builder** — arrastrar campos, reordenar, preview en tiempo real del form HTML
- **Cron scheduler visual** — calendario de próximas ejecuciones, toggle activo/inactivo
- **Schema migration timeline** — línea de tiempo visual de todos los cambios de schema
- **Analytics dashboard** — gráficos de eventos, funnels, heatmaps de actividad
- **Webhook attempts explorer** — tabla con reintentos, estado, payload expandible
- **Geo visualizer** — mapa interactivo para ver registros con geopoints
- **Query explorer** — escribir filtros con autocompletado de campos, ver EXPLAIN en tiempo real

---

*Fecha: 2026-04-11*  
*Estado: Pendiente de implementación — 19 features en 6 grupos (L, M, N, O, P, Q, R)*
