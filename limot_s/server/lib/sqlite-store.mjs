import sqlite3 from "sqlite3";
import { resolve } from "node:path";
import { promisify } from "node:util";

function downsample(rows, maxPoints) {
  if (!maxPoints || rows.length <= maxPoints) {
    return rows;
  }
  const step = Math.ceil(rows.length / maxPoints);
  return rows.filter((row, index) => index % step === 0 || index === rows.length - 1);
}

export class SqliteStore {
  constructor(rootDir) {
    this.dbPath = resolve(rootDir, "monitor.db");
    this.db = new sqlite3.Database(this.dbPath);
    this.run = promisify(this.db.run.bind(this.db));
    this.all = promisify(this.db.all.bind(this.db));
  }

  async init() {
    await this.run(`
      CREATE TABLE IF NOT EXISTS system_metrics (
        ts TEXT, client_id TEXT, hostname TEXT, platform TEXT, release TEXT, arch TEXT,
        uptime_sec REAL, cpu_cores INTEGER, cpu_pct REAL, cpu_temp_c REAL,
        mem_used_bytes REAL, mem_total_bytes REAL, mem_pct REAL,
        load1 REAL, load5 REAL, load15 REAL, load_per_core REAL, gpu_pct REAL, gpu_mem_pct REAL
      )`);
    await this.run(`CREATE INDEX IF NOT EXISTS idx_system_metrics ON system_metrics(client_id, ts)`);

    await this.run(`
      CREATE TABLE IF NOT EXISTS filesystem_metrics (
        ts TEXT, client_id TEXT, filesystem TEXT, fs_type TEXT, mount TEXT,
        total_bytes REAL, used_bytes REAL, used_pct REAL
      )`);
    await this.run(`CREATE INDEX IF NOT EXISTS idx_filesystem_metrics ON filesystem_metrics(client_id, ts)`);

    await this.run(`
      CREATE TABLE IF NOT EXISTS gpu_metrics (
        ts TEXT, client_id TEXT, gpu_index INTEGER, gpu_name TEXT,
        utilization_pct REAL, memory_used_mib REAL, memory_total_mib REAL, memory_pct REAL, temperature_c REAL
      )`);
    await this.run(`CREATE INDEX IF NOT EXISTS idx_gpu_metrics ON gpu_metrics(client_id, ts)`);

    await this.run(`
      CREATE TABLE IF NOT EXISTS directory_metrics (
        ts TEXT, client_id TEXT, dir_key TEXT, dir_path TEXT, owner TEXT, size_bytes REAL
      )`);
    await this.run(`CREATE INDEX IF NOT EXISTS idx_directory_metrics ON directory_metrics(client_id, ts)`);

    await this.run(`
      CREATE TABLE IF NOT EXISTS alerts (
        ts TEXT, client_id TEXT, alert_key TEXT, source TEXT, level TEXT,
        status TEXT, current_value REAL, threshold REAL, message TEXT
      )`);
    await this.run(`CREATE INDEX IF NOT EXISTS idx_alerts ON alerts(client_id, ts)`);
  }

  async compressYesterdayData() {
    const now = new Date();
    // 压缩前天的数据（留一天缓冲）：基于本地时间的 00:00:00 - 23:59:59，并转为 ISO 供查询
    const targetDate = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const y = targetDate.getFullYear();
    const m = targetDate.getMonth();
    const d = targetDate.getDate();
    
    const startObj = new Date(y, m, d, 0, 0, 0, 0);
    const endObj = new Date(y, m, d, 23, 59, 59, 999);
    
    const startIso = startObj.toISOString();
    const endIso = endObj.toISOString();
    const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

    try {
      await this.run("BEGIN TRANSACTION");

      // 1. system_metrics
      await this.run(`
        CREATE TEMP TABLE temp_sys AS 
        SELECT 
          strftime('%Y-%m-%dT%H:00:00.000Z', ts) as ts, client_id,
          MAX(hostname) as hostname, MAX(platform) as platform, MAX(release) as release, MAX(arch) as arch,
          AVG(uptime_sec) as uptime_sec, AVG(cpu_cores) as cpu_cores, AVG(cpu_pct) as cpu_pct, AVG(cpu_temp_c) as cpu_temp_c,
          AVG(mem_used_bytes) as mem_used_bytes, AVG(mem_total_bytes) as mem_total_bytes, AVG(mem_pct) as mem_pct,
          AVG(load1) as load1, AVG(load5) as load5, AVG(load15) as load15, AVG(load_per_core) as load_per_core,
          AVG(gpu_pct) as gpu_pct, AVG(gpu_mem_pct) as gpu_mem_pct
        FROM system_metrics WHERE ts >= ? AND ts <= ?
        GROUP BY client_id, strftime('%Y-%m-%dT%H:00:00.000Z', ts)
      `);
      await this.run("DELETE FROM system_metrics WHERE ts >= ? AND ts <= ?", [startIso, endIso]);
      await this.run("INSERT INTO system_metrics SELECT * FROM temp_sys");
      await this.run("DROP TABLE temp_sys");

      await this.run("COMMIT");
      console.log(`[Data Compressor] Successfully compressed older data for ${dateStr}`);
    } catch (e) {
      await this.run("ROLLBACK");
      console.error("[Data Compressor] Failed to compress older data:", e);
    }
  }

  async appendDirectoryReport(clientId, report) {
    const collectedAt = report.collectedAt ?? new Date().toISOString();
    if (!report.directories) return;
    for (const d of report.directories) {
      await this.run(`INSERT INTO directory_metrics(ts, client_id, dir_key, dir_path, owner, size_bytes) VALUES (?, ?, ?, ?, ?, ?)`,
        [collectedAt, clientId, d.key, d.path, d.owner, d.sizeBytes]);
    }
  }

