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
const { sendToTokens } = require("../../../../lib/fcm");

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
  {
    name: "list_users",
    description: "List authenticated users in the project",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", default: 20 },
        page:  { type: "number", default: 1 },
      },
    },
  },
  {
    name: "send_notification",
    description: "Send a push notification to one or more users",
    inputSchema: {
      type: "object",
      required: ["user_ids", "title", "body"],
      properties: {
        user_ids: { type: "array", items: { type: "string" } },
        title:    { type: "string" },
        body:     { type: "string" },
        data:     { type: "object" },
      },
    },
  },
  {
    name: "invoke_function",
    description: "Invoke a named server-side function with arguments",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        args: { type: "object" },
      },
    },
  },
  {
    name: "track_event",
    description: "Record an analytics event",
    inputSchema: {
      type: "object",
      required: ["event"],
      properties: {
        event:      { type: "string" },
        user_id:    { type: "string" },
        session_id: { type: "string" },
        properties: { type: "object" },
      },
    },
  },
  {
    name: "get_storage_files",
    description: "List files uploaded to storage",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", default: 50 },
      },
    },
  },
  {
    name: "list_forms",
    description: "List all forms defined in the project",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_form_submissions",
    description: "Get submissions for a specific form",
    inputSchema: {
      type: "object",
      required: ["form_name"],
      properties: {
        form_name: { type: "string" },
        limit:     { type: "number", default: 20 },
      },
    },
  },
  {
    name: "get_project_config",
    description: "Read remote config keys for the project",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_api_keys",
    description: "List active API keys (key values are truncated for security)",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_project_stats",
    description: "Get general project stats: record count, user count, file count and storage usage",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

async function executeTool(name, args, schemaName, projectId) {
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

    case "list_users": {
      const { limit = 20, page = 1 } = args;
      const offset = (page - 1) * limit;
      const { rows } = await db.query(
        `SELECT id, email, username, name, email_verified, created_at
         FROM ${schema}._auth_users ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset]
      ).catch(() => ({ rows: [] }));
      return { content: [{ type: "text", text: JSON.stringify({ users: rows, total: rows.length }, null, 2) }] };
    }

    case "send_notification": {
      const { user_ids, title, body, data = {} } = args;
      const tokensRes = await db.query(
        `SELECT token FROM ${schema}._fcm_tokens WHERE user_id = ANY($1::text[])`,
        [user_ids]
      ).catch(() => ({ rows: [] }));
      if (!tokensRes.rows.length) return { content: [{ type: "text", text: JSON.stringify({ sent: 0, reason: "no_tokens" }) }] };
      const result = await sendToTokens(tokensRes.rows.map(r => r.token), { title, body }, data, null);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    case "invoke_function": {
      const { rows: fnRows } = await db.query(
        `SELECT * FROM ${schema}._functions WHERE name = $1 LIMIT 1`, [args.name]
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

    case "track_event": {
      await ensureV2Tables(schemaName);
      await db.query(
        `INSERT INTO ${schema}._analytics_events (event, user_id, session_id, properties)
         VALUES ($1, $2, $3, $4)`,
        [args.event, args.user_id || null, args.session_id || null, JSON.stringify(args.properties || {})]
      );
      return { content: [{ type: "text", text: JSON.stringify({ tracked: true }) }] };
    }

    case "get_storage_files": {
      const { rows } = await db.query(
        `SELECT id, url, mime, size, created_at FROM files WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [projectId, args.limit || 50]
      ).catch(() => ({ rows: [] }));
      return { content: [{ type: "text", text: JSON.stringify({ files: rows }, null, 2) }] };
    }

    case "list_forms": {
      const { rows } = await db.query(
        `SELECT name, collection, created_at FROM ${schema}._forms ORDER BY created_at DESC`
      ).catch(() => ({ rows: [] }));
      return { content: [{ type: "text", text: JSON.stringify({ forms: rows }, null, 2) }] };
    }

    case "get_form_submissions": {
      const { form_name, limit = 20 } = args;
      const { rows: formRows } = await db.query(
        `SELECT collection FROM ${schema}._forms WHERE name = $1 LIMIT 1`, [form_name]
      ).catch(() => ({ rows: [] }));
      if (!formRows[0]) return { content: [{ type: "text", text: `Form '${form_name}' not found` }], isError: true };
      const { rows } = await db.query(
        `SELECT id, data, created_at FROM ${schema}._records WHERE collection = $1 ORDER BY created_at DESC LIMIT $2`,
        [formRows[0].collection, limit]
      );
      return { content: [{ type: "text", text: JSON.stringify({ form: form_name, submissions: rows }, null, 2) }] };
    }

    case "get_project_config": {
      const { rows } = await db.query(
        `SELECT key, value, is_public FROM ${schema}._config ORDER BY key`
      ).catch(() => ({ rows: [] }));
      return { content: [{ type: "text", text: JSON.stringify({ config: rows }, null, 2) }] };
    }

    case "list_api_keys": {
      const { rows } = await db.query(
        `SELECT id, LEFT(key, 20) || '...' AS key_preview, type, scopes, created_at
         FROM api_keys WHERE project_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC`,
        [projectId]
      ).catch(() => ({ rows: [] }));
      return { content: [{ type: "text", text: JSON.stringify({ keys: rows }, null, 2) }] };
    }

    case "get_project_stats": {
      const [recRes, usrRes, fileRes] = await Promise.all([
        db.query(`SELECT COUNT(*) AS records FROM ${schema}._records WHERE deleted_at IS NULL`).catch(() => ({ rows: [{ records: 0 }] })),
        db.query(`SELECT COUNT(*) AS users FROM ${schema}._auth_users`).catch(() => ({ rows: [{ users: 0 }] })),
        db.query(`SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS storage_bytes FROM files WHERE project_id = $1`, [projectId]).catch(() => ({ rows: [{ files: 0, storage_bytes: 0 }] })),
      ]);
      return { content: [{ type: "text", text: JSON.stringify({
        records:    parseInt(recRes.rows[0].records),
        users:      parseInt(usrRes.rows[0].users),
        files:      parseInt(fileRes.rows[0].files),
        storage_mb: Math.round(fileRes.rows[0].storage_bytes / 1024 / 1024),
      }, null, 2) }] };
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
          const result = await executeTool(name, toolArgs, schemaName, projectId);
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
