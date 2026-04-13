/**
 * Platform-level migration runner.
 * Tracks applied migrations in a `_platform_migrations` table in the public schema.
 * Each migration is a { id, description, up } object where `up` is an async fn(client).
 */

const { db } = require("../matecito");

const MIGRATIONS = [
  {
    id: "001_ensure_platform_tables",
    description: "Ensure platform-level _platform_migrations tracking table exists",
    up: async (client) => {
      // no-op: table is created by ensureMigrationsTable below
    },
  },
  {
    id: "002_projects_storage_quota_mb",
    description: "Add storage_quota_mb column to projects if missing",
    up: async (client) => {
      await client.query(`
        ALTER TABLE projects
          ADD COLUMN IF NOT EXISTS storage_quota_mb INTEGER NOT NULL DEFAULT 250
      `);
    },
  },
  {
    id: "003_projects_allowed_origins",
    description: "Add allowed_origins column to projects if missing",
    up: async (client) => {
      await client.query(`
        ALTER TABLE projects
          ADD COLUMN IF NOT EXISTS allowed_origins TEXT[] NOT NULL DEFAULT '{}'
      `);
    },
  },
  {
    id: "004_fulltext_search",
    description: "Add full-text search support (search_vector + search_fields)",
    up: async (client) => {
      // Get all project schemas
      const { rows: projects } = await client.query(
        `SELECT schema_name FROM projects WHERE schema_name IS NOT NULL`
      );

      for (const { schema_name } of projects) {
        const s = `"${schema_name}"`;

        // Add search_vector to _records
        await client.query(`
          ALTER TABLE ${s}._records
          ADD COLUMN IF NOT EXISTS search_vector tsvector
        `);

        // Add search_fields to _collections
        await client.query(`
          ALTER TABLE ${s}._collections
          ADD COLUMN IF NOT EXISTS search_fields TEXT[]
        `);

        // Create GIN index on search_vector
        await client.query(`
          CREATE INDEX IF NOT EXISTS ${schema_name}_records_search_vector_idx
          ON ${s}._records USING gin(search_vector)
        `).catch(() => {}); // may already exist
      }
    },
  },
  {
    id: "005_remote_config",
    description: "Add _remote_config table for feature flags",
    up: async (client) => {
      const { rows: projects } = await client.query(
        `SELECT schema_name FROM projects WHERE schema_name IS NOT NULL`
      );

      for (const { schema_name } of projects) {
        const s = `"${schema_name}"`;
        await client.query(`
          CREATE TABLE IF NOT EXISTS ${s}._remote_config (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            key         TEXT NOT NULL UNIQUE,
            value       JSONB NOT NULL,
            description TEXT,
            is_public   BOOLEAN DEFAULT TRUE,
            updated_at  TIMESTAMPTZ DEFAULT NOW(),
            updated_by  TEXT
          )
        `);
      }
    },
  },
  {
    id: "006_notifications",
    description: "Add _notifications table for in-app notifications",
    up: async (client) => {
      const { rows: projects } = await client.query(
        `SELECT schema_name FROM projects WHERE schema_name IS NOT NULL`
      );

      for (const { schema_name } of projects) {
        const s = `"${schema_name}"`;
        await client.query(`
          CREATE TABLE IF NOT EXISTS ${s}._notifications (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id     TEXT NOT NULL,
            title       TEXT NOT NULL,
            body        TEXT,
            type        TEXT DEFAULT 'info',
            data        JSONB DEFAULT '{}',
            read_at     TIMESTAMPTZ,
            created_at  TIMESTAMPTZ DEFAULT NOW()
          )
        `);
        await client.query(`
          CREATE INDEX IF NOT EXISTS ${schema_name}_notif_user_created_idx
          ON ${s}._notifications(user_id, created_at DESC)
        `).catch(() => {});
      }
    },
  },
  {
    id: "007_functions_and_triggers",
    description: "Add _functions, _function_logs, _function_env, _triggers tables",
    up: async (client) => {
      const { rows: projects } = await client.query(
        `SELECT schema_name FROM projects WHERE schema_name IS NOT NULL`
      );

      for (const { schema_name } of projects) {
        const s = `"${schema_name}"`;

        await client.query(`
          CREATE TABLE IF NOT EXISTS ${s}._functions (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            name        TEXT NOT NULL UNIQUE,
            description TEXT,
            code        TEXT NOT NULL,
            timeout_ms  INTEGER DEFAULT 5000,
            is_public   BOOLEAN DEFAULT FALSE,
            created_at  TIMESTAMPTZ DEFAULT NOW(),
            updated_at  TIMESTAMPTZ DEFAULT NOW()
          )
        `);

        await client.query(`
          CREATE TABLE IF NOT EXISTS ${s}._function_logs (
            id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            function_id  UUID REFERENCES ${s}._functions(id) ON DELETE CASCADE,
            status       TEXT NOT NULL,
            duration_ms  INTEGER,
            result       JSONB,
            error        TEXT,
            invoked_by   TEXT,
            created_at   TIMESTAMPTZ DEFAULT NOW()
          )
        `);

        await client.query(`
          CREATE INDEX IF NOT EXISTS ${schema_name}_func_logs_func_created_idx
          ON ${s}._function_logs(function_id, created_at DESC)
        `).catch(() => {});

        await client.query(`
          CREATE TABLE IF NOT EXISTS ${s}._function_env (
            id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            key        TEXT NOT NULL UNIQUE,
            value_enc  TEXT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
          )
        `);

        await client.query(`
          CREATE TABLE IF NOT EXISTS ${s}._triggers (
            id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            collection    TEXT NOT NULL,
            event         TEXT NOT NULL,
            function_name TEXT NOT NULL,
            is_active     BOOLEAN DEFAULT TRUE,
            created_at    TIMESTAMPTZ DEFAULT NOW()
          )
        `);

        await client.query(`
          CREATE INDEX IF NOT EXISTS ${schema_name}_triggers_coll_event_idx
          ON ${s}._triggers(collection, event)
        `).catch(() => {});
      }
    },
  },
  {
    id: "008_ai_and_analytics",
    description: "Add AI Gateway and Analytics tables",
    up: async (client) => {
      const { rows: projects } = await client.query(
        `SELECT schema_name FROM projects WHERE schema_name IS NOT NULL`
      );

      for (const { schema_name } of projects) {
        const s = `"${schema_name}"`;

        // AI config
        await client.query(`
          CREATE TABLE IF NOT EXISTS ${s}._project_settings (
            id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            ai_config  JSONB,
            updated_at TIMESTAMPTZ DEFAULT NOW()
          )
        `);

        await client.query(`
          CREATE TABLE IF NOT EXISTS ${s}._ai_usage (
            id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            model             TEXT NOT NULL,
            prompt_tokens     INTEGER NOT NULL DEFAULT 0,
            completion_tokens INTEGER NOT NULL DEFAULT 0,
            user_id           TEXT,
            endpoint          TEXT,
            created_at        TIMESTAMPTZ DEFAULT NOW()
          )
        `);

        await client.query(`
          CREATE INDEX IF NOT EXISTS ${schema_name}_ai_usage_created_idx
          ON ${s}._ai_usage(created_at DESC)
        `).catch(() => {});

        // Analytics
        await client.query(`
          CREATE TABLE IF NOT EXISTS ${s}._analytics_events (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            event       TEXT NOT NULL,
            user_id     TEXT,
            session_id  TEXT,
            properties  JSONB DEFAULT '{}',
            ip          TEXT,
            user_agent  TEXT,
            created_at  TIMESTAMPTZ DEFAULT NOW()
          )
        `);

        await client.query(`
          CREATE INDEX IF NOT EXISTS ${schema_name}_analytics_event_created_idx
          ON ${s}._analytics_events(event, created_at DESC)
        `).catch(() => {});

        await client.query(`
          CREATE INDEX IF NOT EXISTS ${schema_name}_analytics_user_created_idx
          ON ${s}._analytics_events(user_id, created_at DESC)
        `).catch(() => {});
      }
    },
  },
  {
    id: "010_projects_api_version",
    description: "Add api_version column to projects table (v1 or v2)",
    up: async (client) => {
      await client.query(`
        ALTER TABLE projects
          ADD COLUMN IF NOT EXISTS api_version TEXT NOT NULL DEFAULT 'v1'
      `);
    },
  },
  {
    id: "009_phase3_all_features",
    description: "Phase 3: crons, forms, email_logs, workflows, invitations, schema_migrations, cache_rules, ip_rules, rate_limit_rules, collection_aliases, orgs",
    up: async (client) => {
      const { rows: projects } = await client.query(`SELECT schema_name FROM projects WHERE schema_name IS NOT NULL`);
      for (const { schema_name } of projects) {
        const s = `"${schema_name}"`;
        await client.query(`CREATE TABLE IF NOT EXISTS ${s}._crons (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL UNIQUE, cron_expr TEXT NOT NULL, function_name TEXT NOT NULL, timezone TEXT DEFAULT 'UTC', is_active BOOLEAN DEFAULT TRUE, last_run_at TIMESTAMPTZ, next_run_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {});
        await client.query(`CREATE TABLE IF NOT EXISTS ${s}._forms (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL UNIQUE, collection TEXT NOT NULL, fields JSONB NOT NULL, require_app_check BOOLEAN DEFAULT FALSE, send_confirmation BOOLEAN DEFAULT FALSE, confirmation_email_field TEXT, confirmation_template TEXT, notify_email TEXT, redirect_url TEXT, is_active BOOLEAN DEFAULT TRUE, submit_count INTEGER DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {});
        await client.query(`CREATE TABLE IF NOT EXISTS ${s}._email_logs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), template TEXT, to_email TEXT NOT NULL, subject TEXT, status TEXT NOT NULL, error TEXT, opened_at TIMESTAMPTZ, clicked_at TIMESTAMPTZ, metadata JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {});
        await client.query(`CREATE TABLE IF NOT EXISTS ${s}._workflows (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL UNIQUE, collection TEXT NOT NULL, field TEXT NOT NULL, definition JSONB NOT NULL, is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {});
        await client.query(`CREATE TABLE IF NOT EXISTS ${s}._workflow_history (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workflow_id UUID REFERENCES ${s}._workflows(id), record_id TEXT NOT NULL, from_state TEXT NOT NULL, to_state TEXT NOT NULL, triggered_by TEXT, metadata JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {});
        await client.query(`CREATE TABLE IF NOT EXISTS ${s}._webhook_attempts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), webhook_id UUID NOT NULL, payload JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempt INTEGER DEFAULT 1, next_retry TIMESTAMPTZ, response_status INTEGER, response_body TEXT, error TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {});
        await client.query(`CREATE TABLE IF NOT EXISTS ${s}._invitations (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email TEXT NOT NULL, role TEXT, token TEXT NOT NULL UNIQUE, invited_by TEXT, expires_at TIMESTAMPTZ NOT NULL, accepted_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {});
        await client.query(`CREATE TABLE IF NOT EXISTS ${s}._schema_migrations (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), version INTEGER NOT NULL, operation TEXT NOT NULL, collection TEXT, field TEXT, prev_state JSONB, next_state JSONB, performed_by TEXT, ip TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {});
        await client.query(`CREATE TABLE IF NOT EXISTS ${s}._cache_rules (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), collection TEXT NOT NULL, ttl_seconds INTEGER NOT NULL DEFAULT 60, vary_by TEXT[] DEFAULT '{}', is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {});
        await client.query(`CREATE TABLE IF NOT EXISTS ${s}._ip_rules (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), type TEXT NOT NULL, cidr TEXT NOT NULL, description TEXT, is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {});
        await client.query(`CREATE TABLE IF NOT EXISTS ${s}._rate_limit_rules (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), path TEXT NOT NULL, collection TEXT, max INTEGER NOT NULL, window_ms INTEGER NOT NULL, key_by TEXT DEFAULT 'ip', is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {});
        await client.query(`CREATE TABLE IF NOT EXISTS ${s}._collection_aliases (alias TEXT PRIMARY KEY, collection TEXT NOT NULL, expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {});
        await client.query(`CREATE TABLE IF NOT EXISTS ${s}._orgs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, metadata JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {});
        await client.query(`CREATE TABLE IF NOT EXISTS ${s}._org_members (org_id UUID REFERENCES ${s}._orgs(id) ON DELETE CASCADE, user_id TEXT NOT NULL, role TEXT DEFAULT 'member', joined_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (org_id, user_id))`).catch(() => {});
      }
    },
  },
  {
    id: "010_email_templates",
    description: "Add _email_templates table to all project schemas",
    up: async (client) => {
      const { rows: projects } = await client.query(`SELECT schema_name FROM projects WHERE schema_name IS NOT NULL`);
      for (const { schema_name } of projects) {
        const s = `"${schema_name}"`;
        await client.query(`CREATE TABLE IF NOT EXISTS ${s}._email_templates (
          id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name        TEXT NOT NULL UNIQUE,
          subject     TEXT NOT NULL DEFAULT '',
          html_body   TEXT NOT NULL DEFAULT '',
          text_body   TEXT,
          variables   TEXT[] DEFAULT '{}',
          is_system   BOOLEAN DEFAULT FALSE,
          created_at  TIMESTAMPTZ DEFAULT NOW(),
          updated_at  TIMESTAMPTZ DEFAULT NOW()
        )`).catch(() => {});
      }
    },
  },
];

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _platform_migrations (
      id           TEXT PRIMARY KEY,
      description  TEXT,
      applied_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

/**
 * Run all pending platform migrations.
 * Safe to call on every startup — already-applied migrations are skipped.
 */
async function runMigrations() {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await ensureMigrationsTable(client);

    const { rows } = await client.query("SELECT id FROM _platform_migrations");
    const applied  = new Set(rows.map((r) => r.id));

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.id)) continue;

      console.info(`[migrations] applying: ${migration.id} — ${migration.description}`);
      await migration.up(client);
      await client.query(
        "INSERT INTO _platform_migrations (id, description) VALUES ($1, $2)",
        [migration.id, migration.description]
      );
      console.info(`[migrations] applied:  ${migration.id}`);
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[migrations] FAILED:", err.message);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Returns the list of applied migrations.
 */
async function listMigrations() {
  const { rows } = await db.query(
    "SELECT id, description, applied_at FROM _platform_migrations ORDER BY applied_at"
  );
  return rows;
}

module.exports = { runMigrations, listMigrations };
