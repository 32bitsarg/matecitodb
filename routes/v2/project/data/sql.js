const {
  db,
  requireProjectOrPlatformAuth,
  projectRoute,
  quoteIdent,
} = require("../../../../lib/v2/auth");
const { apiError } = require("../../../../lib/v2/errors");

// ─── Reserved table names (auth system owns these) ────────────────────────────

const RESERVED_TABLES = new Set([
  "users", "auth_users", "auth_sessions", "auth_tokens",
  "refresh_tokens", "password_resets", "email_verifications",
]);

const RESERVED_HINTS = {
  users: `La tabla "users" es administrada por el sistema de autenticación de Matecito. ` +
    `Para guardar datos adicionales de un usuario, creá una colección "profiles" con un campo ` +
    `"user_id" (text) que referencia al ID del usuario autenticado.\n\n` +
    `Ejemplo:\n  CREATE TABLE profiles (\n    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),\n` +
    `    user_id TEXT NOT NULL UNIQUE,\n    bio TEXT,\n    avatar_url TEXT,\n` +
    `    created_at TIMESTAMPTZ DEFAULT NOW()\n  );`,
};

// ─── Security patterns (checked against comment-stripped SQL) ─────────────────

const BLOCKED_PATTERNS = [
  { re: /DROP\s+SCHEMA/i,                    msg: "No podés eliminar schemas" },
  { re: /CREATE\s+SCHEMA/i,                  msg: "No podés crear schemas" },
  { re: /ALTER\s+SCHEMA/i,                   msg: "No podés modificar schemas" },
  { re: /information_schema\s*\./i,          msg: "Acceso a information_schema no permitido" },
  { re: /pg_catalog\s*\./i,                  msg: "Acceso a pg_catalog no permitido" },
  { re: /pg_shadow/i,                        msg: "Acceso a pg_shadow no permitido" },
  { re: /pg_roles/i,                         msg: "Acceso a pg_roles no permitido" },
  { re: /proj_[a-z0-9]+\s*\./i,             msg: "No podés acceder a schemas de otros proyectos" },
  { re: /SET\s+search_path/i,               msg: "No podés modificar el search_path" },
  { re: /SET\s+ROLE/i,                       msg: "No podés cambiar el ROLE" },
  { re: /RESET\s+ROLE/i,                     msg: "No podés resetear el ROLE" },
  { re: /SET SESSION/i,                      msg: "No podés modificar la sesión" },
  { re: /CREATE\s+ROLE/i,                    msg: "No podés crear roles" },
  { re: /ALTER\s+ROLE/i,                     msg: "No podés modificar roles" },
  { re: /\bGRANT\s+/i,                       msg: "No podés usar GRANT" },
  { re: /\bREVOKE\s+/i,                      msg: "No podés usar REVOKE" },
  { re: /SUPERUSER/i,                        msg: "No podés usar SUPERUSER" },
  { re: /\bCOPY\b[\s\S]*\b(TO|FROM)\b[\s\S]*'/i, msg: "COPY con archivos no está permitido" },
  { re: /pg_read_file/i,                     msg: "Acceso al filesystem no permitido" },
  { re: /pg_write_file/i,                    msg: "Acceso al filesystem no permitido" },
  { re: /pg_ls_dir/i,                        msg: "Acceso al filesystem no permitido" },
  { re: /CREATE\s+FOREIGN/i,                 msg: "Foreign tables no permitidas" },
  { re: /CREATE\s+EXTENSION/i,               msg: "No podés instalar extensiones" },
  { re: /dblink/i,                           msg: "dblink no está permitido" },
  { re: /postgres_fdw/i,                     msg: "FDW no está permitido" },
  { re: /^\s*TRUNCATE\b/im,                  msg: "TRUNCATE no está permitido" },
  { re: /^\s*UPDATE\s+\S+\s+SET\b(?![\s\S]*\bWHERE\b)/im, msg: "UPDATE sin WHERE no está permitido" },
  { re: /\bpublic\s*\.\s*(users|projects|workspaces|api_keys|refresh_tokens|workspace_members|invites|files)\b/i,
    msg: "No podés acceder a tablas del sistema de la plataforma" },
];

const MAX_ROWS          = 500;
const STATEMENT_TIMEOUT = "30s";

// ─── Strip SQL comments (for pattern checking only) ───────────────────────────

function stripComments(sql) {
  // Remove block comments first, then line comments
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
}

// ─── Split SQL into individual statements ─────────────────────────────────────
// Handles: dollar-quotes, single-quotes, line comments, block comments

function splitStatements(sql) {
  const statements = [];
  let current = "";
  let i = 0;
  const len = sql.length;

  while (i < len) {
    // Line comment — consume until newline
    if (sql[i] === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      if (end === -1) { current += sql.slice(i); i = len; }
      else { current += sql.slice(i, end + 1); i = end + 1; }
      continue;
    }

    // Block comment
    if (sql[i] === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) { current += sql.slice(i); i = len; }
      else { current += sql.slice(i, end + 2); i = end + 2; }
      continue;
    }

    // Dollar-quoted string: $tag$...$tag$
    if (sql[i] === "$") {
      const tagMatch = /^\$([^$]*)\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end !== -1) {
          current += sql.slice(i, end + tag.length);
          i = end + tag.length;
          continue;
        }
      }
    }

    // Single-quoted string
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < len) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") { j++; break; }
        j++;
      }
      current += sql.slice(i, j);
      i = j;
      continue;
    }

    // Statement separator
    if (sql[i] === ";") {
      current += ";";
      const meaningful = stripComments(current).trim();
      if (meaningful && meaningful !== ";") {
        statements.push(current.trim());
      }
      current = "";
      i++;
      continue;
    }

    current += sql[i];
    i++;
  }

  // Last statement without trailing semicolon
  const meaningful = stripComments(current).trim();
  if (meaningful) statements.push(current.trim());

  return statements;
}

