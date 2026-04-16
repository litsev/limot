import { access, appendFile, mkdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

const SYSTEM_HEADERS = [
  "ts",
  "hostname",
  "platform",
  "release",
  "arch",
  "uptime_sec",
  "cpu_cores",
  "cpu_pct",
  "cpu_temp_c",
  "mem_used_bytes",
  "mem_total_bytes",
  "mem_pct",
  "load1",
  "load5",
  "load15",
  "load_per_core",
  "gpu_pct",
  "gpu_mem_pct"
];

const FILESYSTEM_HEADERS = [
  "ts",
  "filesystem",
  "fs_type",
  "mount",
  "total_bytes",
  "used_bytes",
  "used_pct"
];

const GPU_DEVICE_HEADERS = [
  "ts",
  "gpu_index",
  "gpu_name",
  "utilization_pct",
  "memory_used_mib",
  "memory_total_mib",
  "memory_pct",
  "temperature_c"
];

const DIRECTORY_HEADERS = ["ts", "dir_key", "dir_path", "owner", "size_bytes"];

const ALERT_HEADERS = [
  "ts",
  "alert_key",
  "source",
  "level",
  "status",
  "current_value",
  "threshold",
  "message"
];

function escapeCsv(value) {
  if (value === null || value === undefined) {
    return "";
  }

  const stringValue = String(value);
  if (/[",\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, "\"\"")}"`;
  }
  return stringValue;
}

function splitCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === "\"" && inQuotes && next === "\"") {
      current += "\"";
      index += 1;
      continue;
    }

    if (char === "\"") {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) {
    return [];
  }

  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const fields = splitCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, fields[index] ?? ""]));
  });
}

function toCsvRow(headers, values) {
  return `${headers.map((header) => escapeCsv(values[header])).join(",")}\n`;
}

