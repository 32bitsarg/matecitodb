// ─── Field Validator v2 ───────────────────────────────────────────────────────
//
// Valida el objeto `data` de un registro contra el schema definido en _fields.
// Se llama antes de INSERT/UPDATE en _records.
//
// Uso:
//   const { validateRecordData } = require("../lib/v2/field-validator");
//   const error = await validateRecordData(db, schema, collection, data, { recordId });
//   if (error) return reply.code(422).send({ error: error.message, field: error.field, code: "DATA_005" });

const db = require("../../db");
const { quoteIdent } = require("../matecito");

// ── Type coercers ─────────────────────────────────────────────────────────────

function isNumber(v) {
  return v !== null && v !== "" && !isNaN(Number(v));
}

function isBoolean(v) {
  return v === true || v === false || v === "true" || v === "false";
}

function isDate(v) {
  return !isNaN(Date.parse(v));
}

// ── Constraint validators ─────────────────────────────────────────────────────

function validateConstraints(field, value, constraints) {
  if (!constraints || typeof constraints !== "object") return null;
  const { min, max, minLength, maxLength, pattern, enum: enumVals } = constraints;

  if (field.type === "text" || typeof value === "string") {
    const str = String(value);
    if (minLength !== undefined && str.length < minLength)
      return `must be at least ${minLength} characters`;
    if (maxLength !== undefined && str.length > maxLength)
      return `must be at most ${maxLength} characters`;
    if (pattern && !new RegExp(pattern).test(str))
      return `does not match required pattern`;
  }

  if (field.type === "number") {
    const num = Number(value);
    if (min !== undefined && num < min) return `must be >= ${min}`;
    if (max !== undefined && num > max) return `must be <= ${max}`;
  }

  if (field.type === "date") {
    const d = new Date(value);
    if (min && d < new Date(min)) return `must be after ${min}`;
    if (max && d > new Date(max)) return `must be before ${max}`;
  }

  if (Array.isArray(enumVals) && enumVals.length > 0) {
    if (!enumVals.includes(value)) return `must be one of: ${enumVals.join(", ")}`;
  }

  return null;
}

// ── Unique check ──────────────────────────────────────────────────────────────

async function checkUnique(schemaName, collection, fieldName, value, recordId) {
  const s = quoteIdent(schemaName);
  const params = [collection, String(value)];
  let sql = `SELECT 1 FROM ${s}._records WHERE collection = $1 AND data->>'${fieldName}' = $2 AND deleted_at IS NULL`;
  if (recordId) {
    params.push(recordId);
    sql += ` AND id != $3`;
  }
  sql += ` LIMIT 1`;
  const { rows } = await db.query(sql, params);
  return rows.length > 0;
}

// ── Relation check ────────────────────────────────────────────────────────────

async function checkRelationExists(schemaName, relatedCollection, relatedId) {
  const s = quoteIdent(schemaName);
  const { rows } = await db.query(
    `SELECT 1 FROM ${s}._records WHERE id = $1 AND collection = $2 AND deleted_at IS NULL LIMIT 1`,
    [relatedId, relatedCollection]
  );
  return rows.length > 0;
}

// ── Main validator ────────────────────────────────────────────────────────────

/**
 * Validates record data against the collection's field definitions.
 * @param {string} schemaName   - e.g. "proj_abc123"
 * @param {string} collection   - collection name
 * @param {object} data         - the record data to validate
 * @param {object} opts
 * @param {string} [opts.recordId]   - for updates: the ID of the record being updated (for unique check)
 * @param {boolean} [opts.partial]   - if true, skip required checks (for PATCH)
 * @returns {{ field: string, message: string } | null}
 */
async function validateRecordData(schemaName, collection, data, opts = {}) {
  const { recordId, partial = false } = opts;

  if (!data || typeof data !== "object" || Array.isArray(data)) return null;

  const s = quoteIdent(schemaName);
  let fields;
  try {
    const { rows } = await db.query(
      `SELECT name, type, required, options, constraints FROM ${s}._fields WHERE collection = $1`,
      [collection]
    );
    fields = rows;
  } catch {
    return null; // No fields defined — skip validation
  }

  for (const field of fields) {
    const { name, type, required, options, constraints } = field;
    const value = data[name];
    const missing = value === undefined || value === null || value === "";

    // Required check (skip on partial updates)
    if (required && !partial && missing) {
      return { field: name, message: `Field '${name}' is required` };
    }

    if (missing) continue; // Optional field not provided — skip

    // Type check
    switch (type) {
      case "number":
        if (!isNumber(value))
          return { field: name, message: `Field '${name}' must be a number` };
        break;
      case "boolean":
        if (!isBoolean(value))
          return { field: name, message: `Field '${name}' must be a boolean` };
        break;
      case "date":
        if (!isDate(value))
          return { field: name, message: `Field '${name}' must be a valid date` };
        break;
      case "relation":
        if (typeof value !== "string" || !/^[0-9a-f-]{36}$/.test(value))
          return { field: name, message: `Field '${name}' must be a valid UUID` };
        if (options?.collection) {
          const exists = await checkRelationExists(schemaName, options.collection, value);
          if (!exists)
            return { field: name, message: `Related record '${value}' not found in '${options.collection}'` };
        }
        break;
      case "json":
        if (typeof value !== "object")
          return { field: name, message: `Field '${name}' must be a JSON object or array` };
        break;
      // text: any string value is ok — constraints below apply
    }

    // Constraint checks
    const constraintError = validateConstraints(field, value, constraints);
    if (constraintError)
      return { field: name, message: `Field '${name}': ${constraintError}` };

    // Unique check
    if (constraints?.unique) {
      const isDuplicate = await checkUnique(schemaName, collection, name, value, recordId);
      if (isDuplicate)
        return { field: name, message: `Field '${name}' must be unique` };
    }
  }

  return null; // All good
}

module.exports = { validateRecordData };
