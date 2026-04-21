import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import YAML from "js-yaml";

export function resolveFromFile(baseFilePath, relativePath) {
  return resolve(dirname(baseFilePath), relativePath);
}

export async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true });
}

export async function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export async function readConfigFile(filePath, fallback = null) {
  try {
    const content = await readFile(filePath, "utf8");
    if (filePath.endsWith(".yaml") || filePath.endsWith(".yml")) {
      return YAML.load(content);
    } else {
      return JSON.parse(content);
    }
  } catch {
    return fallback;
  }
}

export async function writeJsonFile(filePath, value) {
  await ensureDir(dirname(filePath));
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * 获取本地时区的ISO格式时间戳（用于日志显示）
 * 例如：2026-04-19T15:30:45.123+08:00
 */
export function getLocalTimeString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const date = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  
  // 计算时区偏差（分钟）
  const tzOffset = -now.getTimezoneOffset();
  const tzHours = Math.floor(Math.abs(tzOffset) / 60);
  const tzMinutes = Math.abs(tzOffset) % 60;
  const tzSign = tzOffset >= 0 ? '+' : '-';
  const tzStr = `${tzSign}${String(tzHours).padStart(2, '0')}:${String(tzMinutes).padStart(2, '0')}`;
  
  return `${year}-${month}-${date}T${hours}:${minutes}:${seconds}.${ms}${tzStr}`;
}

export async function appendLog(logPath, message) {
  await ensureDir(dirname(logPath));
  await appendFile(logPath, `[${getLocalTimeString()}] ${message}\n`, "utf8");
}

export function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}
