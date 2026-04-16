import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir } from "node:fs/promises";

import { sleep } from "./utils.mjs";

const execFileAsync = promisify(execFile);

function summarizeCpuSnapshot() {
  return os.cpus().map((cpu) => ({
    idle: cpu.times.idle,
    total: Object.values(cpu.times).reduce((sum, value) => sum + value, 0)
  }));
}

class CpuSampler {
  constructor(intervalMs = 1000) {
    this.intervalMs = intervalMs;
    this.cached = 0;
    this.lastSnapshot = summarizeCpuSnapshot();
    this.started = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => {
      this.update();
    }, this.intervalMs);
    this.timer.unref(); // 不阻塞进程退出
  }

  async update() {
    const end = summarizeCpuSnapshot();
    let idleDelta = 0;
    let totalDelta = 0;

    for (let index = 0; index < this.lastSnapshot.length; index += 1) {
      idleDelta += end[index].idle - this.lastSnapshot[index].idle;
      totalDelta += end[index].total - this.lastSnapshot[index].total;
    }

    this.cached = totalDelta > 0 ? Number((((totalDelta - idleDelta) / totalDelta) * 100).toFixed(2)) : 0;
    this.lastSnapshot = end;
  }

  getCachedValue() {
    return this.cached;
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.started = false;
  }
}

const cpuSampler = new CpuSampler();

export function startCpuSampler() {
  cpuSampler.start();
}

export function stopCpuSampler() {
  cpuSampler.stop();
}

