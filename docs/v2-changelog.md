# Matebase API v2 — Changelog completo

> Todo lo nuevo vive bajo `/api/v2/`. El `/api/v1/` no fue modificado.

---

## Arquitectura general

- **v1** — Sin cambios. Usuarios existentes no se rompen.
- **v2** — Rutas bajo `/api/v2/platform` y `/api/v2/project/:projectId/...`
- Subdominios públicos (`proyecto.matecito.dev`) siguen reescribiendo a v1 internamente.

---

## Librerías nuevas — `lib/v2/`

| Archivo | Responsabilidad |
|---|---|
| `auth.js` | Re-exporta v1 + `hashToken`, `verifyHashedToken`, `createPasswordResetToken`, `verifyPasswordResetToken`, `createEmailVerificationToken`, `consumeEmailVerificationToken` |
| `errors.js` | Códigos estandarizados (`AUTH_001`–`GEN_005`). Función `apiError(reply, code, msg)` |
| `permissions.js` | `checkPermissionV2` con cache Redis/in-memory, RLS operadores `eq/neq/in`, `logPermissionChange`, `invalidatePermCache` |
| `queue.js` | `enqueueWebhook` (retry 3x + backoff), `enqueueEmail` (async + logging), `processExportJob` |
| `realtime.js` | `emitProjectEvent` (local + `pg_notify`), `startRealtimeListener` (conexión PG dedicada) |
| `redis.js` | Cliente IORedis opcional. Fallback in-memory si no hay `REDIS_URL` |
| `oauth-codes.js` | Códigos one-time 60s para exchange OAuth. `createOAuthCode` / `consumeOAuthCode` |
| `schema.js` | `ensureV2Tables(schemaName)` — crea `_audit_log`, `_export_jobs`, `_remote_config`, columnas `search_vector`/`search_fields`, índices GIN. Idempotente |
| `validators.js` | JSON Schemas reutilizables para validación Fastify |
| `migrations.js` | Runner de migraciones de plataforma. Tabla `_platform_migrations`. Corre al startup |
| `fulltext.js` | Full-text search nativo PostgreSQL. `buildSearchVectorUpdate()`, `searchRecords()`, `getSearchFields()` |
| `filter-parser.js` | Parser centralizado de filtros avanzados: `gt/gte/lt/lte/between/in/nin/null/like/ilike/has/or` |
| `function-runner.js` | Sandbox `vm.runInNewContext` para Functions lite. `runFunction()`, `createDbHelper()` |

---

## Rutas nuevas — `routes/v2/platform/`

| Archivo | Endpoints |
|---|---|
| `auth/register.js` | `POST /auth/register` |
| `auth/login.js` | `POST /auth/login` |
| `auth/refresh.js` | `POST /auth/refresh` |
| `auth/logout.js` | `POST /auth/logout` |
| `auth/reset-password.js` | `POST /auth/request-reset` + `POST /auth/reset-password` |
| `me.js` | `GET /me` + `PATCH /me` |
| `create-p.js` | `POST /projects` |
| `create-w.js` | `POST /workspaces` |
| `delete-p.js` | `DELETE /projects/:id` |
| `delete-w.js` | `DELETE /workspaces/:id` |
| `list-p.js` | `GET /projects` |
| `list-w.js` | `GET /workspaces` |
| `rename-p.js` | `PATCH /projects/:id` |
| `rename-w.js` | `PATCH /workspaces/:id` |
| `info-p.js` | `GET /projects/:id` |
| `info-w.js` | `GET /workspaces/:id` |
| `invites/creates.js` | `POST /invites` |
| `invites/list.js` | `GET /invites` |
| `invites/accept.js` | `POST /invites/:token/accept` |
| `members/add.js` | `POST /members` |
| `members/list.js` | `GET /members` |
| `members/remove.js` | `DELETE /members/:userId` |
| `members/update.js` | `PATCH /members/:userId` |
| `newsletter.js` | `POST /newsletter/subscribe` |
| `migrations.js` | `GET /migrations` |

---

## Rutas nuevas — `routes/v2/project/`

### Auth de proyecto

