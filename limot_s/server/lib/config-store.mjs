import { watch } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import YAML from "js-yaml";
import * as logger from "./logger.mjs";

const DEFAULT_CONFIG = {
  defaults: {
    sampleIntervalSec: 10,
    directoryScanIntervalSec: 180,
    configPullIntervalSec: 60,
    heartbeatIntervalSec: 10,
    reportBatchMax: 50,
    thresholds: {
      cpuWarn: 85,
      cpuCritical: 95,
      cpuAlertDurationMin: 30,
      memWarn: 90,
      memCritical: 95,
      diskWarn: 85,
      diskCritical: 95,
      load1PerCoreWarn: 0.8,
      load1PerCoreCritical: 1.0,
      gpuWarn: 95,
      gpuCritical: 98
    }
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
    this.clientWatcher = null;
  }

  async load(reason = "manual") {
    const raw = await readFile(this.configPath, "utf8");
    
    // Parse based on file extension
    let parsed;
    if (this.configPath.endsWith(".yaml") || this.configPath.endsWith(".yml")) {
      parsed = YAML.load(raw);
    } else {
      parsed = JSON.parse(raw);
    }

    // Load separated client configs
    try {
      const clientsDir = join(this.configDir, "clients");
      const clientFiles = await readdir(clientsDir);
      parsed.clients = [];
      
      for (const file of clientFiles) {
        if (file.endsWith(".yaml") || file.endsWith(".yml")) {
          const clientRaw = await readFile(join(clientsDir, file), "utf8");
          const clientParsed = YAML.load(clientRaw);
          if (clientParsed && clientParsed.id) {
            parsed.clients.push(clientParsed);
          }
        }
      }
    } catch (err) {
      if (err.code !== "ENOENT") {
        logger.error("config", `Failed to load client configs: ${err.message}`);
      }
    }
    
    const merged = deepMerge(DEFAULT_CONFIG, parsed);

    // Apply default warnGB to directories
    const defaultWarnGB = merged.defaults.warnGB || 100;
    if (merged.clients) {
      for (const client of merged.clients) {
        if (client.directories && Array.isArray(client.directories)) {
          for (const rule of client.directories) {
            if (rule.warnGB === undefined) {
              rule.warnGB = defaultWarnGB;
            }
          }
        }
      }
    }

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
      this.scheduleReload();
    });

    try {
      const clientsDir = join(this.configDir, "clients");
      this.clientWatcher = watch(clientsDir, () => {
        this.scheduleReload();
      });
    } catch (error) {
      if (error.code !== "ENOENT") {
        logger.error("config", `failed to watch client configs: ${error.message}`);
      }
    }
  }

  scheduleReload() {
    clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(async () => {
      try {
        await this.load("watch");
        logger.info("config", "config reloaded from file change");
      } catch (error) {
        logger.error("config", `reload failed: ${error.message}`);
      }
    }, 250);
  }

  closeWatchers() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    if (this.clientWatcher) {
      this.clientWatcher.close();
      this.clientWatcher = null;
    }
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
        ...(this.config.defaults.thresholds ?? {}),
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
