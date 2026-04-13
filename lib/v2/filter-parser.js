// ─── Advanced Filter Parser (G2) ──────────────────────────────────────────────
//
// Módulo centralizado de parseo de filtros para list-records, aggregate, etc.
// Reemplaza la lógica inline de parseo con un parser unificado.
//
// Soporta:
//   - Operadores: eq, neq, gt, gte, lt, lte, between, in, nin, null, like, ilike, has
//   - Filtros OR anidados
//   - Filtros via query string (legacy: campo.op:valor)
//   - Filtros via body POST /records/query (estructura JSON)
//
// Query string examples:
//   ?status.eq:active&price.gte:10&price.lte:100&tags.has:javascript
//   ?category.in:tech,business&name.null:false&title.like:%node%
//   ?or[0]=status.eq:draft&or[1]=status.eq:review

const { db, quoteIdent } = require("./auth");

const SAFE_KEY = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

// Skip these query params (no son filtros de campo)
const QUERY_SKIP = new Set([
  "collection", "select", "or", "cursor", "populate", "limit",
  "order", "search", "sort", "include_deleted", "include_expired",
  "projectId",
]);

// ── Parse query-string filters ───────────────────────────────────────────────
//
// Formato: campo.op:valor
// Operadores: eq, neq, gt, gte, lt, lte, between, in, nin, null, like, ilike, has

function parseQueryFilters(query, fields = {}) {
  const conditions = []; // { type: 'and'|'or', filters: [...] }
  const orConditions = [];

  for (const [key, raw] of Object.entries(query)) {
    if (!SAFE_KEY.test(key)) continue;
    if (QUERY_SKIP.has(key)) continue;
    if (typeof raw !== "string" && !Array.isArray(raw)) continue;

    if (key === "or") {
      // Parse OR filters
      const orRaw = Array.isArray(raw) ? raw : [raw];
      for (const expr of orRaw) {
        const parsed = parseSingleFilter(String(expr), fields);
        if (parsed) orConditions.push(parsed);
      }
      continue;
    }

    // Standard field.op:valor
    const parsed = parseSingleFilter(`${key}.${raw}`, fields);
    if (parsed) conditions.push(parsed);
  }

  return { conditions, orConditions };
}

function parseSingleFilter(expr, fields = {}) {
  // Format: campo.op:valor  or  campo:valor (implicit eq)
  const dotIdx = expr.indexOf(".");
  if (dotIdx <= 0) return null;

  const key = expr.slice(0, dotIdx).trim();
  if (!SAFE_KEY.test(key)) return null;
  if (fields && Object.keys(fields).length > 0 && !fields[key]) return null;

  const rest = expr.slice(dotIdx + 1);
  const colonIdx = rest.indexOf(":");

  let op, val;
  if (colonIdx > 0) {
    op = rest.slice(0, colonIdx).trim();
    val = rest.slice(colonIdx + 1).trim();
  } else {
    // SDK legacy format: field=op.value (e.g. tag=eq.alpha, value=gte.10)
    const dotInRest = rest.indexOf(".");
    if (dotInRest > 0 && SQL_OPERATORS[rest.slice(0, dotInRest)]) {
      op = rest.slice(0, dotInRest);
      val = rest.slice(dotInRest + 1);
    } else {
      op = "eq";
      val = rest;
    }
  }

  if (!SQL_OPERATORS[op]) return null;

  return { key, op, val };
}

// ── SQL generation from parsed filters ───────────────────────────────────────

const SQL_OPERATORS = {
  eq:      { sql: "=",          needsVal: true },
  neq:     { sql: "!=",         needsVal: true },
  gt:      { sql: ">",          needsVal: true },
  gte:     { sql: ">=",         needsVal: true },
  lt:      { sql: "<",          needsVal: true },
  lte:     { sql: "<=",         needsVal: true },
  between: { sql: "BETWEEN",    needsVal: true },
  in:      { sql: "= ANY",      needsVal: true },
  nin:     { sql: "!= ALL",     needsVal: true },
  null:    { sql: "IS NULL",    needsVal: false },
  like:    { sql: "ILIKE",      needsVal: true },
  ilike:   { sql: "ILIKE",      needsVal: true },
  has:     { sql: "@>",         needsVal: true },
};

/**
 * Genera la cláusula WHERE y los valores para un set de filtros.
 *
 * @param {Array} conditions - Array de { key, op, val } (AND)
 * @param {Array} orConditions - Array de { key, op, val } (OR)
 * @param {object} fields - Mapa de campos con tipos: { name: { type } }
 * @param {Array} existingValues - Valores ya usados (para offset de índices)
 * @returns {{ where: string[], values: any[] }}
 */
function buildWhereClause(conditions, orConditions, fields = {}, existingValues = []) {
  const where = [];
  const values = [...existingValues];

  // AND conditions
  for (const cond of conditions) {
    const { clause, val } = sqlForFilter(cond, values.length + 1, fields);
    where.push(clause);
    if (val !== undefined) Array.isArray(val) ? values.push(...val) : values.push(val);
  }

  // OR conditions
  if (orConditions.length > 0) {
    const orParts = [];
    for (const cond of orConditions) {
      const { clause, val } = sqlForFilter(cond, values.length + 1, fields);
      orParts.push(clause);
      if (val !== undefined) Array.isArray(val) ? values.push(...val) : values.push(val);
    }
    where.push(`(${orParts.join(" OR ")})`);
  }

  return { where, values };
}

