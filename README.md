# Matebase API

Backend-as-a-Service (BaaS) multi-tenant inspirado en Supabase, Firebase e InsForge. Cada proyecto obtiene su propio schema aislado en PostgreSQL con autenticación, base de datos, storage, realtime, serverless functions e integración con AI.

---

## Quick Start

```bash
# 1. Instalar dependencias
npm install

# 2. Configurar variables de entorno
cp .env.example .env
# Editar .env con tus credenciales de DB

# 3. Ejecutar migraciones (proyectos existentes)
node migrate.js

# 4. Iniciar servidor
node index.js
```

El servidor arranca en `http://localhost:3001`.

---

## Arquitectura

### Multi-tenant por subdominio

Cada proyecto tiene un subdominio dedicado (`myproject.matecito.dev`). El middleware de subdominio resuelve el proyecto, reescribe las URLs públicas a rutas internas y adjunta `req.resolvedProject`.

### Dos capas de API

| Capa | Base URL | Propósito |
|------|----------|-----------|
| **Platform** | `api.matecito.dev/api/v2/platform/...` | Gestión de workspaces, proyectos, miembros, invites |
| **Proyecto** | `myproject.matecito.dev/api/v2/project/...` | Auth, datos, storage, realtime, functions por proyecto |

### Aislamiento de datos

Cada proyecto obtiene su propio **schema PostgreSQL** (`proj_<id>`) con tablas independientes. Los permisos RLS se aplican por colección y operación.

---

## Estructura del Proyecto

```
api/
├── index.js                    # Entry point — Fastify, middleware, route registry
├── db.js                       # PostgreSQL pool config
├── migrate.js                  # Script de migración para proyectos existentes
├── .env                        # Variables de entorno
│
├── lib/
│   ├── matecito.js             # Core v1 — SQL helpers, auth, RLS, projectRoute
│   ├── fcm.js                  # Firebase Cloud Messaging
│   └── v2/
│       ├── auth.js             # Auth v2 extensions (hashed tokens)
│       ├── errors.js           # Códigos de error estandarizados
│       ├── field-validator.js  # Validación de campos en escritura
│       ├── filter-parser.js    # Parser de filtros avanzados (G2)
│       ├── fulltext.js         # Full-text search helpers (G1)
│       ├── function-runner.js  # Sandbox VM para Functions (F1)
│       ├── migrations.js       # Platform migration runner
│       ├── permissions.js      # checkPermissionV2 con cache Redis
│       ├── populate.js         # Bulk-populate de relaciones
│       ├── queue.js            # Webhooks, emails, triggers, audit log
│       ├── realtime.js         # pg_notify event bus + WebSocket
│       ├── redis.js            # IORedis opcional con fallback in-memory
│       ├── scheduler.js        # Cleanup jobs periódicos
│       ├── schema.js           # ensureV2Tables — tablas lazy por proyecto
│       └── validators.js       # JSON Schemas para Fastify
│
├── routes/
│   └── v2/
│       ├── platform/           # Gestión de workspaces, proyectos, auth platform
│       └── project/
│           ├── auth/           # Login, register, OAuth, magic-link, TOTP, roles
│           ├── data/           # CRUD, search, filters, aggregates, vector search
│           ├── storage/        # Upload, list, delete, serve, presign
│           ├── realtime/       # WebSocket con subscripciones
│           ├── notifications/  # Push (FCM) + in-app notifications
│           ├── config/         # Remote Config / Feature Flags
│           ├── functions/      # Serverless JS CRUD + invoke + logs + env + triggers
│           ├── ai/             # AI Gateway + Schema generation
│           ├── analytics/      # Event tracking + funnels
│           ├── logs/           # Request logs + SSE stream
│           ├── mcp/            # MCP server para agentes AI
│           └── playground.js   # API Playground (REST explorer HTML)
│
└── docs/
    ├── v2-roadmap.md           # Roadmap original (Fases A–E)
    ├── v2-roadmap-fase2.md     # Roadmap Fase 2 (F–K) — ✅ COMPLETO
    └── v2-changelog.md         # Changelog completo de todo lo implementado
```

---

## Features Implementadas

### Fase A–E (previamente implementadas)

