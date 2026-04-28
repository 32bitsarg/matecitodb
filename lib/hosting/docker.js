const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const config = require("./config");
let ghcrLoginExpiresAt = 0;

function execCommand(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 10 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        return reject(error);
      }
      resolve({ stdout, stderr });
    });
  });
}

function safeSlug(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function buildImageTag(appSlug, deploymentId) {
  return `matecito/${safeSlug(appSlug)}:${String(deploymentId).replace(/[^a-z0-9]/gi, "").slice(0, 12).toLowerCase()}`;
}

function buildContainerName(appSlug, deploymentId) {
  return `matecito-${safeSlug(appSlug)}-${String(deploymentId).replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase()}`;
}

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

async function dockerPull(imageRef) {
  const { stdout, stderr } = await execCommand(config.dockerBinary, ["pull", imageRef]);
  return { logs: [stdout, stderr].filter(Boolean).join("\n") };
}

async function ensureGhcrLogin() {
  const registry = config.ghcrRegistry;
  if (!config.ghcrUsername || !config.ghcrToken) return { ok: false, skipped: true };
  if (Date.now() < ghcrLoginExpiresAt) return { ok: true, cached: true };

  const { stdout, stderr } = await new Promise((resolve, reject) => {
    const child = require("child_process").spawn(
      config.dockerBinary,
      ["login", registry, "-u", config.ghcrUsername, "--password-stdin"],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    let out = "";
    let err = "";
    child.stdout.on("data", chunk => { out += chunk.toString(); });
    child.stderr.on("data", chunk => { err += chunk.toString(); });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) {
        const e = new Error(`docker login failed with code ${code}`);
        e.stdout = out;
        e.stderr = err;
        return reject(e);
      }
      resolve({ stdout: out, stderr: err });
    });
    child.stdin.write(config.ghcrToken);
    child.stdin.end();
  });

  ghcrLoginExpiresAt = Date.now() + config.ghcrLoginTtlMs;
  return { ok: true, stdout, stderr };
}

async function dockerRun({ app, deploymentId, imageTag, port, envVars, logPath }) {
  const containerName = buildContainerName(app.slug, deploymentId);
  const args = [
    "run",
    "-d",
    "--name", containerName,
    "--restart", "unless-stopped",
    "--memory", `${app.memory_mb}m`,
    "--memory-swap", `${app.memory_mb}m`,
    "--cpus", String(Math.max(app.cpu_units / 100, 0.1)),
    "--pids-limit", "256",
    "--read-only",
    "--security-opt", "no-new-privileges:true",
    "--cap-drop", "ALL",
    "--tmpfs", "/tmp:rw,size=64m",
    "--tmpfs", "/app/.next/cache:rw,size=128m",
    "--user", "node",
    "--log-opt", "max-size=10m",
    "--log-opt", "max-file=3",
    "-p", `${config.internalHost}:${port}:3000`,
  ];

  if (config.outboundNetworkName) {
    args.push("--network", config.outboundNetworkName);
  }

  for (const [key, value] of Object.entries(envVars || {})) {
    args.push("-e", `${key}=${value}`);
  }
  args.push("-e", "PORT=3000");
  args.push("-e", "HOST=0.0.0.0");
  args.push(imageTag);

  const { stdout } = await execCommand(config.dockerBinary, args);
  await ensureDir(path.dirname(logPath));
  await fs.promises.writeFile(logPath, `container_id=${stdout.trim()}\n`, "utf8");
  return { containerName, containerId: stdout.trim() };
}

async function dockerStop(containerName) {
  if (!containerName) return;
  await execCommand(config.dockerBinary, ["rm", "-f", containerName]).catch(() => {});
}

async function dockerRemoveImage(imageRef) {
  if (!imageRef) return;
  await execCommand(config.dockerBinary, ["image", "rm", "-f", imageRef]).catch(() => {});
}

async function dockerInspect(containerName) {
  const { stdout } = await execCommand(config.dockerBinary, ["inspect", containerName]);
  return JSON.parse(stdout)[0] || null;
}

module.exports = {
  ensureDir,
  dockerPull,
  ensureGhcrLogin,
  dockerRun,
  dockerStop,
  dockerRemoveImage,
  dockerInspect,
  buildContainerName,
};
