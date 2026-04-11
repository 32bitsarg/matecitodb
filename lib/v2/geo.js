// ─── Geo helpers (M1) — Haversine sin PostGIS ───────────────────────────────
//
// Validación de geopoints, fórmula Haversine en SQL, bounding box.
// Sin dependencias externas — SQL puro en PostgreSQL.

const EARTH_RADIUS_KM = 6371;

/**
 * Valida un geopoint { lat, lng }.
 */
function validateGeopoint(lat, lng) {
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (isNaN(latitude) || isNaN(longitude)) return { valid: false, error: 'Invalid coordinates' };
  if (latitude < -90 || latitude > 90) return { valid: false, error: 'Latitude must be between -90 and 90' };
  if (longitude < -180 || longitude > 180) return { valid: false, error: 'Longitude must be between -180 and 180' };
  return { valid: true, lat: latitude, lng: longitude };
}

/**
 * Haversine distance en SQL para usar directamente en queries.
 * Retorna la expresión SQL que calcula distance_km.
 *
 * @param {number} latParam - Índice del parámetro $N para lat origen
 * @param {number} lngParam - Índice del parámetro $N para lng origen
 * @param {string} latCol   - Columna SQL de lat destino (e.g. "(data->>'_lat')::float")
 * @param {string} lngCol   - Columna SQL de lng destino
 * @returns {string} expresión SQL
 */
function haversineSql(latParam, lngParam, latCol, lngCol) {
  return `6371 * 2 * ASIN(SQRT(
    POWER(SIN(RADIANS($${latParam}::float - ${latCol}) / 2)), 2) +
    COS(RADIANS($${latParam}::float)) * COS(RADIANS(${latCol})) *
    POWER(SIN(RADIANS($${lngParam}::float - ${lngCol}) / 2)), 2)
  ))`;
}

/**
 *Bounding box SQL para filtrar antes del Haversine (optimización).
 */
function boundingBoxSql(lat, lng, radiusKm) {
  const latDelta = radiusKm / 111.0;
  const lngDelta = radiusKm / (111.0 * Math.cos((lat * Math.PI) / 180));
  return {
    latMin: lat - latDelta,
    latMax: lat + latDelta,
    lngMin: lng - lngDelta,
    lngMax: lng + lngDelta,
  };
}

/**
 * Haversine distance en JS (para resultados ya obtenidos o cálculos locales).
 */
function haversineDistance(lat1, lng1, lat2, lng2) {
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.asin(Math.sqrt(a));
  return EARTH_RADIUS_KM * c;
}

module.exports = {
  validateGeopoint,
  haversineSql,
  boundingBoxSql,
  haversineDistance,
  EARTH_RADIUS_KM,
};
