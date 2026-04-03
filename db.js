const { Pool } = require("pg");

module.exports = new Pool({
  host:     process.env.DB_HOST     || "localhost",
  port:     Number(process.env.DB_PORT || 5432),
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  max:                20,    // máx conexiones en el pool
  idleTimeoutMillis:  30000, // cierra conexiones idle después de 30s
  connectionTimeoutMillis: 5000, // error si no consigue conexión en 5s
});
