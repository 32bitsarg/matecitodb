const crypto     = require("crypto");
const nodemailer = require("nodemailer");
const db         = require("../db");

// ─── Helpers SQL ──────────────────────────────────────────────────────────────

function quoteIdent(value) {
  if (typeof value !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error("Invalid SQL identifier");
  }
  return `"${value}"`;
}

function generateSchemaName(projectId) {
  const clean = String(projectId).replace(/-/g, "").slice(0, 12);
  return `proj_${clean}`;
}

function generateToken(len = 32) {
  return crypto.randomBytes(len).toString("hex");
}

// ─── Auth — Platform ──────────────────────────────────────────────────────────

async function requirePlatformAuth(req, reply) {
  try {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const token   = auth.slice("Bearer ".length).trim();
    const payload = await req.server.jwt.verify(token);

    if (!payload?.sub || payload.kind !== "platform") {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    req.user = {
      id:       payload.sub,
      email:    payload.email    || null,
      username: payload.username || null,
      name:     payload.name     || null,
    };
  } catch {
    return reply.code(401).send({ error: "Unauthorized" });
  }
}

// ─── Auth — Dashboard (platform JWT → acceso a datos del proyecto) ───────────
//
// Permite que el dashboard de administración acceda a rutas de proyecto
// usando el token de plataforma, verificando que el usuario sea miembro
// del workspace dueño del proyecto.
// También acepta tokens de proyecto (para uso desde apps cliente).

async function requireProjectOrPlatformAuth(req, reply) {
  try {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const token   = auth.slice("Bearer ".length).trim();
    const payload = await req.server.jwt.verify(token);

    if (!payload?.sub) return reply.code(401).send({ error: "Unauthorized" });

    // Caso 1: token de proyecto (uso desde app cliente)
    if (payload.kind === "project") {
      req.projectUser = {
        id:       payload.sub,
        pid:      payload.pid,
        email:    payload.email    || null,
        username: payload.username || null,
        name:     payload.name     || null,
      };
      return;
    }

    // Caso 2: token de plataforma (dashboard admin)
    if (payload.kind === "platform") {
      const projectId = req.params?.projectId ?? req.resolvedProject?.id;
      if (!projectId) return reply.code(401).send({ error: "Unauthorized" });

      const { rows } = await db.query(
        `SELECT p.id, wm.role FROM projects p
         JOIN workspace_members wm ON wm.workspace_id = p.workspace_id
         WHERE p.id = $1 AND wm.user_id = $2
         LIMIT 1`,
        [projectId, payload.sub]
      );
      if (!rows[0]) return reply.code(403).send({ error: "Forbidden" });
      if (!["owner", "admin"].includes(rows[0].role)) {
        return reply.code(403).send({ error: "Forbidden: insufficient workspace role" });
      }

      req.projectUser = {
        id:       payload.sub,
        pid:      projectId,
        email:    payload.email    || null,
        username: payload.username || null,
        name:     payload.name     || null,
        _kind:    "platform",
      };
      return;
    }

    return reply.code(401).send({ error: "Unauthorized" });
  } catch {
    return reply.code(401).send({ error: "Unauthorized" });
  }
}

// ─── Auth — Project ───────────────────────────────────────────────────────────

async function requireProjectAuth(req, reply) {
  try {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const token   = auth.slice("Bearer ".length).trim();
    const payload = await req.server.jwt.verify(token);

    if (!payload?.sub || payload.kind !== "project") {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    req.projectUser = {
      id:       payload.sub,
      pid:      payload.pid,
      email:    payload.email    || null,
      username: payload.username || null,
      name:     payload.name     || null,
    };
  } catch {
    return reply.code(401).send({ error: "Unauthorized" });
  }
}

// ─── Membresías ───────────────────────────────────────────────────────────────

async function isWorkspaceMember(userId, workspaceId) {
  const result = await db.query(
    `SELECT role FROM workspace_members
     WHERE user_id = $1 AND workspace_id = $2
     LIMIT 1`,
    [userId, workspaceId]
  );
  return result.rows[0] || null;
}

async function isProjectMember(userId, projectId) {
  const result = await db.query(
    `SELECT p.id, p.workspace_id, p.schema_name
     FROM projects p
     JOIN workspace_members wm ON wm.workspace_id = p.workspace_id
     WHERE p.id = $1 AND wm.user_id = $2
     LIMIT 1`,
    [projectId, userId]
  );
  return result.rows[0] || null;
}

// ─── Schema de proyecto ───────────────────────────────────────────────────────

async function createProjectSchema(executor, schemaName) {
  const s = quoteIdent(schemaName);

  await executor.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
  await executor.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);

  // Usuarios del proyecto
  await executor.query(`
    CREATE TABLE IF NOT EXISTS ${s}._auth_users (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email               TEXT UNIQUE NOT NULL,
      username            TEXT UNIQUE,
      name                TEXT,
      password_hash       TEXT NOT NULL DEFAULT '',
      avatar_seed         TEXT,
      avatar_url          TEXT,
      oauth_provider      TEXT,
      oauth_id            TEXT,
      email_verified      BOOLEAN NOT NULL DEFAULT false,
      email_verified_at   TIMESTAMP,
      created_at          TIMESTAMP DEFAULT NOW(),
      updated_at          TIMESTAMP DEFAULT NOW()
    )
  `);
  // Refresh tokens de usuarios del proyecto
  await executor.query(`
    CREATE TABLE IF NOT EXISTS ${s}._refresh_tokens (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    UUID NOT NULL REFERENCES ${s}._auth_users(id) ON DELETE CASCADE,
      token      TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
      revoked_at TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);
  await executor.query(`
    CREATE INDEX IF NOT EXISTS ${schemaName}_refresh_tokens_token_idx
    ON ${s}._refresh_tokens(token)
  `);

  // Colecciones (tablas lógicas)
  await executor.query(`
    CREATE TABLE IF NOT EXISTS ${s}._collections (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name        TEXT UNIQUE NOT NULL,
      soft_delete BOOLEAN NOT NULL DEFAULT false,
      created_at  TIMESTAMP DEFAULT NOW()
    )
  `);

  // Campos tipados por colección
  await executor.query(`
    CREATE TABLE IF NOT EXISTS ${s}._fields (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      collection TEXT NOT NULL,
      name       TEXT NOT NULL,
      type       TEXT NOT NULL DEFAULT 'text',
      required   BOOLEAN NOT NULL DEFAULT false,
      options    JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (collection, name)
    )
  `);

  // Permisos por colección y operación
  await executor.query(`
    CREATE TABLE IF NOT EXISTS ${s}._permissions (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      collection  TEXT NOT NULL,
      operation   TEXT NOT NULL,
      access      TEXT NOT NULL DEFAULT 'auth',
      filter_rule TEXT DEFAULT NULL,
      created_at  TIMESTAMP DEFAULT NOW(),
      UNIQUE (collection, operation)
    )
  `);

  // Verificaciones de email
  await executor.query(`
    CREATE TABLE IF NOT EXISTS ${s}._email_verifications (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    UUID NOT NULL REFERENCES ${s}._auth_users(id) ON DELETE CASCADE,
      token      TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMP NOT NULL,
      used_at    TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Tokens de reset de contraseña
  await executor.query(`
    CREATE TABLE IF NOT EXISTS ${s}._password_resets (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    UUID NOT NULL REFERENCES ${s}._auth_users(id) ON DELETE CASCADE,
      token      TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMP NOT NULL,
      used_at    TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Logs de requests
  await executor.query(`
    CREATE TABLE IF NOT EXISTS ${s}._logs (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      method      TEXT,
      path        TEXT,
      status_code INT,
      duration_ms INT,
      ip          TEXT,
      user_id     UUID,
      created_at  TIMESTAMP DEFAULT NOW()
    )
  `);
  await executor.query(`
    CREATE INDEX IF NOT EXISTS ${schemaName}_logs_created_idx
    ON ${s}._logs(created_at DESC)
  `);

  // Registros con datos JSONB
  await executor.query(`
    CREATE TABLE IF NOT EXISTS ${s}._records (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      collection TEXT NOT NULL,
      data       JSONB NOT NULL DEFAULT '{}'::jsonb,
      expires_at TIMESTAMP DEFAULT NULL,
      deleted_at TIMESTAMP DEFAULT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Índice en collection para filtros frecuentes
  await executor.query(`
    CREATE INDEX IF NOT EXISTS ${schemaName}_records_collection_idx
    ON ${s}._records(collection)
  `);

  // Índice GIN sobre data JSONB para filtros por campo
  await executor.query(`
    CREATE INDEX IF NOT EXISTS ${schemaName}_records_data_gin_idx
    ON ${s}._records USING GIN (data)
  `);

  // Índice compuesto para queries paginadas por colección (collection + orden temporal)
  await executor.query(`
    CREATE INDEX IF NOT EXISTS ${schemaName}_records_collection_time_idx
    ON ${s}._records(collection, created_at DESC)
  `);

  // Índice compuesto para filtrar logs por status + tiempo
  await executor.query(`
    CREATE INDEX IF NOT EXISTS ${schemaName}_logs_status_time_idx
    ON ${s}._logs(status_code, created_at DESC)
  `);

  // Índice en expires_at para limpiezas eficientes
  await executor.query(`
    CREATE INDEX IF NOT EXISTS ${schemaName}_records_expires_idx
    ON ${s}._records(expires_at)
    WHERE expires_at IS NOT NULL
  `);

  // Índice en deleted_at para soft-delete
  await executor.query(`
    CREATE INDEX IF NOT EXISTS ${schemaName}_records_deleted_idx
    ON ${s}._records(deleted_at)
    WHERE deleted_at IS NOT NULL
  `);

  // Configuración SMTP del proyecto
  await executor.query(`
    CREATE TABLE IF NOT EXISTS ${s}._smtp_config (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      host          TEXT NOT NULL,
      port          INT  NOT NULL DEFAULT 587,
      secure        BOOLEAN NOT NULL DEFAULT false,
      smtp_user     TEXT NOT NULL,
      smtp_password TEXT NOT NULL DEFAULT '',
      from_name     TEXT NOT NULL DEFAULT '',
      from_email    TEXT NOT NULL,
      created_at    TIMESTAMP DEFAULT NOW(),
      updated_at    TIMESTAMP DEFAULT NOW()
    )
  `);

  // Webhooks por colección/evento
  await executor.query(`
    CREATE TABLE IF NOT EXISTS ${s}._webhooks (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      collection TEXT NOT NULL DEFAULT '*',
      event      TEXT NOT NULL DEFAULT '*',
      url        TEXT NOT NULL,
      secret     TEXT,
      enabled    BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // View auth_users → alias amigable de _auth_users para el SQL editor
  await executor.query(`
    CREATE OR REPLACE VIEW ${s}.auth_users AS
    SELECT * FROM ${s}._auth_users
  `);

  // ── Rol PostgreSQL del proyecto (seguridad real para el SQL editor) ──────
  // Se crea AL FINAL, después de todas las tablas, para que el GRANT ALL
  // cubra todas las tablas del schema.
  await executor.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${schemaName}') THEN
        CREATE ROLE "${schemaName}" NOLOGIN;
      END IF;
    END $$
  `);
  await executor.query(`GRANT USAGE ON SCHEMA "${schemaName}" TO "${schemaName}"`);
  await executor.query(`GRANT ALL ON ALL TABLES IN SCHEMA "${schemaName}" TO "${schemaName}"`);
  await executor.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA "${schemaName}" TO "${schemaName}"`);
  // DEFAULT PRIVILEGES: cubre tablas creadas en el futuro (ej: via SQL editor)
  await executor.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA "${schemaName}" GRANT ALL ON TABLES TO "${schemaName}"`);
  await executor.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA "${schemaName}" GRANT ALL ON SEQUENCES TO "${schemaName}"`);
  await executor.query(`REVOKE ALL ON SCHEMA public FROM "${schemaName}"`);
  // Permitir que matebase (el pool de conexiones) pueda hacer SET ROLE a este rol
  await executor.query(`GRANT "${schemaName}" TO matebase`);
}

async function dropProjectSchema(executor, schemaName) {
  const s = quoteIdent(schemaName);
  await executor.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
}

// ─── API Keys ─────────────────────────────────────────────────────────────────

async function getProjectByAnonKey(projectId, anonKey) {
  const result = await db.query(
    `SELECT p.id, p.schema_name
     FROM projects p
     JOIN api_keys k ON k.project_id = p.id
     WHERE p.id = $1
       AND k.key = $2
       AND k.type = 'anon'
       AND k.revoked_at IS NULL
     LIMIT 1`,
    [projectId, anonKey]
  );
  return result.rows[0] || null;
}

async function getProjectKeyContext(projectId, rawKey, allowedTypes = ["anon", "service", "custom"]) {
  const key = String(rawKey || "").trim();
  if (!key) return null;

  const result = await db.query(
    `SELECT
       p.id AS project_id,
       p.schema_name,
       k.id AS api_key_id,
       k.type,
       k.scopes,
       k.revoked_at
     FROM projects p
     JOIN api_keys k ON k.project_id = p.id
     WHERE p.id = $1
       AND k.key = $2
       AND k.type = ANY($3::text[])
       AND k.revoked_at IS NULL
     LIMIT 1`,
    [projectId, key, allowedTypes]
  );

  const row = result.rows[0];
  if (!row) return null;

  // Actualizar last_used_at sin bloquear la respuesta
  db.query(`UPDATE api_keys SET last_used_at = NOW() WHERE id = $1`, [row.api_key_id])
    .catch(() => {});

  return row;
}

function requireProjectApiKey(allowedTypes = ["anon", "service"]) {
  return async function (req, reply) {
    try {
      const rawKey    = req.headers["x-matecito-key"];
      const projectId = req.params.projectId;

      const ctx = await getProjectKeyContext(projectId, rawKey, allowedTypes);
      if (!ctx) {
        return reply.code(401).send({ error: "Invalid project key" });
      }

      req.projectKey = {
        projectId:  ctx.project_id,
        schemaName: ctx.schema_name,
        type:       ctx.type,
        apiKeyId:   ctx.api_key_id,
        scopes:     ctx.scopes ?? null,
      };
    } catch {
      return reply.code(401).send({ error: "Invalid project key" });
    }
  };
}

// ─── Refresh Tokens — Platform ────────────────────────────────────────────────

const REFRESH_EXPIRES_MS = 30 * 24 * 60 * 60 * 1000; // 30 días

async function createPlatformRefreshToken(userId) {
  const token     = generateToken(40);
  const expiresAt = new Date(Date.now() + REFRESH_EXPIRES_MS);

  await db.query(
    `INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)`,
    [userId, token, expiresAt]
  );
  return token;
}

async function rotatePlatformRefreshToken(token) {
  const result = await db.query(
    `SELECT id, user_id, expires_at, revoked_at
     FROM refresh_tokens
     WHERE token = $1
     LIMIT 1`,
    [token]
  );
  const row = result.rows[0];

  if (!row || row.revoked_at || new Date(row.expires_at) < new Date()) return null;

  // Revocar token viejo y emitir uno nuevo en una transacción
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1`, [row.id]);
    const newToken = generateToken(40);
    const expiresAt = new Date(Date.now() + REFRESH_EXPIRES_MS);
    await client.query(
      `INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)`,
      [row.user_id, newToken, expiresAt]
    );
    await client.query("COMMIT");
    return { userId: row.user_id, newToken };
  } catch {
    await client.query("ROLLBACK");
    return null;
  } finally {
    client.release();
  }
}

// ─── Refresh Tokens — Project ─────────────────────────────────────────────────

async function createProjectRefreshToken(schemaName, userId) {
  const s         = quoteIdent(schemaName);
  const token     = generateToken(40);
  const expiresAt = new Date(Date.now() + REFRESH_EXPIRES_MS);

  await db.query(
    `INSERT INTO ${s}._refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)`,
    [userId, token, expiresAt]
  );
  return token;
}

async function rotateProjectRefreshToken(schemaName, token) {
  const s      = quoteIdent(schemaName);
  const result = await db.query(
    `SELECT id, user_id, expires_at, revoked_at
     FROM ${s}._refresh_tokens
     WHERE token = $1
     LIMIT 1`,
    [token]
  );
  const row = result.rows[0];

  if (!row || row.revoked_at || new Date(row.expires_at) < new Date()) return null;

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE ${s}._refresh_tokens SET revoked_at = NOW() WHERE id = $1`, [row.id]);
    const newToken  = generateToken(40);
    const expiresAt = new Date(Date.now() + REFRESH_EXPIRES_MS);
    await client.query(
      `INSERT INTO ${s}._refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)`,
      [row.user_id, newToken, expiresAt]
    );
    await client.query("COMMIT");
    return { userId: row.user_id, newToken };
  } catch {
    await client.query("ROLLBACK");
    return null;
  } finally {
    client.release();
  }
}

// ─── Auth — Flexible (no bloquea, intenta identificar al llamador) ────────────
//
// Usado en rutas de datos donde el acceso puede ser público.
// Intenta JWT (project o platform) y luego API key.
// NO rechaza la request si no hay autenticación.

async function flexAuth(req, _reply) {
  try {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) {
      const token = auth.slice("Bearer ".length).trim();
      let payload = null;
      try { payload = await req.server.jwt.verify(token); } catch {}

      if (payload?.sub) {
        if (payload.kind === "project") {
          req.projectUser = {
            id:       payload.sub,
            pid:      payload.pid,
            email:    payload.email    || null,
            username: payload.username || null,
            name:     payload.name     || null,
            _kind:    "project",
          };
          return;
        }

        if (payload.kind === "platform") {
          // Verificar membresía al workspace
          const projectId = req.params?.projectId ?? req.resolvedProject?.id;
          if (projectId) {
            const { rows } = await db.query(
              `SELECT p.id FROM projects p
               JOIN workspace_members wm ON wm.workspace_id = p.workspace_id
               WHERE p.id = $1 AND wm.user_id = $2
               LIMIT 1`,
              [projectId, payload.sub]
            );
            if (rows[0]) {
              req.projectUser = {
                id:       payload.sub,
                pid:      projectId,
                email:    payload.email    || null,
                username: payload.username || null,
                name:     payload.name     || null,
                _kind:    "platform",
              };
              return;
            }
          }
        }
      }
    }
  } catch { /* ignorar errores — continuar como anónimo */ }

  // Intentar API key
  try {
    const rawKey    = req.headers["x-matecito-key"];
    const projectId = req.params?.projectId ?? req.resolvedProject?.id;
    if (rawKey && projectId) {
      const ctx = await getProjectKeyContext(projectId, rawKey, ["anon", "service", "custom"]);
      if (ctx) {
        req.projectKey = {
          projectId:  ctx.project_id,
          schemaName: ctx.schema_name,
          type:       ctx.type,
          apiKeyId:   ctx.api_key_id,
        };
      }
    }
  } catch { /* ignorar */ }
}

// ─── Enforcement de permisos + RLS ───────────────────────────────────────────
//
// Retorna { allowed, filterSql, filterValues } en lugar de bool.
//
// - allowed:      false → ya envió la respuesta de error, hacer return
// - filterSql:    string SQL con placeholder "$?" para reemplazar con índice real
//                 ej: `data->>'userId' = $?` — solo si hay filter_rule configurado
// - filterValues: array de valores para filterSql
//
// filter_rule en _permissions: formato "campo:{{auth.id}}"
//   Variables soportadas: {{auth.id}}, {{auth.email}}, {{auth.username}}
//
// Niveles de acceso:
//   public  → cualquiera (anónimo incluido)
//   auth    → proyecto JWT o cualquier API key válida
//   service → sólo service key o admin de plataforma
//   nobody  → siempre bloqueado

function resolveRLSFilter(filterRule, req) {
  if (!filterRule) return { filterSql: null, filterValues: [] };

  const user = req.projectUser;
  if (!user) return { filterSql: null, filterValues: [] }; // sin usuario → no aplica

  const colonIdx = filterRule.indexOf(":");
  if (colonIdx <= 0) return { filterSql: null, filterValues: [] };

  const field    = filterRule.slice(0, colonIdx).trim();
  const template = filterRule.slice(colonIdx + 1).trim();

  let value;
  if (template === "{{auth.id}}")       value = user.id;
  else if (template === "{{auth.email}}")    value = user.email;
  else if (template === "{{auth.username}}") value = user.username;
  else return { filterSql: null, filterValues: [] };

  if (!value) return { filterSql: null, filterValues: [] };

  return {
    filterSql:    `data->>'${field}' = $?`,
    filterValues: [value],
  };
}

// ─── Permission cache ─────────────────────────────────────────────────────────

const _permCache     = new Map();
const PERM_CACHE_TTL = 2 * 60 * 1000; // 2 minutes

function _permCacheKey(schemaName, collection, operation) {
  return `${schemaName}:${collection}:${operation}`;
}

function invalidatePermCache(schemaName, collection) {
  for (const op of ["list", "get", "create", "update", "delete"]) {
    _permCache.delete(_permCacheKey(schemaName, collection, op));
  }
}

async function checkPermission(schemaName, collection, operation, req, reply) {
  const ALLOWED_NO_FILTER = { allowed: true,  filterSql: null, filterValues: [] };
  const DENIED            = { allowed: false, filterSql: null, filterValues: [] };

  // Admins de plataforma y service keys: siempre permitidos, sin RLS
  if (req.projectUser?._kind === "platform") return ALLOWED_NO_FILTER;

  // Verificar scope de la API key si aplica
  if (req.projectKey?.scopes) {
    const scopes    = req.projectKey.scopes;
    const isRead    = ["list", "get"].includes(operation);
    const hasScope  =
      scopes.includes("*") ||
      (isRead  && scopes.includes("read"))  ||
      (!isRead && scopes.includes("write"));
    if (!hasScope) {
      reply.code(403).send({ error: "API key scope does not allow this operation" });
      return DENIED;
    }
  }

  // Obtener nivel de acceso y filter_rule (default: 'auth', sin RLS)
  let access      = "nobody";
  let filterRule  = null;
  try {
    const cacheKey = _permCacheKey(schemaName, collection, operation);
    const cached   = _permCache.get(cacheKey);
    if (cached && cached.exp > Date.now()) {
      access     = cached.access;
      filterRule = cached.filterRule;
    } else {
      const schema = quoteIdent(schemaName);
      const { rows } = await db.query(
        `SELECT access, filter_rule FROM ${schema}._permissions
         WHERE collection = $1 AND operation = $2
         LIMIT 1`,
        [collection, operation]
      );
      if (rows[0]) {
        access     = rows[0].access;
        filterRule = rows[0].filter_rule ?? null;
      }
      _permCache.set(cacheKey, { access, filterRule, exp: Date.now() + PERM_CACHE_TTL });
    }
  } catch { /* tabla no existe aún → usar default */ }

  switch (access) {
    case "nobody":
      reply.code(403).send({ error: "Access denied" });
      return DENIED;

    case "public": {
      // RLS se aplica igual si hay filter_rule (requiere usuario autenticado)
      const rlsFilter = resolveRLSFilter(filterRule, req);
      return { allowed: true, ...rlsFilter };
    }

    case "service":
      if (req.projectKey?.type === "service") return ALLOWED_NO_FILTER;
      if (req.projectUser?._kind === "platform") return ALLOWED_NO_FILTER;
      reply.code(403).send({ error: "Service key required" });
      return DENIED;

    case "auth":
    default:
      if (!req.projectUser && !req.projectKey) {
        reply.code(401).send({ error: "Authentication required" });
        return DENIED;
      }
      const rlsFilter = resolveRLSFilter(filterRule, req);
      return { allowed: true, ...rlsFilter };
  }
}

// ─── Email helper ────────────────────────────────────────────────────────────
//
// Envía un email usando la configuración SMTP del proyecto.
// Si el proyecto no tiene SMTP configurado, no hace nada (non-critical).
// Intenta usar la plantilla `templateName` de _email_templates; si no existe,
// usa fallbackSubject/fallbackHtml.

function renderTemplate(str, vars) {
  return str.replace(/\{\{([^}]+)\}\}/g, (_, key) => vars[key.trim()] ?? "");
}

async function sendProjectEmail(schemaName, projectName, { to, templateName, vars, fallbackSubject, fallbackHtml }) {
  const s = quoteIdent(schemaName);
  try {
    const [smtpRes, tplRes] = await Promise.all([
      db.query(`SELECT * FROM ${s}._smtp_config LIMIT 1`),
      db.query(`SELECT * FROM ${s}._email_templates WHERE name = $1 LIMIT 1`, [templateName]),
    ]);
    const smtp = smtpRes.rows[0];
    if (!smtp) return; // Sin SMTP configurado → silencioso

    const template = tplRes.rows[0];
    const allVars  = { "project.name": projectName, ...vars };

    const subject  = template ? renderTemplate(template.subject,   allVars) : fallbackSubject;
    const htmlBody = template ? renderTemplate(template.html_body, allVars) : fallbackHtml;
    const textBody = template ? renderTemplate(template.text_body, allVars) : htmlBody.replace(/<[^>]+>/g, "");

    const transporter = nodemailer.createTransport({
      host:   smtp.host,
      port:   smtp.port,
      secure: smtp.secure,
      auth:   { user: smtp.smtp_user, pass: smtp.smtp_password },
    });

    await transporter.sendMail({
      from:    `"${smtp.from_name || projectName}" <${smtp.from_email}>`,
      to,
      subject,
      html:    htmlBody,
      text:    textBody,
    });
  } catch { /* non-critical — no bloquea el flujo */ }
}

// ─── Log de evento de auth ────────────────────────────────────────────────────

function logAuthEvent(schemaName, { event, userId, ip, status }) {
  const schema = quoteIdent(schemaName);
  db.query(
    `INSERT INTO ${schema}._logs (method, path, status_code, ip, user_id)
     VALUES ('AUTH', $1, $2, $3, $4)`,
    [event, status, ip || null, userId || null]
  ).catch(() => {});
}

// ─── Routing helper ───────────────────────────────────────────────────────────

/**
 * Registra una ruta que funciona tanto por URL directa (:projectId)
 * como por subdominio (sin projectId en la URL).
 */
function projectRoute(fastify, method, path, opts, handler) {
  if (typeof opts === "function") {
    handler = opts;
    opts    = {};
  }

  const m = method.toLowerCase();

  fastify[m](`/:projectId${path}`, opts, handler);
  fastify[m](path, opts, handler);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  db,
  quoteIdent,
  sendProjectEmail,
  requireProjectOrPlatformAuth,
  generateSchemaName,
  generateToken,
  requirePlatformAuth,
  requireProjectAuth,
  flexAuth,
  checkPermission,
  invalidatePermCache,
  logAuthEvent,
  isWorkspaceMember,
  isProjectMember,
  createProjectSchema,
  dropProjectSchema,
  getProjectByAnonKey,
  getProjectKeyContext,
  requireProjectApiKey,
  createPlatformRefreshToken,
  rotatePlatformRefreshToken,
  createProjectRefreshToken,
  rotateProjectRefreshToken,
  projectRoute,
};
