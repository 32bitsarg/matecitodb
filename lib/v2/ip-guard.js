// ─── IP Guard (Q2) — Allowlist / Blocklist por proyecto ────────────────────
//
// Evalúa reglas CIDR por proyecto. Cache en memoria 60s.

const db = require("../../db");
const { quoteIdent } = require("../matecito");

const _cache = new Map(); // schemaName -> { rules, expiresAt }
const CACHE_TTL = 60_000;

function parseCIDR(cidr) {
  const parts = cidr.split("/");
  const ip = parts[0];
  const bits = parseInt(parts[1] || "32", 10);

  const ipParts = ip.split(".").map(Number);
  if (ipParts.length !== 4 || ipParts.some(p => isNaN(p) || p < 0 || p > 255)) return null;

  const ipNum = (ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3];
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  const network = (ipNum & mask) >>> 0;

  return { network, mask, bits };
}

function ipToNum(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4) return 0;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function ipMatches(ip, cidr) {
  const parsed = parseCIDR(cidr);
  if (!parsed) return false;
  const ipNum = ipToNum(ip);
  return ((ipNum & parsed.mask) >>> 0) === parsed.network;
}

async function getRules(schemaName) {
  const cached = _cache.get(schemaName);
  if (cached && cached.expiresAt > Date.now()) return cached.rules;

  const schema = quoteIdent(schemaName);
  const { rows } = await db.query(
    `SELECT id, type, cidr, description, is_active FROM ${schema}._ip_rules WHERE is_active = true`
  ).catch(() => ({ rows: [] }));

  const rules = rows.map(r => ({ ...r, parsed: parseCIDR(r.cidr) }));
  _cache.set(schemaName, { rules, expiresAt: Date.now() + CACHE_TTL });
  return rules;
}

/**
 * Evalúa si una IP está permitida.
 * @returns {object} { allowed: boolean, matchedRule? }
 */
async function evaluateIP(schemaName, ip) {
  const rules = await getRules(schemaName);
  if (rules.length === 0) return { allowed: true };

  const allowRules = rules.filter(r => r.type === "allow");
  const blockRules = rules.filter(r => r.type === "block");

  // Check block rules first
  for (const rule of blockRules) {
    if (rule.parsed && ipMatches(ip, rule.cidr)) {
      return { allowed: false, matchedRule: rule };
    }
  }

  // If there are allow rules, IP must match one
  if (allowRules.length > 0) {
    for (const rule of allowRules) {
      if (rule.parsed && ipMatches(ip, rule.cidr)) {
        return { allowed: true, matchedRule: rule };
      }
    }
    return { allowed: false, matchedRule: null, reason: "IP not in allowlist" };
  }

  // Only block rules existed — IP passed all
  return { allowed: true };
}

function invalidateCache(schemaName) {
  _cache.delete(schemaName);
}

module.exports = { evaluateIP, invalidateCache, parseCIDR, ipMatches };
