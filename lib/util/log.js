// 结构化运行日志：单文件追加 + 2 MB 轮转 + 内存尾缓冲，供「打开日志」与 GET /logs 读取。

import fs from "node:fs";
import path from "node:path";
import { storeDir } from "../store/paths.js";

const MAX_BYTES = 2 * 1024 * 1024;
const TAIL_KEEP = 400;
const tail = [];

export function logDir() {
  return path.join(storeDir(), "logs");
}

export function logPath() {
  return path.join(logDir(), "cloud-backup.log");
}

function rotateIfNeeded() {
  try {
    const st = fs.statSync(logPath());
    if (st.size <= MAX_BYTES) return;
    const old = logPath() + ".1";
    try { fs.unlinkSync(old); } catch {}
    fs.renameSync(logPath(), old);
  } catch {}
}

// 敏感值兜底：日志会经 /logs 与「打开日志」外露，任何令牌形态的值都要在落盘前抹掉。
const SECRET_KEY = /(token|secret|password|passwd|authorization|cookie|signature|accesskey)/i;
const SECRET_PATTERNS = [
  /((?:access_token|refresh_token|token|signature|Signature|OSSAccessKeyId|security-token|x-oss-signature|sig)=)[^&\s"',]+/g,
  /(Bearer\s+)[A-Za-z0-9._\-]{8,}/g,
  /((?:access_token|refresh_token|token|password)["']?\s*:\s*["'])[^"']+/g,
];

export function redact(text) {
  let s = String(text === null || text === undefined ? "" : text);
  for (const re of SECRET_PATTERNS) s = s.replace(re, "$1***");
  return s;
}

function fmt(v) {
  if (v === null || v === undefined) return "-";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Error) return JSON.stringify({ message: v.message, code: v.code || undefined });
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return /[\s"=]/.test(s) ? JSON.stringify(s) : s;
}

export function logEvent(level, event, fields) {
  const at = new Date().toISOString();
  let line = at + " " + String(level || "info").toUpperCase().padEnd(5) + " " + event;
  if (fields && typeof fields === "object") {
    for (const k of Object.keys(fields)) {
      if (fields[k] === undefined) continue;
      line += " " + k + "=" + (SECRET_KEY.test(k) ? "***" : redact(fmt(fields[k])));
    }
  }
  tail.push(line);
  if (tail.length > TAIL_KEEP) tail.length = TAIL_KEEP;
  try {
    fs.mkdirSync(logDir(), { recursive: true });
    rotateIfNeeded();
    fs.appendFileSync(logPath(), line + "\n", "utf8");
  } catch {}
  return line;
}

export function logInfo(event, fields) { return logEvent("info", event, fields); }
export function logWarn(event, fields) { return logEvent("warn", event, fields); }
export function logError(event, fields) { return logEvent("error", event, fields); }

export function tailLines(n) {
  const want = Math.max(1, Math.min(2000, Number(n) || 200));
  try {
    const txt = fs.readFileSync(logPath(), "utf8");
    return txt.split(/\r?\n/).filter(Boolean).slice(-want);
  } catch (e) {
    return tail.slice(-want);
  }
}

export function logStats() {
  let bytes = 0;
  let rotatedBytes = 0;
  try { bytes = fs.statSync(logPath()).size; } catch {}
  try { rotatedBytes = fs.statSync(logPath() + ".1").size; } catch {}
  return { dir: logDir(), file: logPath(), bytes, rotatedBytes };
}

// 下载完成度自检：块数与字节数两条线必须自洽，偏差写日志供排查
export function checkDownloadConsistency(p) {
  const issues = [];
  const total = Number(p && p.total) || 0;
  const done = Number(p && p.done) || 0;
  const needBytes = Number(p && p.needBytes) || 0;
  const bytes = Number(p && p.bytes) || 0;
  if (done > total) issues.push("done exceeds total");
  if (needBytes > 0 && bytes > needBytes * 1.02) issues.push("bytes exceed needBytes by >2%");
  if (total > 0 && done === total && needBytes > 0 && bytes < needBytes * 0.98) issues.push("done complete but bytes short by >2%");
  // 块大小差异可达上千倍（小会话文件 vs 大二进制），块百分比与字节百分比天然不同步，不作告警
  const pctByBlocks = total > 0 ? Math.round((done / total) * 100) : 0;
  const pctByBytes = needBytes > 0 ? Math.round((bytes / needBytes) * 100) : pctByBlocks;
  if (issues.length) logWarn("pull.consistency", { total, done, needBytes, bytes, issues: issues.join("; ") });
  return { ok: issues.length === 0, issues, pctByBlocks, pctByBytes };
}
