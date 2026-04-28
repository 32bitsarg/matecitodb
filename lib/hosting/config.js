const path = require("path");

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const DOMAIN = process.env.DOMAIN || "matecito.dev";

module.exports = {
  serviceApiVersion: process.env.HOSTING_SERVICE_API_VERSION || "v1",
  matecitoApiVersion: process.env.HOSTING_MATECITO_API_VERSION || "v2",
  domain: DOMAIN,
  appsSubdomain: process.env.HOSTING_APPS_SUBDOMAIN || `apps.${DOMAIN}`,
  deployHost: process.env.HOSTING_DEPLOY_HOST || `deploy.${DOMAIN}`,
  port: toInt(process.env.HOSTING_PORT, 4100),
  healthHost: process.env.HOSTING_HEALTH_HOST || "127.0.0.1",
  internalHost: process.env.HOSTING_INTERNAL_HOST || "127.0.0.1",
  minPort: toInt(process.env.HOSTING_MIN_PORT, 4600),
  maxPort: toInt(process.env.HOSTING_MAX_PORT, 4999),
  buildsDir: process.env.HOSTING_BUILDS_DIR || path.join(process.cwd(), "tmp", "hosting-builds"),
  runtimeLogDir: process.env.HOSTING_RUNTIME_LOG_DIR || path.join(process.cwd(), "tmp", "hosting-logs"),
  encryptSecret: process.env.HOSTING_ENCRYPTION_KEY || process.env.JWT_SECRET || "",
  dockerBinary: process.env.DOCKER_BIN || "docker",
  gitBinary: process.env.GIT_BIN || "git",
  defaultNodeVersion: process.env.HOSTING_DEFAULT_NODE_VERSION || "20",
  defaultMemoryMb: toInt(process.env.HOSTING_DEFAULT_MEMORY_MB, 512),
  defaultCpuUnits: toInt(process.env.HOSTING_DEFAULT_CPU_UNITS, 50),
  defaultReplicas: 1,
  bootTimeoutMs: toInt(process.env.HOSTING_BOOT_TIMEOUT_MS, 45_000),
  healthcheckPath: process.env.HOSTING_DEFAULT_HEALTHCHECK_PATH || "/",
  outboundNetworkName: process.env.HOSTING_DOCKER_NETWORK || "",
  requestTimeoutMs: toInt(process.env.HOSTING_PROXY_TIMEOUT_MS, 60_000),
  releaseRateLimitWindowMs: toInt(process.env.HOSTING_RELEASE_RATE_LIMIT_WINDOW_MS, 60_000),
  releaseRateLimitMax: toInt(process.env.HOSTING_RELEASE_RATE_LIMIT_MAX, 20),
  ghcrUsername: process.env.HOSTING_GHCR_USERNAME || "",
  ghcrToken: process.env.HOSTING_GHCR_TOKEN || "",
  ghcrRegistry: process.env.HOSTING_GHCR_REGISTRY || "ghcr.io",
  ghcrLoginTtlMs: toInt(process.env.HOSTING_GHCR_LOGIN_TTL_MS, 30 * 60_000),
  cleanupRetainDeployments: toInt(process.env.HOSTING_CLEANUP_RETAIN_DEPLOYMENTS, 3),
  cleanupMaxImageRemovals: toInt(process.env.HOSTING_CLEANUP_MAX_IMAGE_REMOVALS, 10),
};
