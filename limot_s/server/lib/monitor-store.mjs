export class MonitorStore {
  constructor(configStore) {
    this.configStore = configStore;
    this.latest = new Map();
    this.eventStreams = new Set();
  }

  upsertReport(clientId, payload) {
    const current = this.latest.get(clientId) ?? {};
    this.latest.set(clientId, {
      ...current,
      id: clientId,
      lastSeen: payload.collectedAt ?? new Date().toISOString(),
      system: payload.system ?? current.system ?? null,
      gpu: payload.gpu ?? current.gpu ?? null,
      filesystems: payload.filesystems ?? current.filesystems ?? [],
      directories: payload.directories ?? current.directories ?? [],
      currentAlerts: payload.currentAlerts ?? current.currentAlerts ?? [],
      runtime: payload.runtime ?? current.runtime ?? null,
      lastError: payload.runtime?.lastError ?? current.lastError ?? null
    });
    this.broadcast("snapshot", this.getServerSummaries());
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
      const configuredDirectories = (client.directories ?? []).map((directory) => ({
        key: directory.key,
        path: directory.path,
        sizeBytes: null
      }));

      return {
        id: client.id,
        enabled: client.enabled !== false,
        online: isOnline,
        lastSeen,
        lastError: latest?.lastError ?? null,
        system: latest?.system ?? null,
        gpu: latest?.gpu ?? null,
        filesystems: latest?.filesystems?.length ? latest.filesystems : configuredFilesystems,
        directories: latest?.directories?.length ? latest.directories : configuredDirectories,
        currentAlerts: latest?.currentAlerts ?? [],
        runtime: latest?.runtime ?? null
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