| Archivo | Endpoints | Novedades |
|---|---|---|
| `auth/register.js` | `POST /auth/register` | bcrypt 10 rounds, email verification hasheado |
| `auth/login.js` | `POST /auth/login` | Audit log |
| `auth/refresh.js` | `POST /auth/refresh` | Rotación de refresh token |
| `auth/logout.js` | `POST /auth/logout` | Revocación de refresh token |
| `auth/me.js` | `GET/PATCH /auth/me` | Campo `email_verified` |
| `auth/verify-email.js` | `GET /auth/verify-email` + `POST /auth/resend-verification` | Token hasheado SHA-256 |
| `auth/reset-password.js` | `POST /auth/request-reset` + `POST /auth/reset-password` | Hash en DB, bcrypt 12 al resetear, revoca refresh tokens |
| `auth/oauth.js` | `GET /auth/oauth/:provider` + callback + `POST /auth/oauth/exchange` | **Fix seguridad: tokens nunca en URL, código one-time 60s** |
| `auth/list-users.js` | `GET /auth/users` + `DELETE /auth/users/:userId` | Paginado |
| `auth/oauth-providers.js` | `GET/POST/DELETE /auth/oauth-providers` | — |

### Data layer

| Archivo | Endpoints | Novedades |
|---|---|---|
| `data/list-records.js` | `GET /records` | **Cursor pagination**, field projection, OR filters, full-text search, relation JOINs, RLS extendido |
| `data/create-record.js` | `POST /records` | `checkPermissionV2`, `emitProjectEvent`, `enqueueWebhook` |
| `data/get-record.js` | `GET /records/:id` | RLS post-fetch |
| `data/update-record.js` | `PATCH /records/:id?` | Single + bulk, `expires_at`, fix subquery PG |
| `data/delete-record.js` | `DELETE /records/:id?` | Single + bulk, soft delete, fix subquery PG |
| `data/upsert.js` | `POST /records/upsert` | Insert o update por campos de conflicto |
| `data/restore.js` | `POST /records/:id/restore` + `DELETE /records/:id/hard` | Restore + hard delete |
| `data/batch.js` | `POST /batch` | Hasta 50 ops en una transacción PG |
| `data/count.js` | `GET /records/count` | Con RLS, filtros, full-text |
| `data/search.js` | `GET /records/search` | Full-text search con tsvector/ts_rank |
| `data/search-config.js` | `POST /collections/:name/search-config` | Configura campos de búsqueda + reindexa |
| `data/query-records.js` | `POST /records/query` | Query avanzada con body JSON (where, or, sort, limit, offset) |
| `data/export.js` | `GET /records/export` | CSV y JSON, hasta 10k filas |
| `data/permissions.js` | `GET/PATCH /collections/:name/permissions` | Audit log, `invalidatePermCache` |
| `data/fields.js` | `GET/POST/PATCH/DELETE /fields` | Constraints en campos |
| `data/sql.js` | `POST /sql` | Protecciones + JSON Schema |
| `data/webhooks.js` | `GET/POST/PATCH/DELETE /webhooks` | Máx 20 por proyecto |
| `data/logs.js` | `GET /logs` | Paginado, filtro status, queries paralelas |
| `data/stats.js` | `GET /stats` | Usuarios, colecciones, registros, db_size, storage, settings — paralelo |
| `data/list-collection.js` | `GET /collections` | `?include=fields,counts,permissions` |
| `data/create-collection.js` | `POST /collections` | Transaccional: colección + campos + permisos default |
| `data/delete-collection.js` | `DELETE /collections/:name` | Guard `?force=true` |
| `data/rename-collection.js` | `PATCH /collections/:name` | Renombra atómicamente en todas las tablas |

### Configuración de proyecto

| Archivo | Endpoints |
|---|---|
| `config/index.js` | `GET/PUT/DELETE /config`, `GET/PUT/DELETE /config/:key` — Remote Config / Feature Flags con cache 60s |
| `api-keys.js` | `GET/POST/DELETE /api-keys` |
| `settings.js` | `GET/PATCH /settings` |
| `smtp.js` | `GET/PUT/DELETE/POST(test) /smtp` |
| `regenerate-key.js` | `POST /regenerate-key` |
| `email-templates.js` | `GET/POST/PATCH/DELETE /email-templates` + `POST /email-templates/seed` |