  async appendReport(clientId, report) {
    const collectedAt = report.collectedAt ?? new Date().toISOString();
    if (report.system) {
      const s = report.system;
      const g = report.gpu?.summary;
      await this.run(`INSERT INTO system_metrics(ts, client_id, hostname, platform, release, arch, uptime_sec, cpu_cores, cpu_pct, cpu_temp_c, mem_used_bytes, mem_total_bytes, mem_pct, load1, load5, load15, load_per_core, gpu_pct, gpu_mem_pct) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [collectedAt, clientId, s.hostname, s.platform, s.release, s.arch, s.uptimeSec, s.cpu?.cores, s.cpu?.pct, s.cpu?.tempC, s.memory?.usedBytes, s.memory?.totalBytes, s.memory?.pct, s.load?.one, s.load?.five, s.load?.fifteen, s.load?.perCore, g?.utilizationPct, g?.memoryPct]);
    }
    if (report.filesystems) {
      for (const fs of report.filesystems) {
        await this.run(`INSERT INTO filesystem_metrics(ts, client_id, filesystem, fs_type, mount, total_bytes, used_bytes, used_pct) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [collectedAt, clientId, fs.filesystem, fs.fsType, fs.mount, fs.totalBytes, fs.usedBytes, fs.usedPct]);
      }
    }
    if (report.gpu?.devices) {
      for (const d of report.gpu.devices) {
        await this.run(`INSERT INTO gpu_metrics(ts, client_id, gpu_index, gpu_name, utilization_pct, memory_used_mib, memory_total_mib, memory_pct, temperature_c) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [collectedAt, clientId, d.index, d.name, d.utilizationPct, d.memoryUsedMiB, d.memoryTotalMiB, d.memoryPct, d.temperatureC]);
      }
    }
    if (report.directories) {
      for (const d of report.directories) {
        await this.run(`INSERT INTO directory_metrics(ts, client_id, dir_key, dir_path, owner, size_bytes) VALUES (?, ?, ?, ?, ?, ?)`,
          [collectedAt, clientId, d.key, d.path, d.owner, d.sizeBytes]);
      }
    }
  }

  async appendAlerts(clientId, collectedAt, alerts) {
    if (!alerts) return;
    for (const alert of alerts) {
      await this.run(`INSERT INTO alerts(ts, client_id, alert_key, source, level, status, current_value, threshold, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [collectedAt, clientId, alert.id, alert.source, alert.level, alert.status, alert.currentValue, alert.threshold, alert.message]);
    }
  }

  async appendResolvedAlerts(clientId, collectedAt, resolvedAlerts) {
    if (!resolvedAlerts) return;
    for (const alert of resolvedAlerts) {
      await this.run(`INSERT INTO alerts(ts, client_id, alert_key, source, level, status, current_value, threshold, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [collectedAt, clientId, alert.id, alert.source, alert.level, alert.status, alert.currentValue, alert.threshold, alert.message]);
    }
  }

  async querySystemHistory(clientId, { from, to, points }) {
    const rows = await this.all(`SELECT * FROM system_metrics WHERE client_id = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC`, [clientId, from.toISOString(), to.toISOString()]);
    const mapped = rows.map((r) => ({ts: r.ts, cpuPct: r.cpu_pct, cpuTempC: r.cpu_temp_c, memPct: r.mem_pct, load1: r.load1, load5: r.load5, load15: r.load15, loadPerCore: r.load_per_core, gpuPct: r.gpu_pct, gpuMemPct: r.gpu_mem_pct}));
    return downsample(mapped, points);
  }

  async queryFilesystemHistory(clientId, { from, to, mount, points }) {
    let query = `SELECT * FROM filesystem_metrics WHERE client_id = ? AND ts >= ? AND ts <= ?`;
    const params = [clientId, from.toISOString(), to.toISOString()];
    if (mount) { query += ` AND mount = ?`; params.push(mount); }
    query += ` ORDER BY ts ASC`;
    const rows = await this.all(query, params);
    const uniqueTs = Array.from(new Set(rows.map((r) => r.ts)));
    const sampledTs = new Set(downsample(uniqueTs, points));
    return rows.filter(r => sampledTs.has(r.ts)).map(r => ({ts: r.ts, filesystem: r.filesystem, fsType: r.fs_type, mount: r.mount, totalBytes: r.total_bytes, usedBytes: r.used_bytes, usedPct: r.used_pct}));
  }

  async queryDirectoryHistory(clientId, { from, to, dirKey, points }) {
    let query = `SELECT * FROM directory_metrics WHERE client_id = ? AND ts >= ? AND ts <= ?`;
    const params = [clientId, from.toISOString(), to.toISOString()];
    if (dirKey) { query += ` AND dir_key = ?`; params.push(dirKey); }
    query += ` ORDER BY ts ASC`;
    const rows = await this.all(query, params);
    const uniqueTs = Array.from(new Set(rows.map((r) => r.ts)));
    const sampledTs = new Set(downsample(uniqueTs, points));
    return rows.filter(r => sampledTs.has(r.ts)).map((r) => ({ts: r.ts, dirKey: r.dir_key, path: r.dir_path, sizeBytes: r.size_bytes}));
  }

  async queryAlerts(clientId, { from, to, limit = 200 }) {
    const rows = await this.all(`SELECT * FROM alerts WHERE client_id = ? AND ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT ?`, [clientId, from.toISOString(), to.toISOString(), limit]);
    return rows.map((r) => ({ts: r.ts, alertKey: r.alert_key, source: r.source, level: r.level, status: r.status, currentValue: r.current_value, threshold: r.threshold, message: r.message}));
  }
}
