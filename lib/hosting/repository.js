const db = require("../../db");
const config = require("./config");
const { decryptSecret, encryptSecret } = require("./crypto");
const { generateToken } = require("../v2/auth");

function normalizeApp(row) {
  if (!row) return null;
  return {
    ...row,
    domains: row.domains || [],
  };
}

async function assertWorkspaceAccess(workspaceId, userId) {
  const { rows } = await db.query(
    `SELECT role FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2 LIMIT 1`,
    [workspaceId, userId]
  );
  return rows[0]?.role || null;
}

async function assertProjectAccess(projectId, userId) {
  const { rows } = await db.query(
    `SELECT wm.role
     FROM public.projects p
     JOIN public.workspace_members wm ON wm.workspace_id = p.workspace_id
     WHERE p.id = $1 AND wm.user_id = $2
     LIMIT 1`,
    [projectId, userId]
  );
  return rows[0]?.role || null;
}

async function listAppsForUser(userId) {
  const { rows } = await db.query(
    `SELECT a.*, p.subdomain AS project_subdomain,
            COALESCE(
              json_agg(
                json_build_object('domain', d.domain, 'kind', d.kind, 'status', d.status)
              ) FILTER (WHERE d.id IS NOT NULL),
              '[]'::json
            ) AS domains
     FROM public.host_apps a
     JOIN public.workspace_members wm ON wm.workspace_id = a.workspace_id AND wm.user_id = $1
     LEFT JOIN public.projects p ON p.id = a.project_id
     LEFT JOIN public.host_domains d ON d.app_id = a.id
     GROUP BY a.id
     ORDER BY a.created_at DESC`,
    [userId]
  );
  return rows.map(normalizeApp);
}

async function getAppForUser(appId, userId) {
  const { rows } = await db.query(
    `SELECT a.*, p.subdomain AS project_subdomain,
            COALESCE(
              json_agg(
                json_build_object('id', d.id, 'domain', d.domain, 'kind', d.kind, 'status', d.status)
              ) FILTER (WHERE d.id IS NOT NULL),
              '[]'::json
            ) AS domains
     FROM public.host_apps a
     JOIN public.workspace_members wm ON wm.workspace_id = a.workspace_id AND wm.user_id = $2
     LEFT JOIN public.projects p ON p.id = a.project_id
     LEFT JOIN public.host_domains d ON d.app_id = a.id
     WHERE a.id = $1
     GROUP BY a.id
     LIMIT 1`,
    [appId, userId]
  );
  return normalizeApp(rows[0]);
}