### Storage

| Archivo | Endpoints |
|---|---|
| `storage/upload.js` | `POST /storage/upload` — multipart, Sharp → WebP, quota check |
| `storage/list.js` | `GET /storage/files` |
| `storage/delete.js` | `DELETE /storage/files/:id` |
| `storage/upload-url.js` | `POST /storage/upload-url` — fetch URL remota → WebP |

### Notificaciones

| Archivo | Endpoints |
|---|---|
| `notifications/index.js` | `POST /notifications`, `POST /notifications/broadcast`, `GET /notifications/me`, `GET /notifications/me/unread-count`, `PATCH /notifications/:id/read`, `PATCH /notifications/me/read-all`, `DELETE /notifications/:id` |
| `notifications/send.js` | `POST /notifications/send` — FCM push + persist en `_notifications` |
| `notifications/register-token.js` | `POST /notifications/register-token` |
| `notifications/firebase-config.js` | `GET/PUT/DELETE /notifications/firebase-config` |

### AI

| Archivo | Endpoints |
|---|---|
| `ai/gateway.js` | `POST /ai/chat` (streaming), `POST /ai/embed`, `GET /ai/usage`, `PUT /project/ai-config` |
| `ai/schema-gen.js` | `POST /ai/schema` (describe → sugiere schema), `POST /ai/schema/apply` |

### Analytics

| Archivo | Endpoints |
|---|---|
| `analytics/index.js` | `POST /analytics/track`, `GET /analytics/events`, `GET /analytics/funnel`, `GET /analytics/users/:id/events` |

### Auth

| Archivo | Endpoints |
|---|---|
| `auth/app-check.js` | `GET /auth/app-check/challenge`, `POST /auth/app-check/verify` (proof-of-work anti-bot) |

### Functions (serverless JS)

| Archivo | Endpoints |
|---|---|
| `functions/index.js` | `GET/POST /functions`, `GET/PATCH/DELETE /functions/:name` |
| `functions/invoke.js` | `POST /functions/:name/invoke` — ejecutar function sandboxeada |
| `functions/logs.js` | `GET /functions/:name/logs` — historial de ejecuciones |
| `functions/env.js` | `GET/POST/DELETE /functions/env` — variables de entorno encriptadas (AES-256) |
| `functions/triggers.js` | `GET/POST /functions/triggers`, `PATCH/DELETE /functions/triggers/:id` |

### Otros

| Archivo | Endpoints |
|---|---|
| `logs/stream.js` | `GET /logs/stream` (SSE), `GET /logs`, `GET /logs/errors` |
| `playground.js` | `GET /playground` — HTML REST explorer |
| `mcp/index.js` | `GET /mcp` — WebSocket MCP server (JSON-RPC) |
| `data/vector-search.js` | `POST /records/vector/upsert`, `POST /records/vector/search` |

### Realtime

| Archivo | Endpoints |
|---|---|
| `realtime/ws.js` | `GET /ws` — WebSocket, auth por API key o JWT, subscribe/unsubscribe por colección |

---

## Cambios en esquema de base de datos

### Tablas nuevas (Fase F–K)

| Tabla | Columnas | Fase |
|---|---|---|
| `_remote_config` | `id, key UNIQUE, value JSONB, description, is_public, updated_at, updated_by` | I1 |
| `_notifications` | `id, user_id, title, body, type, data JSONB, read_at, created_at` | J2 |
| `_functions` | `id, name UNIQUE, description, code, timeout_ms, is_public, created_at, updated_at` | F1 |
| `_function_logs` | `id, function_id FK, status, duration_ms, result JSONB, error, invoked_by, created_at` | F1 |
| `_function_env` | `id, key UNIQUE, value_enc (AES-256), created_at` | F1 |
| `_triggers` | `id, collection, event, function_name, is_active, created_at` | F1/F2 |
| `_project_settings` | `id, ai_config JSONB, updated_at` | H1 |
| `_ai_usage` | `id, model, prompt_tokens, completion_tokens, user_id, endpoint, created_at` | H1 |
| `_analytics_events` | `id, event, user_id, session_id, properties JSONB, ip, user_agent, created_at` | I2 |

### Columnas nuevas en tablas existentes

