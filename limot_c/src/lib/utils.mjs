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

export async function appendLog(logPath, message) {
  await ensureDir(dirname(logPath));
  await appendFile(logPath, `[${new Date().toISOString()}] ${message}\n`, "utf8");
}

export function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}
