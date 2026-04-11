# Matebase API v2 — Roadmap de features nuevas

> Prioridad ordenada por impacto/esfuerzo. Todo bajo `/api/v2/`, sin tocar v1.

---

## Fase A — Validación y datos (base sólida)

### A1. Validación de campos en escritura
**Problema:** `_fields` tiene tipos y constraints pero nunca se validan al insertar/actualizar.  
**Solución:** Antes de cada `INSERT`/`UPDATE` en `_records`, leer el schema de la colección y validar cada campo del `data`.

**Archivos a crear/modificar:**
- `lib/v2/field-validator.js` — función `validateRecordData(fields, data)` que valida tipos, required, min/max, pattern, enum, unique
- `routes/v2/project/data/create-record.js` — agregar llamada a `validateRecordData` antes del INSERT
- `routes/v2/project/data/update-record.js` — idem en single update
- `routes/v2/project/data/upsert.js` — idem
- `routes/v2/project/data/batch.js` — idem en cada op insert/update

**Tipos de validación:**
```
text    → minLength, maxLength, pattern, enum
number  → min, max, enum
boolean → (nativo)
date    → min (fecha), max (fecha)
json    → (sin validación de contenido)
relation → que el ID referenciado exista en la colección relacionada
```

**Error a devolver:** `DATA_005` con detalle del campo que falló.

**Tablas afectadas:** ninguna nueva — usa `_fields` existente.

---

### A2. Agregaciones
**Problema:** No hay forma de hacer SUM, AVG, COUNT agrupado sin SQL raw.  
**Solución:** Nuevo endpoint `GET /records/aggregate`.

**Archivos a crear:**
- `routes/v2/project/data/aggregate.js`

**Query params:**
```
collection  → requerido
group_by    → campo para agrupar (opcional)
sum         → campo a sumar
avg         → campo para promedio
min         → campo para mínimo
max         → campo para máximo
count       → true/false (default true)
filter      → filtros estilo list-records (campo.op:valor)
```

**Respuesta:**
```json
{
  "collection": "ventas",
  "group_by": "mes",
  "results": [
    { "group": "2024-01", "count": 42, "sum_total": 15000, "avg_total": 357.14 }
  ]
}
```

**Seguridad:** usa `checkPermissionV2` con operación `list`. RLS aplicado.

---

### A3. Import de datos (CSV / JSON)
**Problema:** Hay export pero no import. El dev tiene que insertar de a uno.  
**Solución:** `POST /records/import` — acepta multipart CSV o JSON body, inserta en bulk con validación.

**Archivos a crear:**
- `routes/v2/project/data/import.js`

**Comportamiento:**
- Hasta 5.000 filas por request
- Valida cada fila contra `_fields` (usa `field-validator.js`)
- Inserta en chunks de 500 dentro de una transacción
- Devuelve `{ inserted, failed, errors: [{ row, reason }] }`
- Respeta quota de storage para archivos (no aplica aquí, solo registros)
- Opción `?on_conflict=skip|update` para manejar duplicados

**Rate limit:** 5 requests / 10 minutos

---

### A4. Populate de relaciones
**Problema:** Los campos `relation` guardan un UUID pero no hay forma de traer el documento relacionado en una sola query.  
**Solución:** Param `?populate=campo1,campo2` en `GET /records` y `GET /records/:id`.

**Archivos a modificar:**
- `routes/v2/project/data/list-records.js` — detectar campos `relation` en `?populate`, hacer LEFT JOIN y embedder el objeto
- `routes/v2/project/data/get-record.js` — idem para registro individual

**Comportamiento:**
```
GET /records?collection=posts&populate=author_id,category_id
→ cada registro tendrá:
  {
    "id": "...",
    "data": {
      "title": "...",
      "author_id": "uuid",
      "_populated": {
        "author_id": { "id": "uuid", "data": { "name": "Juan" } },
        "category_id": { "id": "uuid", "data": { "name": "Tech" } }
      }
    }
  }
```
- Máximo 3 campos populate por query (evitar N+1)
- Verificar que el campo sea tipo `relation` en `_fields`
- Aplicar RLS de la colección relacionada

