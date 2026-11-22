// 从内容寻址备份库还原一次快照。
// 铁律：写入必须落在 targetRoot 之内（manifest 的 rel 视为不可信输入，防越界）；默认不覆盖，覆盖前先改名为 .bak-restore-<stamp>；blob 缺失记入 failed 不静默跳过。

import fs from "node:fs";
import path from "node:path";
import { logInfo, logWarn } from "../util/log.js";
import { storeDir as storeDirOf } from "../store/paths.js";
import { blobPath, sha256File } from "./blob.js";
import { listSnapshots, readManifest, manifestPath } from "./manifest.js";

const BAK_TAG = ".bak-restore-";
// 每个目标文件最多保留的还原备份份数（最近优先）：同一文件被反复覆盖时旧份按此上限淘汰，避免无限堆积。
const BAK_KEEP = 1;

/** 某文件已存在的还原备份，按修改时间从新到旧。 */
function bakSiblings(dir, base) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  const pref = base + BAK_TAG;
  const out = [];
  for (const n of names) {
    if (!n.startsWith(pref)) continue;
    const full = path.join(dir, n);
    let st = null;
    try { st = fs.statSync(full); } catch (e2) { continue; }
    if (!st.isFile()) continue;
    out.push({ path: full, name: n, t: st.mtimeMs });
  }
  out.sort((a, b) => (b.t - a.t) || (a.name < b.name ? 1 : -1));
  return out;
}

/** 覆盖前留备份：先淘汰同一 stamp 的旧备份与超出上限的更旧份，再改名或复制。 */
function makeBak(dest, stamp, move, keep = BAK_KEEP) {
  const dir = path.dirname(dest);
  const base = path.basename(dest);
  const list = bakSiblings(dir, base);
  const sameStamp = list.filter((x) => x.name.startsWith(base + BAK_TAG + stamp));
  const others = list.filter((x) => sameStamp.indexOf(x) < 0);
  const drop = sameStamp.concat(others.slice(Math.max(0, keep - 1)));
  let purged = 0;
  for (const x of drop) {
    try { fs.unlinkSync(x.path); purged++; } catch (e) { /* 删不掉就不计 */ }
  }
  if (keep <= 0) return { bak: null, purged };
  let bak = dest + BAK_TAG + stamp;
  for (let i = 1; fs.existsSync(bak); i++) bak = dest + BAK_TAG + stamp + "-" + i;
  if (move) fs.renameSync(dest, bak); else fs.copyFileSync(dest, bak);
  return { bak, purged };
}

/** 把 manifest 里的相对路径安全地拼到 root 下；越界直接抛错。 */
function safeJoin(root, rel) {
  const rootAbs = path.resolve(root);
  const cleaned = String(rel).replace(/^([/\\])+/, "");
  const full = path.resolve(rootAbs, cleaned);
  if (full !== rootAbs && !full.startsWith(rootAbs + path.sep)) {
    throw new Error("拒绝越界路径: " + rel);
  }
  return full;
}

/** 工作区登记表（storages/workspace.json）：按路径合并，避免整份覆盖导致名称与会话归属错乱。 */
export const WORKSPACE_REGISTRY_REL = "storages/workspace.json";

