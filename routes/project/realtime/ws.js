const { db, requireProjectApiKey, projectRoute } = require("../../../lib/matecito");
const { realtimeBus } = require("../../../lib/realtime");

/**
 * WebSocket auth — acepta tres modos:
 * 1. Header x-matecito-key o query ?key=: API key anon/service (apps Node.js / browser con anon)
 * 2. Query ?token=PROJECT_JWT: usuario autenticado de la app
 * 3. Query ?token=PLATFORM_JWT: admin del dashboard
 *
 * Browsers no soportan custom headers en WebSocket, por eso se acepta ?key= y ?token=.
 */
async function wsAuth(req, reply) {
  const projectId = req.params?.projectId ?? req.resolvedProject?.id;

  // Modo 1: API key en header o query param (apps cliente — browsers no soportan headers en WS)
  const rawKey = req.headers["x-matecito-key"] || req.query?.key;
  if (rawKey) {
    // Normalizar: si vino por query param, ponerlo en el mock de header para reusar requireProjectApiKey
    req.headers["x-matecito-key"] = rawKey;
    return requireProjectApiKey(["anon", "service"])(req, reply);
  }

  // Modo 2: JWT en query param — acepta tanto project JWT (app users) como platform JWT (dashboard)
  const token = req.query?.token;
  if (token) {
    try {
      const payload = await req.server.jwt.verify(token);
      if (!payload?.sub) return reply.code(401).send({ error: "Unauthorized" });

      // Project JWT: usuario autenticado de la app
      if (payload.kind === "project") {
        req.wsAuth = { kind: "project", userId: payload.sub, pid: payload.pid };
        return;
      }

      // Platform JWT: admin del dashboard — verificar membresía al workspace
      if (payload.kind === "platform") {
        if (!projectId) return reply.code(400).send({ error: "projectId required" });

        const { rows } = await db.query(
          `SELECT p.id FROM projects p
           JOIN workspace_members wm ON wm.workspace_id = p.workspace_id
           WHERE p.id = $1 AND wm.user_id = $2 LIMIT 1`,
          [projectId, payload.sub]
        );
        if (!rows[0]) return reply.code(403).send({ error: "Forbidden" });

        req.wsAuth = { kind: "platform", userId: payload.sub };
        return;
      }

      return reply.code(401).send({ error: "Unauthorized" });
    } catch {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  }

  return reply.code(401).send({ error: "Authentication required" });
}

module.exports = async function (fastify) {
  const handler = (connection, req) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    const onFilteredEvent = (event) => {
      if (connection.socket.readyState !== 1) return;
      if (connection.subscribedCollection && event.collection !== connection.subscribedCollection) return;
      connection.socket.send(JSON.stringify(event));
    };

    realtimeBus.on(`project:${projectId}`, onFilteredEvent);

    connection.socket.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === "ping")        connection.socket.send(JSON.stringify({ type: "pong" }));
      if (msg.type === "subscribe")   connection.subscribedCollection = msg.collection ?? null;
      if (msg.type === "unsubscribe") connection.subscribedCollection = null;
    });

    connection.socket.on("close", () => {
      realtimeBus.off(`project:${projectId}`, onFilteredEvent);
    });
  };

  projectRoute(fastify, "GET", "/ws", {
    websocket:  true,
    preHandler: wsAuth,
  }, handler);
};
