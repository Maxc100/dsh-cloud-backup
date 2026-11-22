/**
 */
import fs from "node:fs";
import path from "node:path";
import { storeDir as storeDirOf } from "../store/paths.js";
import { loadState } from "../store/state.js";
import { listSnapshots, readManifest, manifestPath, snapshotDir, rebuildIndex } from "./manifest.js";
import { gcBlobs, listBlobs } from "./blob.js";
import { acquireLock, releaseLock, busyResult } from "./lock.js";
import { logWarn } from "../util/log.js";
import {
  cachedRemoteSnapshots,
  listRemoteSnapshots,
  pruneRemoteSnapshots,
  getBackupIndex,
  upsertBackupIndex,
  syncSnapshot,
  getRemoteManifest,
  classifyCloudError,
} from "../providers/aliyun.js";

/** 某个本地缓存目录占多少字节（缓存清理的展示用，容忍失败）。 */
export function localCacheBytes(storeDir, stamp) {
  storeDir = storeDir || storeDirOf();
  let total = 0;
  const walk = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else { try { total += fs.statSync(p).size; } catch { /* 忽略 */ } }
    }
  };
  walk(snapshotDir(storeDir, stamp));
  return total;
}

export async function listBackups({ storeDir, fresh = false } = {}) {
  storeDir = storeDir || storeDirOf();
  const localSnaps = listSnapshots(storeDir);
  const localSet = new Set(localSnaps.map((s) => s.stamp));
  const localMeta = new Map();
  const cacheBytes = new Map();
  for (const s of localSnaps) {
    const m = readManifest(manifestPath(storeDir, s.stamp));
    localMeta.set(s.stamp, m ? (function () {
      const list = m.plugins || [];
      const per = {};
      let packed = 0;
      for (const p of list) {
        if (p && p.state === "packed") packed += 1;
        for (const pf of ((p && p.profiles) || [])) per[pf] = (per[pf] || 0) + 1;
      }
      return { files: (m.files || []).length, bytes: m.stats?.bytes ?? 0, createdAt: m.created_at || null,
        plugins: list.length, pluginPacked: packed, pluginProfiles: per,
        hostProfile: (m.runtime && m.runtime.profile) || null };
    })() : null);
    cacheBytes.set(s.stamp, localCacheBytes(storeDir, s.stamp));
  }

  const [cloud, idx] = await Promise.all([
    listRemoteSnapshots({ storeDir, fresh }).catch((e) => {
      const msg = (e && e.message) || String(e);
      const kind = classifyCloudError(e);
      // 面板只说人话，原始报错留在这里备查（「更多 → 打开日志」）
      logWarn("cloud.list.failed", { kind, error: msg });
      return { ok: false, snapshots: [], error: msg, errorKind: kind };
    }),
    getBackupIndex({ fresh }).catch((e) => ({ ok: false, entries: {}, error: (e && e.message) || String(e) })),
  ]);
  const cloudOk = !!cloud.ok;
  const cloudKind = cloudOk ? null : (cloud.errorKind || "network");
  // 云端读不到时：先退回「最近一次成功列举到的集合」判断各行的真实状态；
  // 连这份缓存都没有，才把行标成 unknown（并且绝不改写成"未同步"——那是在替云端下结论）
  const knownCloud = cloudOk ? null : cachedRemoteSnapshots(storeDir);
  const stampSet = (list) => new Set((list || []).filter((s) => s.hasManifest).map((s) => s.stamp));
  const cloudStamps = stampSet(cloud.snapshots);
  const knownStamps = stampSet(((knownCloud && knownCloud.snapshots) || []));
  const effStamps = cloudOk ? cloudStamps : knownStamps;
  const cloudListUsable = cloudOk || knownStamps.size > 0;
  const entries = (idx && idx.entries) || {};
  const lastBackup = (loadState().last_backup || null);

  const all = new Set([...localSet, ...cloudStamps]);
  const items = [];
  for (const stamp of all) {
    const inCloud = effStamps.has(stamp);
    const hasCache = localSet.has(stamp);
    const meta = entries[stamp] || null;
    const lm = localMeta.get(stamp) || null;
    const upErr = lastBackup && lastBackup.snapshot === stamp && lastBackup.upload && lastBackup.upload.ok === false
      ? String(lastBackup.upload.error || "upload failed")
      : null;
    items.push({
      stamp,
      state: upErr ? "failed" : (inCloud ? "uploaded" : (cloudListUsable ? "pending" : "unknown")),
      cloudKnown: cloudListUsable,
      inCloud,
      hasCache,
      uploadError: upErr,
      files: meta && Number.isFinite(meta.files) ? meta.files : (lm ? lm.files : null),
      bytes: meta && Number.isFinite(meta.bytes) ? meta.bytes : (lm ? lm.bytes : null),
      createdAt: (meta && meta.created_at) || (lm && lm.createdAt) || null,
      uploadedAt: (meta && meta.uploaded_at) || null,
      cacheBytes: cacheBytes.get(stamp) || 0,
      plugins: meta && Number.isFinite(meta.plugins) ? meta.plugins : (lm && lm.plugins != null ? lm.plugins : null),
      hostProfile: (lm && lm.hostProfile) || null,
      pluginPacked: lm && Number.isFinite(lm.pluginPacked) ? lm.pluginPacked : null,
      pluginProfiles: (lm && lm.pluginProfiles) || null,
    });
  }
  items.sort((a, b) => (a.stamp < b.stamp ? 1 : -1));

  const needMeta = items.filter((x) => x.inCloud && (x.files == null || x.bytes == null)).slice(0, 3);
  if (needMeta.length) {
    const patch = {};
    for (const x of needMeta) {
      try {
        const got = await getRemoteManifest(x.stamp, { storeDir });
        const man = got && got.manifest;
        const st = (man && man.stats) || {};
        const mFiles = Number.isFinite(st.files) ? st.files
          : (man && Array.isArray(man.files) ? man.files.length : null);
        const mBytes = Number.isFinite(st.bytes) ? st.bytes
          : (man && Array.isArray(man.files)
            ? man.files.reduce((n, f) => n + (Number.isFinite(f && f.size) ? f.size : 0), 0)
            : null);
        if (man && Number.isFinite(mFiles) && Number.isFinite(mBytes)) {
          x.files = mFiles;
          x.bytes = mBytes;
          if (!x.createdAt && man.created_at) x.createdAt = man.created_at;
          if (!x.uploadedAt && man.uploaded_at) x.uploadedAt = man.uploaded_at;
          patch[x.stamp] = {
            files: mFiles, bytes: mBytes,
            created_at: man.created_at || x.createdAt || null,
            uploaded_at: man.uploaded_at || x.uploadedAt || null,
          };
        }
      } catch (e) { /* 读不到就算了 */ }
    }
    if (Object.keys(patch).length) { try { await upsertBackupIndex(patch); } catch (e) { /* 索引写失败不影响本次展示 */ } }
  }

  const totals = {
    backups: items.filter((x) => x.state === "uploaded").length,
    pending: items.filter((x) => x.state === "pending").length,
    failed: items.filter((x) => x.state === "failed").length,
    nosync: items.filter((x) => x.state === "unknown").length,
    cloudBytes: items.reduce((n, x) => n + (x.state === "uploaded" && Number.isFinite(x.bytes) ? x.bytes : 0), 0),
    cacheCopies: items.filter((x) => x.hasCache).length,
    cacheBytes: items.reduce((n, x) => n + (x.cacheBytes || 0), 0),
  };
  return { ok: true, items, totals, cloudOk, cloudUnknown: !cloudOk,
    cloud: { ok: cloudOk, error: cloud.error || null, errorKind: cloudKind,
      cached: !cloudOk && knownStamps.size > 0, cachedAt: (knownCloud && knownCloud.cachedAt) || null },
    index: { ok: !!idx.ok, error: idx.error || null } };
}

