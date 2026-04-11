// ─── Org Context (R1) — Multi-tenancy dentro del proyecto ───────────────────
//
// Middleware que resuelve la org del usuario desde header X-Org-Slug.
// Inyecta req.projectOrg y {{auth.org_id}} para RLS.

const db = require("../../db");
const { quoteIdent } = require("../matecito");

const _orgCache = new Map(); // slug -> { id, expiresAt }
const CACHE_TTL = 60_000;

async function resolveOrg(schemaName, slug) {
  const cached = _orgCache.get(slug);
  if (cached && cached.expiresAt > Date.now()) return cached.org;

  const schema = quoteIdent(schemaName);
  const { rows } = await db.query(
    `SELECT id, name, slug, metadata FROM ${schema}._orgs WHERE slug = $1 LIMIT 1`,
    [slug]
  ).catch(() => ({ rows: [] }));

  if (!rows[0]) return null;

  _orgCache.set(slug, { org: rows[0], expiresAt: Date.now() + CACHE_TTL });
  return rows[0];
}

/**
 * Middleware para Fastify: resuelve org desde header.
 * Se usa como preHandler en rutas que necesitan contexto de org.
 */
async function resolveOrgContext(req, reply) {
  const orgSlug = req.headers["x-org-slug"];
  if (!orgSlug) {
    req.projectOrg = null;
    return;
  }

  const project = req.resolvedProject;
  const projectId = project?.id ?? req.params?.projectId;
  const schemaName = project?.schema_name ?? (await db.query(
    `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
  )).rows[0]?.schema_name;

  if (!schemaName) { req.projectOrg = null; return; }

  const org = await resolveOrg(schemaName, orgSlug);
  if (!org) {
    return reply.code(403).send({ error: "Organization not found", code: "ORG_001" });
  }

  req.projectOrg = org;
}

/**
 * Verifica que el usuario sea miembro de la org.
 */
async function isOrgMember(schemaName, orgId, userId) {
  const schema = quoteIdent(schemaName);
  const { rows } = await db.query(
    `SELECT role FROM ${schema}._org_members WHERE org_id = $1 AND user_id = $2 LIMIT 1`,
    [orgId, userId]
  );
  return rows[0] || null;
}

function invalidateOrgCache(slug) {
  _orgCache.delete(slug);
}

module.exports = { resolveOrg, resolveOrgContext, isOrgMember, invalidateOrgCache };
