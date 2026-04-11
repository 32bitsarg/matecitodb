// ─── Permisos v2 ─────────────────────────────────────────────────────────────
//
// Mejoras sobre v1:
//   - Operadores de filter_rule extendidos: eq, neq, in
//   - Cache compatible con Redis (si está disponible) o in-memory
//   - invalidatePermCache exportado y compatible con v1
//   - checkPermissionV2 con soporte de nuevos operadores
//   - logPermissionChange para audit trail

const db         = require("../../db");
const { quoteIdent } = require("../matecito");

// ─── Cache ────────────────────────────────────────────────────────────────────

let _redis = null;

// Inicializar con cliente Redis si está disponible
function setRedisClient(client) {
  _redis = client;
}

const _memCache     = new Map();
const PERM_CACHE_TTL = 120_000; // 2 minutos

function _permCacheKey(schemaName, collection, operation) {
  return `perm:${schemaName}:${collection}:${operation}`;
}

async function _getCached(key) {
  if (_redis) {
    try {
      const val = await _redis.get(key);
      return val ? JSON.parse(val) : null;
    } catch { /* fall through to memory */ }
  }
  const entry = _memCache.get(key);
  if (entry && entry.exp > Date.now()) return entry.data;
  return null;
}

async function _setCached(key, data, ttlMs) {
  if (_redis) {
    try {
      await _redis.set(key, JSON.stringify(data), "PX", ttlMs);
      return;
    } catch { /* fall through to memory */ }
  }
  _memCache.set(key, { data, exp: Date.now() + ttlMs });
}

async function _deleteCached(key) {
  if (_redis) {
    try { await _redis.del(key); } catch { /* ignore */ }
  }
  _memCache.delete(key);
}

async function invalidatePermCache(schemaName, collection) {
  for (const op of ["list", "get", "create", "update", "delete"]) {
    await _deleteCached(_permCacheKey(schemaName, collection, op));
  }
}

// ─── Filter Rule Parser v2 ────────────────────────────────────────────────────
//
// Formatos soportados:
//   v1 compat:  "userId:{{auth.id}}"
//   v2 eq:      "userId.eq:{{auth.id}}"
//   v2 neq:     "status.neq:banned"
//   v2 in:      "role.in:admin,moderator"
//
// Variables: {{auth.id}}, {{auth.email}}, {{auth.username}}

function resolveAuthVar(template, user) {
  if (template === "{{auth.id}}")       return user?.id       ?? null;
  if (template === "{{auth.email}}")    return user?.email    ?? null;
  if (template === "{{auth.username}}") return user?.username ?? null;
  return template; // valor literal
}

/**
 * Special role filter: "role.in:admin,editor"
 * Checks if req.projectUser.roles includes any of the listed roles.
 */
function resolveRoleFilter(filterRule, req) {
  const match = filterRule.match(/^role\.in:(.+)$/);
  if (!match) return null;
  const allowedRoles = match[1].split(",").map(r => r.trim());
  const userRoles    = req.projectUser?.roles ?? [];
  const hasRole      = allowedRoles.some(r => userRoles.includes(r));
  // Return a filter that always matches (role check done above) or reject
  return { hasRole, allowedRoles };
}

