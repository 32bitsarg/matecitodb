const { db, requireProjectOrPlatformAuth, projectRoute, quoteIdent } = require("../../../lib/matecito");

// ─── Patrones bloqueados ──────────────────────────────────────────────────────
//
// Nota: los regex son una capa extra de defensa, pero la seguridad real
// viene del SET ROLE que limita permisos a nivel de postgres.

const BLOCKED_PATTERNS = [
  // Manipulación de schemas
  /DROP\s+SCHEMA/i,
  /CREATE\s+SCHEMA/i,
  /ALTER\s+SCHEMA/i,

  // Acceso directo a schemas del sistema
  /information_schema\s*\./i,
  /pg_catalog\s*\./i,
  /pg_shadow/i,
  /pg_roles/i,

  // Acceso a schemas de otros proyectos
  /proj_[a-z0-9]+\s*\./i,

  // Cambiar el search_path o el rol desde dentro del SQL
  /SET\s+search_path/i,
  /SET\s+ROLE/i,
  /RESET\s+ROLE/i,
  /SET SESSION/i,

  // Escalada de privilegios
  /CREATE\s+ROLE/i,
  /ALTER\s+ROLE/i,
  /GRANT\s+/i,
  /REVOKE\s+/i,
  /SUPERUSER/i,

  // Acceso a archivos del servidor
  /\bCOPY\b[\s\S]*\b(TO|FROM)\b[\s\S]*'/i,
  /pg_read_file/i,
  /pg_write_file/i,
  /pg_ls_dir/i,

  // Conexiones externas
  /CREATE\s+FOREIGN/i,
  /CREATE\s+EXTENSION/i,
  /dblink/i,
  /postgres_fdw/i,

  // Destructivos sin WHERE
  /^\s*DELETE\s+FROM\s+\S+\s*;?\s*$/im,
  /^\s*TRUNCATE\b/i,
  /^\s*DROP\s+TABLE\b/i,
  /^\s*UPDATE\s+\S+\s+SET\b(?![\s\S]*\bWHERE\b)/i,

  // Acceso a la BD general (tabla users de plataforma, projects, etc)
  /\bpublic\s*\.\s*(users|projects|workspaces|api_keys|refresh_tokens|workspace_members|invites|files)\b/i,
];

const MAX_ROWS       = 500;
const STATEMENT_TIMEOUT = "10s";

// Detecta si el SQL contiene DDL para sincronizar _collections después
const DDL_PATTERN = /\b(CREATE|DROP|ALTER)\s+TABLE\b/i;

module.exports = async function (fastify) {
  const handler = async (req, reply) => {
    const project   = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    if (!projectId) {
      return reply.code(400).send({ error: "Project not found" });
    }

    // Obtener schema_name y sql_enabled en una sola query
    let schemaName;
    if (project?.schema_name) {
      schemaName = project.schema_name;

      // Verificar sql_enabled
      const { rows } = await db.query(
        `SELECT sql_enabled FROM projects WHERE id = $1 LIMIT 1`,
        [projectId]
      );
      if (!rows[0]?.sql_enabled) {
        return reply.code(403).send({ error: "SQL endpoint is disabled for this project. Enable it in project settings." });
      }
    } else {
      const { rows } = await db.query(
        `SELECT schema_name, sql_enabled FROM projects WHERE id = $1 LIMIT 1`,
        [projectId]
      );
      if (!rows[0]?.sql_enabled) {
        return reply.code(403).send({ error: "SQL endpoint is disabled for this project. Enable it in project settings." });
      }
      schemaName = rows[0]?.schema_name;
    }

    if (!schemaName) {
      return reply.code(404).send({ error: "Project schema not found" });
    }

    const sql = String(req.body?.sql || "").trim();
    if (!sql) {
      return reply.code(400).send({ error: "sql is required" });
    }

    // ─── Validar patrones bloqueados ─────────────────────────────────────────
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(sql)) {
        return reply.code(403).send({ error: "SQL statement not allowed" });
      }
    }

    // ─── Verificar que el rol del proyecto existe en postgres ────────────────
    // Si no existe todavía (schemas viejos), solo usamos search_path como fallback.
    const roleResult = await db.query(
      `SELECT 1 FROM pg_roles WHERE rolname = $1 LIMIT 1`,
      [schemaName]
    );
    const hasRole = roleResult.rows.length > 0;

    const client = await db.connect();
    const start  = Date.now();

    try {
      // ─── Aislamiento de seguridad ─────────────────────────────────────────
      //
      // 1. Timeout para evitar queries que bloqueen la BD
      await client.query(`SET statement_timeout = '${STATEMENT_TIMEOUT}'`);

      // 2. search_path siempre, independiente del rol
      await client.query(`SET search_path TO ${quoteIdent(schemaName)}`);

      // 3. SET ROLE si el proyecto tiene su rol creado (seguridad real)
      //    Con esto postgres rechaza acceso a otros schemas a nivel de permisos,
      //    no solo por regex.
      if (hasRole) {
        console.log(`[SQL] SET ROLE ${schemaName}`);
        await client.query(`SET ROLE ${quoteIdent(schemaName)}`);
        console.log(`[SQL] SET ROLE OK`);
      }

      console.log(`[SQL] BEGIN`);
      await client.query("BEGIN");
      console.log(`[SQL] executing: ${sql.slice(0, 100)}`);
      const result = await client.query(sql);
      console.log(`[SQL] OK rows=${result.rowCount}`);

      await client.query("COMMIT");

      // ─── Auto-sync _collections si hubo DDL ──────────────────────────────
      if (DDL_PATTERN.test(sql)) {
        try {
          await db.query(`
            INSERT INTO ${quoteIdent(schemaName)}._collections (name)
            SELECT tablename::text
            FROM pg_catalog.pg_tables
            WHERE schemaname = $1
              AND tablename NOT LIKE '\_%'
            ON CONFLICT (name) DO NOTHING
          `, [schemaName]);
        } catch (syncErr) { console.error('[SQL] auto-sync error:', syncErr.message); }
      }

      const duration_ms = Date.now() - start;

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
        duration_ms,
      };

    } catch (err) {
      console.error(`[SQL] ERROR:`, err);
      await client.query("ROLLBACK").catch(() => {});
      return reply.code(400).send({ error: err.message });
    } finally {
      // Siempre resetear rol y timeout antes de devolver la conexión al pool
      await client.query("RESET ROLE").catch(() => {});
      await client.query("RESET statement_timeout").catch(() => {});
      client.release();
    }
  };

  // Rate limit por tipo de auth:
  //   platform JWT (dashboard/devs) → 60/min
  //   service key (backends)        → 30/min
  //   anon/user key o JWT proyecto  → 10/min  (no deberían usar /sql directo)
  projectRoute(fastify, "POST", "/sql", {
    preHandler: requireProjectOrPlatformAuth,
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
