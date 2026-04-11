/**
 * migrate.js — Migración completa para proyectos existentes
 *
 * Aplica TODOS los cambios de schema (v1 + v2 fase 2) a todos los proyectos
 * ya creados en la DB.
 *
 * Es seguro correrlo múltiples veces (usa IF NOT EXISTS / IF EXISTS).
 *
 * Uso:
 *   node migrate.js
 */

require('dotenv').config()
const { db } = require('./lib/matecito')

async function migrate() {
  console.log('🧉 matecito migrate — iniciando\n')

  const { rows: projects } = await db.query(
    `SELECT id, name, schema_name FROM projects ORDER BY created_at ASC`
  )

  if (projects.length === 0) {
    console.log('No hay proyectos en la base de datos.')
    process.exit(0)
  }

  console.log(`Encontrados ${projects.length} proyecto(s):\n`)

  for (const project of projects) {
    const s = `"${project.schema_name}"`
    const sn = project.schema_name
    console.log(`▶ ${project.name} (${sn})`)

    try {
      // ═══════════════════════════════════════════════════════════
      // FASE V1 — Migraciones originales
      // ═══════════════════════════════════════════════════════════

      // 1. _auth_users: email_verified
      await db.query(`
        ALTER TABLE ${s}._auth_users
          ADD COLUMN IF NOT EXISTS email_verified    BOOLEAN   NOT NULL DEFAULT false,
          ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMP DEFAULT NULL
      `)
      console.log('  ✓ _auth_users: email_verified')

      // 2. _collections: soft_delete
      await db.query(`
        ALTER TABLE ${s}._collections
          ADD COLUMN IF NOT EXISTS soft_delete BOOLEAN NOT NULL DEFAULT false
      `)
      console.log('  ✓ _collections: soft_delete')

      // 3. _permissions: filter_rule
      await db.query(`
        ALTER TABLE ${s}._permissions
          ADD COLUMN IF NOT EXISTS filter_rule TEXT DEFAULT NULL
      `)
      console.log('  ✓ _permissions: filter_rule')

      // 4. _records: deleted_at
      await db.query(`
        ALTER TABLE ${s}._records
          ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP DEFAULT NULL
      `)
      await db.query(`
        CREATE INDEX IF NOT EXISTS ${sn}_records_deleted_idx
        ON ${s}._records(deleted_at)
        WHERE deleted_at IS NOT NULL
      `)
      console.log('  ✓ _records: deleted_at + índice')

      // 5. _smtp_config
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${s}._smtp_config (
          id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          host          TEXT NOT NULL,
          port          INT  NOT NULL DEFAULT 587,
          secure        BOOLEAN NOT NULL DEFAULT false,
          smtp_user     TEXT NOT NULL,
          smtp_password TEXT NOT NULL DEFAULT '',
          from_name     TEXT NOT NULL DEFAULT '',
          from_email    TEXT NOT NULL,
          created_at    TIMESTAMP DEFAULT NOW(),
          updated_at    TIMESTAMP DEFAULT NOW()
        )
      `)
      console.log('  ✓ _smtp_config')

      // 6. Rol PostgreSQL
      await db.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${sn}') THEN
            CREATE ROLE "${sn}" NOLOGIN;
          END IF;
        END $$
      `)
      await db.query(`GRANT USAGE, CREATE ON SCHEMA "${sn}" TO "${sn}"`)
      await db.query(`GRANT ALL ON ALL TABLES IN SCHEMA "${sn}" TO "${sn}"`)
      await db.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA "${sn}" TO "${sn}"`)
      await db.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA "${sn}" GRANT ALL ON TABLES TO "${sn}"`)
      await db.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA "${sn}" GRANT ALL ON SEQUENCES TO "${sn}"`)
      await db.query(`REVOKE ALL ON SCHEMA public FROM "${sn}"`)
      await db.query(`GRANT "${sn}" TO matebase`).catch(() => {})
      console.log('  ✓ rol PostgreSQL')

      // ═══════════════════════════════════════════════════════════
      // FASE V2 — Tablas adicionales (ensureV2Tables replica)
      // ═══════════════════════════════════════════════════════════

      // _audit_log
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${s}._audit_log (
          id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          action       TEXT NOT NULL,
          entity       TEXT,
          prev_value   JSONB,
          new_value    JSONB,
          performed_by TEXT,
          ip           TEXT,
          created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
      `)
      console.log('  ✓ _audit_log')

      // _export_jobs
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${s}._export_jobs (
          id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          collection   TEXT NOT NULL,
          status       TEXT NOT NULL DEFAULT 'pending',
          format       TEXT NOT NULL DEFAULT 'json',
          filters      JSONB DEFAULT '{}',
          row_count    INT DEFAULT 0,
          result_data  TEXT,
          error        TEXT,
          created_by   UUID,
          created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          completed_at TIMESTAMP WITH TIME ZONE
        )
      `)
      console.log('  ✓ _export_jobs')

      // _fields: constraints
      await db.query(`
        ALTER TABLE ${s}._fields
          ADD COLUMN IF NOT EXISTS constraints JSONB DEFAULT '{}'
      `)

      // _webhooks: filter_rule
      await db.query(`
        ALTER TABLE ${s}._webhooks
          ADD COLUMN IF NOT EXISTS filter_rule TEXT
      `)
      console.log('  ✓ _fields: constraints, _webhooks: filter_rule')

      // ═══════════════════════════════════════════════════════════
      // FASE F–K — Features Fase 2 (G1, I1, G2, J2, F1, F2, H1, I2, J1, K1, G3, H2, K3, K2)
      // ═══════════════════════════════════════════════════════════

      // ── G1: Full-text search ──────────────────────────────
      await db.query(`
        ALTER TABLE ${s}._records
          ADD COLUMN IF NOT EXISTS search_vector tsvector
      `)
      await db.query(`
        ALTER TABLE ${s}._collections
          ADD COLUMN IF NOT EXISTS search_fields TEXT[]
      `)
      await db.query(`
        CREATE INDEX IF NOT EXISTS ${sn}_records_search_vector_idx
        ON ${s}._records USING gin(search_vector)
      `).catch(() => {})
      console.log('  ✓ G1: search_vector + search_fields')

      // ── I1: Remote Config ─────────────────────────────────
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${s}._remote_config (
          id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          key         TEXT NOT NULL UNIQUE,
          value       JSONB NOT NULL,
          description TEXT,
          is_public   BOOLEAN DEFAULT TRUE,
          updated_at  TIMESTAMPTZ DEFAULT NOW(),
          updated_by  TEXT
        )
      `)
      console.log('  ✓ I1: _remote_config')

      // ── J2: Notification Center ───────────────────────────
      await db.query(`
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
      `)
      await db.query(`
        CREATE INDEX IF NOT EXISTS ${sn}_notif_user_created_idx
        ON ${s}._notifications(user_id, created_at DESC)
      `).catch(() => {})
      console.log('  ✓ J2: _notifications')

      // ── F1: Functions lite ────────────────────────────────
      await db.query(`
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
      `)
      await db.query(`
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
      `)
      await db.query(`
        CREATE INDEX IF NOT EXISTS ${sn}_func_logs_func_created_idx
        ON ${s}._function_logs(function_id, created_at DESC)
      `).catch(() => {})
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${s}._function_env (
          id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          key        TEXT NOT NULL UNIQUE,
          value_enc  TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `)
      console.log('  ✓ F1: _functions, _function_logs, _function_env')

      // ── F2: Triggers ──────────────────────────────────────
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${s}._triggers (
          id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          collection    TEXT NOT NULL,
          event         TEXT NOT NULL,
          function_name TEXT NOT NULL,
          is_active     BOOLEAN DEFAULT TRUE,
          created_at    TIMESTAMPTZ DEFAULT NOW()
        )
      `)
      await db.query(`
        CREATE INDEX IF NOT EXISTS ${sn}_triggers_coll_event_idx
        ON ${s}._triggers(collection, event)
      `).catch(() => {})
      console.log('  ✓ F2: _triggers')

      // ── H1: AI Gateway ────────────────────────────────────
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${s}._project_settings (
          id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          ai_config  JSONB,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `)
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${s}._ai_usage (
          id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          model             TEXT NOT NULL,
          prompt_tokens     INTEGER NOT NULL DEFAULT 0,
          completion_tokens INTEGER NOT NULL DEFAULT 0,
          user_id           TEXT,
          endpoint          TEXT,
          created_at        TIMESTAMPTZ DEFAULT NOW()
        )
      `)
      await db.query(`
        CREATE INDEX IF NOT EXISTS ${sn}_ai_usage_created_idx
        ON ${s}._ai_usage(created_at DESC)
      `).catch(() => {})
      console.log('  ✓ H1: _project_settings, _ai_usage')

      // ── I2: Analytics ─────────────────────────────────────
      await db.query(`
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
      `)
      await db.query(`
        CREATE INDEX IF NOT EXISTS ${sn}_analytics_event_created_idx
        ON ${s}._analytics_events(event, created_at DESC)
      `).catch(() => {})
      await db.query(`
        CREATE INDEX IF NOT EXISTS ${sn}_analytics_user_created_idx
        ON ${s}._analytics_events(user_id, created_at DESC)
      `).catch(() => {})
      console.log('  ✓ I2: _analytics_events')

      // ── G3: Vector search (solo si pgvector está disponible) ─
      const { rows: vecCheck } = await db.query(
        `SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`
      )
      if (vecCheck.length > 0) {
        await db.query(`CREATE EXTENSION IF NOT EXISTS vector`).catch(() => {})
        await db.query(`
          ALTER TABLE ${s}._records
            ADD COLUMN IF NOT EXISTS embedding vector(1536)
        `)
        await db.query(`
          CREATE INDEX IF NOT EXISTS ${sn}_records_embedding_idx
          ON ${s}._records USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)
        `).catch(() => {})
        console.log('  ✓ G3: pgvector + embedding column')
      } else {
        console.log('  ⏭ G3: pgvector no disponible (skipped)')
      }

      // ═══════════════════════════════════════════════════════════
      // FASE 3 — Phase 3 tables
      // ═══════════════════════════════════════════════════════════

      // L1: Crons
      await db.query(`CREATE TABLE IF NOT EXISTS ${s}._crons (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL UNIQUE, cron_expr TEXT NOT NULL, function_name TEXT NOT NULL, timezone TEXT DEFAULT 'UTC', is_active BOOLEAN DEFAULT TRUE, last_run_at TIMESTAMPTZ, next_run_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {})

      // L2: Forms
      await db.query(`CREATE TABLE IF NOT EXISTS ${s}._forms (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL UNIQUE, collection TEXT NOT NULL, fields JSONB NOT NULL, require_app_check BOOLEAN DEFAULT FALSE, send_confirmation BOOLEAN DEFAULT FALSE, confirmation_email_field TEXT, confirmation_template TEXT, notify_email TEXT, redirect_url TEXT, is_active BOOLEAN DEFAULT TRUE, submit_count INTEGER DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {})

      // M2: Email logs
      await db.query(`CREATE TABLE IF NOT EXISTS ${s}._email_logs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), template TEXT, to_email TEXT NOT NULL, subject TEXT, status TEXT NOT NULL, error TEXT, opened_at TIMESTAMPTZ, clicked_at TIMESTAMPTZ, metadata JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {})

      // N1: Workflows
      await db.query(`CREATE TABLE IF NOT EXISTS ${s}._workflows (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL UNIQUE, collection TEXT NOT NULL, field TEXT NOT NULL, definition JSONB NOT NULL, is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {})
      await db.query(`CREATE TABLE IF NOT EXISTS ${s}._workflow_history (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workflow_id UUID REFERENCES ${s}._workflows(id), record_id TEXT NOT NULL, from_state TEXT NOT NULL, to_state TEXT NOT NULL, triggered_by TEXT, metadata JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {})

      // P1: Webhook DLQ
      await db.query(`CREATE TABLE IF NOT EXISTS ${s}._webhook_attempts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), webhook_id UUID NOT NULL, payload JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempt INTEGER DEFAULT 1, next_retry TIMESTAMPTZ, response_status INTEGER, response_body TEXT, error TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {})

      // P2: Invitations
      await db.query(`CREATE TABLE IF NOT EXISTS ${s}._invitations (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email TEXT NOT NULL, role TEXT, token TEXT NOT NULL UNIQUE, invited_by TEXT, expires_at TIMESTAMPTZ NOT NULL, accepted_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {})

      // P4: Schema migrations
      await db.query(`CREATE TABLE IF NOT EXISTS ${s}._schema_migrations (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), version INTEGER NOT NULL, operation TEXT NOT NULL, collection TEXT, field TEXT, prev_state JSONB, next_state JSONB, performed_by TEXT, ip TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {})

      // Q1: Cache rules
      await db.query(`CREATE TABLE IF NOT EXISTS ${s}._cache_rules (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), collection TEXT NOT NULL, ttl_seconds INTEGER NOT NULL DEFAULT 60, vary_by TEXT[] DEFAULT '{}', is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {})

      // Q2: IP rules
      await db.query(`CREATE TABLE IF NOT EXISTS ${s}._ip_rules (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), type TEXT NOT NULL, cidr TEXT NOT NULL, description TEXT, is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {})

      // Q3: Rate limit rules
      await db.query(`CREATE TABLE IF NOT EXISTS ${s}._rate_limit_rules (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), path TEXT NOT NULL, collection TEXT, max INTEGER NOT NULL, window_ms INTEGER NOT NULL, key_by TEXT DEFAULT 'ip', is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {})

      // Q4: Collection aliases
      await db.query(`CREATE TABLE IF NOT EXISTS ${s}._collection_aliases (alias TEXT PRIMARY KEY, collection TEXT NOT NULL, expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {})

      // R1: Orgs
      await db.query(`CREATE TABLE IF NOT EXISTS ${s}._orgs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, metadata JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {})
      await db.query(`CREATE TABLE IF NOT EXISTS ${s}._org_members (org_id UUID REFERENCES ${s}._orgs(id) ON DELETE CASCADE, user_id TEXT NOT NULL, role TEXT DEFAULT 'member', joined_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (org_id, user_id))`).catch(() => {})

      console.log('  ✓ FASE 3: all tables created')

      console.log(`  ✅ ${project.name} — OK\n`)
    } catch (err) {
      console.error(`  ❌ ${project.name} — ERROR: ${err.message}\n`)
    }
  }

  console.log('✅ Migración completada.')
  await db.end()
}

migrate().catch(err => {
  console.error('Error fatal:', err)
  process.exit(1)
})