function sqlForFilter({ key, op, val }, paramIdx, fields = {}) {
  const fieldInfo = fields[key] || {};
  const fieldType = fieldInfo.type || "text";
  const col = `r.data->>'${key}'`;
  const castedCol = castColumn(col, fieldType);

  const opInfo = SQL_OPERATORS[op];
  if (!opInfo) return { clause: "TRUE" };

  switch (op) {
    case "eq":
      return { clause: `${castedCol} = $${paramIdx}`, val: coerceValue(fieldType, val) };

    case "neq":
      return { clause: `(${castedCol} != $${paramIdx} OR ${col} IS NULL)`, val: coerceValue(fieldType, val) };

    case "gt":
      return { clause: `${castedCol} > $${paramIdx}`, val: coerceValue(fieldType, val) };

    case "gte":
      return { clause: `${castedCol} >= $${paramIdx}`, val: coerceValue(fieldType, val) };

    case "lt":
      return { clause: `${castedCol} < $${paramIdx}`, val: coerceValue(fieldType, val) };

    case "lte":
      return { clause: `${castedCol} <= $${paramIdx}`, val: coerceValue(fieldType, val) };

    case "between": {
      const parts = String(val).split(",");
      if (parts.length !== 2) return { clause: "TRUE" };
      return {
        clause: `${castedCol} BETWEEN $${paramIdx} AND $${paramIdx + 1}`,
        val: [coerceValue(fieldType, parts[0].trim()), coerceValue(fieldType, parts[1].trim())],
      };
    }

    case "in": {
      const parts = String(val).split(",").map(s => s.trim());
      return {
        clause: `${castedCol} = ANY(ARRAY[${parts.map((_, i) => `$${paramIdx + i}`).join(",")}])`,
        val: parts.map(p => coerceValue(fieldType, p)),
      };
    }

    case "nin": {
      const parts = String(val).split(",").map(s => s.trim());
      return {
        clause: `${castedCol} != ALL(ARRAY[${parts.map((_, i) => `$${paramIdx + i}`).join(",")}])`,
        val: parts.map(p => coerceValue(fieldType, p)),
      };
    }

    case "null":
      if (val === "true" || val === "1") {
        return { clause: `${col} IS NULL` };
      } else {
        return { clause: `${col} IS NOT NULL` };
      }

    case "like":
    case "ilike":
      // Ensure pattern has wildcards
      const pattern = val.includes("%") ? val : `%${val}%`;
      return { clause: `${castedCol} ILIKE $${paramIdx}`, val: pattern };

    case "has":
      // JSONB array containment: data->'field' @> '"value"'::jsonb
      return {
        clause: `r.data->'${key}' @> $${paramIdx}::jsonb`,
        val: JSON.stringify(val),
      };

    default:
      return { clause: "TRUE" };
  }
}

// ── JSON body filter parser (for POST /records/query) ────────────────────────

function parseBodyFilters(whereObj, fields = {}) {
  if (!whereObj || typeof whereObj !== "object") return { conditions: [], orConditions: [] };

  const conditions = [];
  const orConditions = [];

  for (const [key, val] of Object.entries(whereObj)) {
    if (key === "or" && Array.isArray(val)) {
      for (const subWhere of val) {
        const sub = parseBodyFilters(subWhere, fields);
        // Flatten: each sub-where becomes a group in OR
        const subConds = [...sub.conditions];
        if (subConds.length > 0) {
          // If there's only one condition, add it directly
          if (subConds.length === 1) {
            orConditions.push(subConds[0]);
          } else {
            // Multiple conditions in OR group — flatten
            for (const c of subConds) orConditions.push(c);
          }
        }
      }
      continue;
    }

    if (typeof val === "object" && val !== null) {
      // { status: { eq: "active" } }
      for (const [op, opVal] of Object.entries(val)) {
        if (SQL_OPERATORS[op]) {
          conditions.push({ key, op, val: opVal });
        }
      }
    } else {
      // { status: "active" } → implicit eq
      conditions.push({ key, op: "eq", val });
    }
  }

  return { conditions, orConditions };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function castColumn(col, type) {
  if (type === "number")  return `(${col})::numeric`;
  if (type === "date")    return `(${col})::timestamp`;
  if (type === "boolean") return `(${col})::boolean`;
  return col;
}

function coerceValue(type, val) {
  if (val === null || val === undefined) return null;
  switch (type) {
    case "number": {
      const num = Number(val);
      return isNaN(num) ? val : num;
    }
    case "boolean":
      return val === "true" || val === true;
    case "date":
      return new Date(val).toISOString();
    default:
      return String(val);
  }
}

module.exports = {
  SAFE_KEY,
  QUERY_SKIP,
  SQL_OPERATORS,
  parseQueryFilters,
  parseSingleFilter,
  buildWhereClause,
  parseBodyFilters,
  castColumn,
  coerceValue,
};
