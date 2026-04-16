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

export async function flushOutbox(filePath, maxBatch, sendFn) {
  const items = (await readJsonFile(filePath, [])) ?? [];
  if (items.length === 0) {
    return {
      sent: 0,
      remaining: 0
    };
  }

  const remaining = [...items];
  let sent = 0;

  while (remaining.length > 0 && sent < maxBatch) {
    try {
      await sendFn(remaining[0].payload);
      remaining.shift();
      sent += 1;
    } catch {
      break;
    }
  }

  await writeJsonFile(filePath, remaining);
  return {
    sent,
    remaining: remaining.length
  };
}

