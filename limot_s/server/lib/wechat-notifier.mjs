import { WeixinBot } from '@pinixai/weixin-bot';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import * as logger from './logger.mjs';

export class WechatNotifier {
  constructor(configStore, monitorStore) {
    this.configStore = configStore;
    this.monitorStore = monitorStore;
    this.bot = new WeixinBot();
    this.started = false;
    this.tokensFile = join(process.cwd(), 'data', 'wechat-tokens.json');
    this.outboxFile = join(process.cwd(), 'data', 'wechat-outbox.json');
    this.tokensInfo = {};
    this.outbox = {};
  }

  async loadTokens() {
    try {
      const content = await readFile(this.tokensFile, 'utf8');
      this.tokensInfo = JSON.parse(content);
      for (const [uid, info] of Object.entries(this.tokensInfo)) {
        this.bot.contextTokens.set(uid, info.token);
      }
      logger.info('wechat', `Loaded ${Object.keys(this.tokensInfo).length} persisted tokens.`);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        logger.error('wechat', `Failed to load tokens: ${e.message}`);
      }
    }
  }

  async saveTokens() {
    try {
      await writeFile(this.tokensFile, JSON.stringify(this.tokensInfo, null, 2), 'utf8');
    } catch (e) {
      logger.error('wechat', `Failed to save tokens: ${e.message}`);
    }
  }

  async loadOutbox() {
    try {
      const content = await readFile(this.outboxFile, 'utf8');
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object') {
        this.outbox = parsed;
      }
      logger.info('wechat', `Loaded queued messages for ${Object.keys(this.outbox).length} users.`);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        logger.error('wechat', `Failed to load outbox: ${e.message}`);
      }
    }
  }

  async saveOutbox() {
    try {
      await writeFile(this.outboxFile, JSON.stringify(this.outbox, null, 2), 'utf8');
    } catch (e) {
      logger.error('wechat', `Failed to save outbox: ${e.message}`);
    }
  }

  async enqueueFailedMessage(userId, content, reason = 'unknown') {
    if (!Array.isArray(this.outbox[userId])) {
      this.outbox[userId] = [];
    }
    this.outbox[userId].push({
      content,
      failedAt: new Date().toISOString(),
      reason
    });
    await this.saveOutbox();
    logger.info('wechat', `Queued failed message for ${userId}. queueSize=${this.outbox[userId].length}`);
  }

  async flushOutboxForUser(userId) {
    const queue = this.outbox[userId];
    if (!Array.isArray(queue) || queue.length === 0) {
      return;
    }

    logger.info('wechat', `Retrying queued messages for ${userId}, count=${queue.length}`);
    const remaining = [];

    for (const item of queue) {
      try {
        await this.bot.send(userId, item.content);
      } catch (e) {
        remaining.push(item);
        logger.error('wechat', `Retry failed for ${userId}: ${e.message}`);
      }
    }

    if (remaining.length > 0) {
      this.outbox[userId] = remaining;
    } else {
      delete this.outbox[userId];
    }
    await this.saveOutbox();
  }

  startExpiryChecker() {
    setInterval(async () => {
      if (!this.started) return;
      const now = Date.now();
      const subs = this.configStore.getConfig().wechat?.subscribers || [];
      for (const uid of subs) {
        const info = this.tokensInfo[uid];
        if (info && info.updatedAt) {
          const ageHours = (now - info.updatedAt) / (1000 * 60 * 60);
          // 距离24小时过期还有不到2小时，且过去2小时内没发过警告
          if (ageHours >= 22 && ageHours < 24) {
            if (!info.warnedAt || (now - info.warnedAt > 2 * 3600 * 1000)) {
              try {
                await this.bot.send(uid, "⚠️ 推送通道将在2小时后过期，请回复任意内容（如 ping）保持激活。");
                info.warnedAt = now;
                this.saveTokens();
              } catch (e) {}
            }
          }
        }
      }
    }, 10 * 60 * 1000); // 每 10 分钟检测一次
  }

  async start() {
    if (this.started) return;
    try {
      await this.loadTokens();
      await this.loadOutbox();

      // 劫持代理 SDK 内部保存 Token 的逻辑，以便它改变时自动备份
      const originalSet = this.bot.contextTokens.set.bind(this.bot.contextTokens);
      this.bot.contextTokens.set = (key, value) => {
        originalSet(key, value);
        this.tokensInfo[key] = { token: value, updatedAt: Date.now() };
        this.saveTokens();
        return this.bot.contextTokens;
      };

      await this.bot.login();
      logger.info('wechat', 'Bot logged in successfully.');
      
      this.bot.onMessage(async (msg) => {
        const text = (msg.text || '').trim();
        logger.info('wechat', `收到来自 ${msg.userId} 的消息: ${text}`);

        await this.flushOutboxForUser(msg.userId);
        
        if (text === 'userid' || text === 'id') {
          await this.bot.reply(msg, `你的 userId 为: ${msg.userId}\n请配置到 config.yaml 的 wechat.subscribers 中。`);
        } else if (text === 's') {
          const servers = this.monitorStore.getServerSummaries();
          if (!servers || servers.length === 0) {
            await this.bot.reply(msg, "当前没有接入的服务器节点数据。");
          } else {
            const lines = ["📊 节点总览状态：\n"];
            for (const s of servers) {
              const state = s.online ? "🟢 在线" : "🔴 离线";
              const alertCount = s.currentAlerts?.filter(a => a.status === 'active').length || 0;
              const alertMark = alertCount > 0 ? ` | ⚠️ ${alertCount}告警` : "";
              lines.push(`【${s.id}】${state}${alertMark}`);
              
              const sys = s.system;
              if (sys) {
                const load = sys.load ? `${Number(sys.load.one).toFixed(2)}/${Number(sys.load.five).toFixed(2)}/${Number(sys.load.fifteen).toFixed(2)}/${Number(sys.load.perCore).toFixed(2)}` : '--';
                const cpu = sys.cpu?.pct != null ? `${Number(sys.cpu.pct).toFixed(1)}%` : '--';
                const temp = sys.cpu?.tempC != null ? `${sys.cpu.tempC}°C` : '--';
                const mem = sys.memory?.pct != null ? `${Number(sys.memory.pct).toFixed(1)}%` : '--';
                lines.push(` ├ 负载: ${load}`);
                lines.push(` ├ CPU: ${cpu} (${temp}) | 内存: ${mem}`);
              }
              if (s.gpu?.devices?.length > 0) {
                s.gpu.devices.forEach(d => {
                  lines.push(` ├ GPU${d.index}: ${d.utilizationPct}% (显存${d.memoryPct}%, ${d.temperatureC}°C)`);
                });
              }
              if (s.filesystems?.length > 0) {
                const fsLines = s.filesystems.map(fs => `${fs.mount}: ${fs.usedPct != null ? fs.usedPct + '%' : '--'}`).join(', ');
                lines.push(` └ 磁盘: ${fsLines}`);
              } else {
                lines.push(` └ 磁盘: --`);
              }
              lines.push(""); // 分隔不同节点
            }
            await this.bot.reply(msg, lines.join("\n").trim());
          }
        } else {
          await this.bot.reply(msg, "🟢 LIMOT 监控服务端已成功启动并保持在线，通信通道已激活！\n您可以发送 s 获取节点状态。");
        }
      });

      this.bot.run().catch(err => {
        logger.error('wechat', `Bot run loop exited: ${err.message}`);
      });
      this.started = true;
      this.startExpiryChecker();
      
      // 服务端启动后，如果 persisted context_token 没有过期 (24小时内)，自动发送启动通知
      const now = Date.now();
      const subs = this.configStore.getConfig().wechat?.subscribers || [];
      for (const uid of subs) {
        const info = this.tokensInfo[uid];
        if (info && info.updatedAt && (now - info.updatedAt < 24 * 3600 * 1000)) {
          try {
            await this.bot.send(uid, "🟢 LIMOT 监控服务端已成功启动/重启，通信通道已从持久化中恢复！");
          } catch (err) {
            logger.error('wechat', `Failed to send startup message to ${uid}: ${err.message}`);
          }
        }
      }
    } catch (e) {
      logger.error('wechat', `Bot fail to start: ${e.message}`);
    }
  }

  async notify(content) {
    if (!this.started) return;
    
    const config = this.configStore.getConfig();
    const subs = config.wechat?.subscribers || [];
    if (!Array.isArray(subs) || subs.length === 0) return;

    for (const userId of subs) {
      try {
        logger.info('wechat', `Sending alert to ${userId}`);
        await this.bot.send(userId, content);
        logger.info('wechat', `Successfully sent alert to ${userId}`);
      } catch (e) {
        logger.error('wechat', `Send fail to ${userId}: ${e.message}`);
        await this.enqueueFailedMessage(userId, content, e.message);
      }
    }
  }
}