function toNumber(value) {
  if (value === "" || value === null || value === undefined) {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function yearRange(from, to) {
  const years = [];
  for (let year = from.getUTCFullYear(); year <= to.getUTCFullYear(); year += 1) {
    years.push(year);
  }
  return years;
}

function downsample(rows, maxPoints) {
  if (!maxPoints || rows.length <= maxPoints) {
    return rows;
  }

  const step = Math.ceil(rows.length / maxPoints);
  return rows.filter((row, index) => index % step === 0 || index === rows.length - 1);
}

export class CsvStore {
  constructor(rootDir) {
    this.rootDir = resolve(rootDir);
  }

  async appendDirectoryReport(clientId, report) {
    const collectedAt = report.collectedAt ?? new Date().toISOString();
    const yearDir = resolve(
      this.rootDir,
      String(new Date(collectedAt).getUTCFullYear()),
      clientId
    );
    await mkdir(yearDir, { recursive: true });

    const writes = [];

    // 目录数据
    for (const directory of report.directories ?? []) {
      writes.push(
        this.appendRow(resolve(yearDir, "directory.csv"), DIRECTORY_HEADERS, {
          ts: collectedAt,
          dir_key: directory.key,
          dir_path: directory.path,
          owner: directory.owner,
          size_bytes: directory.sizeBytes
        })
      );
    }

    await Promise.all(writes);
  }

  async appendReport(clientId, report) {
    const collectedAt = report.collectedAt ?? new Date().toISOString();
    const yearDir = resolve(
      this.rootDir,
      String(new Date(collectedAt).getUTCFullYear()),
      clientId
    );
    await mkdir(yearDir, { recursive: true });

    const writes = [];

    // 系统指标
    writes.push(
      this.appendRow(resolve(yearDir, "system.csv"), SYSTEM_HEADERS, {
        ts: collectedAt,
        hostname: report.system?.hostname,
        platform: report.system?.platform,
        release: report.system?.release,
        arch: report.system?.arch,
        uptime_sec: report.system?.uptimeSec,
        cpu_cores: report.system?.cpu?.cores,
        cpu_pct: report.system?.cpu?.pct,
        cpu_temp_c: report.system?.cpu?.tempC,
        mem_used_bytes: report.system?.memory?.usedBytes,
        mem_total_bytes: report.system?.memory?.totalBytes,
        mem_pct: report.system?.memory?.pct,
        load1: report.system?.load?.one,
        load5: report.system?.load?.five,
        load15: report.system?.load?.fifteen,
        load_per_core: report.system?.load?.perCore,
        gpu_pct: report.gpu?.summary?.utilizationPct,
        gpu_mem_pct: report.gpu?.summary?.memoryPct
      })
    );

    // 文件系统数据
    for (const filesystem of report.filesystems ?? []) {
      writes.push(
        this.appendRow(resolve(yearDir, "filesystem.csv"), FILESYSTEM_HEADERS, {
          ts: collectedAt,
          filesystem: filesystem.filesystem,
          fs_type: filesystem.fsType,
          mount: filesystem.mount,
          total_bytes: filesystem.totalBytes,
          used_bytes: filesystem.usedBytes,
          used_pct: filesystem.usedPct
        })
      );
    }

    // GPU设备数据
    for (const device of report.gpu?.devices ?? []) {
      writes.push(
        this.appendRow(resolve(yearDir, "gpu.csv"), GPU_DEVICE_HEADERS, {
          ts: collectedAt,
          gpu_index: device.index,
          gpu_name: device.name,
          utilization_pct: device.utilizationPct,
          memory_used_mib: device.memoryUsedMiB,
          memory_total_mib: device.memoryTotalMiB,
          memory_pct: device.memoryPct,
          temperature_c: device.temperatureC
        })
      );
    }

    // 目录数据
    if (report.directories) {
      for (const directory of report.directories) {
        writes.push(
          this.appendRow(resolve(yearDir, "directory.csv"), DIRECTORY_HEADERS, {
            ts: collectedAt,
            dir_key: directory.key,
            dir_path: directory.path,
            owner: directory.owner,
            size_bytes: directory.sizeBytes
          })
        );
      }
    }

    // 并行执行所有写入操作
    await Promise.all(writes);
  }

  async appendResolvedAlerts(clientId, collectedAt, resolvedAlerts) {
    const yearDir = resolve(
      this.rootDir,
      String(new Date(collectedAt).getUTCFullYear()),
      clientId
    );
    await mkdir(yearDir, { recursive: true });

    for (const alert of resolvedAlerts) {
      await this.appendRow(resolve(yearDir, "alerts.csv"), ALERT_HEADERS, {
        ts: collectedAt,
        alert_key: alert.id,
        source: alert.source,
        level: alert.level,
        status: alert.status,
        current_value: alert.currentValue,
        threshold: alert.threshold,
        message: alert.message
      });
    }
  }

  async appendRow(filePath, headers, values) {
    if (!this.initializingFiles) {
      this.initializingFiles = new Map();
    }

    let initPromise = this.initializingFiles.get(filePath);
    if (!initPromise) {
      initPromise = (async () => {
        try {
          const exists = await this.fileExists(filePath);
          if (!exists) {
            await appendFile(filePath, `${headers.join(",")}\n`, "utf8");
          }
        } finally {
          if (this.initializingFiles.get(filePath) === initPromise) {
            this.initializingFiles.delete(filePath);
          }
        }
      })();
      this.initializingFiles.set(filePath, initPromise);
    }

    await initPromise;
    await appendFile(filePath, toCsvRow(headers, values), "utf8");
  }

  async fileExists(filePath) {
    try {
      await access(filePath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async readRows(clientId, fileName, from, to) {
    const rows = [];
    for (const year of yearRange(from, to)) {
      const filePath = resolve(this.rootDir, String(year), clientId, fileName);
      if (!(await this.fileExists(filePath))) {
        continue;
      }

      const parsed = parseCsv(await readFile(filePath, "utf8"));
      for (const row of parsed) {
        const rowTime = new Date(row.ts).getTime();
        if (rowTime >= from.getTime() && rowTime <= to.getTime()) {
          rows.push(row);
        }
      }
    }
    return rows;
  }

  async querySystemHistory(clientId, { from, to, points }) {
    const rows = await this.readRows(clientId, "system.csv", from, to);
    return downsample(
      rows.map((row) => ({
        ts: row.ts,
        cpuPct: toNumber(row.cpu_pct),
        cpuTempC: toNumber(row.cpu_temp_c),
        memPct: toNumber(row.mem_pct),
        load1: toNumber(row.load1),
        load5: toNumber(row.load5),
        load15: toNumber(row.load15),
        loadPerCore: toNumber(row.load_per_core),
        gpuPct: toNumber(row.gpu_pct),
        gpuMemPct: toNumber(row.gpu_mem_pct)
      })),
      points
    );
  }

  async queryFilesystemHistory(clientId, { from, to, mount, points }) {
    const rows = await this.readRows(clientId, "filesystem.csv", from, to);
    const uniqueTs = Array.from(new Set(rows.map((r) => r.ts))).sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
    const sampledTs = new Set(downsample(uniqueTs, points));
    
    const filtered = mount ? rows.filter((row) => row.mount === mount) : rows;
    return filtered
      .filter((row) => sampledTs.has(row.ts))
      .map((row) => ({
        ts: row.ts,
        filesystem: row.filesystem,
        fsType: row.fs_type,
        mount: row.mount,
        totalBytes: toNumber(row.total_bytes),
        usedBytes: toNumber(row.used_bytes),
        usedPct: toNumber(row.used_pct)
      }));
  }

  async queryDirectoryHistory(clientId, { from, to, dirKey, points }) {
    const rows = await this.readRows(clientId, "directory.csv", from, to);
    const uniqueTs = Array.from(new Set(rows.map((r) => r.ts))).sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
    const sampledTs = new Set(downsample(uniqueTs, points));
    
    const filtered = dirKey ? rows.filter((row) => row.dir_key === dirKey) : rows;
    return filtered
      .filter((row) => sampledTs.has(row.ts))
      .map((row) => ({
        ts: row.ts,
        dirKey: row.dir_key,
        path: row.dir_path,
        sizeBytes: toNumber(row.size_bytes)
      }));
  }

  async queryAlerts(clientId, { from, to, limit = 200 }) {
    const rows = await this.readRows(clientId, "alerts.csv", from, to);
    return rows
      .map((row) => ({
        ts: row.ts,
        alertKey: row.alert_key,
        source: row.source,
        level: row.level,
        status: row.status,
        currentValue: toNumber(row.current_value),
        threshold: toNumber(row.threshold),
        message: row.message
      }))
      .slice(-limit)
      .reverse();
  }
}

