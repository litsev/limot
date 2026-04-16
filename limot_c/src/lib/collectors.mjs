import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { sleep } from "./utils.mjs";

const execFileAsync = promisify(execFile);

function summarizeCpuSnapshot() {
  return os.cpus().map((cpu) => ({
    idle: cpu.times.idle,
    total: Object.values(cpu.times).reduce((sum, value) => sum + value, 0)
  }));
}

async function sampleCpuUsage(intervalMs = 250) {
  const start = summarizeCpuSnapshot();
  await sleep(intervalMs);
  const end = summarizeCpuSnapshot();

  let idleDelta = 0;
  let totalDelta = 0;

  for (let index = 0; index < start.length; index += 1) {
    idleDelta += end[index].idle - start[index].idle;
    totalDelta += end[index].total - start[index].total;
  }

  if (totalDelta <= 0) {
    return 0;
  }

  return Number((((totalDelta - idleDelta) / totalDelta) * 100).toFixed(2));
}

function parseDfLine(line) {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 7) {
    return null;
  }

  const [filesystem, fsType, blocks, used, available, capacity, mount] = parts;
  return {
    filesystem,
    fsType,
    totalBytes: Number(blocks) * 1024,
    usedBytes: Number(used) * 1024,
    availableBytes: Number(available) * 1024,
    usedPct: Number(capacity.replace("%", "")),
    mount
  };
}

function chooseAlertLevel(currentValue, threshold) {
  if (currentValue >= threshold + 10) {
    return "critical";
  }
  return "warn";
}

export async function collectSystemMetrics() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const cpuPct = await sampleCpuUsage();
  const load = os.loadavg();
  const coreCount = Math.max(os.cpus().length, 1);

  return {
    hostname: os.hostname(),
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    uptimeSec: Math.floor(os.uptime()),
    cpu: {
      pct: cpuPct,
      cores: coreCount
    },
    memory: {
      totalBytes: totalMem,
      usedBytes: usedMem,
      pct: Number(((usedMem / totalMem) * 100).toFixed(2))
    },
    load: {
      one: Number(load[0].toFixed(3)),
      five: Number(load[1].toFixed(3)),
      fifteen: Number(load[2].toFixed(3)),
      perCore: Number((load[0] / coreCount).toFixed(3))
    }
  };
}

export async function collectFilesystemMetrics(runtimeConfig) {
  const { stdout } = await execFileAsync("df", ["-kPT"]);
  const lines = stdout.split(/\r?\n/).slice(1).filter(Boolean);
  const includeMounts = runtimeConfig.filesystems?.includeMounts ?? [];
  const excludeFsTypes = new Set(runtimeConfig.filesystems?.excludeFsTypes ?? []);

  return lines
    .map(parseDfLine)
    .filter(Boolean)
    .filter((entry) => !excludeFsTypes.has(entry.fsType))
    .filter((entry) => includeMounts.length === 0 || includeMounts.includes(entry.mount));
}

export async function collectDirectoryMetrics(runtimeConfig) {
  const directories = runtimeConfig.directories ?? [];
  const results = [];

  for (const directory of directories) {
    try {
      const { stdout } = await execFileAsync("du", ["-sk", directory.path], {
        timeout: 300_000
      });
      const [kilobytes] = stdout.trim().split(/\s+/);
      results.push({
        key: directory.key,
        path: directory.path,
        sizeBytes: Number(kilobytes) * 1024
      });
    } catch (error) {
      const stdout = error?.stdout ?? "";
      const [kilobytes] = String(stdout).trim().split(/\s+/);
      const parsedKilobytes = Number(kilobytes);
      if (Number.isFinite(parsedKilobytes) && parsedKilobytes >= 0) {
        results.push({
          key: directory.key,
          path: directory.path,
          sizeBytes: parsedKilobytes * 1024
        });
        continue;
      }

      results.push({
        key: directory.key,
        path: directory.path,
        sizeBytes: null
      });
    }
  }

  return results;
}

