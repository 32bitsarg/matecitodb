const fs = require("fs");
const { requirePlatformAuth } = require("../../lib/v2/auth");
const { apiError } = require("../../lib/v2/errors");
const repo = require("../../lib/hosting/repository");
const { queueDeployment, checkReleaseRateLimit } = require("../../lib/hosting/runtime");
const config = require("../../lib/hosting/config");

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/;
const DOMAIN_RE = /^(?=.{4,255}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const REPO_URL_RE = /^https:\/\/[^\s]+$/i;
const GH_OWNER_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const GH_REPO_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const IMAGE_REF_RE = /^ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_.-]+:[A-Za-z0-9_.-]{6,128}$/;
const API_PREFIX = `/api/hosting/${config.serviceApiVersion}`;

function route(pathname) {
  return `${API_PREFIX}${pathname}`;
}

function secureEquals(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  return require("crypto").timingSafeEqual(left, right);
}

function buildGithubActionsWorkflow({ app, source, deployTokenMasked }) {
  const branch = source?.branch || app.repo_branch || "main";
  const imageRepo = source?.image_repository || `ghcr.io/${source?.repo_owner || "owner"}/${source?.repo_name || "repo"}`;
  return `name: Matecito Deploy

on:
  push:
    branches: [${branch}]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Login to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}

      - name: Set image tag
        id: meta
        shell: bash
        run: |
          SHORT_SHA="\${GITHUB_SHA::12}"
          echo "image_tag=${imageRepo}:\$SHORT_SHA" >> "\$GITHUB_OUTPUT"

      - name: Build image
        run: |
          docker build -t "\${{ steps.meta.outputs.image_tag }}" .

      - name: Push image
        run: |
          docker push "\${{ steps.meta.outputs.image_tag }}"

      - name: Trigger Matecito release
        env:
          HOSTING_RELEASE_URL: \${{ secrets.MATECITO_HOSTING_RELEASE_URL }}
          HOSTING_DEPLOY_TOKEN: \${{ secrets.MATECITO_HOSTING_DEPLOY_TOKEN }}
        run: |
          curl --fail --show-error --silent \\
            -X POST "\$HOSTING_RELEASE_URL" \\
            -H "Content-Type: application/json" \\
            -H "x-hosting-deploy-token: \$HOSTING_DEPLOY_TOKEN" \\
            -d '{
              "appId": "${app.id}",
              "imageTag": "${imageRepo}:'"\${GITHUB_SHA::12}"'",
              "commitSha": "'"\$GITHUB_SHA"'" ,
              "commitMessage": "'"\$GITHUB_REF_NAME"'" ,
              "commitAuthor": "'"\$GITHUB_ACTOR"'" ,
              "branch": "${branch}",
              "runId": "'"\$GITHUB_RUN_ID"'" ,
              "runNumber": "'"\$GITHUB_RUN_NUMBER"'" ,
              "imageRepository": "${imageRepo}"
            }'

# Required repository secrets:
# MATECITO_HOSTING_RELEASE_URL=${`https://${config.deployHost}/api/hosting/github-actions/release`}
# MATECITO_HOSTING_DEPLOY_TOKEN=${deployTokenMasked || "GENERATE_FROM_DASHBOARD"}
`;
}

module.exports = async function (fastify) {
  fastify.addHook("onRequest", async (req, reply) => {
    const needsPlatformAuth =
      req.raw.url.startsWith(`${API_PREFIX}/`) ||
      req.raw.url === "/api/hosting";
    if (needsPlatformAuth) {
      await requirePlatformAuth(req, reply);
    }
  });

  fastify.addHook("onSend", async (_req, reply, payload) => {
    reply.header("x-hosting-api-version", config.serviceApiVersion);
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    return payload;
  });

  fastify.get(route("/apps"), async (req) => {
    return { apps: await repo.listAppsForUser(req.user.id) };
  });

  fastify.post(route("/apps"), async (req, reply) => {
    const body = req.body || {};
    const name = String(body.name || "").trim();
    const slug = String(body.slug || "").trim().toLowerCase();
    const workspaceId = body.workspaceId;
    const projectId = body.projectId || null;

    if (!name || !SLUG_RE.test(slug)) {
      return apiError(reply, "GEN_001", "Invalid app name or slug");
    }
    if (body.repoUrl && !REPO_URL_RE.test(String(body.repoUrl))) {
      return apiError(reply, "GEN_001", "repoUrl must be https");
    }

    const workspaceRole = await repo.assertWorkspaceAccess(workspaceId, req.user.id);
    if (!workspaceRole) return apiError(reply, "PERM_001");

    if (projectId) {
      const projectRole = await repo.assertProjectAccess(projectId, req.user.id);
      if (!projectRole) return apiError(reply, "PERM_001");
    }

    try {
      const app = await repo.createApp({
        workspaceId,
        projectId,
        userId: req.user.id,
        name,
        slug,
        repoUrl: body.repoUrl,
        repoBranch: body.repoBranch || "main",
        sourceType: body.sourceType || "git",
        rootDir: body.rootDir || "",
        installCommand: body.installCommand || "",
        buildCommand: body.buildCommand || "",
        startCommand: body.startCommand || "npm start",
        healthcheckPath: body.healthcheckPath || "/",
        healthcheckTimeoutMs: body.healthcheckTimeoutMs || config.bootTimeoutMs,
        plan: body.plan || "starter",
        memoryMb: body.memoryMb || config.defaultMemoryMb,
        cpuUnits: body.cpuUnits || config.defaultCpuUnits,
      });
      return reply.code(201).send({ app });
    } catch (err) {
      if (/duplicate key/i.test(err.message)) {
        return apiError(reply, "GEN_004", "App slug or domain already exists");
      }
      req.log.error({ step: "hosting_create_app", error: err.message });
      return apiError(reply, "GEN_002", err.message);
    }
  });

  fastify.get(route("/apps/:appId"), async (req, reply) => {
    const app = await repo.getAppForUser(req.params.appId, req.user.id);
    if (!app) return apiError(reply, "GEN_003", "App not found");
    return { app };
  });

  fastify.patch(route("/apps/:appId"), async (req, reply) => {
    const current = await repo.getAppForUser(req.params.appId, req.user.id);
    if (!current) return apiError(reply, "GEN_003", "App not found");
    const app = await repo.updateApp(req.params.appId, req.user.id, req.body || {});
    return { app };
  });

  fastify.get(route("/apps/:appId/deployments"), async (req, reply) => {
    const app = await repo.getAppForUser(req.params.appId, req.user.id);
    if (!app) return apiError(reply, "GEN_003", "App not found");
    return { deployments: await repo.listDeployments(app.id) };
  });

  fastify.get(route("/apps/:appId/events"), async (req, reply) => {
    const app = await repo.getAppForUser(req.params.appId, req.user.id);
    if (!app) return apiError(reply, "GEN_003", "App not found");
    return { events: await repo.listRuntimeEvents(app.id, 100) };
  });

  fastify.post(route("/apps/:appId/deploy"), async (req, reply) => {
    const app = await repo.getAppForUser(req.params.appId, req.user.id);
    if (!app) return apiError(reply, "GEN_003", "App not found");
    if (!req.body?.imageTag) {
      return apiError(reply, "GEN_001", "imageTag is required; builds are external via GitHub Actions");
    }
    const source = await repo.getSourceConfig(app.id);
    if (!source?.image_repository) {
      return apiError(reply, "GEN_001", "Source config with imageRepository is required");
    }
    if (!String(req.body.imageTag).startsWith(`${source.image_repository}:`) || !IMAGE_REF_RE.test(String(req.body.imageTag))) {
      return apiError(reply, "GEN_001", "imageTag must match the configured GHCR repository");
    }
    const deployment = await repo.createDeploymentWithMetadata(app.id, {
      sourceRef: req.body?.sourceRef || app.repo_branch,
      healthcheckPath: app.healthcheck_path,
      imageTag: req.body.imageTag,
      commitSha: req.body.commitSha || null,
      commitMessage: req.body.commitMessage || null,
      commitAuthor: req.body.commitAuthor || null,
      triggerType: req.body.triggerType || "manual",
      sourceType: "external_build",
      metadata: req.body.metadata || { provider: "github-actions" },
    });
    await repo.updateDeployment(deployment.id, { image_tag: req.body.imageTag });
    queueDeployment(deployment.id, fastify.log);
    return reply.code(202).send({ deployment });
  });

  fastify.get(route("/deployments/:deploymentId"), async (req, reply) => {
    const deployment = await repo.getDeployment(req.params.deploymentId);
    if (!deployment) return apiError(reply, "GEN_003", "Deployment not found");
    const app = await repo.getAppForUser(deployment.app_id, req.user.id);
    if (!app) return apiError(reply, "PERM_001");
    return { deployment };
  });

  fastify.get(route("/deployments/:deploymentId/logs"), async (req, reply) => {
    const deployment = await repo.getDeployment(req.params.deploymentId);
    if (!deployment) return apiError(reply, "GEN_003", "Deployment not found");
    const app = await repo.getAppForUser(deployment.app_id, req.user.id);
    if (!app) return apiError(reply, "PERM_001");

    let runtimeLog = "";
    if (deployment.runtime_log_path && fs.existsSync(deployment.runtime_log_path)) {
      runtimeLog = fs.readFileSync(deployment.runtime_log_path, "utf8");
    }
    return {
      logs: {
        build: deployment.build_log || "",
        runtime: runtimeLog,
      },
    };
  });

  fastify.get(route("/apps/:appId/connection"), async (req, reply) => {
    const app = await repo.getAppForUser(req.params.appId, req.user.id);
    if (!app) return apiError(reply, "GEN_003", "App not found");
    const project = app.project_id ? await repo.getProjectConnectionInfo(app.project_id) : null;
    return {
      connection: {
        linked: Boolean(project),
        app_url: `https://${app.slug}.${config.appsSubdomain}`,
        api_url: `https://api.${config.domain}`,
        api_version: config.matecitoApiVersion,
        project_url: project?.subdomain ? `https://${project.subdomain}.${config.domain}` : null,
        project_id: app.project_id || null,
        anon_key: project?.anon_key || null,
        service_key: project?.service_key || null,
        sdk: {
          package: "matecitodb",
          example: project?.subdomain ? [
            "import { createClient } from 'matecitodb'",
            "",
            `const db = createClient('https://${project.subdomain}.${config.domain}', {`,
            `  apiKey: process.env.MATECITO_ANON_KEY,`,
            `  apiVersion: '${config.matecitoApiVersion}',`,
            "})",
          ].join("\n") : null,
        },
      },
    };
  });

  fastify.get(route("/apps/:appId/source"), async (req, reply) => {
    const app = await repo.getAppForUser(req.params.appId, req.user.id);
    if (!app) return apiError(reply, "GEN_003", "App not found");
    return { source: await repo.getSourceConfig(app.id) };
  });

  fastify.put(route("/apps/:appId/source/github"), async (req, reply) => {
    const app = await repo.getAppForUser(req.params.appId, req.user.id);
    if (!app) return apiError(reply, "GEN_003", "App not found");
    const body = req.body || {};
    const repoOwner = String(body.repoOwner || "").trim();
    const repoName = String(body.repoName || "").trim();
    const branch = String(body.branch || "main").trim();
    const repoUrl = String(body.repoUrl || `https://github.com/${repoOwner}/${repoName}.git`).trim();

    if (!GH_OWNER_RE.test(repoOwner) || !GH_REPO_RE.test(repoName) || !REPO_URL_RE.test(repoUrl)) {
      return apiError(reply, "GEN_001", "Invalid GitHub source config");
    }

    const source = await repo.upsertSourceConfig(app.id, {
      provider: "github",
      repoOwner,
      repoName,
      repoUrl,
      branch,
      rootDir: body.rootDir || app.root_dir || "",
      autoDeploy: body.autoDeploy ?? true,
      installationId: body.installationId || null,
      deployToken: body.deployToken,
      imageRepository: body.imageRepository || `ghcr.io/${repoOwner}/${repoName}`,
      externalBuildUrl: body.externalBuildUrl || null,
    });

    await repo.updateApp(app.id, req.user.id, {
      repoUrl,
      repoBranch: branch,
      rootDir: body.rootDir || app.root_dir || "",
    });

    return { source };
  });

  fastify.post(route("/apps/:appId/source/deploy-token/rotate"), async (req, reply) => {
    const app = await repo.getAppForUser(req.params.appId, req.user.id);
    if (!app) return apiError(reply, "GEN_003", "App not found");
    const source = await repo.getSourceConfig(app.id);
    if (!source) return apiError(reply, "GEN_003", "Source config not found");
    const token = await repo.rotateDeployToken(app.id);
    return { deployToken: token };
  });

  fastify.get(route("/apps/:appId/source/github-actions"), async (req, reply) => {
    const app = await repo.getAppForUser(req.params.appId, req.user.id);
    if (!app) return apiError(reply, "GEN_003", "App not found");
    const source = await repo.getSourceConfigWithSecret(app.id);
    if (!source) return apiError(reply, "GEN_003", "Source config not found");
    const deployToken = repo.getDeployTokenPlain(source);
    return {
      githubActions: {
        releaseUrl: `https://${config.deployHost}/api/hosting/github-actions/release`,
        secrets: {
          MATECITO_HOSTING_RELEASE_URL: `https://${config.deployHost}/api/hosting/github-actions/release`,
          MATECITO_HOSTING_DEPLOY_TOKEN: deployToken || null,
        },
        workflowPath: ".github/workflows/matecito-deploy.yml",
        workflowYaml: buildGithubActionsWorkflow({
          app,
          source,
          deployTokenMasked: deployToken,
        }),
      },
    };
  });

  fastify.get(route("/apps/:appId/env"), async (req, reply) => {
    const app = await repo.getAppForUser(req.params.appId, req.user.id);
    if (!app) return apiError(reply, "GEN_003", "App not found");
    return { env: await repo.listEnvVars(app.id) };
  });

  fastify.put(route("/apps/:appId/env/:key"), async (req, reply) => {
    const app = await repo.getAppForUser(req.params.appId, req.user.id);
    if (!app) return apiError(reply, "GEN_003", "App not found");
    const key = String(req.params.key || "").toUpperCase();
    const value = String(req.body?.value || "");
    const scope = req.body?.scope || "runtime";
    if (!ENV_KEY_RE.test(key)) return apiError(reply, "GEN_001", "Invalid env var key");
    const item = await repo.upsertEnvVar(app.id, key, value, scope);
    return { envVar: item };
  });

  fastify.delete(route("/apps/:appId/env/:key"), async (req, reply) => {
    const app = await repo.getAppForUser(req.params.appId, req.user.id);
    if (!app) return apiError(reply, "GEN_003", "App not found");
    await repo.deleteEnvVar(app.id, String(req.params.key || "").toUpperCase());
    return { ok: true };
  });

  fastify.get(route("/apps/:appId/domains"), async (req, reply) => {
    const app = await repo.getAppForUser(req.params.appId, req.user.id);
    if (!app) return apiError(reply, "GEN_003", "App not found");
    return { domains: await repo.listDomains(app.id) };
  });

  fastify.post(route("/apps/:appId/domains"), async (req, reply) => {
    const app = await repo.getAppForUser(req.params.appId, req.user.id);
    if (!app) return apiError(reply, "GEN_003", "App not found");
    const domain = String(req.body?.domain || "").trim().toLowerCase();
    if (!DOMAIN_RE.test(domain)) return apiError(reply, "GEN_001", "Invalid domain");
    try {
      const item = await repo.addDomain(app.id, domain, "custom");
      return reply.code(201).send({ domain: item });
    } catch (err) {
      if (/duplicate key/i.test(err.message)) return apiError(reply, "GEN_004", "Domain already exists");
      return apiError(reply, "GEN_002", err.message);
    }
  });

  fastify.post("/api/hosting/github-actions/release", async (req, reply) => {
    const body = req.body || {};
    const appId = String(body.appId || "").trim();
    const imageTag = String(body.imageTag || "").trim();
    const commitSha = String(body.commitSha || "").trim();
    const branch = String(body.branch || "main").trim();
    const deployToken = String(req.headers["x-hosting-deploy-token"] || body.deployToken || "").trim();

    if (!appId || !imageTag || !deployToken) {
      return apiError(reply, "GEN_001", "appId, imageTag and deploy token are required");
    }

    const app = await repo.getAppById(appId);
    if (!app) return apiError(reply, "GEN_003", "App not found");
    const source = await repo.getSourceConfigWithSecret(app.id);
    if (!source) return apiError(reply, "GEN_003", "Source config not found");
    const rateLimitKey = `${app.id}:${req.ip}`;
    if (!checkReleaseRateLimit(rateLimitKey)) {
      await repo.recordRuntimeEvent({
        appId: app.id,
        deploymentId: null,
        level: "warn",
        eventType: "release_rate_limited",
        message: "Release request rate limited",
        metadata: { ip: req.ip },
      }).catch(() => {});
      return reply.code(429).send({ error: "Too many release attempts", code: "RATE_001" });
    }

    const expectedToken = repo.getDeployTokenPlain(source);
    if (!expectedToken || !secureEquals(expectedToken, deployToken)) {
      return apiError(reply, "AUTH_001", "Invalid deploy token");
    }
    if (source.branch !== branch) {
      return apiError(reply, "GEN_001", "Branch does not match app source config");
    }
    if (!source.image_repository) {
      return apiError(reply, "GEN_001", "image_repository is not configured for this app");
    }
    if (!imageTag.startsWith(`${source.image_repository}:`) || !IMAGE_REF_RE.test(imageTag)) {
      return apiError(reply, "GEN_001", "imageTag must match the configured GHCR repository");
    }
    if (source.last_seen_commit_sha && commitSha && source.last_seen_commit_sha === commitSha) {
      return reply.code(202).send({ ok: true, skipped: true, reason: "commit already released" });
    }

    const deployment = await repo.createDeploymentWithMetadata(app.id, {
      sourceRef: branch,
      healthcheckPath: app.healthcheck_path,
      imageTag,
      commitSha: commitSha || null,
      commitMessage: body.commitMessage || null,
      commitAuthor: body.commitAuthor || null,
      triggerType: "external_build",
      sourceType: "external_build",
      metadata: {
        provider: "github-actions",
        run_id: body.runId || null,
        run_number: body.runNumber || null,
        image_repository: body.imageRepository || source.image_repository || null,
      },
    });
    await repo.updateDeployment(deployment.id, { image_tag: imageTag });
    if (commitSha) {
      await repo.updateSourceConfigCommit(app.id, commitSha);
    }
    await repo.recordRuntimeEvent({
      appId: app.id,
      deploymentId: deployment.id,
      level: "info",
      eventType: "release_accepted",
      message: "External release accepted",
      metadata: { image_tag: imageTag, branch, commit_sha: commitSha || null, ip: req.ip },
    }).catch(() => {});
    queueDeployment(deployment.id, fastify.log);
    return reply.code(202).send({ deployment });
  });

  fastify.get("/api/hosting", async () => ({
    ok: true,
    latest: config.serviceApiVersion,
    versions: [config.serviceApiVersion],
    prefix: API_PREFIX,
  }));
};
