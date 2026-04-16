import os from "node:os";
import { resolve } from "node:path";

import { buildCurrentAlerts, collectDirectoryMetrics, collectFilesystemMetrics, collectGpuMetrics, collectSystemMetrics, startCpuSampler, stopCpuSampler } from "./lib/collectors.mjs";
import { postJson } from "./lib/http-client.mjs";
import { enqueueOutbox, flushOutbox, outboxCount } from "./lib/outbox.mjs";
import { appendLog, readJsonFile, readConfigFile, sleep, writeJsonFile } from "./lib/utils.mjs";

const AGENT_VERSION = "0.1.0";
const DEFAULT_BOOTSTRAP_PATH = resolve(
  new URL("../config.yaml", import.meta.url).pathname
);
const bootstrapPath = resolve(process.argv[2] ?? DEFAULT_BOOTSTRAP_PATH);
const bootstrap = await readConfigFile(bootstrapPath);

if (!bootstrap) {
  throw new Error(`Bootstrap config not found: ${bootstrapPath}`);
}

const cacheDir = resolve(new URL("../cache", import.meta.url).pathname);
const logsDir = resolve(new URL("../logs", import.meta.url).pathname);
const runtimeConfigCachePath = resolve(cacheDir, "runtime-config.json");
const outboxPath = resolve(cacheDir, "outbox.json");
const alertStatePath = resolve(cacheDir, "alerts-state.json");
const logPath = resolve(logsDir, "agent.log");

let stopping = false;
let lastError = null;
const previousAlertEntries = (await readJsonFile(alertStatePath, [])) ?? [];
let previousAlerts = new Map(
  previousAlertEntries
    .filter((entry) => entry?.id)
    .map((entry) => [entry.id, entry])
);

const cachedRuntimeConfig =
  (await readJsonFile(runtimeConfigCachePath, null)) ?? bootstrap.fallbackRuntimeConfig;
let runtimeConfig = cachedRuntimeConfig;

process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});

async function log(message) {
  console.log(`[client] ${message}`);
  await appendLog(logPath, message);
}

function getRuntimeConfig() {
  return runtimeConfig ?? bootstrap.fallbackRuntimeConfig;
}

async function agentRequest(route, payload) {
  return postJson(new URL(route, bootstrap.serverBaseUrl).toString(), {
    clientId: bootstrap.clientId,
    ...payload
  });
}

function diffAlertEvents(currentAlerts) {
  const currentMap = new Map(currentAlerts.map((alert) => [alert.id, alert]));
  const allAlerts = [];

  // 新增或仍活跃的告警
  for (const alert of currentAlerts) {
    allAlerts.push(alert);
  }

  // 已解决的告警（之前存在，现在不存在）
  for (const [alertId, previousAlert] of previousAlerts.entries()) {
    if (!currentMap.has(alertId)) {
      allAlerts.push({
        ...previousAlert,
        status: "resolved"
      });
    }
  }

  previousAlerts = currentMap;
  return allAlerts;
}

async function persistAlertState() {
  await writeJsonFile(alertStatePath, Array.from(previousAlerts.values()));
}

async function syncRuntimeConfig() {
  const response = await agentRequest("/api/agent/config", {
    requestedAt: new Date().toISOString(),
    agentVersion: AGENT_VERSION,
    hostname: os.hostname(),
    memory: {
      totalBytes: os.totalmem(),
      collectedAt: new Date().toISOString()
    }
  });

  if (response.config) {
    runtimeConfig = response.config;
    await writeJsonFile(runtimeConfigCachePath, response.config);
  }
}

async function buildReportPayload() {
  const config = getRuntimeConfig();
  const [system, gpu, filesystems] = await Promise.all([
    collectSystemMetrics(),
    collectGpuMetrics(),
    collectFilesystemMetrics(config)
  ]);

  const report = {
    collectedAt: new Date().toISOString(),
    runtime: {
      agentVersion: AGENT_VERSION,
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      lastError
    },
    system,
    gpu,
    filesystems,
  };

  const currentAlerts = buildCurrentAlerts(report, config);
  const allAlerts = diffAlertEvents(currentAlerts);
  await persistAlertState();

  return {
    ...report,
    currentAlerts: allAlerts,
    alertEvents: allAlerts
  };
}

async function sendReportPayload(payload) {
  await agentRequest("/api/agent/report", payload);
}

async function directoryLoop() {
  while (!stopping) {
    const startedAt = Date.now();
    const config = getRuntimeConfig();

    try {
      const directories = await collectDirectoryMetrics(config);
      const directoryAlerts = buildCurrentAlerts({ directories }, config);
      const report = {
        collectedAt: new Date().toISOString(),
        directories
      };
      
      const reportAlerts = diffAlertEvents(directoryAlerts);
      await persistAlertState();
      
      const payload = {
        ...report,
        currentAlerts: reportAlerts,
        alertEvents: reportAlerts
      };
      
      await agentRequest("/api/agent/report_directory", payload);
    } catch (error) {
      lastError = error.message;
      await log(`directory report failed: ${error.message}`);
    }

    const elapsed = Date.now() - startedAt;
    const waitMs = Math.max((config.directoryScanIntervalSec ?? 180) * 1000 - elapsed, 1000);
    await sleep(waitMs);
  }
}

async function reportLoop() {
  while (!stopping) {
    const startedAt = Date.now();
    const config = getRuntimeConfig();
    let payload = null;

    try {
      payload = await buildReportPayload();
      await sendReportPayload(payload);
      const flushResult = await flushOutbox(
        outboxPath,
        config.reportBatchMax ?? 50,
        async (queuedPayload) => {
          await sendReportPayload(queuedPayload);
        }
      );
      if (flushResult.sent > 0) {
        await log(`flushed ${flushResult.sent} cached reports`);
      }
      lastError = null;
    } catch (error) {
      lastError = error.message;
      await log(`report failed: ${error.message}`);
      if (payload) {
        await enqueueOutbox(outboxPath, payload);
      }
    }

    const elapsed = Date.now() - startedAt;
    const waitMs = Math.max((config.sampleIntervalSec ?? 10) * 1000 - elapsed, 1000);
    await sleep(waitMs);
  }
}

async function heartbeatLoop() {
  while (!stopping) {
    const config = getRuntimeConfig();
    try {
      await agentRequest("/api/agent/heartbeat", {
        sentAt: new Date().toISOString(),
        status: "running",
        agentVersion: AGENT_VERSION,
        cachedReports: await outboxCount(outboxPath),
        lastError
      });
    } catch (error) {
      lastError = error.message;
      await log(`heartbeat failed: ${error.message}`);
    }

    await sleep((config.heartbeatIntervalSec ?? 10) * 1000);
  }
}

async function configLoop() {
  while (!stopping) {
    const config = getRuntimeConfig();
    try {
      await syncRuntimeConfig();
    } catch (error) {
      lastError = error.message;
      await log(`config sync failed: ${error.message}`);
    }

    await sleep((config.configPullIntervalSec ?? 60) * 1000);
  }
}

await log(`agent starting, bootstrap=${bootstrapPath}`);
await log(`server=${bootstrap.serverBaseUrl} clientId=${bootstrap.clientId}`);

startCpuSampler();
await log("CPU sampler started");

try {
  await syncRuntimeConfig();
  await log("initial config sync succeeded");
} catch (error) {
  lastError = error.message;
  await log(`initial config sync failed: ${error.message}`);
}

try {
  await Promise.all([configLoop(), reportLoop(), directoryLoop(), heartbeatLoop()]);
} finally {
  stopCpuSampler();
  await log("CPU sampler stopped");
}
