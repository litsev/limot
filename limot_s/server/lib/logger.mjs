/**
 * 服务端日志输出工具 - 统一使用本地时区时间戳
 */

/**
 * 获取本地时区的ISO格式时间戳
 * 例如：2026-04-19T15:30:45.123+08:00
 */
function getLocalTimeString() {
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

export function info(tag, message) {
  console.log(`[${getLocalTimeString()}] [${tag}] ${message}`);
}

export function error(tag, message, err = null) {
  if (err) {
    console.error(`[${getLocalTimeString()}] [${tag}] ${message}`, err);
  } else {
    console.error(`[${getLocalTimeString()}] [${tag}] ${message}`);
  }
}

export function warn(tag, message) {
  console.warn(`[${getLocalTimeString()}] [${tag}] ${message}`);
}

export function debug(tag, message) {
  console.log(`[${getLocalTimeString()}] [DEBUG] [${tag}] ${message}`);
}