---

## Fase B — Auth avanzado

### B1. Magic link login
**Problema:** No hay login sin contraseña. Muchas apps modernas no quieren que el usuario recuerde passwords.  
**Solución:** El usuario ingresa su email → recibe un link → click → queda autenticado.

**Archivos a crear:**
- `routes/v2/project/auth/magic-link.js`

**Endpoints:**
- `POST /auth/magic-link` — recibe `{ email, redirect_url }`, crea token hasheado (15 min TTL), envía email
- `GET /auth/magic-link/verify?token=xxx` — verifica token, genera access+refresh, redirige con código one-time (mismo patrón OAuth)

**Tabla nueva en schema del proyecto:**
```sql
CREATE TABLE IF NOT EXISTS _magic_links (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    TEXT NOT NULL,
  token      TEXT NOT NULL,  -- SHA-256 del token raw
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Rate limit:** 3 requests / 10 minutos por email

---

### B2. Roles custom por usuario de proyecto
**Problema:** El RLS actual solo puede filtrar por `auth.id`, `auth.email`, `auth.username`. No hay roles.  
**Solución:** Tabla `_user_roles` que asigna roles a usuarios. El RLS puede filtrar por `role.in:admin,editor`.

**Archivos a crear:**
- `routes/v2/project/auth/roles.js` — CRUD de roles disponibles
- `routes/v2/project/auth/user-roles.js` — asignar/quitar roles a usuarios

**Tabla nueva:**
```sql
CREATE TABLE IF NOT EXISTS _roles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS _user_roles (
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL,
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, role)
);
```

**Cambios en `lib/v2/permissions.js`:**
- `resolveRLSFilterV2` — agregar soporte para `role.in:admin,editor` → lookup en `_user_roles`
- El JWT del proyecto incluirá el/los roles del usuario al hacer login

**Cambios en login/register:**
- Al generar el JWT, incluir `roles: ["admin"]` en el payload
- `flexAuth` popula `req.projectUser.roles`

**Endpoints nuevos:**
```
GET    /auth/roles              → listar roles disponibles
POST   /auth/roles              → crear rol
DELETE /auth/roles/:name        → eliminar rol
GET    /auth/users/:id/roles    → roles de un usuario
POST   /auth/users/:id/roles    → asignar rol
DELETE /auth/users/:id/roles/:role → quitar rol
```

---

### B3. 2FA / TOTP
**Problema:** No hay segundo factor de autenticación.  
**Solución:** TOTP compatible con Google Authenticator / Authy.

**Dependencia nueva:** `otpauth` (sin dependencias nativas, puro JS)

**Archivos a crear:**
- `routes/v2/project/auth/totp.js`

**Endpoints:**
```
POST /auth/totp/setup    → genera secret + QR URI (no activa aún)
POST /auth/totp/confirm  → verifica código TOTP y activa 2FA
POST /auth/totp/disable  → desactiva 2FA (requiere código actual)
POST /auth/totp/verify   → durante el login, si 2FA activo, verificar código
```

**Tabla nueva:**
```sql
ALTER TABLE _auth_users
  ADD COLUMN IF NOT EXISTS totp_secret     TEXT,
  ADD COLUMN IF NOT EXISTS totp_enabled    BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS totp_backup_codes TEXT[];  -- hashed
```

**Flujo de login con 2FA:**
1. Login normal → si `totp_enabled = true` → devuelve `{ requires_totp: true, totp_session: "token-corto-5min" }`
2. Cliente hace `POST /auth/totp/verify { totp_session, code }` → devuelve access+refresh

---

## Fase C — Realtime avanzado y webhooks inteligentes

### C1. Realtime con filtros por campo
**Problema:** El WebSocket filtra por colección pero no por campo/valor específico.  
**Solución:** El cliente puede subscribirse con un filtro: solo recibe eventos donde `data.user_id === "mi-id"`.

**Archivos a modificar:**
- `routes/v2/project/realtime/ws.js` — extender protocolo de mensajes

**Protocolo nuevo:**
```json
// Cliente envía:
{ "type": "subscribe", "collection": "messages", "filter": { "room_id": "abc123" } }

