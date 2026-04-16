import http from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ConfigStore } from "./lib/config-store.mjs";
import { CsvStore } from "./lib/csv-store.mjs";
import {
  parseTimeRange,
  readJsonBody,
  sendJson,
  sendText,
  serveStaticFile
} from "./lib/http-utils.mjs";
import { MonitorStore } from "./lib/monitor-store.mjs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_ROOT = resolve(PROJECT_ROOT, "web");
const DATA_ROOT = resolve(PROJECT_ROOT, "data");
const CONFIG_PATH = resolve(PROJECT_ROOT, "config", "monitoring.yaml");

const configStore = new ConfigStore(CONFIG_PATH);
await configStore.load("startup");
configStore.watch();

const csvStore = new CsvStore(DATA_ROOT);
const monitorStore = new MonitorStore(configStore);

configStore.onReload(async () => {
  monitorStore.broadcast("config", configStore.getPublicConfig());
});

function getRouteMatch(pathname, regex) {
  return pathname.match(regex);
}

async function handleAgentRequest(req, res, handler) {
  try {
    const body = await readJsonBody(req);
    const { clientId, ...payload } = body;

    if (!clientId) {
      sendJson(res, 400, { error: "Missing clientId" });
      return;
    }

    const clientConfig = configStore.getClient(clientId);

    if (!clientConfig) {
      sendJson(res, 404, { error: "Unknown client" });
      return;
    }

    const result = await handler({
      clientId,
      clientConfig,
      payload
    });

    sendJson(res, 200, {
      ok: true,
      serverTime: new Date().toISOString(),
      ...result
    });
  } catch (error) {
    console.error("[agent] request failed:", error);
    sendJson(res, 400, { error: error.message });
  }
}

async function requestHandler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname, searchParams } = url;

  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      service: "limot-monitor-server",
      configVersion: configStore.version,
      time: new Date().toISOString()
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/events") {
    monitorStore.attachEventStream(req, res);
    return;
  }

  if (req.method === "GET" && pathname === "/api/servers") {
    sendJson(res, 200, {
      servers: monitorStore.getServerSummaries()
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/config") {
    sendJson(res, 200, configStore.getPublicConfig());
    return;
  }

  if (req.method === "POST" && pathname === "/api/config/reload") {
    try {
      await configStore.load("api");
      sendJson(res, 200, {
        ok: true,
        version: configStore.version,
        loadedAt: configStore.lastLoadedAt
      });
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return;
  }

  const detailsMatch = getRouteMatch(pathname, /^\/api\/servers\/([^/]+)$/);
  if (req.method === "GET" && detailsMatch) {
    const details = monitorStore.getServerDetails(detailsMatch[1]);
    if (!details) {
      sendJson(res, 404, { error: "Server not found" });
      return;
    }
    sendJson(res, 200, details);
    return;
  }

  const systemHistoryMatch = getRouteMatch(
    pathname,
    /^\/api\/servers\/([^/]+)\/history\/system$/
  );
  if (req.method === "GET" && systemHistoryMatch) {
    const [clientId] = systemHistoryMatch.slice(1);
    const range = parseTimeRange(searchParams);
    sendJson(res, 200, {
      rows: await csvStore.querySystemHistory(clientId, range)
    });
    return;
  }

  const filesystemHistoryMatch = getRouteMatch(
    pathname,
    /^\/api\/servers\/([^/]+)\/history\/filesystem$/
  );
  if (req.method === "GET" && filesystemHistoryMatch) {
    const [clientId] = filesystemHistoryMatch.slice(1);
    const range = parseTimeRange(searchParams);
    sendJson(res, 200, {
      rows: await csvStore.queryFilesystemHistory(clientId, {
        ...range,
        mount: searchParams.get("mount")
      })
    });
    return;
  }

  const directoryHistoryMatch = getRouteMatch(
    pathname,
    /^\/api\/servers\/([^/]+)\/history\/directory$/
  );
  if (req.method === "GET" && directoryHistoryMatch) {
    const [clientId] = directoryHistoryMatch.slice(1);
    const range = parseTimeRange(searchParams);
    sendJson(res, 200, {
      rows: await csvStore.queryDirectoryHistory(clientId, {
        ...range,
        dirKey: searchParams.get("dirKey")
      })
    });
    return;
  }

  const alertsMatch = getRouteMatch(pathname, /^\/api\/servers\/([^/]+)\/alerts$/);
  if (req.method === "GET" && alertsMatch) {
    const [clientId] = alertsMatch.slice(1);
    const range = parseTimeRange(searchParams, 24 * 30);
    sendJson(res, 200, {
      rows: await csvStore.queryAlerts(clientId, range)
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/agent/config") {
    await handleAgentRequest(req, res, async ({ clientId }) => ({
      configVersion: configStore.version,
      config: configStore.getAgentRuntimeConfig(clientId)
    }));
    return;
  }

  if (req.method === "POST" && pathname === "/api/agent/report") {
    await handleAgentRequest(req, res, async ({ clientId, payload }) => {
      await csvStore.appendReport(clientId, payload);
      monitorStore.upsertReport(clientId, payload);
      return {
        acceptedAt: new Date().toISOString()
      };
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/agent/heartbeat") {
    await handleAgentRequest(req, res, async ({ clientId, payload }) => {
      monitorStore.upsertHeartbeat(clientId, payload);
      return {
        acceptedAt: new Date().toISOString()
      };
    });
    return;
  }

  if (req.method === "GET") {
    const served = await serveStaticFile(res, WEB_ROOT, pathname);
    if (served) {
      return;
    }
  }

  sendText(res, 404, "Not found");
}

const serverConfig = configStore.getConfig().server;
const server = http.createServer(requestHandler);

server.listen(serverConfig.port, serverConfig.host, () => {
  console.log(
    `[server] limot monitor listening on http://${serverConfig.host}:${serverConfig.port}`
  );
});