/**
 */
export async function deleteBackup({ storeDir, stamp, dryRun = true, allowLast = false, logger = () => {} } = {}) {
  storeDir = storeDir || storeDirOf();
  if (!stamp) return { ok: false, error: "缺少 stamp" };
  const hasCache = listSnapshots(storeDir).some((s) => s.stamp === stamp);
  const cacheBytes = hasCache ? localCacheBytes(storeDir, stamp) : 0;

  // 是不是“云端最后一份”：必须在真正删除之前算出来，否则保护形同虚设。
  let lastCloudCopy = false;
  try {
    const cl = await listRemoteSnapshots({ fresh: true });
    if (!cl || cl.ok === false) throw new Error((cl && cl.error) || "无法列举云端快照");
    const stamps = new Set(((cl.snapshots) || []).filter((x) => x.hasManifest).map((x) => x.stamp));
    lastCloudCopy = stamps.size <= 1 && stamps.has(stamp);
  } catch (e) {
    // 无法确认云端还剩几份时保守当作“最后一份”，避免误删唯一副本
    lastCloudCopy = true;
    logger("last-cloud-copy check failed: " + ((e && e.message) || e));
  }
  if (lastCloudCopy && !allowLast) {
    return {
      ok: false,
      code: "lastCloudCopy",
      error: "这是云端最后一份备份" + (dryRun ? "；确认要删请带 allowLast:true（会清空云端备份）" : "，已拒绝删除（需 allowLast:true）"),
      lastCloudCopy: true,
      dryRun,
      hasCache,
      cacheBytes,
    };
  }

  const remote = await pruneRemoteSnapshots({
    storeDir,
    stamps: [stamp],
    dryRun,
    allowLocalCopy: true,          // 新语义：本地就是缓存，和云一起删
    allowLastCopy: allowLast,      // 最后一份仍要显式放行
    logger,
  }).catch((e) => ({ ok: false, error: (e && e.message) || String(e) }));

  const cloudRow = !!remote.ok ? (remote.plan || []).find((p) => p.stamp === stamp) || null : null;
  // 快照体积：本地清单优先，其次用云端扫描结果（只存云端、本机无缓存时也要能报出真实大小）
  const lman = hasCache ? (readManifest(manifestPath(storeDir, stamp)) || null) : null;
  const sizeBytes = (lman && lman.stats && Number.isFinite(lman.stats.bytes)) ? lman.stats.bytes
    : (cloudRow && Number.isFinite(cloudRow.bytes) ? cloudRow.bytes : null);
  const plan = {
    stamp,
    cloud: cloudRow,
    hasCache,
    cacheBytes,
    lastCloudCopy,
    bytes: sizeBytes,
    files: (lman && Array.isArray(lman.files)) ? lman.files.length
      : (cloudRow && Number.isFinite(cloudRow.files) ? cloudRow.files : null),
  };

  // 本机与云端都不存在：直接报「不存在」，不要返回成功
  const remoteRow = plan.cloud;
  const remoteMissing = !!remoteRow && remoteRow.action === "skip" && /云端没有这份快照/.test(String(remoteRow.reason || ""));
  if (!hasCache && !remoteRow) return { ok: false, code: "notFound", error: "快照不存在（本机与云端都没有）：" + stamp, plan };
  if (!hasCache && remoteMissing) return { ok: false, code: "notFound", error: "快照不存在（本机与云端都没有）：" + stamp, plan };

  const lastRefusal = !remote.ok && /最后一份/.test(String(remote.error || ""));
  if (!remote.ok && !(dryRun && lastRefusal)) return { ok: false, error: remote.error || "删除云端失败", plan };
  if (dryRun) {
    return { ok: true, dryRun: true, plan: Object.assign({}, plan, { lastCloudCopy: plan.lastCloudCopy || lastRefusal, lastError: lastRefusal ? remote.error : null }), remote };
  }

  // 云端删成功（或本来就不在云端）→ 再清本地缓存。
  // 本地删除与数据块回收必须与备份写入互斥（见 lib/engine/lock.js），
  // 否则可能清掉备份刚写入、清单还没落盘的块。
  const lock = acquireLock(storeDir);
  if (!lock.ok) return busyResult(lock);
  try {
    let cacheDeleted = false;
    if (hasCache) {
      try { fs.rmSync(snapshotDir(storeDir, stamp), { recursive: true, force: true }); cacheDeleted = true; logger("removed local cache " + stamp); }
      catch (e) { logger("remove cache failed: " + ((e && e.message) || e)); }
    }

    // 元数据索引同步抹掉这一项（失败不影响数据）
    const idxDrop = await upsertBackupIndex({ [stamp]: null }).catch((e) => ({ ok: false, error: (e && e.message) || String(e) }));

    // 缓存目录变了 → 重建索引 + 回收无主数据块
    const { refs, broken } = rebuildIndex(storeDir, { provider: "aliyun" });
    let gc = { deleted: 0, freed: 0, skipped: false };
    if (broken && broken.length) gc.skipped = "broken-manifests";
    else if (refs.size === 0) gc.skipped = "empty-refset";
    else gc = gcBlobs(storeDir, refs);

    return {
      ok: true,
      dryRun: false,
      plan,
      cacheDeleted,
      gc,
      index: { ok: !!idxDrop.ok, error: idxDrop.error || null },
      remote,
    };
  } finally { releaseLock(lock); }
}

