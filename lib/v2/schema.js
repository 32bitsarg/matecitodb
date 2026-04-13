// ─── Schema v2 — tablas adicionales por proyecto ──────────────────────────────
//
// Crea las tablas extras que necesita v2 en cada schema de proyecto.
// Se llama de forma lazy: `await ensureV2Tables(schemaName)` cuando se necesita.
// Es idempotente (IF NOT EXISTS en todas las queries).

const db = require("../../db");
const { quoteIdent } = require("../matecito");

// Track schemas ya inicializados para evitar queries repetidos
const _initialized = new Set();

async function ensureV2Tables(schemaName) {
  if (_initialized.has(schemaName)) return;

  const s = quoteIdent(schemaName);

  try {
    // Tabla de audit log para cambios de permisos y operaciones admin
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
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS ${schemaName}_audit_log_created_idx
      ON ${s}._audit_log(created_at DESC)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS ${schemaName}_audit_log_action_idx
      ON ${s}._audit_log(action, created_at DESC)
    `);

    // Tabla de export jobs async
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${s}._export_jobs (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        collection   TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'pending',
        format       TEXT NOT NULL DEFAULT 'json',
        filters      JSONB DEFAULT '{}'::jsonb,
        row_count    INT  DEFAULT 0,
        result_data  TEXT,
        error        TEXT,
        created_by   UUID,
        created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        completed_at TIMESTAMP WITH TIME ZONE
      )
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS ${schemaName}_export_jobs_created_idx
      ON ${s}._export_jobs(created_at DESC)
    `);

    // Agregar columna constraints a _fields si no existe (para v2 field constraints)
    await db.query(`
      ALTER TABLE ${s}._fields
      ADD COLUMN IF NOT EXISTS constraints JSONB DEFAULT '{}'::jsonb
    `).catch(() => {}); // ignora si ya existe

    // Índice parcial mejorado en _records para soft-delete (v2 usa más este patrón)
    await db.query(`
      CREATE INDEX IF NOT EXISTS ${schemaName}_records_collection_deleted_idx
      ON ${s}._records(collection, created_at DESC)
      WHERE deleted_at IS NULL
    `).catch(() => {}); // ignora si ya existe

    // Índice GIN mejorado para full-text search en data (solo si no existe)
    await db.query(`
      CREATE INDEX IF NOT EXISTS ${schemaName}_records_data_gin_idx
      ON ${s}._records USING GIN (data)
    `).catch(() => {}); // puede ya existir del schema v1

    // filter_rule en _webhooks (v2 feature)
    await db.query(`
      ALTER TABLE ${s}._webhooks ADD COLUMN IF NOT EXISTS filter_rule TEXT
    `).catch(() => {});

    // ── Full-text search (G1) ─────────────────────────────────────────────
    // search_vector: columna tsvector para búsqueda full-text
    await db.query(`
      ALTER TABLE ${s}._records ADD COLUMN IF NOT EXISTS search_vector tsvector
    `).catch(() => {});

    // search_fields: qué campos text se indexan en cada colección
    await db.query(`
      ALTER TABLE ${s}._collections ADD COLUMN IF NOT EXISTS search_fields TEXT[]
    `).catch(() => {});

    // GIN index en search_vector
    await db.query(`
      CREATE INDEX IF NOT EXISTS ${schemaName}_records_search_vector_idx
      ON ${s}._records USING gin(search_vector)
    `).catch(() => {});

    // ── Remote Config (I1) ────────────────────────────────────────────────
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
    `).catch(() => {});

    // ── Notification Center (J2) ──────────────────────────────────────────
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
    `).catch(() => {});

    await db.query(`
      CREATE INDEX IF NOT EXISTS ${schemaName}_notif_user_created_idx
      ON ${s}._notifications(user_id, created_at DESC)
    `).catch(() => {});

    // ── Functions & Triggers (F1) ─────────────────────────────────────────
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
    `).catch(() => {});

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
    `).catch(() => {});

    await db.query(`
      CREATE INDEX IF NOT EXISTS ${schemaName}_func_logs_func_created_idx
      ON ${s}._function_logs(function_id, created_at DESC)
    `).catch(() => {});

    await db.query(`
      CREATE TABLE IF NOT EXISTS ${s}._function_env (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key        TEXT NOT NULL UNIQUE,
        value_enc  TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    await db.query(`
      CREATE TABLE IF NOT EXISTS ${s}._triggers (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        collection    TEXT NOT NULL,
        event         TEXT NOT NULL,
        function_name TEXT NOT NULL,
        is_active     BOOLEAN DEFAULT TRUE,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    await db.query(`
      CREATE INDEX IF NOT EXISTS ${schemaName}_triggers_coll_event_idx
      ON ${s}._triggers(collection, event)
    `).catch(() => {});

    // ── AI Gateway (H1) ───────────────────────────────────────────────────
    // Store in _project_settings if it doesn't exist
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${s}._project_settings (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ai_config  JSONB,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

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
    `).catch(() => {});

    await db.query(`
      CREATE INDEX IF NOT EXISTS ${schemaName}_ai_usage_created_idx
      ON ${s}._ai_usage(created_at DESC)
    `).catch(() => {});

    // ── Analytics (I2) ────────────────────────────────────────────────────
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
    `).catch(() => {});

    await db.query(`
      CREATE INDEX IF NOT EXISTS ${schemaName}_analytics_event_created_idx
      ON ${s}._analytics_events(event, created_at DESC)
    `).catch(() => {});

    await db.query(`
      CREATE INDEX IF NOT EXISTS ${schemaName}_analytics_user_created_idx
      ON ${s}._analytics_events(user_id, created_at DESC)
    `).catch(() => {});

    // ═══════════════════════════════════════════════════════════
    // FASE 3 — Phase 3 tables
    // ═══════════════════════════════════════════════════════════

    // L1: Crons
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${s}._crons (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name          TEXT NOT NULL UNIQUE,
        cron_expr     TEXT NOT NULL,
        function_name TEXT NOT NULL,
        timezone      TEXT DEFAULT 'UTC',
        is_active     BOOLEAN DEFAULT TRUE,
        last_run_at   TIMESTAMPTZ,
        next_run_at   TIMESTAMPTZ,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    // L2: Forms
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${s}._forms (
        id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name                   TEXT NOT NULL UNIQUE,
        collection             TEXT NOT NULL,
        fields                 JSONB NOT NULL,
        require_app_check      BOOLEAN DEFAULT FALSE,
        send_confirmation      BOOLEAN DEFAULT FALSE,
        confirmation_email_field TEXT,
        confirmation_template    TEXT,
        notify_email           TEXT,
        redirect_url           TEXT,
        is_active              BOOLEAN DEFAULT TRUE,
        submit_count           INTEGER DEFAULT 0,
        created_at             TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    // M2: Email logs
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${s}._email_logs (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        template     TEXT,
        to_email     TEXT NOT NULL,
        subject      TEXT,
        status       TEXT NOT NULL,
        error        TEXT,
        opened_at    TIMESTAMPTZ,
        clicked_at   TIMESTAMPTZ,
        metadata     JSONB DEFAULT '{}',
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});
    await db.query(`
      CREATE INDEX IF NOT EXISTS ${schemaName}_email_logs_to ON ${s}._email_logs(to_email, created_at DESC)
    `).catch(() => {});

    // N1: Workflows
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${s}._workflows (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name        TEXT NOT NULL UNIQUE,
        collection  TEXT NOT NULL,
        field       TEXT NOT NULL,
        definition  JSONB NOT NULL,
        is_active   BOOLEAN DEFAULT TRUE,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${s}._workflow_history (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workflow_id  UUID REFERENCES ${s}._workflows(id),
        record_id    TEXT NOT NULL,
        from_state   TEXT NOT NULL,
        to_state     TEXT NOT NULL,
        triggered_by TEXT,
        metadata     JSONB DEFAULT '{}',
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    // P1: Webhook attempts (DLQ)
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${s}._webhook_attempts (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        webhook_id      UUID NOT NULL,
        payload         JSONB NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        attempt         INTEGER DEFAULT 1,
        next_retry      TIMESTAMPTZ,
        response_status INTEGER,
        response_body   TEXT,
        error           TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});
    await db.query(`
      CREATE INDEX IF NOT EXISTS ${schemaName}_webhook_attempts_retry
      ON ${s}._webhook_attempts(next_retry) WHERE status = 'pending'
    `).catch(() => {});

    // P2: Invitations
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${s}._invitations (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email       TEXT NOT NULL,
        role        TEXT,
        token       TEXT NOT NULL UNIQUE,
        invited_by  TEXT,
        expires_at  TIMESTAMPTZ NOT NULL,
        accepted_at TIMESTAMPTZ,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    // P3: Data masking — uses _fields.constraints (already exists)

    // P4: Schema migration history
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${s}._schema_migrations (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        version      INTEGER NOT NULL,
        operation    TEXT NOT NULL,
        collection   TEXT,
        field        TEXT,
        prev_state   JSONB,
        next_state   JSONB,
        performed_by TEXT,
        ip           TEXT,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    // Q1: Cache rules
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${s}._cache_rules (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        collection   TEXT NOT NULL,
        ttl_seconds  INTEGER NOT NULL DEFAULT 60,
        vary_by      TEXT[] DEFAULT '{}',
        is_active    BOOLEAN DEFAULT TRUE,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    // Q2: IP rules
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${s}._ip_rules (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        type        TEXT NOT NULL,
        cidr        TEXT NOT NULL,
        description TEXT,
        is_active   BOOLEAN DEFAULT TRUE,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    // Q3: Rate limit rules
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${s}._rate_limit_rules (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        path        TEXT NOT NULL,
        collection  TEXT,
        max         INTEGER NOT NULL,
        window_ms   INTEGER NOT NULL,
        key_by      TEXT DEFAULT 'ip',
        is_active   BOOLEAN DEFAULT TRUE,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    // Q4: Collection aliases
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${s}._collection_aliases (
        alias       TEXT PRIMARY KEY,
        collection  TEXT NOT NULL,
        expires_at  TIMESTAMPTZ,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    // R1: Orgs
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${s}._orgs (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name        TEXT NOT NULL,
        slug        TEXT NOT NULL UNIQUE,
        metadata    JSONB DEFAULT '{}',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${s}._org_members (
        org_id      UUID REFERENCES ${s}._orgs(id) ON DELETE CASCADE,
        user_id     TEXT NOT NULL,
        role        TEXT DEFAULT 'member',
        joined_at   TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (org_id, user_id)
      )
    `).catch(() => {});

    await db.query(`
      CREATE TABLE IF NOT EXISTS ${s}._email_templates (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name        TEXT NOT NULL UNIQUE,
        subject     TEXT NOT NULL DEFAULT '',
        html_body   TEXT NOT NULL DEFAULT '',
        text_body   TEXT,
        variables   TEXT[] DEFAULT '{}',
        is_system   BOOLEAN DEFAULT FALSE,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    _initialized.add(schemaName);
  } catch (err) {
    console.error(`[schema v2] Error ensuring v2 tables for ${schemaName}:`, err.message);
  }
}

// Tracked per-process to avoid repeated CREATE IF NOT EXISTS on every request
const _chatHistoryReady = new Set();

async function ensureChatHistory(schemaName) {
  if (_chatHistoryReady.has(schemaName)) return;
  const s = quoteIdent(schemaName);
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${s}._ai_chat_sessions (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL DEFAULT 'Nuevo chat',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${s}._ai_chat_history (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id TEXT NOT NULL,
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      model      TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});
  await db.query(`
    CREATE INDEX IF NOT EXISTS _ai_chat_history_session_idx
    ON ${s}._ai_chat_history(session_id, created_at ASC)
  `).catch(() => {});
  _chatHistoryReady.add(schemaName);
}

module.exports = { ensureV2Tables, ensureChatHistory };