export function mergeWorkspaceRegistry(curPath, blobPath2, stamp, backup = true) {
  const out = { kept: 0, added: 0, sessionsAdded: 0, skippedMissingPath: 0, backedUp: false, bakPurged: 0 };
  let cur = null, snap = null;
  try { cur = JSON.parse(fs.readFileSync(curPath, "utf8")); } catch (e) { throw new Error("本机登记表解析失败: " + ((e && e.message) || e)); }
  try { snap = JSON.parse(fs.readFileSync(blobPath2, "utf8")); } catch (e) { throw new Error("快照登记表解析失败: " + ((e && e.message) || e)); }
  if (!cur || typeof cur !== "object" || !snap || typeof snap !== "object") throw new Error("登记表不是 JSON 对象");
  cur.tables = (cur.tables && typeof cur.tables === "object") ? cur.tables : {};
  cur.tables.workspaces = (cur.tables.workspaces && typeof cur.tables.workspaces === "object") ? cur.tables.workspaces : {};
  const local = cur.tables.workspaces;
  const snapWs = (snap.tables && snap.tables.workspaces && typeof snap.tables.workspaces === "object") ? snap.tables.workspaces : {};
  const idOfPath = new Map();
  for (const [id, w] of Object.entries(local)) if (w && w.path) idOfPath.set(String(w.path).toLowerCase(), id);
  for (const [id, w] of Object.entries(snapWs)) {
    if (!w || !w.path) continue;
    const key = String(w.path).toLowerCase();
    const localId = idOfPath.get(key);
    if (localId) {
      const keep = local[localId];
      const ids = Array.isArray(keep.sessionIds) ? keep.sessionIds.slice() : [];
      for (const sid of (Array.isArray(w.sessionIds) ? w.sessionIds : [])) {
        if (!ids.includes(sid)) { ids.push(sid); out.sessionsAdded++; }
      }
      keep.sessionIds = ids;
      if (!keep.title && w.title) keep.title = w.title;
      out.kept++;
      continue;
    }
    // 本机没有这个工作区：路径存在才登记，避免 DSH 里出现打不开的工作区
    if (!fs.existsSync(w.path)) { out.skippedMissingPath++; continue; }
    let useId = String(id);
    while (local[useId]) useId = String(id) + "-r" + (out.added + 1);
    local[useId] = {
      path: w.path, title: w.title || path.basename(w.path),
      sessionIds: Array.isArray(w.sessionIds) ? w.sessionIds.slice() : [],
      createdAt: w.createdAt || null, updatedAt: w.updatedAt || null,
    };
    idOfPath.set(key, useId);
    out.added++;
  }
  cur.global = (cur.global && typeof cur.global === "object") ? cur.global : {};
  const ids = (Array.isArray(cur.global.workspaceIds) ? cur.global.workspaceIds : []).filter((x) => local[x]);
  for (const id of Object.keys(local)) if (!ids.includes(id)) ids.push(id);
  cur.global.workspaceIds = ids;
  if (!cur.global.defaultWorkspaceId || !local[cur.global.defaultWorkspaceId]) {
    cur.global.defaultWorkspaceId = ids[0] || cur.global.defaultWorkspaceId || null;
  }
  if (backup) {
    const b = makeBak(curPath, stamp, false);
    out.backedUp = !!b.bak;
    out.bakPurged = b.purged;
  }
  const tmp = curPath + ".tmp-merge-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(cur, null, 2) + "\n");
  fs.renameSync(tmp, curPath);
  return out;
}

/** flat 模式的落地名：hash 前缀 + 原文件名，避免不同目录同名互相覆盖。 */
function flatName(rel, hash) {
  return hash.slice(0, 8) + "-" + path.basename(String(rel).replace(/\\/g, "/"));
}

/** 读一份快照的摘要（不列文件细节，只给数量与体积）。 */
/** 可还原的快照列表（新的在前），顺带标出 blob 缺失数（让用户知道哪份是残缺的）。 */
/** 把清单按 rel 归成树（depth=1 只回第一层）；只读已缓存 manifest，不发网络请求。 */
export function snapshotTree({ storeDir = storeDirOf(), stamp, depth = 1 } = {}) {
  const man = readManifest(manifestPath(storeDir, stamp));
  if (!man) return { ok: false, error: "快照不存在或清单损坏: " + stamp };
  return treeFromManifest(man, depth);
}