function getCpuUsageCached() {
  return cpuSampler.getCachedValue();
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

async function collectCpuTemperature() {
  try {
    // 尝试读取Linux thermal zone温度
    const tempFile = "/sys/class/thermal/thermal_zone0/temp";
    const content = await readFile(tempFile, "utf-8");
    const tempMilliC = Number(content.trim());
    if (Number.isFinite(tempMilliC) && tempMilliC > 0) {
      // 转换为摄氏度（文件中是毫摄氏度）
      return Number((tempMilliC / 1000).toFixed(1));
    }
  } catch {
    // thermal zone不可用，继续尝试其他方法
  }

  try {
    // 尝试使用sensors命令（需要lm-sensors）
    const { stdout } = await execFileAsync("sensors", ["-A", "-u"], { timeout: 2000 });
    // 简单匹配Package id或Core温度
    const match = stdout.match(/Package id.*?:\s+([\d.]+)\s*°?C|Core\s+\d+.*?:\s+([\d.]+)\s*°?C/);
    if (match) {
      const temp = Number(match[1] || match[2]);
      if (Number.isFinite(temp)) {
        return Number(temp.toFixed(1));
      }
    }
  } catch {
    // sensors命令不可用
  }

  return null;
}

export async function collectSystemMetrics() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const cpuPct = getCpuUsageCached();
  const cpuTemp = await collectCpuTemperature();
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
      cores: coreCount,
      tempC: cpuTemp
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

const directoryCache = new Map();

export async function collectDirectoryMetrics(runtimeConfig) {
  const directoriesConfig = Array.isArray(runtimeConfig.directories) ? runtimeConfig.directories : [];
  const globalScanIntervalSec = runtimeConfig.directoryScanIntervalSec || 180;
  const results = [];

  const targetDirs = [];

  for (const rule of directoriesConfig) {
    if (!rule.path) continue;
    const scanPath = rule.path;
    const excludePaths = Array.isArray(rule.exclude) ? rule.exclude : [];
    
    try {
      const entries = await readdir(scanPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          // excludePaths支持常见的通配符形式，比如 * 或 ?
          const isExcluded = excludePaths.some(pattern => {
            if (pattern.includes("*") || pattern.includes("?")) {
              const regexBody = pattern
                .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex特殊字符
                .replace(/\*/g, '.*')
                .replace(/\?/g, '.');
              const regex = new RegExp(`^${regexBody}$`);
              return regex.test(entry.name);
            }
            return pattern === entry.name;
          });

          if (!isExcluded) {
            const dirPath = path.join(scanPath, entry.name);
            targetDirs.push({ 
              dirPath, 
              owner: entry.name, 
              ruleWarnGB: rule.warnGB,
              timeoutSec: rule.timeoutSec || 300,
              scanIntervalSec: rule.scanIntervalSec || globalScanIntervalSec
            });
          }
        }
      }
    } catch (e) {
      // ignore
    }
  }

  const now = Date.now();

  // 清理不再配置中的缓存
  const currentDirPaths = new Set(targetDirs.map(t => t.dirPath));
  for (const key of directoryCache.keys()) {
    if (!currentDirPaths.has(key)) {
      directoryCache.delete(key);
    }
  }

  for (const target of targetDirs) {
    const { dirPath, owner, ruleWarnGB, timeoutSec, scanIntervalSec } = target;
    
    const cached = directoryCache.get(dirPath);
    if (cached && now - cached.lastScannedAt < scanIntervalSec * 1000) {
      // 未到点时，因为之前生成过了并且在服务端已经落地记录，
      // 所以我们直接跳过，不放入results，从而避免往服务端发重复数据。
      continue;
    }

    try {
      const { stdout } = await execFileAsync("du", ["-sk", dirPath], {
        timeout: timeoutSec * 1000
      });
      const [kilobytes] = stdout.trim().split(/\s+/);
      const sizeBytes = Number(kilobytes) * 1024;
      
      // 更新缓存并存入当次真正扫描后得出的最新值
      directoryCache.set(dirPath, { lastScannedAt: now, sizeBytes });
      
      results.push({
        key: dirPath,
        path: dirPath,
        owner: owner,
        warnGB: ruleWarnGB,
        sizeBytes
      });
    } catch (error) {
      const stdout = error?.stdout ?? "";
      const [kilobytes] = String(stdout).trim().split(/\s+/);
      const parsedKilobytes = Number(kilobytes);
      if (Number.isFinite(parsedKilobytes) && parsedKilobytes >= 0) {
        const sizeBytes = parsedKilobytes * 1024;
        directoryCache.set(dirPath, { lastScannedAt: now, sizeBytes });
        results.push({
          key: dirPath,
          path: dirPath,
          owner: owner,
          warnGB: ruleWarnGB,
          sizeBytes
        });
        continue;
      }

      directoryCache.set(dirPath, { lastScannedAt: now, sizeBytes: null });
      results.push({
        key: dirPath,
        path: dirPath,
        owner: owner,
        warnGB: ruleWarnGB,
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
      ? Number((devices.reduce((sum, d) => sum + d.utilizationPct, 0) / devices.length).toFixed(2))
      : null;
    
    // 显存合计值：所有GPU总显存使用量 / 总容量 * 100
    const totalMemoryUsedMiB = devices.reduce((sum, d) => sum + d.memoryUsedMiB, 0);
    const totalMemoryMiB = devices.reduce((sum, d) => sum + d.memoryTotalMiB, 0);
    const memoryPct = totalMemoryMiB > 0
      ? Number(((totalMemoryUsedMiB / totalMemoryMiB) * 100).toFixed(2))
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

  if (report.system && report.system.cpu.pct >= thresholds.cpuWarn) {
    alerts.push({
      id: "cpu",
      alertKey: "cpu",
      source: "cpu",
      status: "active",
      level: chooseAlertLevel(report.system.cpu.pct, thresholds.cpuWarn),
      currentValue: report.system.cpu.pct,
      threshold: thresholds.cpuWarn,
      message: `CPU 使用率达到 ${report.system.cpu.pct.toFixed(1)}%`,
      detectedAt: report.collectedAt
    });
  }

  if (report.system && report.system.memory.pct >= thresholds.memWarn) {
    alerts.push({
      id: "memory",
      alertKey: "memory",
      source: "memory",
      status: "active",
      level: chooseAlertLevel(report.system.memory.pct, thresholds.memWarn),
      currentValue: report.system.memory.pct,
      threshold: thresholds.memWarn,
      message: `内存使用率达到 ${report.system.memory.pct.toFixed(1)}%`,
      detectedAt: report.collectedAt
    });
  }

  if (report.system && report.system.load.perCore >= thresholds.load1PerCoreWarn) {
    alerts.push({
      id: "load-per-core",
      alertKey: "load-per-core",
      source: "load",
      status: "active",
      level: chooseAlertLevel(
        report.system.load.perCore * 100,
        thresholds.load1PerCoreWarn * 100
      ),
      currentValue: report.system.load.perCore,
      threshold: thresholds.load1PerCoreWarn,
      message: `每核 1 分钟负载达到 ${report.system.load.perCore.toFixed(2)}`,
      detectedAt: report.collectedAt
    });
  }
  

  for (const filesystem of report.filesystems || []) {
    if (filesystem.usedPct >= thresholds.diskWarn) {
      alerts.push({
        id: `filesystem:${filesystem.mount}`,
        alertKey: `filesystem:${filesystem.mount}`,
        source: `filesystem:${filesystem.mount}`,
        status: "active",
        level: chooseAlertLevel(filesystem.usedPct, thresholds.diskWarn),
        currentValue: filesystem.usedPct,
        threshold: thresholds.diskWarn,
        message: `挂载点 ${filesystem.mount} 使用率达到 ${filesystem.usedPct.toFixed(1)}%`,
        detectedAt: report.collectedAt
      });
    }
  }

  for (const directory of report.directories || []) {
    if (directory.sizeBytes === null) {
      continue;
    }
    
    // 如果没有指定的warnGB阈值，则跳过或者是用默认，由于配置自带规则里的warnGB已经注入
    const warnGB = directory.warnGB;
    if (!warnGB) continue;

    const currentGb = directory.sizeBytes / (1024 ** 3);
    if (currentGb >= warnGB) {
      alerts.push({
        id: `directory:${directory.key}`,
        alertKey: `directory:${directory.key}`,
        source: `directory:${directory.path}`,
        status: "active",
        level: chooseAlertLevel(currentGb, warnGB),
        currentValue: Number(currentGb.toFixed(2)),
        threshold: warnGB,
        message: `目录 ${directory.path} 占用达到 ${currentGb.toFixed(2)} GB`,
        detectedAt: report.collectedAt
      });
    }
  }

  if (
    report.gpu?.available &&
    report.gpu.summary?.utilizationPct !== null &&
    report.gpu.summary.utilizationPct >= thresholds.gpuWarn
  ) {
    alerts.push({
      id: "gpu",
      alertKey: "gpu",
      source: "gpu",
      status: "active",
      level: chooseAlertLevel(report.gpu.summary.utilizationPct, thresholds.gpuWarn),
      currentValue: report.gpu.summary.utilizationPct,
      threshold: thresholds.gpuWarn,
      message: `GPU 使用率达到 ${report.gpu.summary.utilizationPct.toFixed(1)}%`,
      detectedAt: report.collectedAt
    });
  }

  return alerts;
}
