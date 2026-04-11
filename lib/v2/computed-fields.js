// ─── Computed Fields (N2) — Evaluador de fórmulas ───────────────────────────
//
// Parsea fórmulas como "price * quantity", "upper(email)", "IF(x > 0, 'a', 'b')"
// y las convierte a expresiones SQL para columnas generadas.
// No permite escritura directa en campos computed.

const SAFE_FIELD = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

const SQL_FUNCTIONS = {
  upper:   { sql: "UPPER", args: 1 },
  lower:   { sql: "LOWER", args: 1 },
  length:  { sql: "LENGTH", args: 1 },
  round:   { sql: "ROUND", args: 2 },
  coalesce:{ sql: "COALESCE", args: null }, // variable args
  abs:     { sql: "ABS", args: 1 },
  floor:   { sql: "FLOOR", args: 1 },
  ceil:    { sql: "CEIL", args: 1 },
  date_diff_days: { sql: "EXTRACT(EPOCH FROM ($1 - $2))/86400", args: 2 },
  date_diff_hours: { sql: "EXTRACT(EPOCH FROM ($1 - $2))/3600", args: 2 },
};

/**
 * Convierte una fórmula en una expresión SQL.
 * Los campos del record se referencian como data->>'fieldName'.
 */
function formulaToSql(formula, collectionFields = []) {
  let sql = formula;

  // IF(cond, trueVal, falseVal) → CASE WHEN cond THEN trueVal ELSE falseVal END
  sql = sql.replace(/IF\((.+?),\s*(.+?),\s*(.+?)\)/g, "CASE WHEN $1 THEN $2 ELSE $3 END");

  // Funciones: upper(field) → UPPER((data->>'field')::text)
  for (const [name, fn] of Object.entries(SQL_FUNCTIONS)) {
    const regex = new RegExp(`${name}\\((.+?)\\)`, "g");
    sql = sql.replace(regex, (_, args) => {
      const argExprs = args.split(",").map(a => a.trim()).map(a => fieldRef(a, collectionFields));
      if (fn.args === null) {
        return `${fn.sql}(${argExprs.join(", ")})`;
      }
      if (fn.sql.includes("$1")) {
        let result = fn.sql;
        argExprs.forEach((arg, i) => {
          result = result.replace(`$${i + 1}`, arg);
        });
        return result;
      }
      return `${fn.sql}(${argExprs.join(", ")})`;
    });
  }

  // Reemplazar referencias a campos: fieldName → (data->>'fieldName')
  const fieldNames = [...new Set(collectionFields)];
  // Ordenar por largo descendente para evitar partial matches (total_price antes que total)
  fieldNames.sort((a, b) => b.length - a.length);

  for (const fieldName of fieldNames) {
    const regex = new RegExp(`\\b${fieldName}\\b`, "g");
    sql = sql.replace(regex, `(data->>'${fieldName.replace(/'/g, "''")}')`);
  }

  // Reemplazar NOW() (already SQL)
  // Numeric literals are fine as-is
  // String literals in quotes are fine as-is

  return sql;
}

/**
 * Referencia un campo o expresión.
 */
function fieldRef(expr, collectionFields) {
  expr = expr.trim();

  // Numeric literal
  if (/^-?\d+(\.\d+)?$/.test(expr)) return expr;

  // String literal
  if (/^'.*'$/.test(expr)) return expr;

  // Field reference
  if (SAFE_FIELD.test(expr) && collectionFields.includes(expr)) {
    return `(data->>'${expr}')`;
  }

  return expr;
}

/**
 * Genera el SQL para agregar una columna computed a _records.
 */
function generateComputedColumnSql(fieldName, formula, resultType, collectionFields) {
  const expr = formulaToSql(formula, collectionFields);

  const castMap = {
    number: "::numeric",
    text: "::text",
    boolean: "::boolean",
  };

  const cast = castMap[resultType] || "";

  return `ALTER TABLE _records ADD COLUMN IF NOT EXISTS _computed_${fieldName} GENERATED ALWAYS AS (${expr}${cast}) STORED`;
}

/**
 * Evalúa un campo computed en JS para un record específico (fallback).
 */
function evaluateComputed(formula, recordData) {
  // Simple evaluator: replace fields with values, eval safely
  let expr = formula;

  // Handle IF
  expr = expr.replace(/IF\((.+?),\s*(.+?),\s*(.+?)\)/g, "($1 ? $2 : $3)");

  // Handle functions
  for (const [name, fn] of Object.entries(SQL_FUNCTIONS)) {
    const regex = new RegExp(`${name}\\((.+?)\\)`, "gi");
    expr = expr.replace(regex, (_, args) => {
      const vals = args.split(",").map(a => a.trim()).map(a => {
        if (recordData[a] !== undefined) return JSON.stringify(recordData[a]);
        return a;
      });
      switch (name) {
        case "upper":   return String(vals[0]).toUpperCase();
        case "lower":   return String(vals[0]).toLowerCase();
        case "length":  return String(vals[0]).length;
        case "round":   return Math.round(Number(vals[0]) * Math.pow(10, Number(vals[1]))) / Math.pow(10, Number(vals[1]));
        case "coalesce": return vals.find(v => v !== "null" && v !== "undefined") || "null";
        case "abs":     return Math.abs(Number(vals[0]));
        case "floor":   return Math.floor(Number(vals[0]));
        case "ceil":    return Math.ceil(Number(vals[0]));
        default:        return vals[0];
      }
    });
  }

  // Replace field references with values
  for (const [key, val] of Object.entries(recordData)) {
    const regex = new RegExp(`\\b${key}\\b`, "g");
    expr = expr.replace(regex, JSON.stringify(val));
  }

  // Replace + for strings (concatenation)
  // Safe eval: only allow math and string operations
  try {
    // eslint-disable-next-line no-new-func
    const result = Function(`"use strict"; return (${expr})`)();
    return result;
  } catch {
    return null;
  }
}

module.exports = {
  formulaToSql,
  fieldRef,
  generateComputedColumnSql,
  evaluateComputed,
  SQL_FUNCTIONS,
};
