const fs = require("fs");
const path = require("path");
const http = require("http");
const config = require("./config");
const repo = require("./repository");
const { dockerPull, dockerRun, dockerStop, dockerRemoveImage, ensureGhcrLogin, ensureDir } = require("./docker");
const deploymentLocks = new Set();
const appLocks = new Set();
const releaseRateLimiter = new Map();

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sanitizeLog(message) {
  return String(message || "").slice(0, 200_000);
}

async function allocatePort() {
  const { rows } = await require("../../db").query(
    `SELECT target_port FROM public.host_deployments
     WHERE target_port BETWEEN $1 AND $2 AND status IN ('deploying', 'active')`,
    [config.minPort, config.maxPort]
  );
  const used = new Set(rows.map(r => Number(r.target_port)));
  for (let port = config.minPort; port <= config.maxPort; port += 1) {
    if (!used.has(port)) return port;
  }
  throw new Error("No free runtime ports available");
}

async function waitForHealthcheck({ port, pathName, timeoutMs }) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await new Promise(resolve => {
      const client = http.request({
        hostname: config.healthHost,
        port,
        path: pathName || "/",
        method: "GET",
        timeout: 5_000,
      }, res => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 500);
      });
      client.on("error", () => resolve(false));
      client.on("timeout", () => {
        client.destroy();
        resolve(false);
      });
      client.end();
    });

    if (result) return true;
    await delay(1500);
  }
  return false;
}

async function appendRuntimeLog(logPath, chunk) {
  await ensureDir(path.dirname(logPath));
  await fs.promises.appendFile(logPath, `${chunk}\n`, "utf8");
}

function checkReleaseRateLimit(key) {
  const now = Date.now();
  const windowMs = config.releaseRateLimitWindowMs;
  const max = config.releaseRateLimitMax;
  const bucket = releaseRateLimiter.get(key) || [];
  const recent = bucket.filter(ts => now - ts < windowMs);
  if (recent.length >= max) {
    releaseRateLimiter.set(key, recent);
    return false;
  }
  recent.push(now);
  releaseRateLimiter.set(key, recent);
  return true;
}

async function cleanupDeploymentResources(appId, activeDeploymentId) {
  const oldDeployments = await repo.listOldDeployments(appId, config.cleanupRetainDeployments);
  let removed = 0;
  for (const deployment of oldDeployments) {
    if (deployment.id === activeDeploymentId) continue;
    if (deployment.container_name) {
      await dockerStop(deployment.container_name);
    }
    if (deployment.image_tag && removed < config.cleanupMaxImageRemovals) {
      await dockerRemoveImage(deployment.image_tag);
      removed += 1;
    }
  }
}

