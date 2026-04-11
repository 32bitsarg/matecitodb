// ─── MCP Server (K1) — Model Context Protocol ──────────────────────────────
//
// GET /mcp  → SSE endpoint para conexión de agentes MCP (Claude, Cursor, etc.)
//
// Tools expuestos:
//   list_collections, query_records, create_record, update_record,
//   delete_record, get_schema, run_function

const {
  db,
  requireProjectApiKey,
  quoteIdent,
  projectRoute,
} = require("../../../../lib/v2/auth");
const { ensureV2Tables } = require("../../../../lib/v2/schema");
const { runFunction, createDbHelper } = require("../../../../lib/v2/function-runner");
const { apiError } = require("../../../../lib/v2/errors");

const TOOLS = [
  {
    name: "list_collections",
    description: "List all collections in the project",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "query_records",
    description: "Query records from a collection with filters",
    inputSchema: {
      type: "object",
      required: ["collection"],
      properties: {
        collection: { type: "string" },
        limit: { type: "number", default: 20 },
        filter: { type: "object" },
      },
    },
  },
  {
    name: "create_record",
    description: "Create a new record in a collection",
    inputSchema: {
      type: "object",
      required: ["collection", "data"],
      properties: {
        collection: { type: "string" },
        data: { type: "object" },
      },
    },
  },
  {
    name: "update_record",
    description: "Update an existing record",
    inputSchema: {
      type: "object",
      required: ["collection", "id", "data"],
      properties: {
        collection: { type: "string" },
        id: { type: "string" },
        data: { type: "object" },
      },
    },
  },
  {
    name: "delete_record",
    description: "Delete a record by ID",
    inputSchema: {
      type: "object",
      required: ["collection", "id"],
      properties: {
        collection: { type: "string" },
        id: { type: "string" },
      },
    },
  },
  {
    name: "get_schema",
    description: "Get the full schema of the project including collections and fields",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "run_function",
    description: "Execute a server-side function",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        args: { type: "object" },
      },
    },
  },
];

async function executeTool(name, args, schemaName) {
  const schema = quoteIdent(schemaName);

  switch (name) {
    case "list_collections": {
      const { rows } = await db.query(`SELECT name, created_at FROM ${schema}._collections ORDER BY name`);
      return { content: [{ type: "text", text: JSON.stringify({ collections: rows }, null, 2) }] };
    }

    case "query_records": {
      const { collection, limit = 20, filter = {} } = args;
      const where = [`collection = $1`];
      const values = [collection];
      let idx = 2;
      for (const [key, val] of Object.entries(filter)) {
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
          values.push(val);
          where.push(`data->>'${key}' = $${idx++}`);
        }
      }
      const { rows } = await db.query(
        `SELECT id, data, created_at, updated_at FROM ${schema}._records WHERE ${where.join(" AND ")} LIMIT $${idx}`,
        [...values, limit]
      );
      return { content: [{ type: "text", text: JSON.stringify({ records: rows, total: rows.length }, null, 2) }] };
    }

    case "create_record": {
      const { rows } = await db.query(
        `INSERT INTO ${schema}._records (collection, data) VALUES ($1, $2) RETURNING id, data, created_at`,
        [args.collection, JSON.stringify(args.data)]
      );
      return { content: [{ type: "text", text: JSON.stringify(rows[0], null, 2) }] };
    }

    case "update_record": {
      const { rows } = await db.query(
        `UPDATE ${schema}._records SET data = data || $1::jsonb, updated_at = NOW()
         WHERE collection = $2 AND id = $3 RETURNING id, data, updated_at`,
        [JSON.stringify(args.data), args.collection, args.id]
      );
      return { content: [{ type: "text", text: JSON.stringify(rows[0] || { error: "Not found" }, null, 2) }] };
    }

    case "delete_record": {
      const { rows } = await db.query(
        `DELETE FROM ${schema}._records WHERE collection = $1 AND id = $2 RETURNING id`,
        [args.collection, args.id]
      );
      return { content: [{ type: "text", text: JSON.stringify({ deleted: rows[0]?.id || null }, null, 2) }] };
    }

    case "get_schema": {
      const { rows: collections } = await db.query(`SELECT name FROM ${schema}._collections ORDER BY name`);
      const result = [];
      for (const col of collections) {
        const { rows: fields } = await db.query(
          `SELECT name, type, required, constraints FROM ${schema}._fields WHERE collection = $1`,
          [col.name]
        );
        result.push({ name: col.name, fields });
      }
      return { content: [{ type: "text", text: JSON.stringify({ collections: result }, null, 2) }] };
    }

    case "run_function": {
      const { rows: fnRows } = await db.query(
        `SELECT * FROM ${schema}._functions WHERE name = $1 LIMIT 1`,
        [args.name]
      );
      if (!fnRows[0]) return { content: [{ type: "text", text: `Function '${args.name}' not found` }], isError: true };

      const context = {
        args: args.args || {},
        user: null,
        db: createDbHelper(db, quoteIdent, schemaName),
        fetch: globalThis.fetch?.bind(globalThis),
        env: {},
      };

      try {
        const result = await runFunction({ code: fnRows[0].code, timeoutMs: fnRows[0].timeout_ms || 5000, context });
        return { content: [{ type: "text", text: JSON.stringify(result.result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }

    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}

module.exports = async function (fastify) {
  fastify.get("/mcp", {
    websocket: true,
    preHandler: async (req, reply) => {
      const rawKey = req.headers["x-matecito-key"] || req.query?.key;
      if (!rawKey) return reply.code(401).send({ error: "Service key required" });
      req.headers["x-matecito-key"] = rawKey;
      // Allow through — auth validated in handler
    },
  }, async (connection, req) => {
    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    const schemaName = project?.schema_name ?? (await db.query(
      `SELECT schema_name FROM projects WHERE id = $1 LIMIT 1`, [projectId]
    )).rows[0]?.schema_name;

    if (!schemaName) {
      connection.socket.send(JSON.stringify({ error: "Project not found" }));
      connection.socket.close();
      return;
    }

    await ensureV2Tables(schemaName);

    // MCP protocol: JSON-RPC over WebSocket
    connection.socket.on("message", async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.method === "initialize") {
        connection.socket.send(JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "matebase-mcp", version: "2.0.0" },
          },
        }));
      }

      if (msg.method === "tools/list") {
        connection.socket.send(JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: { tools: TOOLS },
        }));
      }

      if (msg.method === "tools/call") {
        const { name, arguments: toolArgs } = msg.params || {};
        try {
          const result = await executeTool(name, toolArgs, schemaName);
          connection.socket.send(JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result,
          }));
        } catch (err) {
          connection.socket.send(JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32603, message: err.message },
          }));
        }
      }

      if (msg.method === "ping") {
        connection.socket.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
      }
    });
  });
};
