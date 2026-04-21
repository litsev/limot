const { createApp, computed, nextTick, onMounted, reactive, ref, watch } = Vue;
const CHART_VISIBILITY_STORAGE_KEY = "limot.chartVisibility.v1";
const DEFAULT_CHART_VISIBILITY = {
  system: true,
  directory: false,
  userDirectory: false,
  filesystem: true
};

function createLineChart(domId) {
  const dom = document.getElementById(domId);
  return dom ? echarts.init(dom) : null;
}

function formatBytes(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "--";
  }

  const units = ["B", "KB", "MB", "GB"];
  const raw = Number(value);
  const sign = raw < 0 ? "-" : "";
  let number = Math.abs(raw);
  let index = 0;
  while (number >= 1024 && index < units.length - 1) {
    number /= 1024;
    index += 1;
  }
  return `${sign}${number.toFixed(number >= 100 ? 0 : 1)} ${units[index]}`;
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
    const ownerUsageUnit = ref("day");
    const ownerUsageSortBy = ref("week");
    const alertRows = ref([]);
    const hiddenAlertKeys = ref(new Set());
    const fullscreenChart = ref(null);
    const chartVisibility = reactive({
      ...DEFAULT_CHART_VISIBILITY
    });

    const alertLevelDict = {
      warn: { label: "普通告警", className: "is-warn" },
      critical: { label: "严重告警", className: "is-critical" }
    };

    const alertStatusDict = {
      active: { label: "进行中", className: "is-active" },
      resolved: { label: "已解决", className: "is-resolved" }
    };

    const history = reactive({
      system: [],
      filesystem: [],
      directory: [],
      userDirectoryUsage: []
    });

    const ownerUsageUnitOptions = [
      { label: "日", value: "day" },
      { label: "周", value: "week" },
      { label: "月", value: "month" }
    ];

    const ownerUsageSortOptions = [
      { label: "按日增量", value: "day" },
      { label: "按周增量", value: "week" },
      { label: "按月增量", value: "month" }
    ];

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
    let userDirectoryChart = null;

    function ensureChart(chartRef, domId) {
      const dom = document.getElementById(domId);
      if (!dom) {
        if (chartRef) {
          chartRef.dispose();
        }
        return null;
      }

      if (chartRef && chartRef.getDom() !== dom) {
        chartRef.dispose();
        chartRef = null;
      }

      return chartRef ?? echarts.init(dom);
    }

    async function fetchJson(url, options) {
      // Create a URL object from the given relative or absolute URL, stripping origin credentials
      const parsedUrl = new URL(url, window.location.href);
      parsedUrl.username = '';
      parsedUrl.password = '';
      
      const response = await fetch(parsedUrl.href, options);
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

    function formatSignedSizeBytes(value) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) {
        return "--";
      }
      const sign = Number(value) > 0 ? "+" : "";
      return `${sign}${formatBytes(value)}`;
    }

    function formatSignedRate(value) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) {
        return "--";
      }
      const sign = Number(value) > 0 ? "+" : "";
      return `${sign}${Number(value).toFixed(2)}%`;
    }

    function getPeriodMsByUnit(unit) {
      if (unit === "week") {
        return 7 * 24 * 60 * 60 * 1000;
      }
      if (unit === "month") {
        return 30 * 24 * 60 * 60 * 1000;
      }
      return 24 * 60 * 60 * 1000;
    }

    function getHoursByUnit(unit) {
      if (unit === "week") {
        return 24 * 7;
      }
      if (unit === "month") {
        return 24 * 30;
      }
      return 24;
    }

    const ownerUsageChangeRows = computed(() => {
      const rows = history.userDirectoryUsage ?? [];
      if (rows.length === 0) {
        return [];
      }

      const byOwner = new Map();
      for (const row of rows) {
        if (!row?.owner || !Number.isFinite(Number(row?.sizeBytes))) {
          continue;
        }
        if (!byOwner.has(row.owner)) {
          byOwner.set(row.owner, []);
        }
        byOwner.get(row.owner).push({
          ts: row.ts,
          sizeBytes: Number(row.sizeBytes)
        });
      }

      const result = [];

      function buildPeriodChange(ownerRows, latest, periodMs) {
        const latestMs = new Date(latest.ts).getTime();
        if (!Number.isFinite(latestMs)) {
          return null;
        }

        const targetMs = latestMs - periodMs;
        let baseline = ownerRows.find((row) => new Date(row.ts).getTime() >= targetMs) ?? null;
        if (!baseline) {
          baseline = ownerRows[0] ?? null;
        }
        if (!baseline) {
          return null;
        }

        const deltaBytes = latest.sizeBytes - baseline.sizeBytes;
        const changeRatePct = baseline.sizeBytes > 0
          ? (deltaBytes / baseline.sizeBytes) * 100
          : null;

        return {
          baselineSizeBytes: baseline.sizeBytes,
          deltaBytes,
          changeRatePct
        };
      }

      for (const [owner, ownerRows] of byOwner.entries()) {
        ownerRows.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
        const latest = ownerRows[ownerRows.length - 1];
        if (!latest) {
          continue;
        }

        const dayChange = buildPeriodChange(ownerRows, latest, 24 * 60 * 60 * 1000);
        const weekChange = buildPeriodChange(ownerRows, latest, 7 * 24 * 60 * 60 * 1000);
        const monthChange = buildPeriodChange(ownerRows, latest, 30 * 24 * 60 * 60 * 1000);

        if (!dayChange || !weekChange || !monthChange) {
          continue;
        }

        result.push({
          owner,
          yesterdaySizeBytes: dayChange.baselineSizeBytes,
          dayDeltaBytes: dayChange.deltaBytes,
          dayChangeRatePct: dayChange.changeRatePct,
          weekSizeBytes: weekChange.baselineSizeBytes,
          weekDeltaBytes: weekChange.deltaBytes,
          weekChangeRatePct: weekChange.changeRatePct,
          monthSizeBytes: monthChange.baselineSizeBytes,
          monthDeltaBytes: monthChange.deltaBytes,
          monthChangeRatePct: monthChange.changeRatePct,
          latestSizeBytes: latest.sizeBytes
        });
      }

      const sortFieldMap = {
        day: "dayDeltaBytes",
        week: "weekDeltaBytes",
        month: "monthDeltaBytes"
      };
      const sortField = sortFieldMap[ownerUsageSortBy.value] ?? "weekDeltaBytes";

      return result.sort((a, b) => {
        const aValue = Number(a[sortField]) || 0;
        const bValue = Number(b[sortField]) || 0;
        const aIsZero = aValue === 0;
        const bIsZero = bValue === 0;

        if (aIsZero && !bIsZero) {
          return 1;
        }
        if (!aIsZero && bIsZero) {
          return -1;
        }

        return bValue - aValue;
      });
    });

    function getAlertLevelMeta(level) {
      return alertLevelDict[level] ?? { label: level ?? "未知", className: "is-unknown" };
    }

    function getAlertStatusMeta(status) {
      return alertStatusDict[status] ?? { label: status ?? "未知", className: "is-unknown" };
    }

    async function loadConfig() {
      Object.assign(publicConfig, await fetchJson("/api/config"));
    }

    function loadChartVisibility() {
      try {
        const raw = localStorage.getItem(CHART_VISIBILITY_STORAGE_KEY);
        if (!raw) {
          return;
        }
        const saved = JSON.parse(raw);
        chartVisibility.system = saved?.system ?? DEFAULT_CHART_VISIBILITY.system;
        chartVisibility.directory = saved?.directory ?? DEFAULT_CHART_VISIBILITY.directory;
        chartVisibility.userDirectory = saved?.userDirectory ?? DEFAULT_CHART_VISIBILITY.userDirectory;
        chartVisibility.filesystem = saved?.filesystem ?? DEFAULT_CHART_VISIBILITY.filesystem;
      } catch {
        chartVisibility.system = DEFAULT_CHART_VISIBILITY.system;
        chartVisibility.directory = DEFAULT_CHART_VISIBILITY.directory;
        chartVisibility.userDirectory = DEFAULT_CHART_VISIBILITY.userDirectory;
        chartVisibility.filesystem = DEFAULT_CHART_VISIBILITY.filesystem;
      }
    }

    function persistChartVisibility() {
      localStorage.setItem(CHART_VISIBILITY_STORAGE_KEY, JSON.stringify({
        system: chartVisibility.system,
        directory: chartVisibility.directory,
        userDirectory: chartVisibility.userDirectory,
        filesystem: chartVisibility.filesystem
      }));
    }

    function toggleChartVisibility(chartKey) {
      if (!(chartKey in chartVisibility)) {
        return;
      }

      chartVisibility[chartKey] = !chartVisibility[chartKey];
      persistChartVisibility();

      if (chartVisibility[chartKey]) {
        nextTick(() => {
          if (chartKey === "system") {
            renderSystemChart();
          } else if (chartKey === "directory") {
            renderDirectoryChart();
          } else if (chartKey === "userDirectory") {
            renderUserDirectoryChart();
          } else if (chartKey === "filesystem") {
            renderFilesystemChart();
          }
        });
      } else {
        if (chartKey === "system" && systemChart) {
          systemChart.dispose();
          systemChart = null;
        } else if (chartKey === "directory" && directoryChart) {
          directoryChart.dispose();
          directoryChart = null;
        } else if (chartKey === "userDirectory" && userDirectoryChart) {
          userDirectoryChart.dispose();
          userDirectoryChart = null;
        } else if (chartKey === "filesystem" && filesystemChart) {
          filesystemChart.dispose();
          filesystemChart = null;
        }
      }
    }

    function chartToggleButtonType(chartKey) {
      return chartVisibility[chartKey] ? "primary" : "info";
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

    async function loadUserDirectoryUsageHistory() {
      if (!selectedServerId.value) {
        history.userDirectoryUsage = [];
        renderUserDirectoryChart();
        return;
      }

      const hours = getHoursByUnit(ownerUsageUnit.value);
      const to = new Date();
      const from = new Date(to.getTime() - hours * 60 * 60 * 1000);
      const params = new URLSearchParams({
        from: from.toISOString(),
        to: to.toISOString(),
        points: "420"
      });

      const payload = await fetchJson(
        `/api/servers/${selectedServerId.value}/history/user-directory-usage?${params}`
      );
      history.userDirectoryUsage = payload.rows ?? [];
      renderUserDirectoryChart();
    }

    async function toggleFullscreen(chartName) {
      const isEntering = fullscreenChart.value !== chartName;
      fullscreenChart.value = isEntering ? chartName : null;
      
      const selectorMap = {
        'system': '#system-chart',
        'directory': '#directory-chart',
        'filesystem': '#filesystem-chart'
      };

      try {
        if (isEntering) {
          const el = document.querySelector(selectorMap[chartName])?.parentElement;
          if (el && el.requestFullscreen) {
            await el.requestFullscreen();
            if (screen.orientation && screen.orientation.lock) {
              await screen.orientation.lock('landscape').catch(() => {});
            }
          }
        } else {
          if (document.fullscreenElement) {
            await document.exitFullscreen();
          }
          if (screen.orientation && screen.orientation.unlock) {
            screen.orientation.unlock();
          }
        }
      } catch (err) {
        console.warn("Fullscreen API error:", err);
      }

      const resizeAction = () => {
        systemChart?.resize();
        filesystemChart?.resize();
        if (directoryChart) {
          renderDirectoryChart();
        }
      };

      setTimeout(resizeAction, 50);
      setTimeout(resizeAction, 300); // 兼容屏幕旋转的耗时
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
        loadUserDirectoryUsageHistory(),
        loadAlerts()
      ]);
    }

    function renderSystemChart() {
      systemChart = ensureChart(systemChart, "system-chart");
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
      filesystemChart = ensureChart(filesystemChart, "filesystem-chart");
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
      directoryChart = ensureChart(directoryChart, "directory-chart");
      if (!directoryChart) {
        return;
      }

      let dirKeys = [...new Set(history.directory.map((r) => r.dirKey))];
      const filterLower = directoryFilter.value.trim().toLowerCase();
      if (filterLower) {
        dirKeys = dirKeys.filter((key) => key.toLowerCase().includes(filterLower));
      }

      const tsSet = [...new Set(history.directory.map((r) => r.ts))].sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
      const xAxis = tsSet.map((ts) => formatDateTime(ts));

      const series = dirKeys.map((dirKey) => {
        const dataMap = new Map();
        history.directory
          .filter((r) => r.dirKey === dirKey)
          .forEach((r) => {
            const sizeGb = Number((r.sizeBytes / 1024 / 1024 / 1024).toFixed(3));
            dataMap.set(r.ts, sizeGb);
          });
          
        let lastKnown = null;
        for (const ts of tsSet) {
          if (dataMap.has(ts)) {
            lastKnown = dataMap.get(ts);
            break;
          }
        }
        
        const data = tsSet.map((ts) => {
          if (dataMap.has(ts)) {
            lastKnown = dataMap.get(ts);
          }
          return lastKnown;
        });

        return {
          name: dirKey,
          type: "line",
          smooth: true,
          connectNulls: true,
          data,
          tooltip: {
            valueFormatter: (value) => value !== null ? `${value} GB` : '--'
          }
        };
      });

      const chartDom = document.getElementById("directory-chart");
      const containerWidth = chartDom.clientWidth || (window.innerWidth - 80);
      // 估算图例每项宽度约 120px
      const itemsPerRow = Math.max(1, Math.floor(containerWidth / 120));
      const rows = Math.ceil(series.length / itemsPerRow);
      // 默认基础 grid.top 为 90，按需增加
      const topOffset = Math.max(90, rows * 24 + 40);
      
      // 绘图核心区域高度为 156px (原定 280 - 90 - 34)
      chartDom.style.height = (156 + topOffset + 34) + "px";
      directoryChart.resize();

      const option = baseChartOption("目录容量", xAxis, series, [
        {
          type: "value",
          axisLabel: {
            formatter: '{value} GB'
          }
        }
      ]);
      option.grid.top = topOffset;

      directoryChart.setOption(option, true);
    }

    function renderUserDirectoryChart() {
      userDirectoryChart = ensureChart(userDirectoryChart, "user-directory-chart");
      if (!userDirectoryChart) {
        return;
      }

      const rows = history.userDirectoryUsage ?? [];
      const owners = [...new Set(rows.map((row) => row.owner))];
      const tsSet = [...new Set(rows.map((row) => row.ts))].sort(
        (a, b) => new Date(a).getTime() - new Date(b).getTime()
      );
      const xAxis = tsSet.map((ts) => formatDateTime(ts));

      const series = owners.map((owner) => {
        const ownerMap = new Map();
        rows
          .filter((row) => row.owner === owner)
          .forEach((row) => {
            ownerMap.set(row.ts, Number(row.sizeBytes) / (1024 ** 3));
          });

        let lastKnown = null;
        const data = tsSet.map((ts) => {
          if (ownerMap.has(ts)) {
            lastKnown = ownerMap.get(ts);
          }
          return lastKnown;
        });

        return {
          name: owner,
          type: "line",
          smooth: true,
          connectNulls: true,
          data,
          tooltip: {
            valueFormatter: (value) => value !== null ? `${Number(value).toFixed(2)} GB` : "--"
          }
        };
      });

      userDirectoryChart.setOption(
        baseChartOption("用户目录占用", xAxis, series, [
          {
            type: "value",
            axisLabel: {
              formatter: "{value} GB"
            }
          }
        ]),
        true
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
      
      // 当屏幕宽度小于 1200px (变成上下堆叠布局时)，自动平滑滚动到详情面板
      if (window.innerWidth < 1200) {
        nextTick(() => {
          const detailPanel = document.getElementById("server-detail-panel");
          if (detailPanel) {
            detailPanel.scrollIntoView({ behavior: "smooth", block: "start" });
          }
        });
      }
    }

    function attachSse() {
      const eventsUrl = new URL("/api/events", window.location.href);
      eventsUrl.username = '';
      eventsUrl.password = '';
      const stream = new EventSource(eventsUrl.href);
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

    watch(ownerUsageUnit, async () => {
      await loadUserDirectoryUsageHistory();
    });

    window.addEventListener("resize", () => {
      systemChart?.resize();
      filesystemChart?.resize();
      if (directoryChart) {
        renderDirectoryChart(); // 重新计算自适应高度并重绘图表
      }
      userDirectoryChart?.resize();
    });

    document.addEventListener("fullscreenchange", () => {
      if (!document.fullscreenElement) {
        fullscreenChart.value = null;
        if (screen.orientation && screen.orientation.unlock) {
          screen.orientation.unlock();
        }
      }
    });

    onMounted(async () => {
      loadChartVisibility();
      await Promise.all([loadConfig(), loadServers()]);
      attachSse();
      if (selectedServerId.value) {
        await refreshSelectedServer();
      }
    });

    return {
      directoryFilter,
      alertRows,
      getAlertLevelMeta,
      getAlertStatusMeta,
      clearAlert,
      clearAllAlerts,
      formatBytes,
      formatDateTime,
      formatFixed,
      formatPct,
      formatSignedRate,
      formatSignedSizeBytes,
      fullscreenChart,
      hoursRange,
      chartToggleButtonType,
      chartVisibility,
      loadDirectoryHistory,
      loadFilesystemHistory,
      ownerUsageChangeRows,
      ownerUsageSortBy,
      ownerUsageSortOptions,
      ownerUsageUnit,
      ownerUsageUnitOptions,
      publicConfig,
      reloadConfig,
      refreshSelectedServer,
      selectServer,
      selectedServer,
      selectedServerId,
      servers,
      toggleChartVisibility,
      toggleFullscreen,
      visibleAlerts
    };
  }
}).use(ElementPlus).mount("#app");