| Feature | Descripción |
|---------|-------------|
| **A1** Validación de campos | Type coercion, constraints, required, unique, relations |
| **A2** Agregaciones | SUM, AVG, MIN, MAX, COUNT con GROUP BY |
| **A3** Import CSV/JSON | Hasta 5000 filas con validación |
| **A4** Populate de relaciones | LEFT JOIN automático en query |
| **B1** Magic link | Login sin contraseña con link por email |
| **B2** Roles custom | `_roles`, `_user_roles`, RLS por `role.in:` |
| **B3** 2FA TOTP | Google Authenticator compatible, backup codes |
| **C1** Realtime con filtros | Subscribe por colección + filtro de campo |
| **C2** Webhooks con filtros | `filter_rule` por colección/evento |
| **C3** Presigned URLs | URLs firmadas con TTL para storage privado |
| **D1** Audit log | Historial de cambios en permisos y datos |
| **D2** Scheduled cleanup | Limpieza de expirados, audit log, exports |
| **D3** Rate limit por usuario | Key por `projectId:userId` si auth'd |
| **E1** SDK headers | `X-Matecito-Version`, `X-Storage-Used-MB`, etc. |
| **E2** Schema introspection | `GET /schema` — todo en una llamada |
| **E3** Test webhooks | `POST /webhooks/:id/test` |

### Fase F–K (Roadmap Fase 2 — ✅ 14/14 COMPLETO)

| # | Feature | Endpoints clave | Descripción |
|---|---------|-----------------|-------------|
| 1 | **G1** Full-text search | `GET /records/search`, `POST /collections/:name/search-config` | Búsqueda nativa PostgreSQL con `tsvector`/`ts_rank`. 6 idiomas. |
| 2 | **I1** Remote Config | `GET/PUT/DELETE /config`, `GET/PUT/DELETE /config/:key` | Feature flags + config dinámica con cache 60s. |
| 3 | **G2** Filtros avanzados | `GET /records?campo.gt:10`, `POST /records/query` | `gt/gte/lt/lte/between/in/nin/null/like/ilike/has/or` |
| 4 | **J2** Notification Center | `POST /notifications`, `GET /notifications/me`, realtime WS | Notificaciones in-app con lectura, marcado, broadcast. |
| 5 | **F1** Functions lite | `POST /functions/:name/invoke` | Código JS serverless sandboxeado con `vm`, timeout, contexto DB. |
| 6 | **F2** Triggers | `POST /functions/triggers` | Ejecución automática de functions en create/update/delete. |
| 7 | **H1** AI Model Gateway | `POST /ai/chat`, `POST /ai/embed`, `GET /ai/usage` | Proxy a OpenAI/Anthropic/Groq con streaming + tracking. |
| 8 | **I2** Event Analytics | `POST /analytics/track`, `GET /analytics/funnel` | Tracking de eventos, agregación, funnels de conversión. |
| 9 | **J1** App Check | `GET /auth/app-check/challenge`, `POST /auth/app-check/verify` | Proof-of-work SHA-256 anti-bot en endpoints públicos. |
| 10 | **K1** MCP Server | `GET /mcp` (WebSocket JSON-RPC) | 7 tools para Claude/Cursor: query, create, update, delete, schema. |
| 11 | **G3** Vector search | `POST /records/vector/search` | Semantic search con `pgvector` + cosine similarity. |
| 12 | **H2** AI Schema gen | `POST /ai/schema`, `POST /ai/schema/apply` | Describe en lenguaje natural → LLM sugiere schema → aplica. |
| 13 | **K3** Logs stream | `GET /logs/stream` (SSE), `GET /logs/errors` | Logs en tiempo real via Server-Sent Events. |
| 14 | **K2** API Playground | `GET /playground` | HTML REST explorer con formularios interactivos. |

---

## Autenticación

### Platform Auth
- JWT con `kind: "platform"` para gestión de workspaces y proyectos.

### Project Auth
- **Email/password** con bcrypt, email verification.
- **OAuth2** (Google, GitHub) con código one-time 60s.
- **Magic link** sin contraseña.
- **2FA TOTP** con Google Authenticator + 8 backup codes.
- **API keys**: `anon`, `service`, `custom` con scopes (`read`, `write`, `*`).

### Niveles de acceso
| Nivel | Descripción |
|-------|-------------|
| `public` | Cualquiera puede acceder |
| `auth` | Requiere autenticación |
| `service` | Requiere service key |
| `nobody` | Nadie puede acceder |

### RLS Filter Rules
Formato: `field.op:{{auth.id}}` donde op = `eq`, `neq`, `in`, `role.in:admin,editor`.

---