| Tabla | Columna | Tipo | Propósito |
|---|---|---|---|
| `_records` | `search_vector` | `tsvector` | Índice full-text search (G1) |
| `_collections` | `search_fields` | `TEXT[]` | Qué campos se indexan en search_vector |

### Índices nuevos

| Índice | Tabla | Tipo |
|---|---|---|
| `*_records_search_vector_idx` | `_records` | GIN sobre `search_vector` |

### Migraciones de plataforma nuevas

| ID | Descripción |
|---|---|
| `004_fulltext_search` | Agrega `search_vector`, `search_fields` + índice GIN en todos los proyectos |
| `005_remote_config` | Crea tabla `_remote_config` en todos los proyectos |
| `006_notifications` | Crea tabla `_notifications` + índice en todos los proyectos |
| `007_functions_and_triggers` | Crea `_functions`, `_function_logs`, `_function_env`, `_triggers` en todos los proyectos |
| `008_ai_and_analytics` | Crea `_project_settings`, `_ai_usage`, `_analytics_events` en todos los proyectos |

---

## Cambios en archivos existentes

| Archivo | Cambio |
|---|---|
| `index.js` | Registra v2 routes, Swagger (`/docs`), `@fastify/rate-limit` con Redis, correlation IDs (`X-Request-ID`), health mejorado, migraciones al startup, logger por env |
| `package.json` | Nuevas dependencias: `ioredis`, `@fastify/swagger`, `@fastify/swagger-ui` |
| `routes/v2/project/data/create-record.js` | Integra `buildSearchVectorUpdate()` — indexa full-text al crear |
| `routes/v2/project/data/update-record.js` | Integra `buildSearchVectorUpdate()` — indexa full-text al actualizar |
| `routes/v2/project/data/upsert.js` | Integra `buildSearchVectorUpdate()` — indexa full-text en upsert |
| `routes/v2/project/data/batch.js` | Integra `buildSearchVectorUpdate()` — indexa full-text en batch insert/update |
| `routes/v2/project/data/list-records.js` | Integrado con `filter-parser.js` — soporta operadores avanzados y OR |
| `routes/v2/project/data/create-record.js` | Integra `buildSearchVectorUpdate()` + `enqueueTrigger()` |
| `routes/v2/project/data/update-record.js` | Integra `buildSearchVectorUpdate()` + `enqueueTrigger()` |
| `routes/v2/project/data/delete-record.js` | Integra `enqueueTrigger()` |
| `routes/v2/project/data/upsert.js` | Integra `buildSearchVectorUpdate()` + `enqueueTrigger()` |
| `routes/v2/project/data/batch.js` | Integra `enqueueWebhook()` + `enqueueTrigger()` en todas las ops |
| `routes/v2/project/notifications/send.js` | Persiste en `_notifications` además de FCM push |
| `routes/v2/project/realtime/ws.js` | Agrega subscripción `_notifications:{userId}` para realtime in-app |
| `lib/v2/queue.js` | Agrega `enqueueTrigger()` — dispara functions asociadas a eventos |

---

## Fase 3 — Features (19/19 implementadas ✅)

### Librerías nuevas `lib/v2/`

| Archivo | Responsabilidad |
|---|---|
| `geo.js` | Geo queries Haversine sin PostGIS (M1) |
| `cron-runner.js` | Parser cron expressions + ejecución loop (L1) |
| `workflow-engine.js` | Validador de state machines + guards + on_enter (N1) |
| `computed-fields.js` | Evaluador de fórmulas SQL/JS (N2) |
| `response-cache.js` | Cache Redis/in-memory con invalidación (Q1) |
| `ip-guard.js` | Allowlist/blocklist CIDR (Q2) |
| `data-masker.js` | Enmascaramiento de campos por rol (P3) |
| `org-context.js` | Multi-tenancy por org dentro del proyecto (R1) |

### Rutas nuevas — Fase 3