/** 由 manifest 现算目录树（本地、云端共用同一套聚合逻辑）。 */
export function treeFromManifest(man, depth = 1) {
  if (!man || !Array.isArray(man.files)) return { ok: false, error: "清单缺少 files" };
  const tree = { name: "(根)", files: 0, bytes: 0, children: [] };
  const nodes = new Map();                       // key -> node（key 用 '/' 连接的各层段）
  nodes.set("", tree);
  const byParent = new Map();                    // parentKey -> node
  byParent.set("", tree);

  const seenFiles = new Set();                   // dedupe by rel
  const rootAgg = { files: 0, bytes: 0 };        // 直接落在根下的文件（AGENTS.md 等）
  for (const f of man.files || []) {
    const rel = String(f.rel || f.hash || "");
    if (seenFiles.has(rel)) continue;
    seenFiles.add(rel);
    const parts = rel.split(/[/\\]+/).filter(Boolean);
    const fileBytes = f.size || 0;

    // 需要建到第 d 层目录；depth 就是目录层数上限
    const dirLevels = Math.min(depth, parts.length - 1);
    let key = "";
    const chain = [];
    for (let d = 1; d <= dirLevels; d++) {
      const parentKey = key;
      key = key ? key + "/" + parts[d - 1] : parts[d - 1];
      if (!nodes.has(key)) {
        const node = { name: parts[d - 1], files: 0, bytes: 0, children: [] };
        nodes.set(key, node);
        byParent.get(parentKey).children.push(node);
        byParent.set(key, node);
      }
      chain.push(nodes.get(key));                // 这条链上的每一层都「包含」这个文件
    }
    // 逐层累加：父目录统计全部后代文件，自身不计入；
    // 同时修掉「根文件被计两次」（旧代码 node === tree 后又 tree.files++）。
    for (const node of chain) { node.files++; node.bytes += fileBytes; }
    tree.files++;                                // 全局计数含根
    tree.bytes += fileBytes;
    if (dirLevels === 0) { rootAgg.files++; rootAgg.bytes += fileBytes; }
  }
  // 直接放在根下的文件也作为一个可见分组，保证 children 之和 == 总数
  if (rootAgg.files > 0) tree.children.push({ name: "(根)", files: rootAgg.files, bytes: rootAgg.bytes, children: [] });
  tree.children.sort(function (a, b) { return b.bytes - a.bytes || b.files - a.files || (a.name < b.name ? -1 : 1); });
  const packs = (Array.isArray(man.plugins) ? man.plugins : []).map((p) => ({
    name: p.name, version: p.version, state: p.state,
    via: p.source_kind || null, spec: p.spec || null, profiles: p.profiles || [], blob: p.blob || null,
  }));
  return { ok: true, stamp: man.stamp, depth, top: tree, plugins: packs, runtime: man.runtime || null };
}

/** 顶层目录汇总（第一层分组），给列表条目直接展示，不用再调 tree。 */
function topSummary(files) {
  if (!files) return [];
  const groups = new Map();
  let rootFiles = 0, rootBytes = 0;
  for (const f of files) {
    const parts = String(f.rel || "").split(/[/\\]+/).filter(Boolean);
    if (parts.length < 2) { rootFiles++; rootBytes += f.size || 0; continue; }
    const dir = parts[0];
    const g = groups.get(dir) || { dir, files: 0, bytes: 0 };
    g.files++; g.bytes += f.size || 0;
    groups.set(dir, g);
  }
  const out = Array.from(groups.values()).sort((a, b) => b.bytes - a.bytes);
  if (rootFiles > 0) out.push({ dir: "(根)", files: rootFiles, bytes: rootBytes });
  return out;
}

export function listRestorable({ storeDir = storeDirOf() } = {}) {
  const out = [];
  for (const s of listSnapshots(storeDir)) {
    const man = readManifest(s.file);
    if (!man) { out.push({ stamp: s.stamp, broken: true }); continue; }
    let missing = 0;
    for (const f of man.files || []) if (!fs.existsSync(blobPath(storeDir, f.hash))) missing++;
    out.push({
      stamp: man.stamp,
      created_at: man.created_at,
      files: (man.files || []).length,
      bytes: man.stats ? man.stats.bytes : 0,
      uniqueBlobs: new Set((man.files || []).map((f) => f.hash)).size,
      missingBlobs: missing,
      restorable: missing === 0,
      top: topSummary(man.files || []),
    });
  }
  return out;
}

