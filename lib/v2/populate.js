// ─── Populate helper v2 ───────────────────────────────────────────────────────
//
// Resuelve campos de tipo "relation" trayendo los documentos relacionados.
// Uso: await populateRecords(db, schema, fields, records, populateList)
//
// ?populate=author_id,category_id → máx 3 campos
// Resultado: record.data._populated = { author_id: { id, data, ... }, ... }

const db = require("../../db");
const { quoteIdent } = require("../matecito");

const MAX_POPULATE = 3;

/**
 * @param {string} schemaName
 * @param {object[]} fields   - rows from _fields (name, type, options)
 * @param {object[]} records  - array of _records rows
 * @param {string}   populate - comma-separated field names
 * @returns {object[]} records with _populated injected into data
 */
async function populateRecords(schemaName, fields, records, populate) {
  if (!populate || records.length === 0) return records;

  const schema    = quoteIdent(schemaName);
  const fieldMap  = new Map(fields.map(f => [f.name, f]));
  const requested = populate.split(",").map(f => f.trim()).filter(Boolean).slice(0, MAX_POPULATE);

  // Only process fields that are of type "relation"
  const relFields = requested.filter(name => fieldMap.get(name)?.type === "relation");
  if (relFields.length === 0) return records;

  // For each relation field, collect all unique IDs across all records
  const idsByField = {};
  for (const fieldName of relFields) {
    const ids = [...new Set(
      records.map(r => r.data?.[fieldName]).filter(v => v && typeof v === "string")
    )];
    idsByField[fieldName] = ids;
  }

  // Fetch related records in bulk (one query per relation field)
  const populatedByField = {};
  for (const fieldName of relFields) {
    const ids = idsByField[fieldName];
    if (ids.length === 0) { populatedByField[fieldName] = {}; continue; }

    try {
      const { rows } = await db.query(
        `SELECT * FROM ${schema}._records WHERE id = ANY($1) AND deleted_at IS NULL`,
        [ids]
      );
      populatedByField[fieldName] = Object.fromEntries(rows.map(r => [r.id, r]));
    } catch {
      populatedByField[fieldName] = {};
    }
  }

  // Inject _populated into each record's data
  return records.map(record => {
    const _populated = {};
    for (const fieldName of relFields) {
      const relId  = record.data?.[fieldName];
      if (relId) _populated[fieldName] = populatedByField[fieldName][relId] ?? null;
    }
    return {
      ...record,
      data: { ...(record.data ?? {}), _populated },
    };
  });
}

module.exports = { populateRecords };
