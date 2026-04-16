import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const DEFAULT_CONFIG = {
  defaults: {
    sampleIntervalSec: 10,
    directoryScanIntervalSec: 180,
    configPullIntervalSec: 60,
    heartbeatIntervalSec: 10,
    reportBatchMax: 50
  },
  server: {
    host: "0.0.0.0",
    port: 8443
  },
  clients: []
};

function deepMerge(baseValue, overrideValue) {
  if (Array.isArray(baseValue)) {
    return Array.isArray(overrideValue) ? overrideValue : [...baseValue];
  }

  if (
    baseValue &&
    overrideValue &&
    typeof baseValue === "object" &&
    typeof overrideValue === "object"
  ) {
    const merged = { ...baseValue };
    for (const [key, value] of Object.entries(overrideValue)) {
      merged[key] = key in baseValue ? deepMerge(baseValue[key], value) : value;
    }
    return merged;
  }

  return overrideValue ?? baseValue;
}

export class ConfigStore {
  constructor(configPath) {
    this.configPath = resolve(configPath);
    this.configDir = dirname(this.configPath);
    this.config = null;
    this.listeners = new Set();
    this.lastLoadedAt = null;
    this.version = 0;
    this.watchTimer = null;
    this.watcher = null;
  }

  async load(reason = "manual") {
    const raw = await readFile(this.configPath, "utf8");
    const parsed = JSON.parse(raw);
    const merged = deepMerge(DEFAULT_CONFIG, parsed);

    this.config = merged;
    this.version += 1;
    this.lastLoadedAt = new Date().toISOString();

    for (const listener of this.listeners) {
      await listener(merged, reason);
    }

    return merged;
  }

  watch() {
    if (this.watcher) {
      return;
    }

    this.watcher = watch(this.configPath, () => {
      clearTimeout(this.watchTimer);
      this.watchTimer = setTimeout(async () => {
        try {
          await this.load("watch");
          console.log("[config] monitoring.json reloaded from file change");
        } catch (error) {
          console.error("[config] reload failed:", error.message);
        }
      }, 250);
    });
  }

  onReload(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  resolveConfigPath(relativePath) {
    return resolve(this.configDir, relativePath);
  }

  getConfig() {
    if (!this.config) {
      throw new Error("Configuration has not been loaded yet");
    }

    return this.config;
  }

  getClient(clientId) {
    return this.getConfig().clients.find((client) => client.id === clientId) ?? null;
  }

  getAgentRuntimeConfig(clientId) {
    const client = this.getClient(clientId);
    if (!client) {
      return null;
    }

    return {
      id: client.id,
      enabled: client.enabled !== false,
      sampleIntervalSec: client.sampleIntervalSec ?? this.config.defaults.sampleIntervalSec,
      directoryScanIntervalSec:
        client.directoryScanIntervalSec ?? this.config.defaults.directoryScanIntervalSec,
      configPullIntervalSec:
        client.configPullIntervalSec ?? this.config.defaults.configPullIntervalSec,
      heartbeatIntervalSec:
        client.heartbeatIntervalSec ?? this.config.defaults.heartbeatIntervalSec,
      reportBatchMax: client.reportBatchMax ?? this.config.defaults.reportBatchMax,
      thresholds: {
        cpuWarn: 85,
        memWarn: 90,
        diskWarn: 85,
        load1PerCoreWarn: 0.8,
        gpuWarn: 95,
        ...(client.thresholds ?? {})
      },
      filesystems: {
        includeMounts: client.filesystems?.includeMounts ?? [],
        excludeFsTypes: client.filesystems?.excludeFsTypes ?? []
      },
      directories: client.directories ?? []
    };
  }

  getPublicConfig() {
    const { clients, defaults, server } = this.getConfig();

    return {
      version: this.version,
      loadedAt: this.lastLoadedAt,
      defaults,
      server: {
        host: server.host,
        port: server.port,
        protocol: "http"
      },
      clients: clients.map((client) => ({
        id: client.id,
        enabled: client.enabled !== false,
        thresholds: client.thresholds ?? {},
        filesystems: client.filesystems ?? {},
        directories: client.directories ?? []
      }))
    };
  }
}