/**
 */
export function pruneCache({ storeDir, keep = 5, cloudStamps = null } = {}) {
  storeDir = storeDir || storeDirOf();
  const n = Number.isFinite(Number(keep)) ? Math.max(0, Math.floor(Number(keep))) : 5;
  if (!(cloudStamps instanceof Set)) {
    return { ok: false, reason: "没有云端快照清单，跳过缓存回收（避免误删唯一副本）", deleted: [], freed: 0, kept: [], skipped: [] };
  }
  // 删本地缓存 + 回收数据块同样要和备份写入互斥（见 lib/engine/lock.js）
  const lock = acquireLock(storeDir);
  if (!lock.ok) return busyResult(lock);
  try {
    const snaps = listSnapshots(storeDir).filter((s) => fs.existsSync(manifestPath(storeDir, s.stamp)));
    const deleted = [];
    const kept = [];
    const skipped = [];
    let freed = 0;
    snaps.forEach((s, i) => {
      if (!cloudStamps.has(s.stamp)) { skipped.push(s.stamp); return; }
      if (i < n) { kept.push(s.stamp); return; }
      const size = localCacheBytes(storeDir, s.stamp);
      try {
        fs.rmSync(snapshotDir(storeDir, s.stamp), { recursive: true, force: true });
        deleted.push(s.stamp);
        freed += size;
      } catch { kept.push(s.stamp); }
    });
    if (deleted.length) {
      const { refs, broken } = rebuildIndex(storeDir, { provider: "aliyun" });
      if (!broken.length && refs.size) {
        const g = gcBlobs(storeDir, refs);
        freed += g.freed || 0;
      }
    }
    return { ok: true, deleted, freed, kept, skipped };
  } finally { releaseLock(lock); }
}

