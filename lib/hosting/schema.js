const db = require("../../db");

async function ensureHostingTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.host_apps (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
      project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL,
      owner_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      runtime TEXT NOT NULL DEFAULT 'node',
      repo_url TEXT,
      repo_branch TEXT NOT NULL DEFAULT 'main',
      source_type TEXT NOT NULL DEFAULT 'git',
      root_dir TEXT NOT NULL DEFAULT '',
      install_command TEXT,
      build_command TEXT,
      start_command TEXT,
      healthcheck_path TEXT NOT NULL DEFAULT '/',
      healthcheck_timeout_ms INTEGER NOT NULL DEFAULT 45000,
      plan TEXT NOT NULL DEFAULT 'starter',
      memory_mb INTEGER NOT NULL DEFAULT 512,
      cpu_units INTEGER NOT NULL DEFAULT 50,
      desired_state TEXT NOT NULL DEFAULT 'running',
      active_deployment_id UUID,
      last_deployment_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT host_apps_runtime_check CHECK (runtime IN ('node')),
      CONSTRAINT host_apps_memory_check CHECK (memory_mb BETWEEN 128 AND 2048),
      CONSTRAINT host_apps_cpu_check CHECK (cpu_units BETWEEN 10 AND 200),
      CONSTRAINT host_apps_desired_state_check CHECK (desired_state IN ('running', 'stopped'))
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS public.host_deployments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      app_id UUID NOT NULL REFERENCES public.host_apps(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL DEFAULT 'git',
      source_ref TEXT,
      commit_sha TEXT,
      commit_message TEXT,
      commit_author TEXT,
      trigger_type TEXT NOT NULL DEFAULT 'manual',
      image_tag TEXT,
      container_name TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      target_port INTEGER,
      healthcheck_path TEXT NOT NULL DEFAULT '/',
      build_log TEXT,
      runtime_log_path TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT host_deployments_status_check CHECK (
        status IN ('queued', 'building', 'deploying', 'active', 'failed', 'stopped', 'rolled_back')
      ),
      CONSTRAINT host_deployments_trigger_type_check CHECK (
        trigger_type IN ('manual', 'push', 'redeploy', 'external_build')
      )
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS public.host_domains (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      app_id UUID NOT NULL REFERENCES public.host_apps(id) ON DELETE CASCADE,
      domain TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL DEFAULT 'generated',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      verified_at TIMESTAMPTZ,
      CONSTRAINT host_domains_kind_check CHECK (kind IN ('generated', 'custom')),
      CONSTRAINT host_domains_status_check CHECK (status IN ('pending', 'active', 'disabled'))
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS public.host_env_vars (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      app_id UUID NOT NULL REFERENCES public.host_apps(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value_encrypted TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'runtime',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(app_id, key),
      CONSTRAINT host_env_vars_scope_check CHECK (scope IN ('build', 'runtime', 'all'))
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS public.host_source_configs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      app_id UUID NOT NULL UNIQUE REFERENCES public.host_apps(id) ON DELETE CASCADE,
      provider TEXT NOT NULL DEFAULT 'github',
      repo_owner TEXT NOT NULL,
      repo_name TEXT NOT NULL,
      repo_url TEXT NOT NULL,
      branch TEXT NOT NULL DEFAULT 'main',
      root_dir TEXT NOT NULL DEFAULT '',
      auto_deploy BOOLEAN NOT NULL DEFAULT TRUE,
      installation_id TEXT,
      webhook_secret_encrypted TEXT,
      deploy_token_encrypted TEXT,
      image_repository TEXT,
      external_build_url TEXT,
      last_seen_commit_sha TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT host_source_configs_provider_check CHECK (provider IN ('github'))
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS public.host_webhook_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider TEXT NOT NULL,
      delivery_id TEXT,
      event_name TEXT NOT NULL,
      repo_owner TEXT,
      repo_name TEXT,
      branch TEXT,
      commit_sha TEXT,
      accepted BOOLEAN NOT NULL DEFAULT FALSE,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS public.host_runtime_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      app_id UUID REFERENCES public.host_apps(id) ON DELETE CASCADE,
      deployment_id UUID REFERENCES public.host_deployments(id) ON DELETE CASCADE,
      level TEXT NOT NULL DEFAULT 'info',
      event_type TEXT NOT NULL,
      message TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT host_runtime_events_level_check CHECK (level IN ('info', 'warn', 'error'))
    )
  `);

  await db.query(`
    ALTER TABLE public.host_apps
    ADD CONSTRAINT host_apps_active_deployment_fk
    FOREIGN KEY (active_deployment_id) REFERENCES public.host_deployments(id) ON DELETE SET NULL
  `).catch(() => {});

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_host_apps_workspace_id ON public.host_apps(workspace_id)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_host_apps_project_id ON public.host_apps(project_id)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_host_deployments_app_id ON public.host_deployments(app_id, created_at DESC)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_host_domains_app_id ON public.host_domains(app_id)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_host_source_configs_repo ON public.host_source_configs(provider, repo_owner, repo_name, branch)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_host_webhook_events_repo ON public.host_webhook_events(provider, repo_owner, repo_name, branch, created_at DESC)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_host_runtime_events_app ON public.host_runtime_events(app_id, created_at DESC)
  `);
}

module.exports = {
  ensureHostingTables,
};