// Server filtra antes de emitir:
// Solo envía el evento si event.record.data.room_id === "abc123"
```

**Cambios en `lib/v2/realtime.js`:**
- `emitProjectEvent` ya incluye el record completo en el payload
- El filtro se aplica en el handler de WebSocket, no en el listener de pg_notify

---

### C2. Webhooks con filtros de campo
**Problema:** Los webhooks ejecutan para TODOS los eventos de una colección. No se puede filtrar por valor.  
**Solución:** Agregar `filter_rule` a `_webhooks`, mismo formato que RLS.

**Archivos a modificar:**
- `routes/v2/project/data/webhooks.js` — agregar campo `filter_rule` al schema
- `lib/v2/queue.js` — en `_executeWebhooks`, evaluar `filter_rule` contra el payload antes de disparar

**Tabla:**
```sql
ALTER TABLE _webhooks ADD COLUMN IF NOT EXISTS filter_rule TEXT;
```

**Ejemplo:**
```json
{ "url": "https://...", "collection": "orders", "event": "record.created", "filter_rule": "status.eq:pagado" }
```

---

### C3. Presigned URLs para storage privado
**Problema:** Todos los archivos del storage son públicos. No hay forma de proteger archivos privados.  
**Solución:** URLs firmadas con TTL y secret del proyecto.

**Archivos a crear:**
- `routes/v2/project/storage/presign.js` — genera URL firmada
- `routes/v2/project/storage/serve.js` — sirve el archivo si la firma es válida

**Endpoint:**
```
POST /storage/presign  { file_id, expires_in: 3600 }
→ { url: "https://api.proyecto.matecito.dev/storage/serve/FILE_ID?sig=xxx&exp=1234567890" }
```

**Firma:** HMAC-SHA256 con `JWT_SECRET + file_id + expires_at`. Sin DB extra.

**Tabla:**
```sql
ALTER TABLE files ADD COLUMN IF NOT EXISTS is_private BOOLEAN DEFAULT FALSE;
```

---

## Fase D — Automatización y lógica server-side

### D1. Audit log completo de data
**Problema:** Solo hay audit log de cambios de permisos. No hay historial de cambios en registros.  
**Solución:** Loguear cada create/update/delete en `_audit_log` con diff.

**Archivos a modificar:**
- `lib/v2/queue.js` — agregar `enqueueAuditLog(schemaName, action, entity, prevValue, newValue, userId, ip)`
- `routes/v2/project/data/create-record.js` — llamar a `enqueueAuditLog` después del INSERT
- `routes/v2/project/data/update-record.js` — idem con prev/new value
- `routes/v2/project/data/delete-record.js` — idem

**Endpoint nuevo:**
```
GET /audit-log?collection=posts&action=record.updated&from=2024-01-01&limit=50
```

**Rate limit:** La tabla `_audit_log` ya existe (creada por `ensureV2Tables`).

---

### D2. Scheduled cleanup de records expirados
**Problema:** Los registros con `expires_at` pasado se filtran en las queries pero siguen ocupando espacio en DB.  
**Solución:** Job periódico que los borra físicamente.

**Archivos a crear:**
- `lib/v2/scheduler.js` — `startScheduler()` que corre jobs internos con `setInterval`

**Jobs:**
```
Cada 1 hora  → DELETE FROM _records WHERE expires_at < NOW() AND deleted_at IS NULL (por cada schema activo)
Cada 24 hs   → Truncar _audit_log si tiene más de log_retention_days días (usa setting del proyecto)
Cada 24 hs   → Limpiar _export_jobs completados con más de 7 días
```

**Archivos a modificar:**
- `index.js` — llamar a `startScheduler()` al startup

---

### D3. Rate limit por usuario autenticado
**Problema:** Rate limit actual es por `projectId:IP`. En NAT/oficinas todos comparten IP.  
**Solución:** Si hay usuario autenticado, usar `projectId:userId` como key.

**Archivos a modificar:**
- `index.js` — actualizar `keyGenerator` del rate-limit:
```js
keyGenerator: (req) => {
  const projectId = req.resolvedProject?.id ?? req.params?.projectId;
  const userId    = req.projectUser?.id;
  if (projectId && userId) return `${projectId}:user:${userId}`;
  if (projectId)           return `${projectId}:${req.ip}`;
  return req.ip;
}
```

---

## Fase E — Developer Experience

### E1. SDK hints en headers de respuesta
**Problema:** El dev no sabe cuánto quota le queda, cuántos requests puede hacer, etc.  
**Solución:** Headers informativos en cada respuesta.

**Headers nuevos:**
```
X-Request-ID         → correlation ID (ya implementado)
X-RateLimit-Limit    → max requests (ya lo agrega @fastify/rate-limit)
X-RateLimit-Remaining→ restantes
X-Storage-Used-MB    → storage usado del proyecto
X-Storage-Quota-MB   → quota total
X-Matecito-Version   → "2"
```

**Archivos a modificar:**
- `index.js` — hook `onSend` que agrega los headers de storage si el request es de proyecto

---

### E2. Endpoint de schema introspection
**Problema:** El SDK del cliente tiene que hacer varias llamadas para saber la estructura de un proyecto.  
**Solución:** `GET /schema` devuelve todo en una sola llamada.

**Archivos a crear:**
- `routes/v2/project/schema.js`

**Respuesta:**
```json
{
  "project": { "id": "...", "name": "...", "settings": {} },
  "collections": [
    {
      "name": "posts",
      "soft_delete": false,
      "fields": [ { "name": "title", "type": "text", "required": true } ],
      "permissions": { "list": "public", "get": "public", "create": "auth", "update": "auth", "delete": "service" }
    }
  ],
  "auth": {
    "providers": ["email", "google"],
    "magic_link": false,
    "totp": false
  }
}
```

---

### E3. Test endpoint de webhooks
**Problema:** No hay forma de testear un webhook sin generar un evento real.  
**Solución:** `POST /webhooks/:id/test` que dispara un payload de ejemplo.

**Archivos a modificar:**
- `routes/v2/project/data/webhooks.js` — agregar ruta `POST /webhooks/:id/test`

---

## Resumen por fase

| Fase | Features | Esfuerzo estimado |
|---|---|---|
| **A** | Validación de campos, Agregaciones, Import CSV/JSON, Populate | Medio |
| **B** | Magic link, Roles custom, 2FA TOTP | Alto |
| **C** | Realtime filtrado, Webhooks con filtros, Presigned URLs | Medio |
| **D** | Audit log completo, Scheduler cleanup, Rate limit por usuario | Bajo-Medio |
| **E** | SDK headers, Schema introspection, Test webhooks | Bajo |

---

## Dependencias nuevas a instalar

| Paquete | Para qué |
|---|---|
| `otpauth` | 2FA TOTP (Fase B3) |

---

## Orden de implementación recomendado

1. **D3** — Rate limit por usuario (5 líneas, impacto inmediato)
2. **E3** — Test de webhooks (bajo esfuerzo, muy pedido)
3. **A2** — Agregaciones (endpoint nuevo, sin cambios en existentes)
4. **A1** — Validación de campos (impacto alto, seguridad)
5. **D1** — Audit log completo de data
6. **D2** — Scheduler cleanup
7. **A4** — Populate de relaciones
8. **A3** — Import CSV/JSON
9. **B1** — Magic link
10. **C1** — Realtime filtrado por campo
11. **C2** — Webhooks con filtros
12. **C3** — Presigned URLs storage
13. **E2** — Schema introspection
14. **E1** — SDK headers
15. **B2** — Roles custom
16. **B3** — 2FA TOTP
