import sqlite3 from "sqlite3";
import { resolve } from "node:path";
import { promisify } from "node:util";
import * as logger from "./logger.mjs";

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
    await this.ensureAutoincrementPrimaryKeyTable(
      "system_metrics",
      `
        CREATE TABLE system_metrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT, client_id TEXT, hostname TEXT, platform TEXT, release TEXT, arch TEXT,
          uptime_sec REAL, cpu_cores INTEGER, cpu_pct REAL, cpu_temp_c REAL,
          mem_used_bytes REAL, mem_total_bytes REAL, mem_pct REAL,
          load1 REAL, load5 REAL, load15 REAL, load_per_core REAL, gpu_pct REAL, gpu_mem_pct REAL
        )`,
      [
        "ts", "client_id", "hostname", "platform", "release", "arch",
        "uptime_sec", "cpu_cores", "cpu_pct", "cpu_temp_c",
        "mem_used_bytes", "mem_total_bytes", "mem_pct",
        "load1", "load5", "load15", "load_per_core", "gpu_pct", "gpu_mem_pct"
      ],
      [`CREATE INDEX IF NOT EXISTS idx_system_metrics ON system_metrics(client_id, ts)`]
    );

    await this.ensureAutoincrementPrimaryKeyTable(
      "filesystem_metrics",
      `
        CREATE TABLE filesystem_metrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT, client_id TEXT, filesystem TEXT, fs_type TEXT, mount TEXT,
          total_bytes REAL, used_bytes REAL, used_pct REAL
        )`,
      ["ts", "client_id", "filesystem", "fs_type", "mount", "total_bytes", "used_bytes", "used_pct"],
      [`CREATE INDEX IF NOT EXISTS idx_filesystem_metrics ON filesystem_metrics(client_id, ts)`]
    );

    await this.ensureAutoincrementPrimaryKeyTable(
      "gpu_metrics",
      `
        CREATE TABLE gpu_metrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT, client_id TEXT, gpu_index INTEGER, gpu_name TEXT,
          utilization_pct REAL, memory_used_mib REAL, memory_total_mib REAL, memory_pct REAL, temperature_c REAL
        )`,
      [
        "ts", "client_id", "gpu_index", "gpu_name",
        "utilization_pct", "memory_used_mib", "memory_total_mib", "memory_pct", "temperature_c"
      ],
      [`CREATE INDEX IF NOT EXISTS idx_gpu_metrics ON gpu_metrics(client_id, ts)`]
    );

    await this.ensureAutoincrementPrimaryKeyTable(
      "directory_metrics",
      `
        CREATE TABLE directory_metrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT, client_id TEXT, dir_key TEXT, dir_path TEXT, owner TEXT, size_bytes REAL
        )`,
      ["ts", "client_id", "dir_key", "dir_path", "owner", "size_bytes"],
      [`CREATE INDEX IF NOT EXISTS idx_directory_metrics ON directory_metrics(client_id, ts)`]
    );

    await this.ensureAutoincrementPrimaryKeyTable(
      "user_directory_usage",
      `
        CREATE TABLE user_directory_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          client_id TEXT,
          ts TEXT,
          owner TEXT,
          size_bytes REAL
        )`,
      ["client_id", "ts", "owner", "size_bytes"],
      [`CREATE INDEX IF NOT EXISTS idx_user_directory_usage ON user_directory_usage(client_id, ts, owner)`]
    );

    await this.ensureAlertsTable();
  }

  async ensureAutoincrementPrimaryKeyTable(tableName, createSql, columnNames, indexStatements = []) {
    const columns = await this.all(`PRAGMA table_info(${tableName})`);
    const hasTable = Array.isArray(columns) && columns.length > 0;
    const hasPrimaryKey = hasTable && columns.some((column) => column.name === "id");

    if (!hasTable) {
      await this.run(createSql);
    } else if (!hasPrimaryKey) {
      const tempTableName = `${tableName}_v2`;
      const columnList = columnNames.join(", ");
      await this.run(createSql.replace(`CREATE TABLE ${tableName}`, `CREATE TABLE ${tempTableName}`));
      await this.run(`
        INSERT INTO ${tempTableName}(${columnList})
        SELECT ${columnList}
        FROM ${tableName}
      `);
      await this.run(`DROP TABLE ${tableName}`);
      await this.run(`ALTER TABLE ${tempTableName} RENAME TO ${tableName}`);
    }

    for (const statement of indexStatements) {
      await this.run(statement);
    }
  }

  async ensureAlertsTable() {
    const columns = await this.all(`PRAGMA table_info(alerts)`);
    const hasAlertsTable = Array.isArray(columns) && columns.length > 0;
    const hasPrimaryKey = hasAlertsTable && columns.some((column) => column.name === "id");
    const hasUpdatedAt = hasAlertsTable && columns.some((column) => column.name === "updated_at");
    const hasResolvedAt = hasAlertsTable && columns.some((column) => column.name === "resolved_at");

    if (!hasAlertsTable) {
      await this.run(`
        CREATE TABLE alerts (
          id TEXT PRIMARY KEY,
          ts TEXT,
          updated_at TEXT,
          resolved_at TEXT,
          client_id TEXT,
          alert_key TEXT,
          source TEXT,
          level TEXT,
          status TEXT,
          current_value REAL,
          threshold REAL,
          message TEXT
        )`);
    } else if (!hasPrimaryKey || !hasUpdatedAt || !hasResolvedAt) {
      await this.run(`
        CREATE TABLE alerts_v2 (
          id TEXT PRIMARY KEY,
          ts TEXT,
          updated_at TEXT,
          resolved_at TEXT,
          client_id TEXT,
          alert_key TEXT,
          source TEXT,
          level TEXT,
          status TEXT,
          current_value REAL,
          threshold REAL,
          message TEXT
        )`);
      await this.run(`
        INSERT INTO alerts_v2(
          id, ts, updated_at, resolved_at, client_id, alert_key, source, level, status, current_value, threshold, message
        )
        SELECT
          'legacy:' || client_id || ':' || alert_key || ':' || ts || ':' || rowid,
          ts,
          ts,
          CASE WHEN status = 'resolved' THEN ts ELSE NULL END,
          client_id,
          alert_key,
          source,
          level,
          status,
          current_value,
          threshold,
          message
        FROM alerts
      `);
      await this.run(`DROP TABLE alerts`);
      await this.run(`ALTER TABLE alerts_v2 RENAME TO alerts`);
    }

    await this.run(`CREATE INDEX IF NOT EXISTS idx_alerts ON alerts(client_id, updated_at)`);
    await this.run(`CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(client_id, status)`);
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
      await this.run(`
        INSERT INTO system_metrics(
          ts, client_id, hostname, platform, release, arch,
          uptime_sec, cpu_cores, cpu_pct, cpu_temp_c,
          mem_used_bytes, mem_total_bytes, mem_pct,
          load1, load5, load15, load_per_core, gpu_pct, gpu_mem_pct
        )
        SELECT
          ts, client_id, hostname, platform, release, arch,
          uptime_sec, cpu_cores, cpu_pct, cpu_temp_c,
          mem_used_bytes, mem_total_bytes, mem_pct,
          load1, load5, load15, load_per_core, gpu_pct, gpu_mem_pct
        FROM temp_sys
      `);
      await this.run("DROP TABLE temp_sys");

      await this.run("COMMIT");
      logger.info("compressor", `Successfully compressed older data for ${dateStr}`);
    } catch (e) {
      await this.run("ROLLBACK");
      logger.error("compressor", `Failed to compress older data: ${e.message}`);
    }
  }

  async appendDirectoryReport(clientId, report) {
    const collectedAt = report.collectedAt ?? new Date().toISOString();
    if (!report.directories) return;
    for (const d of report.directories) {
      await this.run(`INSERT INTO directory_metrics(ts, client_id, dir_key, dir_path, owner, size_bytes) VALUES (?, ?, ?, ?, ?, ?)`,
        [collectedAt, clientId, d.key, d.path, d.owner, d.sizeBytes]);
    }
    await this.appendOwnerDirectoryUsage(clientId, collectedAt, report.directories);
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
      await this.appendOwnerDirectoryUsage(clientId, collectedAt, report.directories);
    }
  }

  async appendOwnerDirectoryUsage(clientId, collectedAt, directories) {
    if (!Array.isArray(directories) || directories.length === 0) {
      return;
    }

    const ownerUsage = new Map();
    for (const directory of directories) {
      if (!Number.isFinite(directory?.sizeBytes) || !directory?.owner) {
        continue;
      }
      const current = ownerUsage.get(directory.owner) ?? 0;
      ownerUsage.set(directory.owner, current + Number(directory.sizeBytes));
    }

    for (const [owner, sizeBytes] of ownerUsage.entries()) {
      await this.run(
        `INSERT INTO user_directory_usage(client_id, ts, owner, size_bytes) VALUES (?, ?, ?, ?)`,
        [clientId, collectedAt, owner, sizeBytes]
      );
    }
  }

  async upsertAlerts(clientId, collectedAt, alerts) {
    if (!alerts) return;
    for (const alert of alerts) {
      const recordId = alert.recordId ?? `${clientId}:${alert.id}`;
      const detectedAt = alert.detectedAt ?? collectedAt;
      const updatedAt = collectedAt ?? new Date().toISOString();
      const resolvedAt = alert.status === "resolved" ? (alert.resolvedAt ?? updatedAt) : null;
      await this.run(
        `INSERT INTO alerts(
          id, ts, updated_at, resolved_at, client_id, alert_key, source, level, status, current_value, threshold, message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          updated_at = excluded.updated_at,
          resolved_at = excluded.resolved_at,
          client_id = excluded.client_id,
          alert_key = excluded.alert_key,
          source = excluded.source,
          level = excluded.level,
          status = excluded.status,
          current_value = excluded.current_value,
          threshold = excluded.threshold,
          message = excluded.message`,
        [
          recordId,
          detectedAt,
          updatedAt,
          resolvedAt,
          clientId,
          alert.id,
          alert.source,
          alert.level,
          alert.status,
          alert.currentValue,
          alert.threshold,
          alert.message
        ]
      );
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

  async queryUserDirectoryUsageHistory(clientId, { from, to, owner, points }) {
    let query = `SELECT * FROM user_directory_usage WHERE client_id = ? AND ts >= ? AND ts <= ?`;
    const params = [clientId, from.toISOString(), to.toISOString()];
    if (owner) {
      query += ` AND owner = ?`;
      params.push(owner);
    }
    query += ` ORDER BY ts ASC`;

    const rows = await this.all(query, params);
    const uniqueTs = Array.from(new Set(rows.map((r) => r.ts)));
    const sampledTs = new Set(downsample(uniqueTs, points));
    return rows
      .filter((r) => sampledTs.has(r.ts))
      .map((r) => ({
        ts: r.ts,
        owner: r.owner,
        sizeBytes: r.size_bytes
      }));
  }

  async queryDirectoryDailyComparisons(clientId, dirKeys = []) {
    if (!Array.isArray(dirKeys) || dirKeys.length === 0) {
      return new Map();
    }

    const result = new Map();
    for (const key of dirKeys) {
      const latestRows = await this.all(
        `SELECT ts, dir_key, dir_path, owner, size_bytes
         FROM directory_metrics
         WHERE client_id = ? AND dir_key = ? AND size_bytes IS NOT NULL
         ORDER BY ts DESC
         LIMIT 1`,
        [clientId, key]
      );

      if (!latestRows || latestRows.length === 0) {
        result.set(key, null);
        continue;
      }

      const latest = latestRows[0];
      const latestMs = Date.parse(latest.ts);
      if (!Number.isFinite(latestMs)) {
        result.set(key, null);
        continue;
      }

      const targetIso = new Date(latestMs - 24 * 60 * 60 * 1000).toISOString();
      const oldRows = await this.all(
        `SELECT ts, dir_key, dir_path, owner, size_bytes
         FROM directory_metrics
         WHERE client_id = ?
           AND dir_key = ?
           AND size_bytes IS NOT NULL
           AND ts <> ?
         ORDER BY ABS(strftime('%s', ts) - strftime('%s', ?)) ASC, ts DESC
         LIMIT 1`,
        [clientId, key, latest.ts, targetIso]
      );

      if (!oldRows || oldRows.length === 0) {
        result.set(key, null);
        continue;
      }

      const old = oldRows[0];

      result.set(
        key,
        {
          old: {
            ts: old.ts,
            dirKey: old.dir_key,
            path: old.dir_path,
            owner: old.owner,
            sizeBytes: old.size_bytes
          },
          latest: {
            ts: latest.ts,
            dirKey: latest.dir_key,
            path: latest.dir_path,
            owner: latest.owner,
            sizeBytes: latest.size_bytes
          }
        }
      );
    }

    return result;
  }

  async queryAlerts(clientId, { from, to, limit = 200 }) {
    const rows = await this.all(
      `SELECT * FROM alerts
       WHERE client_id = ?
         AND COALESCE(updated_at, ts) >= ?
         AND COALESCE(updated_at, ts) <= ?
       ORDER BY updated_at DESC, ts DESC
       LIMIT ?`,
      [clientId, from.toISOString(), to.toISOString(), limit]
    );
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      updatedAt: r.updated_at,
      resolvedAt: r.resolved_at,
      alertKey: r.alert_key,
      source: r.source,
      level: r.level,
      status: r.status,
      currentValue: r.current_value,
      threshold: r.threshold,
      message: r.message
    }));
  }
}