// ─── Check a single statement for reserved table names ───────────────────────

function checkReservedTable(sql) {
  const clean = stripComments(sql);
  const match = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?(\w+)["']?/i.exec(clean);
  if (!match) return null;
  const name = match[1].toLowerCase();
  if (!RESERVED_TABLES.has(name)) return null;
  return RESERVED_HINTS[name] ??
    `La tabla "${name}" está reservada por el sistema. Usá un nombre diferente.`;
}

// ─── Check a single statement for blocked patterns ───────────────────────────

function checkBlocked(sql) {
  const clean = stripComments(sql);
  for (const { re, msg } of BLOCKED_PATTERNS) {
    if (re.test(clean)) return msg;
  }
  // DELETE without WHERE (checked on clean sql)
  if (/^\s*DELETE\s+FROM\s+\S+\s*;?\s*$/im.test(clean)) {
    return "DELETE sin WHERE no está permitido";
  }
  // DROP TABLE (without IF EXISTS on internal tables is risky but allowed — blocked if no WHERE context)
  if (/^\s*DROP\s+TABLE\b/i.test(clean)) {
    return "DROP TABLE no está permitido desde el SQL Editor";
  }
  return null;
}

// ─── Route ────────────────────────────────────────────────────────────────────

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
        return reply.code(403).send({ error: "SQL Editor está deshabilitado para este proyecto. Activalo en Ajustes → General.", code: "PERM_002" });
      }
    } else {
      const { rows } = await db.query(
        `SELECT schema_name, sql_enabled FROM projects WHERE id = $1 LIMIT 1`, [projectId]
      );
      if (!rows[0]?.sql_enabled) {
        return reply.code(403).send({ error: "SQL Editor está deshabilitado para este proyecto. Activalo en Ajustes → General.", code: "PERM_002" });
      }
      schemaName = rows[0]?.schema_name;
    }

    if (!schemaName) return apiError(reply, "GEN_003", "Project schema not found");

    const rawSql = String(req.body?.sql || "").trim();
    if (!rawSql) return reply.code(400).send({ error: "sql is required", code: "GEN_002" });

    // Split into individual statements
    const statements = splitStatements(rawSql);
    if (statements.length === 0) {
      return reply.code(400).send({ error: "No se encontraron statements SQL válidos", code: "GEN_002" });
    }

    // Validate all statements before executing any
    for (let idx = 0; idx < statements.length; idx++) {
      const stmt = statements[idx];

      const reservedErr = checkReservedTable(stmt);
      if (reservedErr) {
        return reply.code(403).send({
          error: reservedErr,
          code: "PERM_003",
          statement_index: idx + 1,
          statement_preview: stmt.slice(0, 120),
        });
      }

      const blockedErr = checkBlocked(stmt);
      if (blockedErr) {
        return reply.code(403).send({
          error: blockedErr,
          code: "PERM_002",
          statement_index: idx + 1,
          statement_preview: stmt.slice(0, 120),
        });
      }
    }

    // Get role for this schema
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

      const results = [];
      let lastResult = null;

      for (let idx = 0; idx < statements.length; idx++) {
        const stmt = statements[idx];
        try {
          const result = await client.query(stmt);
          lastResult = result;

          // Auto-sync _collections for CREATE TABLE
          try {
            const s = quoteIdent(schemaName);
            const createMatch = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?(\w+)["']?/i.exec(stripComments(stmt));
            const renameMatch = /\bALTER\s+TABLE\s+["']?(\w+)["']?\s+RENAME\s+TO\s+["']?(\w+)["']?/i.exec(stripComments(stmt));
            if (createMatch && !createMatch[1].startsWith("_")) {
              await db.query(`INSERT INTO ${s}._collections (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [createMatch[1]]);
            } else if (renameMatch) {
              await db.query(`UPDATE ${s}._collections SET name = $1 WHERE name = $2`, [renameMatch[2], renameMatch[1]]);
            }
          } catch { /* non-critical */ }

          results.push({
            index:     idx + 1,
            command:   result.command ?? "",
            row_count: result.rowCount ?? 0,
            ok:        true,
          });
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          return reply.code(400).send({
            error:             err.message,
            code:              "GEN_004",
            statement_index:   idx + 1,
            statement_preview: stmt.slice(0, 200),
            statements_ok:     idx,
          });
        }
      }

      await client.query("COMMIT");

      // Single statement → return familiar format
      if (statements.length === 1 && lastResult) {
        const rows   = lastResult.rows   ?? [];
        const fields = lastResult.fields?.map(f => f.name) ?? [];
        return {
          command:     lastResult.command ?? "",
          fields,
          rows:        rows.slice(0, MAX_ROWS),
          row_count:   lastResult.rowCount ?? rows.length,
          truncated:   rows.length > MAX_ROWS,
          duration_ms: Date.now() - start,
        };
      }

      // Multi-statement → return summary
      return {
        ok:                  true,
        statements_executed: statements.length,
        results,
        duration_ms:         Date.now() - start,
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
          sql: { type: "string", minLength: 1, maxLength: 100000 },
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