/** 只算不写：这次还原会写多少、覆盖多少、缺多少 blob。 */
export function previewRestore({ storeDir = storeDirOf(), stamp, targetRoot, overwrite = false, flat = false } = {}) {
  const man = readManifest(manifestPath(storeDir, stamp));
  if (!man) return { ok: false, error: "快照不存在或清单损坏: " + stamp };
  const plan = { total: (man.files || []).length, willWrite: 0, willOverwrite: 0, willSkip: 0,
    willSkipSame: 0, willSkipDifferent: 0, willMergeWorkspace: 0, missingBlobs: 0, bytes: 0, outOfRoot: 0 };
  const seen = new Set();
  for (const f of man.files || []) {
    let dest;
    try { dest = flat ? path.join(path.resolve(targetRoot), flatName(f.rel, f.hash)) : safeJoin(targetRoot, f.rel); }
    catch { plan.outOfRoot++; continue; }
    if (!fs.existsSync(blobPath(storeDir, f.hash))) plan.missingBlobs++;
    if (seen.has(f.hash)) continue;
    seen.add(f.hash);
    if (fs.existsSync(dest)) {
      if (!flat && f.rel === WORKSPACE_REGISTRY_REL) { plan.willMergeWorkspace++; plan.willWrite++; }
      else if (overwrite) { plan.willOverwrite++; plan.willWrite++; }
      else {
        plan.willSkip++;
        let same = false;
        try { same = sha256File(dest) === f.hash; } catch (e) { same = false; }
        if (same) plan.willSkipSame++; else plan.willSkipDifferent++;
      }
    } else { plan.willWrite++; }
    plan.bytes += f.size || 0;
  }
  return { ok: true, stamp: man.stamp, created_at: man.created_at, targetRoot: path.resolve(targetRoot), flat, overwrite, ...plan };
}