async function createApp({
  workspaceId,
  projectId,
  userId,
  name,
  slug,
  repoUrl,
  repoBranch,
  sourceType,
  rootDir,
  installCommand,
  buildCommand,
  startCommand,
  healthcheckPath,
  healthcheckTimeoutMs,
  plan,
  memoryMb,
  cpuUnits,
}) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const insert = await client.query(
      `INSERT INTO public.host_apps
        (workspace_id, project_id, owner_user_id, name, slug, repo_url, repo_branch, source_type, root_dir,
         install_command, build_command, start_command, healthcheck_path, healthcheck_timeout_ms, plan, memory_mb, cpu_units)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'main'), COALESCE($8, 'git'), COALESCE($9, ''),
               NULLIF($10, ''), NULLIF($11, ''), NULLIF($12, ''), COALESCE(NULLIF($13, ''), '/'),
               COALESCE($14, 45000), COALESCE($15, 'starter'), COALESCE($16, $17), COALESCE($18, $19))
       RETURNING *`,
      [
        workspaceId,
        projectId || null,
        userId,
        name,
        slug,
        repoUrl || null,
        repoBranch || "main",
        sourceType || "git",
        rootDir || "",
        installCommand || null,
        buildCommand || null,
        startCommand || null,
        healthcheckPath || "/",
        healthcheckTimeoutMs || config.bootTimeoutMs,
        plan || "starter",
        memoryMb || config.defaultMemoryMb,
        config.defaultMemoryMb,
        cpuUnits || config.defaultCpuUnits,
        config.defaultCpuUnits,
      ]
    );

    const defaultDomain = `${slug}.${config.appsSubdomain}`;
    await client.query(
      `INSERT INTO public.host_domains (app_id, domain, kind, status, verified_at)
       VALUES ($1, $2, 'generated', 'active', NOW())`,
      [insert.rows[0].id, defaultDomain]
    );
    await client.query("COMMIT");
    return getAppById(insert.rows[0].id);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function updateApp(appId, userId, patch) {
  const fields = [];
  const values = [];
  let idx = 1;

  const allowed = {
    name: "name",
    repoUrl: "repo_url",
    repoBranch: "repo_branch",
    rootDir: "root_dir",
    installCommand: "install_command",
    buildCommand: "build_command",
    startCommand: "start_command",
    healthcheckPath: "healthcheck_path",
    healthcheckTimeoutMs: "healthcheck_timeout_ms",
    plan: "plan",
    memoryMb: "memory_mb",
    cpuUnits: "cpu_units",
    desiredState: "desired_state",
    projectId: "project_id",
  };

  for (const [key, column] of Object.entries(allowed)) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      fields.push(`${column} = $${idx++}`);
      values.push(patch[key] === "" ? null : patch[key]);
    }
  }

  if (!fields.length) return getAppForUser(appId, userId);

  values.push(appId, userId);
  await db.query(
    `UPDATE public.host_apps a
     SET ${fields.join(", ")}, updated_at = NOW()
     WHERE a.id = $${idx++}
       AND EXISTS (
         SELECT 1 FROM public.workspace_members wm
         WHERE wm.workspace_id = a.workspace_id AND wm.user_id = $${idx}
       )`,
    values
  );
  return getAppForUser(appId, userId);
}

async function getAppById(appId) {
  const { rows } = await db.query(
    `SELECT a.*, p.subdomain AS project_subdomain,
            COALESCE(
              json_agg(
                json_build_object('id', d.id, 'domain', d.domain, 'kind', d.kind, 'status', d.status)
              ) FILTER (WHERE d.id IS NOT NULL),
              '[]'::json
            ) AS domains
     FROM public.host_apps a
     LEFT JOIN public.projects p ON p.id = a.project_id
     LEFT JOIN public.host_domains d ON d.app_id = a.id
     WHERE a.id = $1
     GROUP BY a.id
     LIMIT 1`,
    [appId]
  );
  return normalizeApp(rows[0]);
}

async function createDeployment(appId, sourceRef, healthcheckPath) {
  return createDeploymentWithMetadata(appId, {
    sourceRef,
    healthcheckPath,
  });
}

async function createDeploymentWithMetadata(appId, opts = {}) {
  const { rows } = await db.query(
    `INSERT INTO public.host_deployments
      (app_id, source_ref, healthcheck_path, status, commit_sha, commit_message, commit_author, trigger_type, source_type, metadata)
     VALUES (
       $1, $2, COALESCE(NULLIF($3, ''), '/'), 'queued',
       $4, $5, $6, COALESCE($7, 'manual'), COALESCE($8, 'git'), COALESCE($9, '{}'::jsonb)
     )
     RETURNING *`,
    [
      appId,
      opts.sourceRef || null,
      opts.healthcheckPath || "/",
      opts.commitSha || null,
      opts.commitMessage || null,
      opts.commitAuthor || null,
      opts.triggerType || "manual",
      opts.sourceType || "git",
      JSON.stringify(opts.metadata || {}),
    ]
  );
  return rows[0];
}

async function listDeployments(appId) {
  const { rows } = await db.query(
    `SELECT * FROM public.host_deployments WHERE app_id = $1 ORDER BY created_at DESC`,
    [appId]
  );
  return rows;
}

async function listOldDeployments(appId, retain = 3) {
  const keep = Math.max(Number(retain) || 3, 1);
  const { rows } = await db.query(
    `SELECT *
     FROM public.host_deployments
     WHERE app_id = $1
     ORDER BY created_at DESC
     OFFSET $2`,
    [appId, keep]
  );
  return rows;
}

