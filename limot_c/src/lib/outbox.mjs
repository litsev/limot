import { readJsonFile, writeJsonFile } from "./utils.mjs";

export async function enqueueOutbox(filePath, payload) {
  const items = (await readJsonFile(filePath, [])) ?? [];
  items.push({
    queuedAt: new Date().toISOString(),
    payload
  });
  await writeJsonFile(filePath, items);
}

export async function outboxCount(filePath) {
  const items = (await readJsonFile(filePath, [])) ?? [];
  return items.length;
}

export async function flushOutbox(filePath, maxBatch, sendBatchFn, batchSize = 1) {
  const items = (await readJsonFile(filePath, [])) ?? [];
  if (items.length === 0) {
    return { sent: 0, remaining: 0 };
  }

  const remaining = [...items];
  let sent = 0;

  while (remaining.length > 0 && sent < maxBatch) {
    const count = Math.min(batchSize, maxBatch - sent);
    const chunk = remaining.splice(0, count);
    try {
      await sendBatchFn(chunk.map(item => item.payload));
      sent += chunk.length;
    } catch {
      // 发送失败，放回队列头部
      remaining.unshift(...chunk);
      break;
    }
  }

  await writeJsonFile(filePath, remaining);
  return { sent, remaining: remaining.length };
}