export async function collectGpuMetrics() {
  try {
    const { stdout } = await execFileAsync("nvidia-smi", [
      "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu",
      "--format=csv,noheader,nounits"
    ]);

    const devices = stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.split(",").map((part) => part.trim()))
      .map(([index, name, util, memoryUsed, memoryTotal, temperature]) => ({
        index: Number(index),
        name,
        utilizationPct: Number(util),
        memoryUsedMiB: Number(memoryUsed),
        memoryTotalMiB: Number(memoryTotal),
        memoryPct:
          Number(memoryTotal) > 0
            ? Number(((Number(memoryUsed) / Number(memoryTotal)) * 100).toFixed(2))
            : 0,
        temperatureC: Number(temperature)
      }));

    const utilizationPct = devices.length
      ? Math.max(...devices.map((device) => device.utilizationPct))
      : null;
    const memoryPct = devices.length
      ? Math.max(...devices.map((device) => device.memoryPct))
      : null;

    return {
      available: devices.length > 0,
      devices,
      summary: {
        utilizationPct,
        memoryPct
      }
    };
  } catch {
    return {
      available: false,
      devices: [],
      summary: {
        utilizationPct: null,
        memoryPct: null
      }
    };
  }
}

export function buildCurrentAlerts(report, runtimeConfig) {
  const thresholds = runtimeConfig.thresholds ?? {};
  const alerts = [];

  if (report.system.cpu.pct >= thresholds.cpuWarn) {
    alerts.push({
      alertKey: "cpu",
      source: "cpu",
      level: chooseAlertLevel(report.system.cpu.pct, thresholds.cpuWarn),
      currentValue: report.system.cpu.pct,
      threshold: thresholds.cpuWarn,
      message: `CPU 使用率达到 ${report.system.cpu.pct.toFixed(1)}%`
    });
  }

  if (report.system.memory.pct >= thresholds.memWarn) {
    alerts.push({
      alertKey: "memory",
      source: "memory",
      level: chooseAlertLevel(report.system.memory.pct, thresholds.memWarn),
      currentValue: report.system.memory.pct,
      threshold: thresholds.memWarn,
      message: `内存使用率达到 ${report.system.memory.pct.toFixed(1)}%`
    });
  }

  if (report.system.load.perCore >= thresholds.load1PerCoreWarn) {
    alerts.push({
      alertKey: "load-per-core",
      source: "load",
      level: chooseAlertLevel(
        report.system.load.perCore * 100,
        thresholds.load1PerCoreWarn * 100
      ),
      currentValue: report.system.load.perCore,
      threshold: thresholds.load1PerCoreWarn,
      message: `每核 1 分钟负载达到 ${report.system.load.perCore.toFixed(2)}`
    });
  }

  for (const filesystem of report.filesystems) {
    if (filesystem.usedPct >= thresholds.diskWarn) {
      alerts.push({
        alertKey: `filesystem:${filesystem.mount}`,
        source: `filesystem:${filesystem.mount}`,
        level: chooseAlertLevel(filesystem.usedPct, thresholds.diskWarn),
        currentValue: filesystem.usedPct,
        threshold: thresholds.diskWarn,
        message: `挂载点 ${filesystem.mount} 使用率达到 ${filesystem.usedPct.toFixed(1)}%`
      });
    }
  }

  const directoryRules = new Map(
    (runtimeConfig.directories ?? []).map((directory) => [directory.key, directory])
  );
  for (const directory of report.directories) {
    const rule = directoryRules.get(directory.key);
    if (!rule || !rule.warnGB || directory.sizeBytes === null) {
      continue;
    }
    const currentGb = directory.sizeBytes / (1024 ** 3);
    if (currentGb >= rule.warnGB) {
      alerts.push({
        alertKey: `directory:${directory.key}`,
        source: `directory:${directory.path}`,
        level: chooseAlertLevel(currentGb, rule.warnGB),
        currentValue: Number(currentGb.toFixed(2)),
        threshold: rule.warnGB,
        message: `目录 ${directory.path} 占用达到 ${currentGb.toFixed(2)} GB`
      });
    }
  }

  if (
    report.gpu?.available &&
    report.gpu.summary?.utilizationPct !== null &&
    report.gpu.summary.utilizationPct >= thresholds.gpuWarn
  ) {
    alerts.push({
      alertKey: "gpu",
      source: "gpu",
      level: chooseAlertLevel(report.gpu.summary.utilizationPct, thresholds.gpuWarn),
      currentValue: report.gpu.summary.utilizationPct,
      threshold: thresholds.gpuWarn,
      message: `GPU 使用率达到 ${report.gpu.summary.utilizationPct.toFixed(1)}%`
    });
  }

  return alerts;
}
