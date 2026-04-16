const { createApp, computed, nextTick, onMounted, reactive, ref, watch } = Vue;

function createLineChart(domId) {
  const dom = document.getElementById(domId);
  return dom ? echarts.init(dom) : null;
}

function formatBytes(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "--";
  }

  const units = ["B", "KB", "MB", "GB"];
  let number = Number(value);
  let index = 0;
  while (number >= 1024 && index < units.length - 1) {
    number /= 1024;
    index += 1;
  }
  return `${number.toFixed(number >= 100 ? 0 : 1)} ${units[index]}`;
}

function baseChartOption(title, xAxisData, series, yAxis = [{}]) {
  return {
    animationDuration: 350,
    color: [
      "#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231",
      "#911eb4", "#46f0f0", "#f032e6", "#bcf60c", "#fabebe",
      "#008080", "#e6beff", "#9a6324", "#fffac8", "#800000",
      "#aaffc3", "#808000", "#ffd8b1", "#000075", "#808080"
    ],
    grid: {
      left: 46,
      right: 40,
      top: 90, // Default larger top to fit 5 rows for legends wrapping
      bottom: 34
    },
    legend: {
      type: "plain",
      top: 0
    },
    tooltip: {
      trigger: "axis"
    },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: xAxisData
    },
    yAxis,
    series
  };
}