| Archivo | Endpoints | Feature |
|---|---|---|
| `functions/crons.js` | CRUD + run manual | L1 Cron jobs |
| `forms/index.js` | CRUD de forms | L2 Forms |
| `forms/submit.js` | `POST /f/:formId` (público) | L2 Form submit |
| `data/geo.js` | `/records/geo/nearby`, `/bounds`, `/batch-distance` | M1 Geo queries |
| `data/explain.js` | `POST /records/explain` | R3 Query explain |
| `data/sync.js` | `GET /records/sync`, `POST /records/sync/push` | O2 Sync offline |
| `data/aliases.js` | CRUD de collection aliases | Q4 Aliases |
| `auth/invitations.js` | CRUD + accept | P2 Invitations |
| `workflows/index.js` | CRUD + history + workflow-state | N1 Workflows |
| `auth/orgs.js` | CRUD orgs + members | R1 Orgs |
| `security/ip-rules.js` | CRUD + test IP | Q2 IP rules |
| `security/rate-limits.js` | CRUD rate limit rules | Q3 Rate limits |
| `cache/index.js` | CRUD cache rules + purge + stats | Q1 Response cache |
| `email-logs.js` | Email logs + preview + send-test | M2 Email logs |
| `migrations.js` | Schema migration history + rollback | P4 Schema migrations |

### Tablas nuevas — Fase 3

| Tabla | Feature |
|---|---|
| `_crons` | L1 Cron jobs |
| `_forms` | L2 Forms |
| `_email_logs` | M2 Email logs |
| `_workflows`, `_workflow_history` | N1 Workflows |
| `_webhook_attempts` | P1 Webhook DLQ |
| `_invitations` | P2 Invitations |
| `_schema_migrations` | P4 Schema migrations |
| `_cache_rules` | Q1 Response cache |
| `_ip_rules` | Q2 IP rules |
| `_rate_limit_rules` | Q3 Rate limits |
| `_collection_aliases` | Q4 Aliases |
| `_orgs`, `_org_members` | R1 Orgs |

### Features adicionales de Fase 3

| Feature | Archivo | Detalle |
|---------|---------|---------|
| **O1** Project branching | `routes/v2/platform/projects/branch.js` | Crear branch, diff, merge, delete — dev/staging/prod sin costo extra |
| **R2** Bulk dry-run + atomic | `routes/v2/project/data/batch.js` | `?dry_run=true` valida sin escribir, `?atomic=true` rollback total |
| **P1** Webhook retry + DLQ | `lib/v2/queue.js` + `webhooks.js` | Retry 6x backoff exponencial, dead letter queue, `GET /webhooks/dlq`, retry manual |
| **P3** Data masking por rol | `lib/v2/data-masker.js` | Strategies: `partial`, `full`, `hash`, `redact`. Config por campo en `_fields` |
| **R3** Query explain | `routes/v2/project/data/explain.js` | `POST /records/explain` — estimated_rows, uses_index, suggestions, solo service key |

### Migraciones de plataforma — Fase 3

| ID | Descripción |
|---|---|
| `009_phase3_all_features` | Crea todas las tablas Fase 3 en todos los proyectos |

---

## Mejoras de seguridad

| Problema v1 | Solución v2 |
|---|---|
| Tokens reset/verificación en texto plano en DB | SHA-256 en DB, raw token al usuario |
| OAuth callback con tokens en query params | Código one-time 60s → POST para canjear |
| Rate limit en `package.json` pero sin registrar | Registrado, Redis distribuido si disponible |
| Errores de webhook/email silenciosos | Retry 3x con backoff + logging |
| EventEmitter in-memory (single instance) | `pg_notify` multi-instancia |
| `UPDATE/DELETE ... LIMIT n` (MySQL syntax) | Subquery válida en PostgreSQL |
| `GEN_002` mapeado a HTTP 500 | Corregido a 400 |

---

## Paquetes a instalar en el VPS

```bash
npm install ioredis @fastify/swagger @fastify/swagger-ui otpauth
```

---

## Variables de entorno nuevas (opcionales)

| Variable | Descripción | Default |
|---|---|---|
| `REDIS_URL` | URL de Redis para cache de permisos y rate-limit distribuido | — (in-memory) |
| `LOG_LEVEL` | Nivel de log de Pino | `info` |
| `NODE_ENV` | `production` desactiva pino-pretty y el `_dev_token` en reset | — |
| `API_BASE_URL` | Base URL para callbacks OAuth | `https://<host>` |