async function getDeployment(deploymentId) {
  const { rows } = await db.query(
    `SELECT d.*, a.slug, a.name AS app_name, a.workspace_id, a.project_id, a.memory_mb, a.cpu_units,
            a.install_command, a.build_command, a.start_command, a.repo_url, a.repo_branch, a.root_dir,
            a.healthcheck_timeout_ms, p.subdomain AS project_subdomain
     FROM public.host_deployments d
     JOIN public.host_apps a ON a.id = d.app_id
     LEFT JOIN public.projects p ON p.id = a.project_id
     WHERE d.id = $1
     LIMIT 1`,
    [deploymentId]
  );
  return rows[0] || null;
}

async function getProjectConnectionInfo(projectId) {
  if (!projectId) return null;
  const { rows } = await db.query(
    `SELECT p.id, p.name, p.subdomain,
            MAX(CASE WHEN k.type = 'anon' AND k.revoked_at IS NULL THEN k.key END) AS anon_key,
            MAX(CASE WHEN k.type = 'service' AND k.revoked_at IS NULL THEN k.key END) AS service_key
     FROM public.projects p
     LEFT JOIN public.api_keys k ON k.project_id = p.id
     WHERE p.id = $1
     GROUP BY p.id
     LIMIT 1`,
    [projectId]
  );
  return rows[0] || null;
}

async function updateDeployment(deploymentId, patch) {
  const fields = [];
  const values = [];
  let idx = 1;
  for (const [key, value] of Object.entries(patch)) {
    fields.push(`${key} = $${idx++}`);
    values.push(value);
  }
  if (!fields.length) return getDeployment(deploymentId);
  values.push(deploymentId);
  await db.query(
    `UPDATE public.host_deployments SET ${fields.join(", ")}, updated_at = NOW() WHERE id = $${idx}`,
    values
  );
  return getDeployment(deploymentId);
}

async function markDeploymentActive(appId, deploymentId) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE public.host_deployments
       SET status = CASE WHEN id = $2 THEN 'active' ELSE 'stopped' END,
           finished_at = CASE WHEN id = $2 THEN NOW() ELSE finished_at END,
           updated_at = NOW()
       WHERE app_id = $1 AND status IN ('active', 'deploying', 'stopped')`,
      [appId, deploymentId]
    );
    await client.query(
      `UPDATE public.host_apps
       SET active_deployment_id = $2, last_deployment_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [appId, deploymentId]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function findAppByDomain(hostname) {
  const { rows } = await db.query(
    `SELECT a.*, d.domain, dep.target_port, dep.id AS deployment_id, dep.container_name
     FROM public.host_domains d
     JOIN public.host_apps a ON a.id = d.app_id
     LEFT JOIN public.host_deployments dep ON dep.id = a.active_deployment_id
     WHERE d.domain = $1 AND d.status = 'active'
     LIMIT 1`,
    [hostname]
  );
  return rows[0] || null;
}

async function listEnvVars(appId) {
  const { rows } = await db.query(
    `SELECT id, app_id, key, scope, created_at, updated_at FROM public.host_env_vars WHERE app_id = $1 ORDER BY key ASC`,
    [appId]
  );
  return rows;
}

async function getDecryptedEnvVars(appId, scope = "runtime") {
  const { rows } = await db.query(
    `SELECT key, value_encrypted, scope FROM public.host_env_vars
     WHERE app_id = $1
       AND (scope = $2 OR scope = 'all' OR $2 = 'all')
     ORDER BY key ASC`,
    [appId, scope]
  );
  return rows.reduce((acc, row) => {
    acc[row.key] = decryptSecret(row.value_encrypted);
    return acc;
  }, {});
}

async function upsertEnvVar(appId, key, value, scope) {
  const encrypted = encryptSecret(value);
  const { rows } = await db.query(
    `INSERT INTO public.host_env_vars (app_id, key, value_encrypted, scope)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (app_id, key)
     DO UPDATE SET value_encrypted = EXCLUDED.value_encrypted, scope = EXCLUDED.scope, updated_at = NOW()
     RETURNING id, app_id, key, scope, created_at, updated_at`,
    [appId, key, encrypted, scope]
  );
  return rows[0];
}

