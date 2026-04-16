# 监控系统配置文件
version: 1

# 服务器配置
server:
  # 服务器绑定地址
  host: 10.0.0.1
  # 服务器端口
  port: 443

# 默认配置（所有客户端的基础配置）
defaults:
  # 系统指标采样间隔（秒）
  sampleIntervalSec: 10
  # 目录占用空间扫描间隔（秒）
  directoryScanIntervalSec: 180
  # 客户端配置拉取间隔（秒）
  configPullIntervalSec: 60
  # 心跳检测间隔（秒）
  heartbeatIntervalSec: 10
  # 单次上报最大数据条数
  reportBatchMax: 50
  # 默认的目录空间警告阈值（GB）
  warnGB: 500
