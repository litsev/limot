export class MonitorStore {
  constructor(configStore) {
    this.configStore = configStore;
    this.latest = new Map();
    this.eventStreams = new Set();
    this.memoryInfo = new Map();
    this.alertStates = new Map(); // 追踪每个客户端的活跃告警状态
  }

  upsertReport(clientId, payload) {
    const current = this.latest.get(clientId) ?? {};
    const oldAlerts = current.currentAlerts ?? [];
    const activeAlerts = (payload.currentAlerts ?? []).filter(
      (alert) => alert.status === "active"
    );
    const resolvedAlerts = (payload.currentAlerts ?? []).filter(
      (alert) => alert.status === "resolved"
    );
    
    const oldAlertIds = new Set(oldAlerts.map(a => a.id));
    const newAlerts = activeAlerts.filter(a => !oldAlertIds.has(a.id));

    // 合并目录状态：保留未被本次上报覆盖的历史目录最新数据
    const mergedDirectoriesMap = new Map((current.directories ?? []).map(d => [d.key, d]));
    for (const d of (payload.directories ?? [])) {
      mergedDirectoriesMap.set(d.key, d);
    }
    const mergedDirectories = Array.from(mergedDirectoriesMap.values());

    this.latest.set(clientId, {
      ...current,
      id: clientId,
      lastSeen: payload.collectedAt ?? new Date().toISOString(),
      system: payload.system ?? current.system ?? null,
      gpu: payload.gpu ?? current.gpu ?? null,
      filesystems: payload.filesystems ?? current.filesystems ?? [],
      directories: mergedDirectories,
      currentAlerts: activeAlerts,
      runtime: payload.runtime ?? current.runtime ?? null,
      lastError: payload.runtime?.lastError ?? current.lastError ?? null
    });
    this.broadcast("snapshot", this.getServerSummaries());
    
    // 返回已解决和新的告警供caller处理
    return { resolvedAlerts, newAlerts };
  }

  upsertHeartbeat(clientId, heartbeat) {
    const current = this.latest.get(clientId) ?? {};
    this.latest.set(clientId, {
      ...current,
      id: clientId,
      lastSeen: heartbeat.sentAt ?? new Date().toISOString(),
      runtime: {
        ...(current.runtime ?? {}),
        ...(heartbeat ?? {})
      },
      lastError: heartbeat.lastError ?? current.lastError ?? null
    });
    this.broadcast("snapshot", this.getServerSummaries());
  }

  upsertMemoryInfo(clientId, memoryInfo) {
    this.memoryInfo.set(clientId, {
      ...memoryInfo,
      updatedAt: new Date().toISOString()
    });
    this.broadcast("snapshot", this.getServerSummaries());
  }

  upsertGpuCount(clientId, gpuCount, wechatNotifier) {
    const current = this.latest.get(clientId) ?? {};
    const oldCount = current.gpuCount;
    if (oldCount !== undefined && gpuCount < oldCount) {
      if (wechatNotifier) {
        wechatNotifier.notify(`🚨 严重告警 [${clientId}]: GPU通信异常！已知数量从 ${oldCount} 减少至 ${gpuCount}`);
      }
    }
    this.latest.set(clientId, {
      ...current,
      gpuCount
    });
  }

  getMemoryInfo(clientId) {
    return this.memoryInfo.get(clientId) ?? null;
  }

  getServerSummaries() {
    const config = this.configStore.getConfig();
    const onlineWindowMs =
      Math.max(config.defaults.heartbeatIntervalSec ?? 10, 10) * 3 * 1000;
    const now = Date.now();

    return config.clients.map((client) => {
      const latest = this.latest.get(client.id) ?? null;
      const lastSeen = latest?.lastSeen ?? null;
      const isOnline = lastSeen
        ? now - new Date(lastSeen).getTime() <= onlineWindowMs
        : false;
      const configuredFilesystems = (client.filesystems?.includeMounts ?? []).map((mount) => ({
        mount
      }));
      const memoryInfo = this.getMemoryInfo(client.id);

      return {
        id: client.id,
        enabled: client.enabled !== false,
        online: isOnline,
        lastSeen,
        lastError: latest?.lastError ?? null,
        system: latest?.system ?? null,
        gpu: latest?.gpu ?? null,
        filesystems: latest?.filesystems?.length ? latest.filesystems : configuredFilesystems,
        directories: latest?.directories ?? [],
        currentAlerts: latest?.currentAlerts ?? [],
        runtime: latest?.runtime ?? null,
        memory: memoryInfo
      };
    });
  }

  getServerDetails(clientId) {
    return this.getServerSummaries().find((server) => server.id === clientId) ?? null;
  }

  attachEventStream(req, res) {
    res.writeHead(200, {
      "cache-control": "no-cache, no-transform",
      "content-type": "text/event-stream; charset=utf-8",
      connection: "keep-alive"
    });
    res.write("\n");

    const stream = { req, res };
    this.eventStreams.add(stream);
    req.on("close", () => {
      this.eventStreams.delete(stream);
    });

    this.sendEvent(stream, "snapshot", this.getServerSummaries());
  }

  broadcast(event, payload) {
    for (const stream of this.eventStreams) {
      this.sendEvent(stream, event, payload);
    }
  }

  sendEvent(stream, event, payload) {
    stream.res.write(`event: ${event}\n`);
    stream.res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}