async function executeDeployment(deploymentId) {
  if (deploymentLocks.has(deploymentId)) {
    throw new Error("Deployment already running");
  }
  deploymentLocks.add(deploymentId);
  const deployment = await repo.getDeployment(deploymentId);
  if (!deployment) throw new Error("Deployment not found");
  const app = await repo.getAppById(deployment.app_id);
  if (appLocks.has(app.id)) {
    deploymentLocks.delete(deploymentId);
    throw new Error("Another deployment is already running for this app");
  }
  appLocks.add(app.id);
  const logPath = path.join(config.runtimeLogDir, `${deployment.id}.log`);

  try {
    await repo.updateDeployment(deploymentId, {
      status: "deploying",
      started_at: new Date(),
      runtime_log_path: logPath,
    });
    if (!deployment.image_tag) throw new Error("image_tag is required; builds must come from GitHub Actions");
    const login = await ensureGhcrLogin().catch(err => {
      throw new Error(`GHCR login failed: ${err.message}`);
    });
    if (!login.skipped) {
      await appendRuntimeLog(logPath, "[release] ghcr login refreshed");
    }
    const pulled = await dockerPull(deployment.image_tag);
    await repo.updateDeployment(deploymentId, {
      build_log: sanitizeLog(pulled.logs),
    });
    await appendRuntimeLog(logPath, `[release] image pulled: ${deployment.image_tag}`);

    const runtimeEnv = await repo.getDecryptedEnvVars(app.id, "runtime");
    const appDomain = `${app.slug}.${config.appsSubdomain}`;
    const projectConnection = app.project_id ? await repo.getProjectConnectionInfo(app.project_id) : null;
    const projectUrl = projectConnection?.subdomain ? `https://${projectConnection.subdomain}.${config.domain}` : "";
    const defaultEnv = {
      NODE_ENV: "production",
      MATECITO_APP_ID: app.id,
      MATECITO_APP_SLUG: app.slug,
      MATECITO_DEPLOYMENT_ID: deploymentId,
      MATECITO_APP_URL: `https://${appDomain}`,
      MATECITO_PROJECT_ID: app.project_id || "",
      MATECITO_PROJECT_URL: projectUrl,
      MATECITO_API_URL: `https://api.${config.domain}`,
      MATECITO_API_VERSION: config.matecitoApiVersion,
    };
    if (projectConnection?.anon_key) {
      defaultEnv.MATECITO_ANON_KEY = projectConnection.anon_key;
    }
    const targetPort = await allocatePort();
    const runResult = await dockerRun({
      app,
      deploymentId,
      imageTag: deployment.image_tag,
      port: targetPort,
      envVars: { ...defaultEnv, ...runtimeEnv },
      logPath,
    });

    await repo.updateDeployment(deploymentId, {
      target_port: targetPort,
      container_name: runResult.containerName,
    });
    await appendRuntimeLog(logPath, `[runtime] container started on port ${targetPort}`);

    const healthy = await waitForHealthcheck({
      port: targetPort,
      pathName: deployment.healthcheck_path || app.healthcheck_path || config.healthcheckPath,
      timeoutMs: app.healthcheck_timeout_ms || config.bootTimeoutMs,
    });

    if (!healthy) {
      await dockerStop(runResult.containerName);
      throw new Error("Healthcheck failed");
    }

    const previous = app.active_deployment_id ? await repo.getDeployment(app.active_deployment_id) : null;
    await repo.markDeploymentActive(app.id, deploymentId);
    if (previous?.container_name && previous.id !== deploymentId) {
      await dockerStop(previous.container_name);
    }
    await cleanupDeploymentResources(app.id, deploymentId).catch(() => {});
    await repo.recordRuntimeEvent({
      appId: app.id,
      deploymentId,
      level: "info",
      eventType: "deployment_promoted",
      message: "Deployment promoted successfully",
      metadata: { image_tag: deployment.image_tag, target_port: targetPort },
    });
    await appendRuntimeLog(logPath, `[runtime] deployment promoted`);
    return await repo.getDeployment(deploymentId);
  } catch (err) {
    await repo.updateDeployment(deploymentId, {
      status: "failed",
      finished_at: new Date(),
      build_log: sanitizeLog(`${deployment.build_log || ""}\n${err.stack || err.message}`),
    });
    await repo.recordRuntimeEvent({
      appId: app.id,
      deploymentId,
      level: "error",
      eventType: err.message.includes("Healthcheck failed") ? "healthcheck_failed" : "deployment_failed",
      message: err.message,
      metadata: { image_tag: deployment.image_tag || null },
    }).catch(() => {});
    await appendRuntimeLog(logPath, `[error] ${err.stack || err.message}`);
    throw err;
  } finally {
    deploymentLocks.delete(deploymentId);
    appLocks.delete(app.id);
  }
}

function queueDeployment(deploymentId, logger = console) {
  setImmediate(async () => {
    try {
      await executeDeployment(deploymentId);
    } catch (err) {
      logger.error({ step: "hosting_deploy_failed", deploymentId, error: err.message });
    }
  });
}

function proxyRequest(request, reply, targetPort) {
  return new Promise((resolve, reject) => {
    const hopByHop = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade"]);
    const headers = {};
    for (const [key, value] of Object.entries(request.headers)) {
      if (!hopByHop.has(String(key).toLowerCase())) headers[key] = value;
    }
    headers.host = request.headers.host;
    headers["x-forwarded-for"] = request.ip;
    headers["x-forwarded-proto"] = request.protocol;
    headers["x-forwarded-host"] = request.headers.host;

    const upstream = http.request({
      hostname: config.internalHost,
      port: targetPort,
      path: request.raw.url,
      method: request.raw.method,
      headers,
      timeout: config.requestTimeoutMs,
    }, upstreamRes => {
      reply.code(upstreamRes.statusCode || 502);
      for (const [header, value] of Object.entries(upstreamRes.headers)) {
        if (hopByHop.has(String(header).toLowerCase())) continue;
        if (value !== undefined) reply.header(header, value);
      }
      upstreamRes.pipe(reply.raw);
      upstreamRes.on("end", resolve);
    });

    upstream.on("timeout", () => {
      upstream.destroy(new Error("Upstream request timed out"));
    });
    upstream.on("error", reject);
    request.raw.pipe(upstream);
  });
}

module.exports = {
  executeDeployment,
  queueDeployment,
  proxyRequest,
  checkReleaseRateLimit,
};
