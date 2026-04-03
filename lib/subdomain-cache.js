const db = require("../db");

const subdomainCache = new Map();
const CACHE_TTL_MS   = process.env.NODE_ENV === "production" ? 120_000 : 30_000;

// Limpiar entradas expiradas cada 5 minutos para evitar memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of subdomainCache) {
    if (entry.exp <= now) subdomainCache.delete(key);
  }
}, 5 * 60 * 1000).unref();

async function getProjectBySubdomain(subdomain) {
  const cached = subdomainCache.get(subdomain);
  if (cached && cached.exp > Date.now()) return cached.data;

  const { rows } = await db.query(
    `SELECT p.id, p.name, p.subdomain, p.schema_name,
            p.storage_quota_mb, p.log_retention_days, p.sql_enabled, p.allowed_origins,
            k_anon.key AS anon_key,
            k_srv.key  AS service_key
     FROM   projects p
     LEFT JOIN api_keys k_anon ON k_anon.project_id = p.id AND k_anon.type = 'anon'  AND k_anon.revoked_at IS NULL
     LEFT JOIN api_keys k_srv  ON k_srv.project_id  = p.id AND k_srv.type  = 'service' AND k_srv.revoked_at IS NULL
     WHERE  p.subdomain = $1
     LIMIT  1`,
    [subdomain]
  );

  const project = rows[0] ?? null;
  if (project) {
    subdomainCache.set(subdomain, { data: project, exp: Date.now() + CACHE_TTL_MS });
  }

  return project;
}

/**
 * Invalida la caché para un proyecto (por subdomain o por projectId).
 * Llamar inmediatamente tras revocar/regenerar API keys o cambiar settings.
 */
function invalidateProjectCache(identifier) {
  // Intento directo por subdomain string
  subdomainCache.delete(identifier);
  // Barrido por projectId
  for (const [key, entry] of subdomainCache) {
    if (entry.data?.id === identifier || entry.data?.subdomain === identifier) {
      subdomainCache.delete(key);
    }
  }
}

module.exports = { getProjectBySubdomain, invalidateProjectCache };
