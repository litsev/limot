const { createApp, computed, nextTick, onMounted, reactive, ref, watch } = Vue;

function createLineChart(domId) {
  const dom = document.getElementById(domId);
  return dom ? echarts.init(dom) : null;
}

function formatBytes(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "--";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
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
    color: ["#0d7a70", "#cb6b2d", "#355c7d", "#8f9f57"],
    grid: {
      left: 46,
      right: 40,
      top: 42,
      bottom: 34
    },
    legend: {
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
    const selectedMount = ref("");
    const selectedDirKey = ref("");
    const hoursRange = ref(24);
    const alertRows = ref([]);

    const history = reactive({
      system: [],
      filesystem: [],
      directory: []
    });

    const mountOptions = computed(() => {
      const server = selectedServer.value;
      return (server?.filesystems ?? []).map((item) => item.mount);
    });

    const directoryOptions = computed(() => {
      const server = selectedServer.value;
      return server?.directories ?? [];
    });

    const selectedServer = computed(() =>
      servers.value.find((server) => server.id === selectedServerId.value) ?? null
    );

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
      if (!selectedServerId.value || !selectedMount.value) {
        history.filesystem = [];
        renderFilesystemChart();
        return;
      }

      const to = new Date();
      const from = new Date(to.getTime() - hoursRange.value * 60 * 60 * 1000);
      const params = new URLSearchParams({
        from: from.toISOString(),
        to: to.toISOString(),
        points: "420",
        mount: selectedMount.value
      });

      const payload = await fetchJson(
        `/api/servers/${selectedServerId.value}/history/filesystem?${params}`
      );
      history.filesystem = payload.rows ?? [];
      renderFilesystemChart();
    }

    async function loadDirectoryHistory() {
      if (!selectedServerId.value || !selectedDirKey.value) {
        history.directory = [];
        renderDirectoryChart();
        return;
      }

      const to = new Date();
      const from = new Date(to.getTime() - hoursRange.value * 60 * 60 * 1000);
      const params = new URLSearchParams({
        from: from.toISOString(),
        to: to.toISOString(),
        points: "420",
        dirKey: selectedDirKey.value
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

      if (!selectedMount.value && details.filesystems?.[0]?.mount) {
        selectedMount.value = details.filesystems[0].mount;
      }

      if (!selectedDirKey.value && details.directories?.[0]?.key) {
        selectedDirKey.value = details.directories[0].key;
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
      );
    }

    function renderFilesystemChart() {
      if (!filesystemChart) {
        filesystemChart = createLineChart("filesystem-chart");
      }
      if (!filesystemChart) {
        return;
      }

      const xAxis = history.filesystem.map((row) => formatDateTime(row.ts));
      filesystemChart.setOption(
        baseChartOption("文件系统", xAxis, [
          {
            name: "使用率 %",
            type: "line",
            smooth: true,
            data: history.filesystem.map((row) => row.usedPct)
          }
        ], [
          {
            type: "value",
            min: 0,
            max: 100
          }
        ])
      );
    }

    function renderDirectoryChart() {
      if (!directoryChart) {
        directoryChart = createLineChart("directory-chart");
      }
      if (!directoryChart) {
        return;
      }

      const xAxis = history.directory.map((row) => formatDateTime(row.ts));
      directoryChart.setOption(
        baseChartOption("目录容量", xAxis, [
          {
            name: "目录大小",
            type: "line",
            smooth: true,
            data: history.directory.map((row) => row.sizeBytes),
            tooltip: {
              valueFormatter: (value) => formatBytes(value)
            }
          }
        ], [
          {
            type: "value",
            axisLabel: {
              formatter: (value) => formatBytes(value)
            }
          }
        ])
      );
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

    watch(selectedServerId, async () => {
      selectedMount.value = "";
      selectedDirKey.value = "";
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
      alertRows,
      directoryOptions,
      formatDateTime,
      formatFixed,
      formatPct,
      hoursRange,
      loadDirectoryHistory,
      loadFilesystemHistory,
      mountOptions,
      publicConfig,
      reloadConfig,
      refreshSelectedServer,
      selectServer,
      selectedDirKey,
      selectedMount,
      selectedServer,
      selectedServerId,
      servers
    };
  }
}).use(ElementPlus).mount("#app");