/** 执行还原。 */
export function restoreSnapshot({ storeDir = storeDirOf(), stamp, targetRoot, overwrite = false, flat = false, backupOverwritten = true, rels = null, logger = () => {}, onStep = null, shouldStop = null } = {}) {
  if (!targetRoot) throw new Error("restoreSnapshot 需要 targetRoot");
  const man = readManifest(manifestPath(storeDir, stamp));
  if (!man) return { ok: false, error: "快照不存在或清单损坏: " + stamp, failed: [] };

  const rootAbs = path.resolve(targetRoot);
  fs.mkdirSync(rootAbs, { recursive: true });
  // rels：只还原这些路径（文件精确匹配，目录按前缀）；不传=整份
  const wantRels = (Array.isArray(rels) && rels.length)
    ? rels.map((r) => String(r).replace(/\/+$/, "")).filter(Boolean)
    : null;
  const scoped = wantRels
    ? (man.files || []).filter((f) => wantRels.some((r) => f.rel === r || f.rel.indexOf(r + "/") === 0))
    : (man.files || []);
  const res = { ok: true, stamp: man.stamp, targetRoot: rootAbs, total: scoped.length, restored: 0, skipped: 0,
    skippedSame: 0, skippedDiff: 0, skippedDiffSample: [], mergedWorkspace: null, overwritten: 0, backedUp: 0, bakPurged: 0, bytes: 0, failed: [] };

  let step = 0;
  let stopped = false;
  for (const f of scoped) {
    // 取消只在文件之间生效：正在写的那一个照写完、已写入的保留，不做半途回滚
    if (typeof shouldStop === "function" && shouldStop()) { stopped = true; break; }
    step++;
    if (typeof onStep === "function") { try { onStep(step, scoped.length); } catch (e) { /* 进度只用于展示 */ } }
    let dest;
    try { dest = flat ? path.join(rootAbs, flatName(f.rel, f.hash)) : safeJoin(rootAbs, f.rel); }
    catch (e) { res.failed.push({ rel: f.rel, error: (e && e.message) || String(e) }); continue; }

    const src = blobPath(storeDir, f.hash);
    if (!fs.existsSync(src)) { res.failed.push({ rel: f.rel, error: "blob 缺失 " + f.hash.slice(0, 12) }); continue; }

    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (fs.existsSync(dest)) {
        if (!flat && f.rel === WORKSPACE_REGISTRY_REL) {
          res.mergedWorkspace = mergeWorkspaceRegistry(dest, src, man.stamp, backupOverwritten);
          res.bakPurged += res.mergedWorkspace.bakPurged || 0;
          res.restored++;
          res.bytes += f.size || 0;
          continue;
        }
        if (!overwrite) {
          res.skipped++;
          let same = false;
          try { same = sha256File(dest) === f.hash; } catch (e) { same = false; }
          if (same) res.skippedSame++;
          else {
            res.skippedDiff++;
            if (res.skippedDiffSample.length < 8) res.skippedDiffSample.push(f.rel);
          }
          continue;
        }
        if (backupOverwritten) {
          const b = makeBak(dest, man.stamp, true);
          if (b.bak) res.backedUp++;
          res.bakPurged += b.purged;
        } else {
          fs.unlinkSync(dest);
        }
        res.overwritten++;
      }
      const tmp = dest + ".tmp-restore-" + process.pid + "-" + Math.random().toString(16).slice(2, 8);
      try {
        fs.copyFileSync(src, tmp);
        fs.renameSync(tmp, dest);
      } finally {
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) { /* 忽略 */ }
      }
      res.restored++;
      res.bytes += f.size || 0;
    } catch (e) {
      res.failed.push({ rel: f.rel, error: (e && e.message) || String(e) });
    }
  }

  res.stopped = stopped;
  if (res.failed.length) res.ok = false;
  logger("restore " + man.stamp + " -> " + rootAbs + ": restored " + res.restored + ", skipped " + res.skipped
    + " (same " + res.skippedSame + ", different " + res.skippedDiff + "), overwritten " + res.overwritten
    + ", failed " + res.failed.length + (res.bakPurged ? ", 清理旧备份 " + res.bakPurged : "")
    + (res.mergedWorkspace ? ", workspace merged: +" + res.mergedWorkspace.added + " / kept " + res.mergedWorkspace.kept + " / sessions +" + res.mergedWorkspace.sessionsAdded : ""));
  const fields = { stamp: man.stamp, targetRoot: rootAbs, total: res.total, restored: res.restored, skipped: res.skipped, skippedSame: res.skippedSame, skippedDiff: res.skippedDiff, mergedWorkspace: res.mergedWorkspace, overwritten: res.overwritten, bakPurged: res.bakPurged, failed: res.failed.length, bytes: res.bytes, firstError: res.failed.length ? String((res.failed[0] && (res.failed[0].error || res.failed[0].path)) || "") : undefined };
  if (res.failed.length) logWarn("restore.done", fields); else logInfo("restore.done", fields);
  return res;
}

/** 还原后自证：逐文件 sha256 与 manifest 比对。 */
export function verifyRestore({ storeDir = storeDirOf(), stamp, targetRoot, flat = false } = {}) {
  const man = readManifest(manifestPath(storeDir, stamp));
  if (!man) return { ok: false, error: "快照不存在" };
  const rootAbs = path.resolve(targetRoot);
  const out = { ok: true, checked: 0, same: 0, diff: 0, missing: 0, diffs: [] };
  for (const f of man.files || []) {
    let dest;
    try { dest = flat ? path.join(rootAbs, flatName(f.rel, f.hash)) : safeJoin(rootAbs, f.rel); }
    catch { out.diff++; out.diffs.push({ rel: f.rel, why: "越界路径" }); continue; }
    out.checked++;
    if (!fs.existsSync(dest)) { out.missing++; out.diffs.push({ rel: f.rel, why: "文件不存在" }); continue; }
    let got = null;
    try { got = sha256File(dest); } catch (e) { out.diff++; out.diffs.push({ rel: f.rel, why: "读失败: " + ((e && e.message) || e) }); continue; }
    if (got === f.hash) out.same++;
    else { out.diff++; out.diffs.push({ rel: f.rel, why: "hash 不符" }); }
  }
  if (out.diff || out.missing) out.ok = false;
  return out;
}
