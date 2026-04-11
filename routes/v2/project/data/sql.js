const {
  db,
  requireProjectOrPlatformAuth,
  projectRoute,
  quoteIdent,
} = require("../../../../lib/v2/auth");
const { apiError } = require("../../../../lib/v2/errors");

const BLOCKED_PATTERNS = [
  /DROP\s+SCHEMA/i,
  /CREATE\s+SCHEMA/i,
  /ALTER\s+SCHEMA/i,
  /information_schema\s*\./i,
  /pg_catalog\s*\./i,
  /pg_shadow/i,
  /pg_roles/i,
  /proj_[a-z0-9]+\s*\./i,
  /SET\s+search_path/i,
  /SET\s+ROLE/i,
  /RESET\s+ROLE/i,
  /SET SESSION/i,
  /CREATE\s+ROLE/i,
  /ALTER\s+ROLE/i,
  /GRANT\s+/i,
  /REVOKE\s+/i,
  /SUPERUSER/i,
  /\bCOPY\b[\s\S]*\b(TO|FROM)\b[\s\S]*'/i,
  /pg_read_file/i,
  /pg_write_file/i,
  /pg_ls_dir/i,
  /CREATE\s+FOREIGN/i,
  /CREATE\s+EXTENSION/i,
  /dblink/i,
  /postgres_fdw/i,
  /^\s*DELETE\s+FROM\s+\S+\s*;?\s*$/im,
  /^\s*TRUNCATE\b/i,
  /^\s*DROP\s+TABLE\b/i,
  /^\s*UPDATE\s+\S+\s+SET\b(?![\s\S]*\bWHERE\b)/i,
  /\bpublic\s*\.\s*(users|projects|workspaces|api_keys|refresh_tokens|workspace_members|invites|files)\b/i,
];

const MAX_ROWS          = 500;
const STATEMENT_TIMEOUT = "10s";

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    if (!projectId) return apiError(reply, "GEN_003", "Project not found");

    let schemaName;
    if (project?.schema_name) {
      schemaName = project.schema_name;
      const { rows } = await db.query(`SELECT sql_enabled FROM projects WHERE id = $1 LIMIT 1`, [projectId]);
      if (!rows[0]?.sql_enabled) {
        return reply.code(403).send({ error: "SQL endpoint is disabled for this project", code: "PERM_002" });
      }
    } else {
      const { rows } = await db.query(
        `SELECT schema_name, sql_enabled FROM projects WHERE id = $1 LIMIT 1`, [projectId]
      );
      if (!rows[0]?.sql_enabled) {
        return reply.code(403).send({ error: "SQL endpoint is disabled for this project", code: "PERM_002" });
      }
      schemaName = rows[0]?.schema_name;
    }

    if (!schemaName) return apiError(reply, "GEN_003", "Project schema not found");

    const sql = String(req.body?.sql || "").trim();
    if (!sql) return reply.code(400).send({ error: "sql is required", code: "GEN_002" });

    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(sql)) {
        return reply.code(403).send({ error: "SQL statement not allowed", code: "PERM_002" });
      }
    }

    const roleResult = await db.query(
      `SELECT 1 FROM pg_roles WHERE rolname = $1 LIMIT 1`, [schemaName]
    );
    const hasRole = roleResult.rows.length > 0;

    const client = await db.connect();
    const start  = Date.now();

    try {
      await client.query(`SET statement_timeout = '${STATEMENT_TIMEOUT}'`);
      await client.query(`SET search_path TO ${quoteIdent(schemaName)}`);
      if (hasRole) await client.query(`SET ROLE ${quoteIdent(schemaName)}`);

      await client.query("BEGIN");
      const result = await client.query(sql);
      await client.query("COMMIT");

      // Auto-sync _collections after DDL
      const createMatch = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?(\w+)["']?/i.exec(sql);
      const dropMatch   = /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["']?(\w+)["']?/i.exec(sql);
      const renameMatch = /\bALTER\s+TABLE\s+["']?(\w+)["']?\s+RENAME\s+TO\s+["']?(\w+)["']?/i.exec(sql);

      try {
        const s = quoteIdent(schemaName);
        if (createMatch) {
          const tbl = createMatch[1];
          if (!tbl.startsWith("_")) {
            await db.query(`INSERT INTO ${s}._collections (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [tbl]);
          }
        } else if (dropMatch) {
          await db.query(`DELETE FROM ${quoteIdent(schemaName)}._collections WHERE name = $1`, [dropMatch[1]]);
        } else if (renameMatch) {
          await db.query(`UPDATE ${quoteIdent(schemaName)}._collections SET name = $1 WHERE name = $2`, [renameMatch[2], renameMatch[1]]);
        }
      } catch { /* auto-sync is non-critical */ }

      const rows     = result.rows    ?? [];
      const fields   = result.fields?.map(f => f.name) ?? [];
      const command  = result.command ?? "";
      const rowCount = result.rowCount ?? rows.length;

      return {
        command,
        fields,
        rows: rows.slice(0, MAX_ROWS),
        row_count: rowCount,
        truncated: rows.length > MAX_ROWS,
        duration_ms: Date.now() - start,
      };

    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      return reply.code(400).send({ error: err.message, code: "GEN_004" });
    } finally {
      await client.query("RESET ROLE").catch(() => {});
      await client.query("RESET statement_timeout").catch(() => {});
      client.release();
    }
  };

  projectRoute(fastify, "POST", "/sql", {
    preHandler: requireProjectOrPlatformAuth,
    schema: {
      body: {
        type: "object",
        required: ["sql"],
        additionalProperties: false,
        properties: {
          sql: { type: "string", minLength: 1, maxLength: 10000 },
        },
      },
    },
    config: {
      rateLimit: {
        max: (req) => {
          if (req.projectUser?._kind === "platform") return 60;
          if (req.projectKey?.type === "service")    return 30;
          return 10;
        },
        timeWindow: "1 minute",
      },
    },
  }, handler);
};
