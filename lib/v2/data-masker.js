// ─── Data Masker (P3) — Enmascaramiento de campos por rol ──────────────────
//
// Aplica máscaras a campos según los roles del usuario.
// Se ejecuta post-query en list-records y get-record.

/**
 * Aplica masking a un record según sus roles y las definiciones de campos.
 *
 * @param {object} record - { id, data, ... }
 * @param {Array} fieldsWithMask - [{ name, mask: { strategy, pattern, visible_to_roles } }]
 * @param {string[]} userRoles - roles del usuario
 * @returns {object} record con campos masked
 */
function maskRecord(record, fieldsWithMask, userRoles) {
  if (!record || !record.data) return record;
  if (!fieldsWithMask || fieldsWithMask.length === 0) return record;

  const roles = new Set(userRoles || []);
  const data = { ...record.data };

  for (const field of fieldsWithMask) {
    if (!field.mask) continue;

    const { strategy, pattern, visible_to_roles } = field.mask;
    if (!strategy) continue;

    // Check if user has access
    if (visible_to_roles && visible_to_roles.length > 0) {
      const hasAccess = visible_to_roles.some(r => roles.has(r));
      if (hasAccess) continue; // user can see it
    }

    const value = data[field.name];
    if (value === undefined || value === null) continue;

    data[field.name] = applyMask(strategy, pattern, String(value));
  }

  return { ...record, data };
}

function applyMask(strategy, pattern, value) {
  switch (strategy) {
    case "partial": {
      const mask = pattern || "***-***-####";
      // Apply pattern: # = show, * = hide
      if (value.length <= 4) return mask.substring(0, value.length).replace(/#/g, () => "");
      const visible = value.slice(-4);
      return mask.replace(/####/, visible).replace(/\*/g, "•");
    }

    case "full":
      return "[REDACTED]";

    case "hash": {
      const crypto = require("crypto");
      return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
    }

    case "redact":
      return null;

    default:
      return value;
  }
}

/**
 * Obtiene campos con mask de una colección.
 */
async function getMaskedFields(db, schemaName, collection) {
  const { quoteIdent } = require("../matecito");
  const schema = quoteIdent(schemaName);

  const { rows } = await db.query(
    `SELECT name, type, constraints FROM ${schema}._fields WHERE collection = $1`,
    [collection]
  ).catch(() => ({ rows: [] }));

  return rows
    .filter(r => r.constraints?.mask)
    .map(r => ({ name: r.name, type: r.type, mask: r.constraints.mask }));
}

module.exports = { maskRecord, applyMask, getMaskedFields };
