// lib/engine/manifest.js —— 快照清单与索引

import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../store/paths.js";

export const SNAPSHOT_KIND = "dsh-backup-snapshot";

export function stampNow(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

export function snapshotsRoot(storeDir) { return path.join(storeDir, "snapshots"); }
export function snapshotDir(storeDir, stamp) { return path.join(snapshotsRoot(storeDir), stamp); }
export function manifestPath(storeDir, stamp) { return path.join(snapshotDir(storeDir, stamp), "manifest.json"); }
export function indexPath(storeDir) { return path.join(storeDir, "index.json"); }

export function buildManifest({
  files, stamp, workspace = "all", dshHome, host, provider = "aliyun", skipped = 0, plugins = null, runtime = null }) {
  const byRel = files.map((f) => ({ rel: f.rel, hash: f.hash, size: f.size, mtime: Math.round(f.mtime) }));
  const bytes = byRel.reduce((s, f) => s + f.size, 0);
  const uniq = new Set(byRel.map((f) => f.hash));
  return {
    v: 1,
    kind: SNAPSHOT_KIND,
    stamp,
    created_at: new Date().toISOString(),
    host: host || "",
    workspace,
    dsh_home: dshHome || "",
    provider,
    ...(runtime ? { runtime } : {}),
    stats: { files: byRel.length, bytes, unique_blobs: uniq.size, skipped },
    files: byRel,
    ...(Array.isArray(plugins) && plugins.length ? { plugins } : {}),
  };
}

export function writeManifest(storeDir, m) {
  const file = manifestPath(storeDir, m.stamp);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(m));
  return file;
}

export function readManifest(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

export function listSnapshots(storeDir) {
  const root = snapshotsRoot(storeDir);
  let names = [];
  try { names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
  return names.sort().reverse().map((stamp) => {
    const file = manifestPath(storeDir, stamp);
    const st = (() => { try { return fs.statSync(file); } catch { return null; } })();
    return { stamp, file, exists: !!st, mtime: st ? st.mtimeMs : 0, bytes: st ? st.size : 0 };
  });
}

/** 重建 index.json：快照清单 + 全部被引用的 blob 集合。 */
export function rebuildIndex(storeDir, { provider = "aliyun", extra = {} } = {}) {
  const snaps = [];
  const refs = new Set();
  const broken = [];                    // 解析不了的清单必须上报，否则它的独占 blob 会被 GC 当垃圾删掉
  for (const s of listSnapshots(storeDir)) {
    const m = readManifest(s.file);
    if (!m) { broken.push(s.stamp); continue; }
    for (const f of m.files || []) refs.add(f.hash);
    for (const p of m.plugins || []) { if (p && p.blob) refs.add(p.blob); }
    snaps.push({ stamp: s.stamp, created_at: m.created_at, files: (m.files || []).length, bytes: m.stats?.bytes ?? 0, unique_blobs: m.stats?.unique_blobs ?? 0, workspace: m.workspace || "all" });
  }
  const index = { v: 1, kind: "dsh-backup-index", updated_at: new Date().toISOString(), provider, snapshots: snaps, blobs: refs.size, broken, ...extra };
  writeFileAtomic(indexPath(storeDir), JSON.stringify(index, null, 2));
  return { index, refs, broken };
}