createApp({
  setup() {
    const servers = ref([]);
    const publicConfig = reactive({});
    const selectedServerId = ref("");
    const hoursRange = ref(24);
    const directoryFilter = ref("");
    const alertRows = ref([]);
    const hiddenAlertKeys = ref(new Set());

    const history = reactive({
      system: [],
      filesystem: [],
      directory: []
    });

    const selectedServer = computed(() =>
      servers.value.find((server) => server.id === selectedServerId.value) ?? null
    );

    const visibleAlerts = computed(() => {
      if (!selectedServer.value || !selectedServer.value.currentAlerts) {
        return [];
      }
      // 只显示状态为"active"的告警，并过滤掉用户已手动清空的告警
      return selectedServer.value.currentAlerts.filter(
        (alert) =>
          alert.status !== "resolved" &&
          !hiddenAlertKeys.value.has(`${selectedServer.value.id}::${alert.id}`)
      );
    });

    function clearAlert(alertId) {
      if (!selectedServerId.value) return;
      const nextSet = new Set(hiddenAlertKeys.value);
      nextSet.add(`${selectedServerId.value}::${alertId}`);
      hiddenAlertKeys.value = nextSet;
    }

    function clearAllAlerts() {
      if (!selectedServer.value || !selectedServer.value.currentAlerts) return;
      const nextSet = new Set(hiddenAlertKeys.value);
      for (const alert of selectedServer.value.currentAlerts) {
        nextSet.add(`${selectedServerId.value}::${alert.id}`);
      }
      hiddenAlertKeys.value = nextSet;
    }

    let systemChart = null;
    let filesystemChart = null;
    let directoryChart = null;

    async function fetchJson(url, options) {
      const response = await fetch(url, options);
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? `HTTP ${response.status}`);
      }
      return payload;
    }

    function formatDateTime(value) {
      if (!value) {
        return "--";
      }
      return new Date(value).toLocaleString("zh-CN");
    }

    function formatPct(value) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) {
        return "--";
      }
      return `${Number(value).toFixed(1)}%`;
    }

    function formatFixed(value) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) {
        return "--";
      }
      return Number(value).toFixed(2);
    }

    async function loadConfig() {
      Object.assign(publicConfig, await fetchJson("/api/config"));
    }

    async function loadServers() {
      const payload = await fetchJson("/api/servers");
      servers.value = payload.servers ?? [];

      if (!selectedServerId.value && servers.value[0]) {
        selectedServerId.value = servers.value[0].id;
      }
    }

    async function loadAlerts() {
      if (!selectedServerId.value) {
        return;
      }

      const to = new Date();
      const from = new Date(to.getTime() - hoursRange.value * 60 * 60 * 1000);
      const params = new URLSearchParams({
        from: from.toISOString(),
        to: to.toISOString()
      });
      const payload = await fetchJson(`/api/servers/${selectedServerId.value}/alerts?${params}`);
      alertRows.value = payload.rows ?? [];
    }

    async function loadSystemHistory() {
      if (!selectedServerId.value) {
        return;
      }

      const to = new Date();
      const from = new Date(to.getTime() - hoursRange.value * 60 * 60 * 1000);
      const params = new URLSearchParams({
        from: from.toISOString(),
        to: to.toISOString(),
        points: "420"
      });

      const payload = await fetchJson(
        `/api/servers/${selectedServerId.value}/history/system?${params}`
      );
      history.system = payload.rows ?? [];
      renderSystemChart();
    }

    async function loadFilesystemHistory() {
      if (!selectedServerId.value) {
        history.filesystem = [];
        renderFilesystemChart();
        return;
      }

      const to = new Date();
      const from = new Date(to.getTime() - hoursRange.value * 60 * 60 * 1000);
      const params = new URLSearchParams({
        from: from.toISOString(),
        to: to.toISOString(),
        points: "420"
      });

      const payload = await fetchJson(
        `/api/servers/${selectedServerId.value}/history/filesystem?${params}`
      );
      history.filesystem = payload.rows ?? [];
      renderFilesystemChart();
    }

    async function loadDirectoryHistory() {
      if (!selectedServerId.value) {
        history.directory = [];
        renderDirectoryChart();
        return;
      }

      const to = new Date();
      const from = new Date(to.getTime() - hoursRange.value * 60 * 60 * 1000);
      const params = new URLSearchParams({
        from: from.toISOString(),
        to: to.toISOString(),
        points: "420"
      });

      const payload = await fetchJson(
        `/api/servers/${selectedServerId.value}/history/directory?${params}`
      );
      history.directory = payload.rows ?? [];
      renderDirectoryChart();
    }

    async function refreshSelectedServer() {
      if (!selectedServerId.value) {
        return;
      }

      const details = await fetchJson(`/api/servers/${selectedServerId.value}`);
      const index = servers.value.findIndex((server) => server.id === selectedServerId.value);
      if (index >= 0) {
        servers.value[index] = details;
      }

      await Promise.all([
        loadSystemHistory(),
        loadFilesystemHistory(),
        loadDirectoryHistory(),
        loadAlerts()
      ]);
    }

    function renderSystemChart() {
      if (!systemChart) {
        systemChart = createLineChart("system-chart");
      }
      if (!systemChart) {
        return;
      }

      const xAxis = history.system.map((row) => formatDateTime(row.ts));
      systemChart.setOption(
        baseChartOption("系统指标", xAxis, [
          {
            name: "CPU %",
            type: "line",
            smooth: true,
            data: history.system.map((row) => row.cpuPct)
          },
          {
            name: "内存 %",
            type: "line",
            smooth: true,
            data: history.system.map((row) => row.memPct)
          },
          {
            name: "GPU %",
            type: "line",
            smooth: true,
            data: history.system.map((row) => row.gpuPct)
          },
          {
            name: "显存 %",
            type: "line",
            smooth: true,
            data: history.system.map((row) => row.gpuMemPct)
          },
          {
            name: "负载/核",
            type: "line",
            smooth: true,
            yAxisIndex: 1,
            data: history.system.map((row) => row.loadPerCore)
          }
        ], [
          {
            type: "value",
            min: 0,
            max: 100
          },
          {
            type: "value",
            min: 0
          }
        ])
      , true);
    }

    function renderFilesystemChart() {
      if (!filesystemChart) {
        filesystemChart = createLineChart("filesystem-chart");
      }
      if (!filesystemChart) {
        return;
      }

      const mounts = [...new Set(history.filesystem.map((r) => r.mount))];
      const tsSet = [...new Set(history.filesystem.map((r) => r.ts))].sort();
      const xAxis = tsSet.map((ts) => formatDateTime(ts));

      // 构建查询表，用于 tooltip 中快速查找
      const filesystemDataMap = new Map();
      history.filesystem.forEach((r) => {
        const key = `${r.ts}::${r.mount}`;
        filesystemDataMap.set(key, r);
      });

      const series = mounts.map((mount) => {
        const mountDataMap = new Map();
        history.filesystem
          .filter((r) => r.mount === mount)
          .forEach((r) => {
            mountDataMap.set(r.ts, r.usedPct);
          });
        return {
          name: mount,
          type: "line",
          smooth: true,
          connectNulls: true,
          data: tsSet.map((ts) => mountDataMap.get(ts) ?? null)
        };
      });

      const chartOption = baseChartOption("文件系统", xAxis, series, [
        {
          type: "value",
          min: 0,
          max: 100
        }
      ]);

      chartOption.tooltip = {
        trigger: "axis",
        formatter: (params) => {
          if (!params || params.length === 0) return '';
          const ts = params[0].axisValue;
          // 从 xAxis 的格式化时间反查原始 ts
          const tsIndex = xAxis.indexOf(ts);
          if (tsIndex === -1) return '';
          const originalTs = tsSet[tsIndex];
          
          let result = `<div style="margin-bottom: 8px;">${ts}</div>`;
          params.forEach((param) => {
            const mount = param.seriesName;
            const key = `${originalTs}::${mount}`;
            const data = filesystemDataMap.get(key);
            
            if (data) {
              result += `<div style="color: ${param.color}; margin-bottom: 4px;">
                ${mount}: ${data.usedPct.toFixed(1)}% (${formatBytes(data.usedBytes)}/${formatBytes(data.totalBytes)})
              </div>`;
            } else {
              result += `<div style="color: ${param.color}; margin-bottom: 4px;">
                ${mount}: --
              </div>`;
            }
          });
          return result;
        }
      };

      filesystemChart.setOption(chartOption, true);
    }

    function renderDirectoryChart() {
      if (!directoryChart) {
        directoryChart = createLineChart("directory-chart");
      }
      if (!directoryChart) {
        return;
      }

      let dirKeys = [...new Set(history.directory.map((r) => r.dirKey))];
      const filterLower = directoryFilter.value.trim().toLowerCase();
      if (filterLower) {
        dirKeys = dirKeys.filter((key) => key.toLowerCase().includes(filterLower));
      }

      const tsSet = [...new Set(history.directory.map((r) => r.ts))].sort();
      const xAxis = tsSet.map((ts) => formatDateTime(ts));

      const series = dirKeys.map((dirKey) => {
        const dataMap = new Map();
        history.directory
          .filter((r) => r.dirKey === dirKey)
          .forEach((r) => {
            const sizeGb = Number((r.sizeBytes / 1024 / 1024 / 1024).toFixed(3));
            dataMap.set(r.ts, sizeGb);
          });
        return {
          name: dirKey,
          type: "line",
          smooth: true,
          connectNulls: true,
          data: tsSet.map((ts) => dataMap.get(ts) ?? null),
          tooltip: {
            valueFormatter: (value) => value !== null ? `${value} GB` : '--'
          }
        };
      });

      directoryChart.setOption(
        baseChartOption("目录容量", xAxis, series, [
          {
            type: "value",
            axisLabel: {
              formatter: '{value} GB'
            }
          }
        ])
      , true);
    }

    async function reloadConfig() {
      await fetchJson("/api/config/reload", {
        method: "POST"
      });
      ElementPlus.ElMessage.success("配置已重载");
      await Promise.all([loadConfig(), loadServers()]);
      await refreshSelectedServer();
    }

    function selectServer(serverId) {
      selectedServerId.value = serverId;
    }

    function attachSse() {
      const stream = new EventSource("/api/events");
      stream.addEventListener("snapshot", async (event) => {
        servers.value = JSON.parse(event.data);
        if (!selectedServerId.value && servers.value[0]) {
          selectedServerId.value = servers.value[0].id;
        }
      });
    }

    watch(directoryFilter, () => {
      renderDirectoryChart();
    });

    watch(selectedServerId, async () => {
      directoryFilter.value = "";
      await nextTick();
      await refreshSelectedServer();
    });

    watch(hoursRange, async () => {
      await refreshSelectedServer();
    });

    window.addEventListener("resize", () => {
      systemChart?.resize();
      filesystemChart?.resize();
      directoryChart?.resize();
    });

    onMounted(async () => {
      await Promise.all([loadConfig(), loadServers()]);
      attachSse();
      if (selectedServerId.value) {
        await refreshSelectedServer();
      }
    });

    return {
      directoryFilter,
      alertRows,
      clearAlert,
      clearAllAlerts,
      formatBytes,
      formatDateTime,
      formatFixed,
      formatPct,
      hoursRange,
      loadDirectoryHistory,
      loadFilesystemHistory,
      publicConfig,
      reloadConfig,
      refreshSelectedServer,
      selectServer,
      selectedServer,
      selectedServerId,
      servers,
      visibleAlerts
    };
  }
}).use(ElementPlus).mount("#app");
