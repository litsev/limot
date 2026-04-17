# Limot Monitor

一个基于 `Node.js` 的轻量级服务器实时监控系统，分为：

- `limot_s`: 服务端，负责配置管理、历史 CSV 存储、实时状态聚合和监控页面
- `limot_c`: 客户端 Agent，负责采集本机状态、按配置监控目录并安全上报

## 主要特性

- CPU、内存、负载、磁盘使用率、GPU 利用率采集
- 指定目录大小监控，目录项由服务端配置文件下发
- 历史数据按 `年份/服务器` 分目录保存为 CSV
- 页面实时总览、详情折线图、告警列表
- 客户端与服务端之间直接使用 `HTTP + JSON` 明文传输
- 服务端内置嵌入式 HTTP 服务器，无需额外反向代理即可运行

## 目录结构

所有配置文件均以 `.yaml` 结尾，配置模板文件均以 `.example` 结尾。首次使用时需要复制 `.example` 文件并重命名去掉 `.example` 后缀作为实际的配置。

```text
limot_s/
  config/
    config.yaml
    config.yaml.example
    clients/
  server/
  web/
  data/

limot_c/
  config.yaml
  config.yaml.example
  src/
  cache/
  logs/
```

## 启动方式

前提：安装 Node.js 18+。

服务端：

```bash
cd limot_s
node server/index.mjs
```

客户端：

```bash
cd limot_c
node src/index.mjs
```

浏览器访问：

```text
http://127.0.0.1:8443/
```

## 作为系统服务运行

推荐生产环境使用 `systemd` 托管服务端和客户端。

下面示例假设：

- 项目目录：`/limot`
- Node 路径：`/usr/bin/node`

如果你的环境不同，请把下面命令里的路径和用户名替换成实际值。

### 1. 安装服务端 systemd 服务

```bash
sudo tee /etc/systemd/system/limot-server.service >/dev/null <<'EOF'
[Unit]
Description=Limot Monitor Server
After=network.target
Wants=network.target

[Service]
Type=simple
User=username
WorkingDirectory=/limot/limot_s
ExecStart=/usr/bin/node /limot/limot_s/server/index.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

### 2. 安装客户端 systemd 服务

```bash
sudo tee /etc/systemd/system/limot-client.service >/dev/null <<'EOF'
[Unit]
Description=Limot Monitor Client
After=network-online.target limot-server.service
Wants=network-online.target

[Service]
Type=simple
User=root # 客户端需要 root 权限才能访问系统状态和监控目录
WorkingDirectory=/limot/limot_c
ExecStart=/usr/bin/node /limot/limot_c/src/index.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

### 3. 重新加载并启用服务

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now limot-server.service
sudo systemctl enable --now limot-client.service
```

### 4. 常用管理命令

查看状态：

```bash
sudo systemctl status limot-server.service
sudo systemctl status limot-client.service
```

重启服务：

```bash
sudo systemctl restart limot-server.service
sudo systemctl restart limot-client.service
```

停止服务：

```bash
sudo systemctl stop limot-server.service
sudo systemctl stop limot-client.service
```

开机自启：

```bash
sudo systemctl enable limot-server.service
sudo systemctl enable limot-client.service
```

取消开机自启：

```bash
sudo systemctl disable limot-server.service
sudo systemctl disable limot-client.service
```

查看日志：

```bash
sudo journalctl -u limot-server.service -f
sudo journalctl -u limot-client.service -f
```

### 5. 修改代码或配置后的操作

- 修改 `README`、前端页面、服务端代码、客户端代码后，执行对应服务重启
- 修改 `limot_s/config/config.yaml` 或 `limot_s/config/clients/*.yaml` 后，建议执行 `sudo systemctl restart limot-server.service`
- 修改 `limot_c/config.yaml` 后，建议执行 `sudo systemctl restart limot-client.service`

### 6. 卸载 systemd 服务

```bash
sudo systemctl stop limot-server.service limot-client.service
sudo systemctl disable limot-server.service limot-client.service
sudo rm -f /etc/systemd/system/limot-server.service
sudo rm -f /etc/systemd/system/limot-client.service
sudo systemctl daemon-reload
```

## 当前状态

- 已在本机完成真实联调，服务端和客户端可以直接跑通。
- 已验证服务端 HTTP、客户端配置拉取、明文上报、CSV 历史写入、告警写入和目录历史查询。
- 当前默认配置适合本机联调：
  - 服务端监听 `0.0.0.0:8443`
  - 客户端连接 `http://127.0.0.1:8443`

## 自定义 IP / 端口

如果你要改成固定业务 IP 或端口，需要同步改以下配置文件：

1. `limot_s/config/config.yaml` 里的服务端监听相关配置
2. `limot_c/config.yaml` 里的 `server_url` 等连接配置

## 注意

- 前端页面使用 CDN 形式加载 `Vue 3`、`Element Plus` 和 `ECharts`，这样不依赖本地构建工具，但运行时需要可以访问 CDN。
- 当前版本客户端与服务端之间为 HTTP 明文传输，客户端和服务器之间建议使用加密隧道传输数据，服务端使用 HTTPS 端口转发+密码访问认证对外暴露前端页面。
