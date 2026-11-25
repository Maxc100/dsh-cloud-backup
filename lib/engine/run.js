// lib/engine/run.js —— 一次备份流水线（本地部分 + 可选上传）

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { storeDir as storeDirOf, dshHome } from "../store/paths.js";
import { loadConfig } from "../store/config.js";
import { saveState } from "../store/state.js";
import { collectFiles } from "./collect.js";
import { logInfo, logWarn } from "../util/log.js";
import { putBlob, sha256File, gcBlobs, listBlobs } from "./blob.js";
import { buildManifest, writeManifest, stampNow, listSnapshots, snapshotDir, readManifest, rebuildIndex } from "./manifest.js";
import { pruneList } from "./rotation.js";
import { listRetryStamps, uploadBackup } from "./backups.js";
import { collectPluginPacks } from "./plugin-packs.js";
import { detectHost } from "./host-info.js";
import { acquireLock, releaseLock } from "./lock.js";

export async function runBackup(opts = {}) {
  const cfg = opts.config || loadConfig();
  const log = typeof opts.logger === "function" ? opts.logger : () => {};
  const storeDir = storeDirOf();
  const home = dshHome();
  const t0 = Date.now();
  const lock = acquireLock(storeDir);
  if (!lock.ok) { log("skip: " + lock.reason); return { ok: false, reason: lock.reason }; }

  try {
    // cfg.enabled 只控制“自动备份”；手动触发的备份不受它拦截
    const manualRun = opts.trigger === "manual" || opts.trigger === "force";
    if (cfg.enabled === false && !manualRun) { log("skip: disabled by config"); return { ok: false, reason: "disabled" }; }

    const col = collectFiles({ dshHome: home, config: cfg });
    log("collect: " + col.stats.count + " files / " + (col.stats.bytes / 1048576).toFixed(2) + " MB, skipped " + col.stats.skipped);

    // 2) 内容寻址落盘（同 hash 只写一次）
    let created = 0, reused = 0, newBytes = 0;
    const hashByAbs = new Map();
    for (const f of col.files) {
      let h = hashByAbs.get(f.abs);
      if (!h) { h = sha256File(f.abs); hashByAbs.set(f.abs, h); }
      const r = putBlob(storeDir, f.abs, { hash: h });
      f.hash = r.hash;
      if (r.created) { created++; newBytes += r.size; } else reused++;
    }
    log("blobs: " + created + " new / " + reused + " reused / +" + (newBytes / 1048576).toFixed(2) + " MB");

    let stamp = stampNow();
    for (let i = 0; i < 5 && fs.existsSync(snapshotDir(storeDir, stamp)); i++) {
      await new Promise((r) => setTimeout(r, 1050 - (Date.now() % 1000)));
      stamp = stampNow();
    }
    let pluginMeta = null;
    if (cfg.packPlugins !== false) {
      try {
        const packs = await collectPluginPacks({
          dshHome: home,
          maxBytes: Number(cfg.maxPluginPackMB || 20) * 1024 * 1024,
          maxCount: Number(cfg.maxPluginPacks == null ? 20 : cfg.maxPluginPacks),
          onPack: (entry) => { const r = putBlob(storeDir, entry.tgzPath, { hash: entry.blob }); if (r && r.created) { created++; newBytes += r.size; } else { reused++; } },
        });
        pluginMeta = packs.plugins.map((p) => { const copy = { ...p }; delete copy.tgzPath; return copy; });
        log("plugins: " + packs.stats.packed + " packed / " + packs.stats.specOnly + " spec-only / " + packs.stats.skipped + " skipped");
      } catch (e) {
        logWarn("plugin.pack.error", { error: String((e && e.message) || e) });
      }
    }
    const manifest = buildManifest({
      files: col.files, stamp, workspace: cfg.workspace || "all", dshHome: home,
      host: os.hostname(), provider: "aliyun", skipped: col.stats.skipped, plugins: pluginMeta,
      runtime: detectHost({ dshHome: home, argv: process.argv, env: process.env, versions: process.versions }),
    });
    const mfPath = writeManifest(storeDir, manifest);
    const { refs } = rebuildIndex(storeDir, { provider: "aliyun" });
    log("snapshot: " + stamp + " -> " + (manifest.stats.bytes / 1048576).toFixed(2) + " MB logical, " + manifest.stats.unique_blobs + " unique blobs");

    // 4) GFS 剪枝（只删快照清单目录，不碰 blob）
    const stamps = listSnapshots(storeDir).map((s) => s.stamp);
    const doomed = pruneList(stamps, {
      recentKeep: cfg.recentKeep, dailyKeep: cfg.dailyKeep, weeklyKeep: cfg.weeklyKeep, monthlyKeep: cfg.monthlyKeep,
    }).filter((s) => s !== stamp);
    for (const s of doomed) {
      try { fs.rmSync(snapshotDir(storeDir, s), { recursive: true, force: true }); log("pruned snapshot " + s); } catch (e) { log("prune failed " + s + ": " + e.message); }
    }

    const { refs: liveRefs, broken } = rebuildIndex(storeDir, { provider: "aliyun" });
    let gc = { deleted: 0, freed: 0, total: listBlobs(storeDir).length, skipped: false };
    if (broken && broken.length) {
      gc.skipped = "broken-manifests";
      log("gc skipped: " + broken.length + " 份快照清单无法解析（" + broken.slice(0, 3).join(",") + "），为避免误删数据块跳过回收");
    } else if (!liveRefs || liveRefs.size === 0) {
      gc.skipped = "empty-refset";
      log("gc skipped: 清单没有任何引用（0 文件快照或清单缺失），跳过回收");
    } else {
      gc = gcBlobs(storeDir, liveRefs);
      if (gc.deleted) log("gc: " + gc.deleted + " blobs / " + (gc.freed / 1048576).toFixed(2) + " MB freed, " + (gc.total - gc.deleted) + " kept");
    }

    const wantUpload = opts.forceUpload === true || cfg.autoUpload === true;
    let upload = { ok: null, skipped: "no-uploader" };
    if (wantUpload && typeof opts.uploader === "function") {
      try {
        const blobs = [...(manifest.files || []).reduce((m, f) => m.set(f.hash, true), new Map()).keys()];
        for (const p of manifest.plugins || []) { if (p && p.blob) blobs.push(p.blob); }
        upload = await opts.uploader({ storeDir, snapshot: { stamp, manifestPath: mfPath }, manifest, blobs, logger: log });
      } catch (e) {
        upload = {
          ok: false,
          error: String((e && e.message) || e),
          uploaded: Number.isFinite(e && e.uploaded) ? e.uploaded : null,
          total: Number.isFinite(e && e.total) ? e.total : null,
        };
        log("upload failed: " + upload.error);
      }
    } else if (wantUpload) {
      upload = { ok: null, skipped: "not-configured" };
    }

    // 顺带重传：把最近若干份「本地有、云端没有」的快照补传上去（不阻断本次结果）
    const retried = [];
    const retryMax = Number.isFinite(cfg.retryFailed) ? cfg.retryFailed : 3;
    if (wantUpload && retryMax > 0) {
      try {
        const stamps = await listRetryStamps({ storeDir, limit: retryMax, exclude: stamp });
        for (const s2 of stamps) {
          try {
            const r2 = await uploadBackup({ storeDir, stamp: s2, logger: log });
            retried.push({ stamp: s2, ok: r2.ok !== false, error: r2.error || null });
            log("retry upload " + s2 + ": " + (r2.ok === false ? "failed" : "ok"));
          } catch (e) {
            retried.push({ stamp: s2, ok: false, error: String((e && e.message) || e) });
            log("retry upload " + s2 + " failed: " + retried[retried.length - 1].error);
          }
        }
      } catch (e) { log("retry upload scan failed: " + String((e && e.message) || e)); }
    }

    const durationMs = Date.now() - t0;
    logInfo("backup.done", { stamp, files: manifest.stats.files, newBlobs: created, reusedBlobs: reused, durationMs, trigger: opts.trigger || "manual", uploadOk: upload && upload.ok, uploadSkipped: upload && upload.skipped, uploadError: upload && upload.error, gcSkipped: gc && gc.skipped });
    const result = {
      ok: true, snapshot: stamp, files: manifest.stats.files, bytes: manifest.stats.bytes,
      uniqueBlobs: manifest.stats.unique_blobs, newBlobs: created, reusedBlobs: reused, newBytes,
      pruned: doomed.length, gcDeleted: gc.deleted, gcFreed: gc.freed, upload, retried, durationMs, trigger: opts.trigger || "manual",
    };
    saveState({ last_backup: { at: new Date().toISOString(), ...result, upload } });
    log("done in " + (durationMs / 1000).toFixed(1) + "s");
    return result;
  } finally {
    releaseLock(lock);
  }
}

/** 只读体检：快照数、blob 数、被引用 blob 是否都还在（不修，只报告）。 */
export function auditStore(storeDir = storeDirOf()) {
  const snaps = listSnapshots(storeDir);
  const refs = new Set();
  let missing = 0, badManifests = 0;
  for (const s of snaps) {
    const m = readManifest(s.file);
    if (!m) { badManifests++; continue; }
    for (const f of m.files || []) {
      refs.add(f.hash);
      if (!fs.existsSync(path.join(storeDir, "objects", "blobs", f.hash.slice(0, 2), f.hash.slice(2, 4), f.hash.slice(4)))) missing++;
    }
  }
  const blobs = listBlobs(storeDir);
  let bytes = 0;
  for (const b of blobs) bytes += b.size;
  return { snapshots: snaps.length, blobs: blobs.length, blobBytes: bytes, referenced: refs.size, missingFiles: missing, badManifests };
}