/**
 */
export async function uploadBackup({ storeDir, stamp, logger = () => {} } = {}) {
  storeDir = storeDir || storeDirOf();
  if (!stamp) return { ok: false, error: "缺少 stamp" };
  const mf = manifestPath(storeDir, stamp);
  if (!fs.existsSync(mf)) return { ok: false, error: "本机没有这份快照（可能已被清理）" };
  const manifest = readManifest(mf);
  if (!manifest) return { ok: false, error: "清单损坏，无法上传" };
  const blobs = [...new Set([].concat(
    (manifest.files || []).map((f) => f.hash),
    (manifest.plugins || []).filter((p) => p && p.blob).map((p) => p.blob),
  ))];
  if (!blobs.length) return { ok: false, error: "这份快照没有文件" };
  const r = await syncSnapshot({ manifest, blobs, storeDir, logger }).catch((e) => ({ ok: false, error: (e && e.message) || String(e) }));
  return { ok: !!r.ok, uploaded: r.uploaded || 0, skipped: r.skipped || 0, error: r.error || null };
}

/** 只读：本地缓存总量 + 数据块数量（维护区展示用）。 */
export function cacheStats(storeDir) {
  storeDir = storeDir || storeDirOf();
  const snaps = listSnapshots(storeDir);
  let bytes = 0;
  for (const s of snaps) bytes += localCacheBytes(storeDir, s.stamp);
  let blobs = 0;
  try { blobs = listBlobs(storeDir).length; } catch { /* 忽略 */ }
  return { copies: snaps.length, bytes, blobs };
}

/** 最近若干份「本地有、云端没有」的快照，失败优先；供备份后顺带重传。 */
export async function listRetryStamps({ storeDir, limit = 3, exclude = null } = {}) {
  const n = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  if (n === 0) return [];
  const r = await listBackups({ storeDir });
  if (!r.cloudOk) return [];
  return r.items
    .filter((x) => x.hasCache && x.stamp !== exclude && (x.state === "failed" || x.state === "pending"))
    .sort((a, b) => (a.state === b.state ? (a.stamp < b.stamp ? 1 : -1) : (a.state === "failed" ? -1 : 1)))
    .slice(0, n)
    .map((x) => x.stamp);
}