## Base de Datos

### Tablas del Schema de Proyecto

| Tabla | Propósito |
|-------|-----------|
| `_auth_users` | Usuarios autenticados |
| `_collections` | Definición de colecciones |
| `_fields` | Campos de cada colección (tipo, required, constraints) |
| `_permissions` | Permisos por colección y operación |
| `_records` | Datos de las colecciones |
| `_webhooks` | Webhooks configurados |
| `_refresh_tokens` | Tokens de refresco |
| `_smtp_config` | Configuración SMTP por proyecto |
| `_email_templates` | Templates de email customizables |
| `_audit_log` | Historial de cambios admin/data |
| `_export_jobs` | Jobs de export async (JSON/CSV) |
| `_roles` | Roles custom del proyecto |
| `_user_roles` | Asignación de roles a usuarios |
| `_magic_links` | Tokens de magic link (hashed) |
| `_oauth_providers` | Configuración OAuth por proyecto |
| `_fcm_tokens` | Tokens FCM por usuario |
| `_remote_config` | Feature flags y config dinámica (I1) |
| `_notifications` | Notificaciones in-app (J2) |
| `_functions` | Código JS serverless (F1) |
| `_function_logs` | Historial de ejecuciones (F1) |
| `_function_env` | Variables de entorno encriptadas (F1) |
| `_triggers` | Asociación function→evento (F2) |
| `_project_settings` | Config de AI Gateway (H1) |
| `_ai_usage` | Tracking de tokens de LLM (H1) |
| `_analytics_events` | Eventos de usuario (I2) |

### Columnas especiales en `_records`

| Columna | Tipo | Propósito |
|---------|------|-----------|
| `search_vector` | `tsvector` | Índice full-text search (G1) |
| `embedding` | `vector(1536)` | Embedding semántico con pgvector (G3) |
| `deleted_at` | `TIMESTAMP` | Soft delete |
| `expires_at` | `TIMESTAMP` | Auto-expiración |
| `data` | `JSONB` | Datos del registro |

---

## Endpoints Principales

### Auth del Proyecto
```
POST   /auth/register           → registro con email/password
POST   /auth/login              → login con JWT + refresh tokens
POST   /auth/refresh            → refresh access token
POST   /auth/logout             → revocar refresh token
GET    /auth/me                 → perfil del usuario actual
POST   /auth/magic-link         → login sin contraseña
POST   /auth/totp/setup         → configurar 2FA
POST   /auth/oauth/:provider    → OAuth2 (Google, GitHub)
GET    /auth/users              → listar usuarios (admin)
GET    /auth/roles              → gestionar roles
```

### Datos
```
GET    /records?collection=posts&limit=50&cursor=...
POST   /records                 → crear registro
GET    /records/:id             → obtener registro
PATCH  /records/:id             → actualizar registro
DELETE /records/:id             → eliminar registro
POST   /records/upsert          → insert or update
POST   /batch                   → batch operations (hasta 50 ops)
GET    /records/search?q=query&collection=posts&limit=20
POST   /records/query           → query avanzada con body JSON
GET    /records/aggregate?collection=&group_by=&sum=&avg=
GET    /records/count?collection=
POST   /records/vector/upsert   → guardar embedding
POST   /records/vector/search   → búsqueda semántica
```

### Functions
```
GET    /functions               → listar functions
POST   /functions               → crear function
GET    /functions/:name         → detalle
PATCH  /functions/:name         → actualizar
DELETE /functions/:name         → eliminar
POST   /functions/:name/invoke  → ejecutar
GET    /functions/:name/logs    → historial
GET    /functions/env           → listar keys
POST   /functions/env           → crear env var
GET    /functions/triggers      → listar triggers
POST   /functions/triggers      → crear trigger
```

### AI
```
POST   /ai/chat                 → chat con LLM (streaming soportado)
POST   /ai/embed                → generar embeddings
GET    /ai/usage                → consumo de tokens
PUT    /project/ai-config       → configurar provider + API key
POST   /ai/schema               → describir app → sugiere schema
POST   /ai/schema/apply         → aplicar schema sugerido
```

### Analytics
```
POST   /analytics/track         → trackear evento
GET    /analytics/events?from=&to=&group_by=event
GET    /analytics/funnel?steps=page_viewed,purchase_completed
GET    /analytics/users/:id/events
```