async function deleteEnvVar(appId, key) {
  await db.query(`DELETE FROM public.host_env_vars WHERE app_id = $1 AND key = $2`, [appId, key]);
}

async function addDomain(appId, domain, kind = "custom") {
  const { rows } = await db.query(
    `INSERT INTO public.host_domains (app_id, domain, kind, status)
     VALUES ($1, $2, $3, CASE WHEN $3 = 'generated' THEN 'active' ELSE 'pending' END)
     RETURNING *`,
    [appId, domain, kind]
  );
  return rows[0];
}

async function listDomains(appId) {
  const { rows } = await db.query(
    `SELECT * FROM public.host_domains WHERE app_id = $1 ORDER BY created_at ASC`,
    [appId]
  );
  return rows;
}

async function getSourceConfig(appId) {
  const { rows } = await db.query(
    `SELECT id, app_id, provider, repo_owner, repo_name, repo_url, branch, root_dir, auto_deploy,
            installation_id, image_repository, external_build_url, last_seen_commit_sha, created_at, updated_at
     FROM public.host_source_configs
     WHERE app_id = $1
     LIMIT 1`,
    [appId]
  );
  return rows[0] || null;
}

async function getSourceConfigWithSecret(appId) {
  const { rows } = await db.query(
    `SELECT * FROM public.host_source_configs
     WHERE app_id = $1
     LIMIT 1`,
    [appId]
  );
  return rows[0] || null;
}

async function upsertSourceConfig(appId, config) {
  const secretEncrypted = Object.prototype.hasOwnProperty.call(config, "webhookSecret")
    ? (config.webhookSecret ? encryptSecret(config.webhookSecret) : null)
    : undefined;
  const deployTokenEncrypted = Object.prototype.hasOwnProperty.call(config, "deployToken")
    ? (config.deployToken ? encryptSecret(config.deployToken) : null)
    : undefined;
  const { rows } = await db.query(
    `INSERT INTO public.host_source_configs
      (app_id, provider, repo_owner, repo_name, repo_url, branch, root_dir, auto_deploy, installation_id, webhook_secret_encrypted, deploy_token_encrypted, image_repository, external_build_url)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'main'), COALESCE($7, ''), COALESCE($8, TRUE), $9, $10, $11, $12, $13)
     ON CONFLICT (app_id)
     DO UPDATE SET
       provider = EXCLUDED.provider,
       repo_owner = EXCLUDED.repo_owner,
       repo_name = EXCLUDED.repo_name,
       repo_url = EXCLUDED.repo_url,
       branch = EXCLUDED.branch,
       root_dir = EXCLUDED.root_dir,
       auto_deploy = EXCLUDED.auto_deploy,
       installation_id = EXCLUDED.installation_id,
       webhook_secret_encrypted = COALESCE(EXCLUDED.webhook_secret_encrypted, public.host_source_configs.webhook_secret_encrypted),
       deploy_token_encrypted = COALESCE(EXCLUDED.deploy_token_encrypted, public.host_source_configs.deploy_token_encrypted),
       image_repository = EXCLUDED.image_repository,
       external_build_url = EXCLUDED.external_build_url,
       updated_at = NOW()
     RETURNING id, app_id, provider, repo_owner, repo_name, repo_url, branch, root_dir, auto_deploy,
               installation_id, image_repository, external_build_url, last_seen_commit_sha, created_at, updated_at`,
    [
      appId,
      config.provider || "github",
      config.repoOwner,
      config.repoName,
      config.repoUrl,
      config.branch || "main",
      config.rootDir || "",
      config.autoDeploy ?? true,
      config.installationId || null,
      secretEncrypted === undefined ? null : secretEncrypted,
      deployTokenEncrypted === undefined ? null : deployTokenEncrypted,
      config.imageRepository || null,
      config.externalBuildUrl || null,
    ]
  );
  return rows[0];
}

