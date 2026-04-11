// ─── Realtime v2 — pg_notify ──────────────────────────────────────────────────
//
// Mejora sobre v1 (EventEmitter in-memory):
//   - Usa pg_notify para propagar eventos entre instancias del servidor
//   - Fallback a EventEmitter in-memory si pg_notify no está disponible
//   - Mismo interface que v1: emitProjectEvent(projectId, event)
//
// Setup: llamar a startRealtimeListener() al inicio del servidor

const { EventEmitter } = require("events");
const { Pool }         = require("pg");

const realtimeBus = new EventEmitter();
realtimeBus.setMaxListeners(0);

const CHANNEL = "mb_project_events";

let _listenerClient = null;
let _listenerActive = false;

/**
 * Inicia el listener de pg_notify.
 * Usa una conexión dedicada (no del pool) para poder hacer LISTEN.
 * Se llama una vez al startup del servidor.
 */
async function startRealtimeListener() {
  if (_listenerActive) return;

  try {
    _listenerClient = new Pool({
      host:     process.env.DB_HOST     || "localhost",
      port:     Number(process.env.DB_PORT || 5432),
      user:     process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      max: 1,
    });

    const client = await _listenerClient.connect();

    await client.query(`LISTEN ${CHANNEL}`);
    _listenerActive = true;

    client.on("notification", (msg) => {
      try {
        const event = JSON.parse(msg.payload);
        realtimeBus.emit(`project:${event.projectId}`, event);
      } catch (err) {
        console.warn("[realtime] Could not parse notification payload:", err.message);
      }
    });

    client.on("error", (err) => {
      console.error("[realtime] Listener client error:", err.message);
      _listenerActive = false;
      // Reintentar en 5 segundos
      setTimeout(startRealtimeListener, 5000);
    });

    console.info("[realtime] pg_notify listener started");
  } catch (err) {
    console.warn("[realtime] Could not start pg_notify listener, using in-memory only:", err.message);
    _listenerActive = false;
  }
}

/**
 * Emite un evento de proyecto.
 * - Siempre emite localmente (EventEmitter) para el mismo proceso
 * - Si pg_notify está activo, notifica a otros procesos/instancias
 */
async function emitProjectEvent(projectId, event) {
  // Emitir localmente (inmediato, sin await)
  realtimeBus.emit(`project:${projectId}`, event);

  // Notificar vía pg_notify para multi-instancia
  if (_listenerActive) {
    try {
      const db      = require("../../db");
      const payload = JSON.stringify({ projectId, ...event });
      // pg_notify tiene un límite de 8000 bytes en el payload
      if (payload.length <= 7900) {
        await db.query(`SELECT pg_notify($1, $2)`, [CHANNEL, payload]);
      }
    } catch (err) {
      console.warn("[realtime] pg_notify failed:", err.message);
    }
  }
}

module.exports = {
  realtimeBus,
  emitProjectEvent,
  startRealtimeListener,
};
