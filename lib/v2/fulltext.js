// ─── Full-text search helpers ─────────────────────────────────────────────────
//
// Utilities para búsqueda full-text nativa de PostgreSQL con tsvector/ts_rank.
// Se integra con la columna search_fields de _collections y search_vector de _records.

const { db, quoteIdent } = require("./auth");

const SUPPORTED_LANGUAGES = new Set([
  "spanish", "english", "french", "german", "portuguese", "simple",
]);

/**
 * Obtiene los campos de búsqueda configurados para una colección.
 * @returns {string[]} Lista de nombres de campos, o [] si no configurado.
 */
async function getSearchFields(schemaName, collection) {
  const { rows } = await db.query(
    `SELECT search_fields FROM ${quoteIdent(schemaName)}._collections WHERE name = $1 LIMIT 1`,
    [collection]
  );
  if (!rows[0] || !rows[0].search_fields) return [];
  return rows[0].search_fields;
}

/**
 * Construye un tsvector desde los campos de texto de un record.
 * Concatena los valores de los campos configurados en search_fields.
 */
function buildSearchVectorExpr(searchFields) {
  if (!searchFields || searchFields.length === 0) return "NULL";

  const parts = searchFields
    .map(f => `COALESCE(data->>'${f.replace(/'/g, "''")}', '')`)
    .join(" || ' ' || ");

  return parts;
}

/**
 * Actualiza search_vector después de un INSERT o UPDATE.
 * Retorna la query SQL lista para ejecutar (o string vacío si no hay search_fields).
 */
async function buildSearchVectorUpdate(schemaName, collection, recordId, data) {
  const searchFields = await getSearchFields(schemaName, collection);
  if (!searchFields.length) return null;

  const schema = quoteIdent(schemaName);

  // Construir el texto a indexar desde los campos configurados
  const textParts = [];
  for (const field of searchFields) {
    const val = data?.[field];
    if (val && typeof val === "string") {
      textParts.push(val);
    }
  }

  if (textParts.length === 0) {
    // No hay texto para indexar, limpiamos el vector
    return {
      sql: `UPDATE ${schema}._records SET search_vector = NULL WHERE id = $1`,
      params: [recordId],
    };
  }

  const textValue = textParts.join(" ");

  return {
    sql: `UPDATE ${schema}._records SET search_vector = to_tsvector('simple', $1) WHERE id = $2`,
    params: [textValue, recordId],
  };
}

/**
 * Ejecuta una búsqueda full-text.
 * @param {string} schemaName - Nombre del schema del proyecto
 * @param {string} collection - Nombre de la colección
 * @param {string} query - Texto a buscar
 * @param {object} opts - Opciones: limit, lang, filters
 * @returns {{ results: Array<{id, data, _score}>, total: number }}
 */
async function searchRecords(schemaName, collection, query, opts = {}) {
  const schema = quoteIdent(schemaName);
  const lang = SUPPORTED_LANGUAGES.has(opts.lang) ? opts.lang : "simple";
  const limit = Math.min(100, Math.max(1, opts.limit || 20));

  // Escapar la query para tsquery: reemplazar caracteres especiales
  const safeQuery = String(query)
    .replace(/[&|!()<>:\\]/g, " ")
    .trim();

  if (!safeQuery) {
    return { results: [], total: 0 };
  }

  // Construir la búsqueda: convertir espacios en & (AND)
  const tsqueryValue = safeQuery.split(/\s+/).join(" & ");

  const where = [`r.collection = $1`, `r.search_vector @@ to_tsquery($2, $3)`];
  const values = [collection, lang, tsqueryValue];

  if (opts.include_deleted !== "true") {
    where.push(`r.deleted_at IS NULL`);
  }
  if (opts.include_expired !== "true") {
    where.push(`(r.expires_at IS NULL OR r.expires_at > NOW())`);
  }

  // RLS filter si se pasa
  if (opts.rlsFilterSql) {
    let rlsIdx = values.length;
    values.push(...opts.rlsFilterValues);
    where.push(opts.rlsFilterSql.replace(/\$\?/g, () => `$${++rlsIdx}`));
  }

  const whereClause = `WHERE ${where.join(" AND ")}`;

  // Count total
  const countRes = await db.query(
    `SELECT COUNT(*) FROM ${schema}._records r ${whereClause}`,
    values
  );
  const total = parseInt(countRes.rows[0].count, 10);

  // Results con rank
  values.push(limit);
  const limitIdx = values.length;

  const dataRes = await db.query(
    `SELECT r.id, r.data, r.created_at, r.updated_at,
            ts_rank(r.search_vector, to_tsquery($2, $3)) AS _score
     FROM ${schema}._records r
     ${whereClause}
     ORDER BY _score DESC, r.created_at DESC
     LIMIT $${limitIdx}`,
    values
  );

  const results = dataRes.rows.map(row => ({
    id: row.id,
    data: row.data,
    created_at: row.created_at,
    updated_at: row.updated_at,
    _score: parseFloat(row._score),
  }));

  return { results, total };
}

module.exports = {
  getSearchFields,
  buildSearchVectorExpr,
  buildSearchVectorUpdate,
  searchRecords,
  SUPPORTED_LANGUAGES,
};
