# 客户端启动配置
version: 1

# 客户端标识
clientId: "pc"

# 监控服务器地址
serverBaseUrl: "http://10.0.0.1:443"

# 请求超时时间（毫秒）
requestTimeoutMs: 10000

# 备用运行时配置（服务器不可用时使用）
fallbackRuntimeConfig:
  # 系统指标采样间隔（秒）
  sampleIntervalSec: 10
  # 目录占用空间扫描间隔（秒）
  directoryScanIntervalSec: 180
  # 配置拉取间隔（秒）
  configPullIntervalSec: 60
  # 心跳检测间隔（秒）
  heartbeatIntervalSec: 10
  # 单次上报最大数据条数
  reportBatchMax: 50

  # 告警阈值配置
  thresholds:
    # CPU使用率警告阈值（%）
    cpuWarn: 85
    # 内存使用率警告阈值（%）
    memWarn: 90
    # 磁盘使用率警告阈值（%）
    diskWarn: 85
    # 单核负载警告阈值
    load1PerCoreWarn: 0.8
    # GPU使用率警告阈值（%）
    gpuWarn: 95

  # 文件系统配置
  filesystems:
    # 包含的挂载点列表
    includeMounts:
      - /
    # 排除的文件系统类型
    excludeFsTypes:
      - tmpfs
      - devtmpfs
      - overlay
      - squashfs

  # 需要监控的目录列表
  directories:
    - path: /home/admin
      exclude:
        - lost+found
      warnGB: 50
      timeoutSec: 300
      scanIntervalSec: 180
