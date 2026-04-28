const { apiError } = require("../../lib/v2/errors");
const repo = require("../../lib/hosting/repository");
const config = require("../../lib/hosting/config");
const { proxyRequest } = require("../../lib/hosting/runtime");

module.exports = async function (fastify) {
  fastify.all("/*", async (req, reply) => {
    const host = String(req.headers.host || "").split(":")[0].toLowerCase();

    if (!host || host === config.deployHost || host === `api.${config.domain}`) {
      return apiError(reply, "GEN_003", "Route not found");
    }

    const target = await repo.findAppByDomain(host);
    if (!target?.target_port) {
      return apiError(reply, "GEN_003", "App not found for host");
    }

    try {
      await proxyRequest(req, reply, target.target_port);
      return reply;
    } catch (err) {
      req.log.error({ step: "hosting_proxy_error", host, error: err.message, port: target.target_port });
      return apiError(reply, "GEN_005", "Upstream app is unavailable");
    }
  });
};
