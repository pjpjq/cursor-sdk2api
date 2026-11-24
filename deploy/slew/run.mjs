import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { SystemClock } from "./dist/clock.js";
import { loadConfig } from "./dist/config.js";
import { requestId as newRequestId } from "./dist/ids.js";
import { createLogger } from "./dist/log.js";
import { createCursorRuntime } from "./dist/sdk/cursor-runtime.js";
import { ensureEmptyWorkspace } from "./dist/sdk/empty-workspace.js";
import { configureSdkOutboundProxy } from "./dist/sdk/proxy.js";
import { createApp } from "./dist/server/app.js";
import { headerValue, requestPath, sendJson } from "./dist/server/http-util.js";

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 19)) {
  throw new Error("cursor-sdk2api requires Node.js 22.19.0 or newer");
}

const config = loadConfig();
const adminKey = process.env.ADMIN_ACCESS_KEY;
if (config.authMode !== "managed" || (config.gatewayAccessKey?.length ?? 0) < 32) {
  throw new Error("Slew requires managed auth with a GATEWAY_ACCESS_KEY of at least 32 characters");
}
if (!adminKey || adminKey.length < 32 ||
    adminKey === config.gatewayAccessKey || adminKey === config.managedCursorKey) {
  throw new Error("Slew requires a distinct ADMIN_ACCESS_KEY of at least 32 characters");
}

const digest = (value) => createHash("sha256").update(value).digest();
const adminDigest = digest(`Bearer ${adminKey}`);
const publicPaths = new Set([
  "/health",
  "/v1/models",
  "/v1/account",
  "/v1/messages",
  "/v1/messages/count_tokens",
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/responses/compact",
]);

const logger = createLogger(config.logLevel);
configureSdkOutboundProxy();
const app = createApp({
  config,
  sdk: createCursorRuntime({ stateDir: config.stateDir }),
  clock: new SystemClock(),
  logger,
  workspaceDir: ensureEmptyWorkspace(config.instanceId, config.emptyWorkspaceDir),
});

const server = createServer((req, res) => {
  let path;
  try {
    path = requestPath(req);
  } catch {
    sendJson(res, 400, { error: "invalid request URL" }, newRequestId());
    return;
  }
  if (publicPaths.has(path)) {
    void app.handler(req, res);
    return;
  }
  if (path.startsWith("/v0/management/")) {
    const presented = digest(headerValue(req, "authorization") ?? "");
    if (timingSafeEqual(presented, adminDigest)) {
      void app.handler(req, res);
    } else {
      sendJson(res, 401, { error: "management authentication required" }, newRequestId(), {
        "www-authenticate": 'Bearer realm="cursor-sdk2api-admin"',
      });
    }
    return;
  }
  sendJson(res, 404, { error: "not found" }, newRequestId());
});

server.listen(config.port, config.host, () => {
  logger.info({ node: process.version, port: config.port, host: config.host }, "Slew gateway listening");
});

let draining = false;
async function shutdown() {
  if (draining) return;
  draining = true;
  app.beginShutdown();
  await app.coordinator.drain(config.runDeadlineMs);
  app.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