function resolveRLSFilterV2(filterRule, req) {
  if (!filterRule) return { filterSql: null, filterValues: [] };

  // Role-based filter (no SQL needed — checked against JWT roles)
  if (filterRule.startsWith("role.")) {
    const roleCheck = resolveRoleFilter(filterRule, req);
    if (roleCheck && !roleCheck.hasRole) {
      return { filterSql: "1 = 0", filterValues: [] }; // deny all rows
    }
    return { filterSql: null, filterValues: [] }; // allow, no SQL filter
  }

  const colonIdx = filterRule.indexOf(":");
  if (colonIdx <= 0) return { filterSql: null, filterValues: [] };

  const lhs      = filterRule.slice(0, colonIdx).trim();
  const rhsRaw   = filterRule.slice(colonIdx + 1).trim();
  const user     = req.projectUser;

  // Determinar campo y operador
  const dotIdx = lhs.lastIndexOf(".");
  let field, op;

  if (dotIdx > 0) {
    field = lhs.slice(0, dotIdx);
    op    = lhs.slice(dotIdx + 1).toLowerCase(); // eq, neq, in
  } else {
    field = lhs;
    op    = "eq"; // v1 compat
  }

  // Validar nombre de campo
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) {
    return { filterSql: null, filterValues: [] };
  }

  const col = `data->>'${field}'`;

  switch (op) {
    case "eq": {
      const val = resolveAuthVar(rhsRaw, user);
      if (val == null) return { filterSql: null, filterValues: [] };
      return { filterSql: `${col} = $?`, filterValues: [val] };
    }

    case "neq": {
      const val = resolveAuthVar(rhsRaw, user);
      if (val == null) return { filterSql: null, filterValues: [] };
      return { filterSql: `${col} != $?`, filterValues: [val] };
    }

    case "in": {
      const items = rhsRaw.split(",").map(v => v.trim()).filter(Boolean);
      if (items.length === 0) return { filterSql: null, filterValues: [] };
      const placeholders = items.map((_, i) => `$?`).join(", ");
      return { filterSql: `${col} IN (${placeholders})`, filterValues: items };
    }

    default:
      return { filterSql: null, filterValues: [] };
  }
}

// ─── Audit log ────────────────────────────────────────────────────────────────

async function logPermissionChange(schemaName, { collection, prevValue, newValue, performedBy, ip }) {
  try {
    const s = quoteIdent(schemaName);
    await db.query(
      `INSERT INTO ${s}._audit_log (action, entity, prev_value, new_value, performed_by, ip)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ["permission_updated", collection, JSON.stringify(prevValue), JSON.stringify(newValue), performedBy ?? null, ip ?? null]
    );
  } catch { /* audit log is non-critical */ }
}

// ─── checkPermissionV2 ────────────────────────────────────────────────────────
//
// Misma interfaz que checkPermission de v1, pero usa:
//   - Cache con Redis si disponible
//   - Filter rules v2 (operadores extendidos)
//   - Respuestas con error codes

async function checkPermissionV2(schemaName, collection, operation, req, reply) {
  const ALLOWED_NO_FILTER = { allowed: true,  filterSql: null, filterValues: [] };
  const DENIED            = { allowed: false, filterSql: null, filterValues: [] };

  // Platform admins: acceso total sin RLS
  if (req.projectUser?._kind === "platform") return ALLOWED_NO_FILTER;
  // Service key: acceso total sin RLS
  if (req.projectKey?.type === "service") return ALLOWED_NO_FILTER;

  // Verificar scope de API key
  if (req.projectKey?.scopes) {
    const scopes   = req.projectKey.scopes;
    const isRead   = ["list", "get"].includes(operation);
    const hasScope =
      scopes.includes("*") ||
      (isRead  && scopes.includes("read"))  ||
      (!isRead && scopes.includes("write"));

    if (!hasScope) {
      reply.code(403).send({ error: "API key scope does not allow this operation", code: "PERM_004" });
      return DENIED;
    }
  }

  // Obtener permiso con cache
  let access     = "auth";
  let filterRule = null;

  try {
    const cacheKey = _permCacheKey(schemaName, collection, operation);
    const cached   = await _getCached(cacheKey);

    if (cached) {
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
      await _setCached(cacheKey, { access, filterRule }, PERM_CACHE_TTL);
    }
  } catch { /* tabla puede no existir → usar default */ }

  switch (access) {
    case "nobody":
      reply.code(403).send({ error: "Access denied", code: "PERM_002" });
      return DENIED;

    case "public": {
      const rlsFilter = resolveRLSFilterV2(filterRule, req);
      return { allowed: true, ...rlsFilter };
    }

    case "service":
      reply.code(403).send({ error: "Service key required", code: "PERM_003" });
      return DENIED;

    case "auth":
    default:
      if (!req.projectUser && !req.projectKey) {
        reply.code(401).send({ error: "Authentication required", code: "AUTH_001" });
        return DENIED;
      }
      const rlsFilter = resolveRLSFilterV2(filterRule, req);
      return { allowed: true, ...rlsFilter };
  }
}

module.exports = {
  setRedisClient,
  invalidatePermCache,
  checkPermissionV2,
  resolveRLSFilterV2,
  logPermissionChange,
};