async function updateSourceConfigCommit(appId, commitSha) {
  await db.query(
    `UPDATE public.host_source_configs
     SET last_seen_commit_sha = $2, updated_at = NOW()
     WHERE app_id = $1`,
    [appId, commitSha]
  );
}

async function findAutoDeployApps(provider, repoOwner, repoName, branch) {
  const { rows } = await db.query(
    `SELECT sc.*, a.healthcheck_path, a.id AS app_id, a.workspace_id, a.project_id, a.repo_url AS app_repo_url
     FROM public.host_source_configs sc
     JOIN public.host_apps a ON a.id = sc.app_id
     WHERE sc.provider = $1
       AND LOWER(sc.repo_owner) = LOWER($2)
       AND LOWER(sc.repo_name) = LOWER($3)
       AND sc.branch = $4
       AND sc.auto_deploy = TRUE`,
    [provider, repoOwner, repoName, branch]
  );
  return rows;
}

async function recordWebhookEvent(event) {
  const { rows } = await db.query(
    `INSERT INTO public.host_webhook_events
      (provider, delivery_id, event_name, repo_owner, repo_name, branch, commit_sha, accepted, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, FALSE), COALESCE($9, '{}'::jsonb))
     RETURNING *`,
    [
      event.provider,
      event.deliveryId || null,
      event.eventName,
      event.repoOwner || null,
      event.repoName || null,
      event.branch || null,
      event.commitSha || null,
      event.accepted ?? false,
      JSON.stringify(event.payload || {}),
    ]
  );
  return rows[0];
}

async function recordRuntimeEvent({ appId, deploymentId, level = "info", eventType, message, metadata = {} }) {
  const { rows } = await db.query(
    `INSERT INTO public.host_runtime_events
      (app_id, deployment_id, level, event_type, message, metadata)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, '{}'::jsonb))
     RETURNING *`,
    [appId || null, deploymentId || null, level, eventType, message || null, JSON.stringify(metadata || {})]
  );
  return rows[0];
}

async function listRuntimeEvents(appId, limit = 50) {
  const { rows } = await db.query(
    `SELECT * FROM public.host_runtime_events
     WHERE app_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [appId, limit]
  );
  return rows;
}

function getWebhookSecretPlain(sourceConfigRow) {
  if (!sourceConfigRow?.webhook_secret_encrypted) return null;
  return decryptSecret(sourceConfigRow.webhook_secret_encrypted);
}

function getDeployTokenPlain(sourceConfigRow) {
  if (!sourceConfigRow?.deploy_token_encrypted) return null;
  return decryptSecret(sourceConfigRow.deploy_token_encrypted);
}

async function rotateDeployToken(appId) {
  const raw = `mdpl_${generateToken(24)}`;
  const encrypted = encryptSecret(raw);
  await db.query(
    `UPDATE public.host_source_configs
     SET deploy_token_encrypted = $2, updated_at = NOW()
     WHERE app_id = $1`,
    [appId, encrypted]
  );
  return raw;
}

module.exports = {
  assertWorkspaceAccess,
  assertProjectAccess,
  listAppsForUser,
  getAppForUser,
  getAppById,
  createApp,
  updateApp,
  createDeployment,
  createDeploymentWithMetadata,
  listDeployments,
  listOldDeployments,
  getDeployment,
  getProjectConnectionInfo,
  updateDeployment,
  markDeploymentActive,
  findAppByDomain,
  listEnvVars,
  getDecryptedEnvVars,
  upsertEnvVar,
  deleteEnvVar,
  addDomain,
  listDomains,
  getSourceConfig,
  getSourceConfigWithSecret,
  upsertSourceConfig,
  updateSourceConfigCommit,
  findAutoDeployApps,
  recordWebhookEvent,
  recordRuntimeEvent,
  listRuntimeEvents,
  getWebhookSecretPlain,
  getDeployTokenPlain,
  rotateDeployToken,
};
