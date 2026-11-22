// lib/engine/prune.js —— 清理本地旧快照（省本地磁盘），云端留底

import fs from "node:fs";
import { storeDir as storeDirOf } from "../store/paths.js";
import { listSnapshots, readManifest, snapshotDir, rebuildIndex } from "./manifest.js";
import { listBlobs } from "./blob.js";
import { listRemoteSnapshots, loadRemoteState } from "../providers/aliyun.js";
import { acquireLock, releaseLock, busyResult } from "./lock.js";

export function keepCount(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

export async function pruneLocalSnapshots(o = {}) {
  const storeDir = o.storeDir || storeDirOf();
  const keepRecent = keepCount(o.keepRecent, 5);
  const stamps = Array.isArray(o.stamps) && o.stamps.length ? o.stamps : null;
  const dryRun = o.dryRun !== false;
  const requireCloud = o.requireCloud !== false;
  const reclaim = o.reclaim !== false;
  const logger = o.logger || (() => {});

  const snaps = listSnapshots(storeDir);                 // 新的在前
  const keep = stamps ? snaps.filter((s) => !stamps.includes(s.stamp)) : snaps.slice(0, keepRecent);
  const targets = stamps ? snaps.filter((s) => stamps.includes(s.stamp)) : snaps.slice(keepRecent);

  let cloud = null, cloudError = null;
  try {
    const ls = await listRemoteSnapshots({ storeDir });
    if (ls && ls.ok) cloud = new Map((ls.snapshots || []).map((x) => [x.stamp, !!x.hasManifest]));
    else cloudError = (ls && ls.error) || "云端列举失败";
  } catch (e) { cloudError = (e && e.message) || String(e); }

  // 删除本地快照并回收数据块，必须与备份写入互斥（见 lib/engine/lock.js）。
  // dryRun 只读，不取锁，否则面板里的「预览」会在备份期间被拒。
  const lock = dryRun ? { ok: true, lockFile: null } : acquireLock(storeDir);
  if (!lock.ok) return busyResult(lock);
  try {
    const plan = [];
    let deleted = 0, freedSnapshotBytes = 0;
    for (const s of targets) {
      const man = readManifest(s.file);
      const files = man && man.files ? man.files.length : 0;
      const bytes = man && man.stats ? man.stats.bytes || 0 : 0;
      const hasCloud = cloud ? cloud.get(s.stamp) === true : false;
      let action = "delete", reason = "";
      if (requireCloud && !cloud) { action = "skip"; reason = "云端不可达，不敢删（" + cloudError + "）"; }
      else if (requireCloud && !hasCloud) { action = "skip"; reason = "云端没有这份快照的清单"; }
      plan.push({ stamp: s.stamp, files, bytes, cloudHasManifest: cloud ? hasCloud : null, action, reason });
      if (action !== "delete" || dryRun) continue;
      try {
        fs.rmSync(snapshotDir(storeDir, s.stamp), { recursive: true, force: true });
        deleted++;
        freedSnapshotBytes += bytes;
        logger("prune-local removed " + s.stamp);
      } catch (e) {
        plan[plan.length - 1].action = "failed";
        plan[plan.length - 1].reason = "删除失败: " + ((e && e.message) || e);
        logger("prune-local " + s.stamp + " failed: " + ((e && e.message) || e));
      }
    }

    const gc = { candidates: 0, deleted: 0, freedBytes: 0, keptLocalOnly: 0, skipped: false };
    if (reclaim && (dryRun || deleted > 0)) {
      let refs;
      try {
        if (dryRun) {
          // 演练模式：本地还没删，必须按「删完剩下的快照」算引用集，否则「回收数据块」永远显示 0
          refs = new Set();
          for (const s of keep) {
            const m = readManifest(s.file);
            for (const f of m && m.files ? m.files : []) refs.add(f.hash);
          }
        } else {
          refs = rebuildIndex(storeDir, { provider: "aliyun" }).refs;
        }
      } catch (e) { gc.skipped = true; gc.error = String((e && e.message) || e); }
      if (refs) {
        const remote = (loadRemoteState(storeDir) || {}).blobs || {};
        for (const b of listBlobs(storeDir)) {
          if (refs.has(b.hash)) continue;
          if (!remote[b.hash] || !remote[b.hash].file_id) { gc.keptLocalOnly++; continue; }
          gc.candidates++;
          gc.freedBytes += b.size;
          if (dryRun) { gc.deleted++; continue; }
          try { fs.unlinkSync(b.path); gc.deleted++; } catch {}
        }
      }
    }

    return {
      ok: true, dryRun, storeDir,
      localSnapshots: snaps.length,
      keep: keep.map((s) => s.stamp),
      targets: targets.map((s) => s.stamp),
      cloud: { ok: !!cloud, error: cloudError, snapshots: cloud ? cloud.size : 0 },
      plan, deleted, freedSnapshotBytes, gc,
    };
  } finally { releaseLock(lock); }
}