### Notificaciones
```
POST   /notifications           → enviar a usuarios
POST   /notifications/broadcast → enviar a todos
GET    /notifications/me        → mis notificaciones
GET    /notifications/me/unread-count
PATCH  /notifications/:id/read  → marcar leída
PATCH  /notifications/me/read-all
```

### Config / Logs / Otros
```
GET    /config                  → feature flags públicos
PUT    /config/:key             → crear/actualizar flag
GET    /logs/stream             → SSE logs en tiempo real
GET    /logs/errors             → solo errores
GET    /playground              → API Playground HTML
GET    /mcp                     → MCP Server (WebSocket)
```

---

## Variables de Entorno

```env
# Servidor
PORT=3001

# PostgreSQL
DB_HOST=localhost
DB_USER=matebase
DB_PASSWORD=tu_password
DB_NAME=matebase_console

# JWT
JWT_SECRET=tu_secret_largo_y_seguro

# Dominio y Storage
DOMAIN=matecito.dev
STORAGE_PATH=/opt/matebase/storage
STORAGE_URL=http://localhost:3001/storage/files

# Redis (opcional — cache distribuido + rate limit)
REDIS_URL=redis://localhost:6379

# Logging
LOG_LEVEL=info
NODE_ENV=production
```

---

## Migraciones

### Platform migrations (`lib/v2/migrations.js`)
Se ejecutan automáticamente al startup. Tabla tracking: `_platform_migrations`.

| ID | Descripción |
|---|---|
| `001` | Tracking table |
| `002` | `storage_quota_mb` en projects |
| `003` | `allowed_origins` en projects |
| `004` | Full-text search (search_vector + search_fields) |
| `005` | Remote Config table |
| `006` | Notifications table |
| `007` | Functions + Triggers tables |
| `008` | AI + Analytics tables |

### Per-project schema (`lib/v2/schema.js`)
Se aplica lazy vía `ensureV2Tables()` cuando se necesita una feature v2. Idempotente.

### Script de migración (`migrate.js`)
Para proyectos ya existentes:
```bash
node migrate.js
```
Aplica **todas** las columnas y tablas nuevas a cada schema de proyecto existente.

---

## Seguridad

| Característica | Implementación |
|---|---|
| Passwords | bcrypt con 10-12 rounds |
| Tokens reset/verify | SHA-256 hashed en DB, raw solo al usuario |
| OAuth | Código one-time 60s, nunca tokens en URL |
| API keys | Scopes: `read`, `write`, `*` |
| RLS | Filter rules por colección, cache 2 min |
| Functions sandbox | `vm.runInNewContext` sin require/process/fs |
| Env vars functions | AES-256-CBC encriptadas en DB |
| AI provider keys | AES-256-CBC encriptadas en DB |
| App Check | Proof-of-work SHA-256 anti-bot |
| Rate limit | Redis distribuido o in-memory fallback |

---

## Dependencias

```bash
npm install
```

Dependencias clave:
- `fastify` v5 — framework HTTP
- `pg` — cliente PostgreSQL
- `bcrypt` — hashing de passwords
- `jsonwebtoken` — JWT
- `nodemailer` — envío de emails
- `sharp` — procesamiento de imágenes
- `ioredis` — Redis opcional
- `@fastify/rate-limit` — rate limiting
- `@fastify/swagger` + `@fastify/swagger-ui` — docs en `/docs`
- `@fastify/websocket` — WebSocket support

Sin dependencias nativas requeridas para las features Fase 2.

---

## pgvector (Feature G3)

Vector search requiere la extensión `pgvector` en PostgreSQL:

```sql
-- Verificar disponibilidad
SELECT * FROM pg_available_extensions WHERE name = 'vector';

-- Instalar (Debian/Ubuntu)
sudo apt install postgresql-15-vector

-- Activar
CREATE EXTENSION vector;
```

Si no está disponible, el resto de features funcionan normalmente. `POST /records/vector/*` devolverá un error 501 informativo.

---

## Docs

- **Roadmap original:** [`docs/v2-roadmap.md`](docs/v2-roadmap.md)
- **Roadmap Fase 2:** [`docs/v2-roadmap-fase2.md`](docs/v2-roadmap-fase2.md)
- **Changelog completo:** [`docs/v2-changelog.md`](docs/v2-changelog.md)
- **Swagger UI:** `http://localhost:3001/docs` (al correr el servidor)
- **API Playground:** `http://localhost:3001/playground` (por proyecto)

---

## License

Private — Matebase 2025
