// 本机写操作互斥：备份「先写块、后写清单」，两段之间若块回收在跑会把新块当孤儿删掉。

import fs from "node:fs";
import path from "node:path";

const LOCK_NAME = ".run-lock";
const STALE_MS = 30 * 60 * 1000;

function writeLock(lockFile) {
  const fd = fs.openSync(lockFile, "wx");
  fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  fs.closeSync(fd);
}

/** 取锁；返回 { ok:true, lockFile } 或 { ok:false, reason }（超 30 分钟视为遗留锁） */
export function acquireLock(storeDir) {
  const lockFile = path.join(storeDir, LOCK_NAME);
  try { fs.mkdirSync(storeDir, { recursive: true }); } catch { /* 目录已存在 */ }
  try {
    writeLock(lockFile);
    return { ok: true, lockFile };
  } catch {
    let age = 0;
    try { age = Date.now() - fs.statSync(lockFile).mtimeMs; } catch { /* 锁刚被释放 */ }
    if (age > STALE_MS) {
      try { fs.unlinkSync(lockFile); } catch { /* 已被他人清理 */ }
      try { writeLock(lockFile); return { ok: true, lockFile, stale: true }; } catch { /* 竞争失败 */ }
    }
    return { ok: false, reason: "another write in progress (" + Math.round(age / 1000) + "s)" };
  }
}

export function releaseLock(lock) {
  if (!lock || !lock.lockFile) return;
  try { fs.unlinkSync(lock.lockFile); } catch { /* 已被清理 */ }
}

/** 给「忙」统一一个可读的响应，避免面板把锁冲突当成删除失败 */
export function busyResult(lock) {
  return {
    ok: false,
    code: "busy",
    reason: "busy",
    error: "正在备份，请稍后再试（" + String((lock && lock.reason) || "写入进行中") + "）",
  };
}
