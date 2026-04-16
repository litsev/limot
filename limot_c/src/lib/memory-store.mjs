import { readJsonFile, writeJsonFile } from "./utils.mjs";

/**
 * 内存信息存储模块 - 存储硬件内存配置信息
 */
export class MemoryStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = null;
  }

  /**
   * 加载内存信息
   */
  async load() {
    this.data = await readJsonFile(this.filePath, {
      totalBytes: null,
      recordedAt: null
    });
    return this.data;
  }

  /**
   * 保存内存信息
   */
  async save(totalBytes) {
    this.data = {
      totalBytes,
      recordedAt: new Date().toISOString()
    };
    await writeJsonFile(this.filePath, this.data);
    return this.data;
  }

  /**
   * 获取已保存的内存信息
   */
  getData() {
    return this.data || {
      totalBytes: null,
      recordedAt: null
    };
  }

  /**
   * 检查是否需要更新（内存信息改变时）
   */
  hasChanged(newTotalBytes) {
    return !this.data || this.data.totalBytes !== newTotalBytes;
  }
}
