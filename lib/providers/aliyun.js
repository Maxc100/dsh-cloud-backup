// 阿里云盘上传通道。云端布局：<APP_FOLDER>/objects/blobs/<h0:2>/<h2:4>/<h4:64>、snapshots/<stamp>/manifest.json、index

import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { API, ensureAppFolder, ensureAccessToken } from "../auth/aliyun.js";
import { loadCredentials } from "../store/credentials.js";
import { storeDir as storeDirOf } from "../store/paths.js";
import { logInfo, logWarn, checkDownloadConsistency } from "../util/log.js";
import { NotFoundError } from "../util/errors.js";

export const CHUNK = 10 * 1024 * 1024;          // 保守按 10MB 切片（实测 40MB 仍单片，切小更稳）
const REFERER = "https://www.aliyundrive.com/";

function jsonHeaders(at) {
  return {
    authorization: "Bearer " + at,
    "content-type": "application/json",
    referer: REFERER,
    origin: REFERER.slice(0, -1),
    "user-agent": "dsh-cloud-backup/0.3 (+node)",
  };
}

// 统一请求：429/TooManyRequests 由这里退避重试（列目录、取文件信息都会被限流）
// 网络层错误可读化：undici 只给 "fetch failed"，真实原因在 e.cause.code 里
export function netErrText(e) {
  const c = (e && e.cause) || {};
  const code = c.code || (e && e.code) || "";
  const map = {
    ECONNRESET: "连接被重置", ECONNREFUSED: "连接被拒绝", ETIMEDOUT: "连接超时",
    EAI_AGAIN: "DNS 暂时不可用", ENOTFOUND: "域名解析失败", EPIPE: "连接已断开",
    UND_ERR_CONNECT_TIMEOUT: "连接超时", UND_ERR_SOCKET: "套接字已关闭", UND_ERR_ABORTED: "请求被取消",
  };
  if (map[code]) return map[code] + "（" + code + "）";
  return String((e && e.message) || "网络错误");
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function api(p, { at, body, method = "POST", timeoutMs = 30000, apiBase = API } = {}) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    let res = null;
    try {
      res = await fetch(apiBase + p, {
        method,
        headers: jsonHeaders(at),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // 网络层失败（ECONNRESET / DNS / 超时）与限流一样值得重试：进面板时的偶发 "fetch failed" 就是这一类
      if (attempt >= 4) {
        logWarn("cloud.api.fail", { path: p, method, attempt, code: (e && e.cause && e.cause.code) || "", message: netErrText(e) });
        throw new Error("网络请求失败：" + netErrText(e) + "（" + method + " " + p + "，已重试 4 次）");
      }
      await sleep(300 * attempt + Math.floor(Math.random() * 150));
      continue;
    }
    const text = await res.text();
    let j = null;
    try { j = text ? JSON.parse(text) : null; } catch { j = { raw: text.slice(0, 500) }; }
    if (res.ok) return j;
    const code = (j && (j.code || j.error)) || "";
    const msg = "aliyun " + method + " " + p + " -> HTTP " + res.status + (code ? " [" + code + "] " : " ") + ((j && j.message) || "");
    const throttled = res.status === 429 || String(code).indexOf("TooManyRequests") >= 0 || msg.indexOf("TooManyRequests") >= 0;
    const transient = res.status >= 500 || res.status === 408 || res.status === 425;
    if ((!throttled && !transient) || attempt === 4) {
      if (transient) logWarn("cloud.api.fail", { path: p, method, attempt, status: res.status, message: msg });
      const err = new Error(msg);
      err.status = res.status;
      err.code = String(code || "");
      throw err;
    }
    await new Promise(function (r) { setTimeout(r, 300 * attempt + Math.floor(Math.random() * 150)); });
  }
  throw new Error("aliyun " + method + " " + p + " -> 重试后仍失败");
}

export function remoteStatePath(storeDir = storeDirOf()) { return path.join(storeDir, "remote-index.json"); }

export function loadRemoteState(storeDir = storeDirOf()) {
  try { return JSON.parse(fs.readFileSync(remoteStatePath(storeDir), "utf8")); } catch { return { v: 1, folders: {}, blobs: {} }; }
}
export function saveRemoteState(storeDir, st) {
  const f = remoteStatePath(storeDir);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(st));
  fs.renameSync(tmp, f);
}

async function listAll(at, driveId, parentId) {
  const out = [];
  let marker = "";
  for (let i = 0; i < 50; i++) {
    const j = await api("/adrive/v3/file/list", {
      at,
      body: { drive_id: driveId, parent_file_id: parentId, limit: 100, marker, order_by: "name", order_direction: "ASC" },
    });
    for (const it of j.items || []) out.push({ name: it.name, file_id: it.file_id, type: it.type, size: it.size, content_hash: it.content_hash });
    if (!j.next_marker) break;
    marker = j.next_marker;
  }
  return out;
}

/** 建目录（已存在则返回原 id）。带 drive_id 的调用需要外部传入。 */
async function ensureFolder(at, driveId, parentId, name, cache, key) {
  if (cache && cache[key]) return cache[key];
  const j = await api("/adrive/v2/file/createWithFolders", {
    at,
    body: { drive_id: driveId, parent_file_id: parentId, name, type: "folder", check_name_mode: "refuse" },
  });
  const id = j.file_id;
  if (cache) cache[key] = id;
  return id;
}

/** 逐级建目录：names 为路径段数组，返回最末级 file_id。 */
async function ensurePath(at, driveId, rootId, names, cache, base = "") {
  let cur = rootId;
  let prefix = base;
  for (const n of names) {
    prefix = prefix ? prefix + "/" + n : n;
    cur = await ensureFolder(at, driveId, cur, n, cache, prefix);
  }
  return cur;
}

async function uploadBuffer(at, driveId, parentId, name, buf) {
  const size = buf.length;
  const parts = Math.max(1, Math.ceil(size / CHUNK));
  const create = await api("/adrive/v2/file/create", {
    at,
    body: {
      drive_id: driveId,
      parent_file_id: parentId,
      name,
      type: "file",
      size,
      check_name_mode: "refuse",
      part_info_list: Array.from({ length: parts }, (_, i) => ({ part_number: i + 1 })),
    },
  });
  // rapid_upload = 云端已有同内容文件（秒传）：此时 create 不返回 upload_id，
  // 也没有 part 需要 PUT，complete 必须跳过，否则报 HTTP 400 [InvalidParameter.UploadId] upload_id is required。
  if (create.rapid_upload) return { file_id: create.file_id, rapid: true };
  for (const p of create.part_info_list || []) {
    const start = (p.part_number - 1) * CHUNK;
    const slice = buf.subarray(start, Math.min(size, start + CHUNK));
    // 铁律 1：分片 PUT 不能带任何 header（upload_url 是 OSS V4 预签名）
    const put = await fetch(p.upload_url, { method: "PUT", body: slice, signal: AbortSignal.timeout(300000) });
    if (!put.ok) throw new Error("part PUT " + p.part_number + " -> HTTP " + put.status);
  }
  if (create.upload_id) {
    await api("/v2/file/complete", { at, body: { drive_id: driveId, file_id: create.file_id, upload_id: create.upload_id } });
  }
  return { file_id: create.file_id, rapid: false };
}

// 从磁盘按分片读盘上传：一次只在内存里放一个分片（CHUNK），不再整块 readFileSync。
// 大块（几十 MB）在并发 4 路时否则会同时驻留 4 份完整文件。
export async function uploadFromFile(at, driveId, parentId, name, file, size) {
  const parts = Math.max(1, Math.ceil(size / CHUNK));
  const create = await api("/adrive/v2/file/create", {
    at,
    body: {
      drive_id: driveId,
      parent_file_id: parentId,
      name,
      type: "file",
      size,
      check_name_mode: "refuse",
      part_info_list: Array.from({ length: parts }, (_, i) => ({ part_number: i + 1 })),
    },
  });
  if (create.rapid_upload) return { file_id: create.file_id, rapid: true };
  const fd = fs.openSync(file, "r");
  try {
    for (const p of create.part_info_list || []) {
      const start = (p.part_number - 1) * CHUNK;
      const len = Math.min(size, start + CHUNK) - start;
      const slice = Buffer.allocUnsafe(len);
      let got = 0;
      while (got < len) {
        const n = fs.readSync(fd, slice, got, len - got, start + got);
        if (!n) break;
        got += n;
      }
      const put = await fetch(p.upload_url, { method: "PUT", body: got === len ? slice : slice.subarray(0, got), signal: AbortSignal.timeout(300000) });
      if (!put.ok) throw new Error("part PUT " + p.part_number + " -> HTTP " + put.status);
    }
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
  if (create.upload_id) {
    await api("/v2/file/complete", { at, body: { drive_id: driveId, file_id: create.file_id, upload_id: create.upload_id } });
  }
  return { file_id: create.file_id, rapid: false };
}


/** 删除云端一个目录/文件（进回收站，可从阿里云盘 UI 找回）。 */
export async function trashRemote({ fileId } = {}) {
  invalidateRemoteSnapshotCache();   // 云端结构要变了，列表缓存作废
  if (!fileId) throw new Error("缺少 fileId");
  const creds = loadCredentials() || {};
  const driveId = creds.drive_id || creds.default_drive_id;
  const at = await ensureAccessToken();
  await api("/v2/recyclebin/trash", { at, body: { drive_id: driveId, file_id: fileId } });
  return { ok: true, fileId };
}

// 清理云端孤儿快照目录：只删 snapshots/ 下没有 manifest 的子目录，有 manifest 的一律不动。
export async function cleanupRemoteOrphans({ storeDir = storeDirOf(), dryRun = false, logger = () => {} } = {}) {
  if (manifestWriting > 0) return { ok: true, removed: [], kept: 0, skipped: "manifest-writing" };
  invalidateRemoteSnapshotCache();   // 云端结构要变了，列表缓存作废
  const creds = loadCredentials() || {};
  const driveId = creds.drive_id || creds.default_drive_id;
  const at = await ensureAccessToken();
  const root = await ensureAppFolder();
  const top = await listAll(at, driveId, root.file_id);
  const snapsDir = top.find((x) => x.name === "snapshots" && x.type === "folder");
  if (!snapsDir) return { ok: true, removed: [], kept: 0 };

  const dirs = await listAll(at, driveId, snapsDir.file_id);
  const removed = [];
  let kept = 0;
  for (const d of dirs) {
    if (d.type !== "folder") continue;
    const inner = await listAll(at, driveId, d.file_id);
    const hasManifest = inner.some((x) => x.name === "manifest.json");
    if (hasManifest) { kept++; continue; }
    if (dryRun) { removed.push({ stamp: d.name, fileId: d.file_id, dryRun: true }); logger("[dry-run] would remove orphan " + d.name); continue; }
    try {
      await trashRemote({ fileId: d.file_id });
      removed.push({ stamp: d.name, fileId: d.file_id });
      logger("removed orphan " + d.name);
    } catch (e) {
      logger("remove orphan " + d.name + " failed: " + ((e && e.message) || e));
    }
  }
  return { ok: true, removed, kept, dryRun };
}

// 云端 GC：保留本地仍存在的快照 + 最近 N 份，其余进回收站；只处理有 manifest 的目录（孤儿交给 cleanupRemoteOrphans）。
export async function gcRemoteSnapshots({ storeDir = storeDirOf(), keepRecent = 8, dryRun = false, logger = () => {} } = {}) {
  // 非法保留份数（NaN / 负数 / 非数字）会让 slice(0, NaN)=[] 把云端快照全判成孤儿 → 强制回落默认
  const keepN = Number(keepRecent);
  keepRecent = Number.isFinite(keepN) ? Math.max(0, Math.floor(keepN)) : 8;
  invalidateRemoteSnapshotCache();   // 云端结构要变了，列表缓存作废
  const ls = await listRemoteSnapshots({ storeDir });
  if (!ls.ok) return { ok: false, error: ls.error, removed: [] };
  const withMf = ls.snapshots.filter((x) => x.hasManifest);
  const localStamps = new Set();
  try {
    const dir = path.join(storeDir, "snapshots");
    if (fs.existsSync(dir)) for (const n of fs.readdirSync(dir)) localStamps.add(n);
  } catch {}
  const keep = new Set(withMf.slice(0, keepRecent).map((x) => x.stamp));
  for (const st of localStamps) keep.add(st);
  const removed = [];
  for (const x of withMf) {
    if (keep.has(x.stamp)) continue;
    if (dryRun) { removed.push({ stamp: x.stamp, dryRun: true }); logger("[dry-run] would gc " + x.stamp); continue; }
    try { await trashRemote({ fileId: x.dirId }); removed.push({ stamp: x.stamp }); logger("gc removed " + x.stamp); }
    catch (e) { logger("gc " + x.stamp + " failed: " + ((e && e.message) || e)); }
  }
  return { ok: true, removed, kept: [...keep].length, dryRun };
}

function localStampsOf(storeDir) {
  const set = new Set();
  try {
    const dir = path.join(storeDir, "snapshots");
    if (fs.existsSync(dir)) for (const n of fs.readdirSync(dir)) if (!n.startsWith(".")) set.add(n);
  } catch {}
  return set;
}

// 删云端快照（进回收站，30 天内可找回）：支持按 stamp 精确删；两道保护默认开（本地仍有副本的跳过、云端最后一份整体拒绝）；dryRun 默认 true 先演练再确认。
export async function pruneRemoteSnapshots({
  stamps = null, keepRecent = null, dryRun = true,
  allowLocalCopy = false, allowLastCopy = false,
  storeDir = storeDirOf(), logger = () => {},
} = {}) {
  invalidateRemoteSnapshotCache();
  const ls = await listRemoteSnapshots({ storeDir, fresh: true });
  if (!ls.ok) return { ok: false, error: ls.error || "列出云端快照失败", plan: [] };
  const all = (ls.snapshots || []).filter((x) => x.hasManifest);
  const local = localStampsOf(storeDir);

  let targets = [], unknown = [];
  if (Array.isArray(stamps) && stamps.length) {
    const want = new Set(stamps);
    targets = all.filter((x) => want.has(x.stamp));
    unknown = stamps.filter((s) => !all.some((x) => x.stamp === s));
  } else if (keepRecent !== null && keepRecent !== undefined) {
    const n = Number.isFinite(Number(keepRecent)) ? Math.max(1, Math.floor(Number(keepRecent))) : 8;
    const keep = new Set(all.slice(0, n).map((x) => x.stamp));
    for (const s of local) keep.add(s);          // 本地还有的云端副本，默认不动
    targets = all.filter((x) => !keep.has(x.stamp));
  } else {
    return { ok: false, error: "需要 stamps 或 keepRecent", plan: [] };
  }

  const plan = [];
  for (const x of targets) {
    const isLocal = local.has(x.stamp);
    let action = "delete", reason = "";
    if (isLocal && !allowLocalCopy) { action = "skip"; reason = "本地仍有这份副本，跳过（要删云端请显式放行）"; }
    plan.push({ stamp: x.stamp, dirId: x.dirId, action, reason, localCopy: isLocal, manifestSize: x.manifestSize || 0 });
  }
  for (const s of unknown) plan.push({ stamp: s, action: "skip", reason: "云端没有这份快照" });

  const willDelete = plan.filter((p) => p.action === "delete").map((p) => p.stamp);
  const remain = all.length - willDelete.length;
  if (willDelete.length && remain <= 0 && !allowLastCopy) {
    return { ok: false, error: "这会删掉云端最后一份快照，已拒绝（确实要清空请显式放行 allowLastCopy）", plan, remain: all.length };
  }
  if (dryRun) {
    for (const s of willDelete) logger("[dry-run] would trash remote snapshot " + s);
    return { ok: true, dryRun: true, plan, willDelete, remain, deleted: [] };
  }

  const st = loadRemoteState(storeDir);
  st.folders = st.folders || {};
  const deleted = [];
  for (const p of plan) {
    if (p.action !== "delete") continue;
    try {
      await trashRemote({ fileId: p.dirId });
      delete st.folders["snapshots/" + p.stamp];
      delete st.folders[p.stamp];
      deleted.push(p.stamp);
      logger("trashed remote snapshot " + p.stamp);
    } catch (e) {
      p.action = "failed";
      p.reason = "删除失败: " + ((e && e.message) || e);
      logger("trash remote " + p.stamp + " failed: " + ((e && e.message) || e));
    }
  }
  saveRemoteState(storeDir, st);
  invalidateRemoteSnapshotCache();
  if (deleted.length) dropManifestCache();        // 云端删过东西：整表作废，避免拿旧清单
  return { ok: true, dryRun: false, plan, willDelete, remain: all.length - deleted.length, deleted };
}

/** 列云端有哪些快照（只读远端目录树，不下载内容）。 */
// 云端快照列表缓存在进程内 45 秒：卡片每次刷新都要它，而 14 个目录串行 listAll 要 16 秒。
// 任何写操作（上传清单 / 回收站 / 清理孤儿）都会主动失效；也可以 fresh:true 强制绕过。
const _snapCache = { at: 0, value: null };
const SNAP_TTL_MS = 45 * 1000;
// 磁盘缓存：冷启动（应用重启后第一次打开面板）直接用它，避免又走 N 次 listAll（实测 14 个目录要 16 秒）
const SNAP_DISK_TTL_MS = 10 * 60 * 1000;
let _snapDirty = false;          // 刚发生过写入（上传/删快照）→ 不许用磁盘里的旧列表
function snapCachePath(storeDir) { return path.join(storeDir, "remote-snap-cache.json"); }
function readSnapCacheDisk(storeDir) {
  if (_snapDirty) return null;
  try {
    const j = JSON.parse(fs.readFileSync(snapCachePath(storeDir), "utf8"));
    if (j && j.value && j.value.snapshots && Date.now() - (j.at || 0) < SNAP_DISK_TTL_MS) {
      return Object.assign({}, j.value, { fromDisk: true, fromDiskAt: j.at || 0 });
    }
  } catch (e) { /* 没有缓存 / 坏了都当没有 */ }
  return null;
}
function writeSnapCacheDisk(storeDir, value) {
  try { fs.mkdirSync(storeDir, { recursive: true }); fs.writeFileSync(snapCachePath(storeDir), JSON.stringify({ at: Date.now(), value })); } catch (e) { /* 缓存写失败不影响功能 */ }
}
export function invalidateRemoteSnapshotCache() { _snapCache.at = 0; _snapCache.value = null; _snapDirty = true; try { /* 磁盘缓存下次写入时覆盖 */ } catch (e) {} }

/** 云端列举失败的归类：auth（授权失效）/ config（凭据不完整）/ network（网络与其它）。
    两类失败给用户的动作完全不同——授权失效要重新授权，网络问题重试即可，所以必须分开。 */
// 只有「服务端明确说凭据不可用」才判 auth：401、令牌类错误码，或本地压根没有凭据。
// 403/429/5xx/超时都可能是限流与瞬时故障，一律 network —— 否则面板会误报「登录已失效」，把用户推去重新登录。
const AUTH_CODES = /^(InvalidParameter|InvalidRefreshToken|RefreshTokenExpired|InvalidAccessToken|InvalidToken|AccessTokenInvalid|IllegalAccessToken|TokenExpired|UserNotLogin|NotAuthorized|Unauthorized)$/i;
const RATE_WORDS = /TooManyRequests|Too many requests|Throttl|RateLimit|RequestLimit|RequestQuota|QuotaExceed|ForbiddenFile|1063/i;

export function classifyCloudError(e) {
  const name = (e && e.name) || "";
  const msg = String((e && e.message) || e || "");
  const status = Number((e && e.status) || 0);
  const code = String((e && e.code) || "");
  if (/drive_id|凭据/.test(msg)) return "config";
  if (RATE_WORDS.test(code) || RATE_WORDS.test(msg)) return "network";
  if (name === "AuthError") {
    if (/未连接|无 refresh_token/.test(msg)) return "pending";
    if (status === 401 || AUTH_CODES.test(code) || (status === 0 && AUTH_CODES.test(msg))) return "auth";
    return "network";
  }
  if (status === 401 || AUTH_CODES.test(code)) return "auth";
  if (status === 403) return "network";
  if (/\b401\b/.test(msg)) return "auth";
  return "network";
}

/** 最近一次成功列举到的云端快照（进程内缓存优先，其次磁盘缓存）。云端读不到时用它判断行状态。 */
export function cachedRemoteSnapshots(storeDir = storeDirOf()) {
  const mem = _snapCache.value;
  if (!_snapDirty && mem && mem.snapshots && mem.snapshots.length) {
    return { ok: true, snapshots: mem.snapshots, cachedAt: _snapCache.at, fromMemory: true };
  }
  const disk = readSnapCacheDisk(storeDir);
  if (disk) return disk;
  return null;
}

/** 限并发 map（阿里云盘 listAll 每层一次往返，串行 14 份要 16 秒，8 并发约 2~3 秒）。 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const n = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: n }, async () => {
    while (cursor < items.length) { const k = cursor++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

export async function listRemoteSnapshots({ storeDir = storeDirOf(), fresh = false } = {}) {
  if (!fresh) {
    if (_snapCache.value && Date.now() - _snapCache.at < SNAP_TTL_MS) return _snapCache.value;
    const disk = readSnapCacheDisk(storeDir);
    if (disk) { _snapCache.value = disk; _snapCache.at = Date.now(); return disk; }
  }
  await ensureAccessToken();
  const creds = loadCredentials() || {};
  const driveId = creds.drive_id || creds.default_drive_id;
  if (!driveId) return { ok: false, error: "凭据里没有 drive_id", errorKind: "config", snapshots: [] };
  const at = await ensureAccessToken();
  const root = await ensureAppFolder();
  const st = loadRemoteState(storeDir);
  st.folders = st.folders || {};
  try {
    // 只读列举：snapshots 目录可能还不存在，用 listAll 而不是 ensurePath（恢复路径绝不在云端建目录）
    const top = await listAll(at, driveId, root.file_id);
    const snapsDir = top.find((x) => x.name === "snapshots" && x.type === "folder");
    if (!snapsDir) return { ok: true, snapshots: [] };
    const dirs = (await listAll(at, driveId, snapsDir.file_id)).filter((d) => d.type === "folder");
    // 性能快路径：元数据索引里已有的快照不必再逐个列目录（N 次 listAll → 0 次）
    let idxEntries = {};
    try { const ix = await getBackupIndex({ fresh: false }); idxEntries = (ix && ix.entries) || {}; } catch (e) { idxEntries = {}; }
    const knownOf = (name) => idxEntries[name] && Number.isFinite(idxEntries[name].files);
    const known = dirs.filter((d) => knownOf(d.name)).map((d) => ({
      stamp: d.name, dirId: d.file_id, hasManifest: true, manifestId: null, manifestSize: 0, fromIndex: true,
    }));
    const needProbe = dirs.filter((d) => !knownOf(d.name));
    const probed = await mapLimit(needProbe, 8, async (d) => {
      const inner = await listAll(at, driveId, d.file_id);
      const mf = inner.find((x) => x.name === "manifest.json");
      return { stamp: d.name, dirId: d.file_id, hasManifest: !!mf, manifestId: mf ? mf.file_id : null, manifestSize: mf ? mf.size : 0 };
    });
    const snapshots = known.concat(probed);
    snapshots.sort((a, b) => (a.stamp < b.stamp ? 1 : -1));
    const value = { ok: true, snapshots };
    _snapCache.at = Date.now();
    _snapCache.value = value;
    _snapDirty = false;
    writeSnapCacheDisk(storeDir, value);
    return value;
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), errorKind: classifyCloudError(e), snapshots: [] };
  }
}

/** 下载一个文件到本地路径（阿里云盘的下载链接必须带 referer，否则 403）。 */
/** 取一个块文件的直链（get_download_url）。单独导出，便于预热与测速。 */
// 直链缓存：同一 file_id 的签名地址在 TTL 内复用，避免重复打限流严格的取链接口
const urlCache = new Map();          // fileId -> { url, at }
const URL_TTL_MS = 10 * 60 * 1000;
const URL_CACHE_MAX = 4000;
const urlGate = makeGate(6);         // 实测并发 >6 会 TooManyRequests


/** 取一个块文件的直链：带缓存 + 限流闸门 + 429 退避重试。 */
export async function getBlobUrl(driveId, fileId) {
  const hit = urlCache.get(fileId);
  if (hit && Date.now() - hit.at < URL_TTL_MS) return hit.url;
  const did = driveId || (loadCredentials() || {}).drive_id || (loadCredentials() || {}).default_drive_id;
  let lastErr = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await urlGate.acquire();
    try {
      const r = await api("/v2/file/get_download_url", { at: await ensureAccessToken(), body: { drive_id: did, file_id: fileId } });
      const url = r.url || r.download_url;
      if (!url) throw new Error("get_download_url 没有返回 url");
      if (urlCache.size >= URL_CACHE_MAX) urlCache.clear();
      urlCache.set(fileId, { url, at: Date.now() });
      return url;
    } catch (e) {
      lastErr = e;
      const msg = String((e && e.message) || e);
      const throttled = msg.indexOf("429") >= 0 || msg.indexOf("TooManyRequests") >= 0;
      if (!throttled || attempt === 5) throw e;
      await new Promise(function (r) { setTimeout(r, 200 * attempt + Math.floor(Math.random() * 150)); });
    } finally { urlGate.release(); }
  }
  throw lastErr || new Error("取直链失败");
}

// 下载一个块到 destPath：流式写盘；range 给定时只取该段（206），用于大块分段并行；url 可传入预热好的直链
/**/
export async function downloadBlob({ driveId, fileId, destPath, url: givenUrl = null, range = null, stream = true, signal = null } = {}) {
  const tUrl = Date.now();
  const url = givenUrl || await getBlobUrl(driveId, fileId);
  const urlMs = Date.now() - tUrl;
  const headers = { referer: "https://www.aliyundrive.com/" };   // 下载必须带 referer
  if (range) headers.range = "bytes=" + range.start + "-" + range.end;
  const tDl = Date.now();
  const res = await fetch(url, { headers, signal: signal || AbortSignal.timeout(600000) });
  if (!res.ok && res.status !== 206) throw new Error("download HTTP " + res.status);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmp = destPath + ".tmp-dl-" + process.pid + "-" + Math.random().toString(16).slice(2, 8);
  let bytes = 0;
  if (stream && res.body) {
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
    bytes = fs.statSync(tmp).size;
  } else {
    const buf = Buffer.from(await res.arrayBuffer());
    bytes = buf.length;
    fs.writeFileSync(tmp, buf);
  }
  fs.renameSync(tmp, destPath);
  return { url, status: res.status, urlMs, dlMs: Date.now() - tDl, bytes };
}

// 大块分段并行：单连接受 QoS 限速，多 Range 可叠加；每段独立重试一次，到齐后按序拼接
/**/
async function downloadPartsParallel({ driveId, fileId, url, destPath, size, parts, gate, onBytes, signal = null }) {
  const partSize = Math.ceil(size / parts);
  const made = new Array(parts).fill(null);
  await mapLimit(Array.from({ length: parts }, (_, i) => i), parts, async (i) => {
    const start = i * partSize;
    const end = Math.min(size - 1, (i + 1) * partSize - 1);
    if (start > end) return;
    const p = destPath + ".part" + i;
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await gate.acquire();
        try {
          const r = await downloadBlob({ driveId, fileId, destPath: p, url, range: { start, end }, signal });
          if (onBytes) onBytes(r.bytes);
        } finally { gate.release(); }
        made[i] = p;
        return;
      } catch (e) {
        lastErr = e;
        try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e2) { /* 忽略 */ }
        if (attempt < 2) await new Promise(function (r) { setTimeout(r, 250 * attempt); });
      }
    }
    throw lastErr || new Error("分段下载失败");
  });
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmp = destPath + ".tmp-join-" + process.pid + "-" + Math.random().toString(16).slice(2, 8);
  try {
    for (const p of made) {
      if (!p) continue;
      await pipeline(fs.createReadStream(p), fs.createWriteStream(tmp, { flags: "a" }));
    }
    fs.renameSync(tmp, destPath);
  } finally {
    for (const p of made) { if (!p) continue; try { fs.unlinkSync(p); } catch (e3) { /* 忽略 */ } }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e4) { /* 忽略 */ }
  }
}

function makeGate(max) {
  let active = 0;
  const waiters = [];
  return {
    acquire: async function () {
      // 先占位再等：否则两个并发调用都能看到 active<max，一起越过上限
      while (active >= max) await new Promise(function (r) { waiters.push(r); });
      active += 1;
    },
    release: function () {
      active -= 1;
      const w = waiters.shift();
      if (w) w();
    },
  };
}

async function downloadTo(at, driveId, fileId, destPath) {
  const r = await downloadBlob({ driveId, fileId, destPath });
  return r.bytes;
}

/** 云端 manifest 内存缓存（按 stamp，5 分钟、最多 24 份）——目录树反复展开不再重复下载。 */
const MANIFEST_TTL_MS = 5 * 60 * 1000;
const MANIFEST_CACHE_MAX = 64;   // 实测云端 24 份，留足余量避免 LRU 抖动
const manifestCache = new Map();   // stamp -> { man, at }

/** 清掉某份（或全部）云端 manifest 缓存：删除快照后必须调。 */
export function dropManifestCache(stamp) {
  if (stamp) manifestCache.delete(stamp);
  else manifestCache.clear();
}

function manifestCacheGet(stamp) {
  const hit = manifestCache.get(stamp);
  if (!hit) return null;
  if (Date.now() - hit.at > MANIFEST_TTL_MS) { manifestCache.delete(stamp); return null; }
  manifestCache.delete(stamp);          // 命中即延寿：重新 set 一次排到 LRU 队尾
  manifestCache.set(stamp, hit);
  return hit.man;
}

function manifestCachePut(stamp, man) {
  manifestCache.set(stamp, { man, at: Date.now() });
  while (manifestCache.size > MANIFEST_CACHE_MAX) {
    const oldest = manifestCache.keys().next().value;
    manifestCache.delete(oldest);
  }
}

// 取云端某快照的 manifest（带内存缓存），不在本地 store 留半份快照；cacheOnly=true 只查缓存，未命中返回 null。
export async function getRemoteManifest(stamp, { storeDir = storeDirOf(), cacheOnly = false } = {}) {
  const hit = manifestCacheGet(stamp);
  if (hit) return { manifest: hit, cached: true };
  if (cacheOnly) return { manifest: null, cached: false };
  const { manifest } = await fetchRemoteManifest({ stamp, storeDir, persist: false });
  manifestCachePut(stamp, manifest);
  return { manifest, cached: false };
}

/** 取某快照的 manifest（同时落到本地 store 的 snapshots/<stamp>/manifest.json）。 */
export async function fetchRemoteManifest({ stamp, storeDir = storeDirOf(), persist = true } = {}) {
  const creds = loadCredentials() || {};
  const driveId = creds.drive_id || creds.default_drive_id;
  const at = await ensureAccessToken();
  const root = await ensureAppFolder();
  const top = await listAll(at, driveId, root.file_id);
  const snapsDir = top.find((x) => x.name === "snapshots" && x.type === "folder");
  if (!snapsDir) throw new NotFoundError("云端没有 snapshots 目录");
  const dirs = await listAll(at, driveId, snapsDir.file_id);
  const d = dirs.find((x) => x.name === stamp && x.type === "folder");
  if (!d) throw new NotFoundError("云端没有快照 " + stamp);
  const inner = await listAll(at, driveId, d.file_id);
  const mf = inner.find((x) => x.name === "manifest.json");
  if (!mf) throw new NotFoundError("云端快照 " + stamp + " 缺 manifest.json");
  if (!persist) {
    // 只读场景（例如看云端快照的目录树）：落临时文件解析后删掉，不在本地 store 里留半份快照
    const tmp = path.join(os.tmpdir(), "dshcb-mf-" + stamp + "-" + Date.now() + "-" + process.pid + ".json");
    try {
      await downloadTo(at, driveId, mf.file_id, tmp);
      const man = JSON.parse(fs.readFileSync(tmp, "utf8"));
      return { manifest: man, path: null };
    } finally {
      try { fs.unlinkSync(tmp); } catch (e) { /* 忽略 */ }
    }
  }
  const dest = path.join(storeDir, "snapshots", stamp, "manifest.json");
  await downloadTo(at, driveId, mf.file_id, dest);
  const man = JSON.parse(fs.readFileSync(dest, "utf8"));
  return { manifest: man, path: dest };
}

/** 找云端某个 blob 的 file_id：先查本地缓存，再列目录。 */
async function findRemoteBlob(at, driveId, st, rootId, hash) {
  const cached = st.blobs && st.blobs[hash];
  if (cached && cached.file_id) return cached.file_id;
  const objectsTop = await listAll(at, driveId, rootId);
  const objectsDir = objectsTop.find((x) => x.name === "objects" && x.type === "folder");
  if (!objectsDir) return null;
  const blobsDir = (await listAll(at, driveId, objectsDir.file_id)).find((x) => x.name === "blobs" && x.type === "folder");
  if (!blobsDir) return null;
  const d1 = (await listAll(at, driveId, blobsDir.file_id)).find((x) => x.name === hash.slice(0, 2) && x.type === "folder");
  if (!d1) return null;
  const d2 = (await listAll(at, driveId, d1.file_id)).find((x) => x.name === hash.slice(2, 4) && x.type === "folder");
  if (!d2) return null;
  const f = (await listAll(at, driveId, d2.file_id)).find((x) => x.name === hash.slice(4));
  if (!f) return null;
  st.blobs = st.blobs || {};
  st.blobs[hash] = { file_id: f.file_id, size: f.size };
  return f.file_id;
}

// 把一份快照完整拉到本地 store（灾难恢复第一步）：manifest 落盘 + 缺失的 blob 逐个下载并校验 sha256。
// 下载状态：/status 回给界面（客户端下载时轮询，显示 done/total）
let pullProgress = null;
// manifest 覆盖写（先 trash 旧文件、再上传新文件）期间，孤儿清理必须让路：
// 否则清理会把“暂时没有 manifest”的快照目录当孤儿删掉，表现为备份凭空消失
let manifestWriting = 0;
export function getPullProgress() { return pullProgress; }

// 暂停/继续：只作用于进行中的下载；已落盘的块保留，继续时按 hash 自动跳过
let pullPaused = false;
let pullAbort = null;
function pausedError() {
  const e = new Error("已暂停");
  e.paused = true;
  return e;
}
export function pausePull() {
  if (!(pullProgress && pullProgress.active)) return false;
  pullPaused = true;
  pullProgress.paused = true;
  // 立刻断流：正在进行的 fetch 会被 abort，块级循环随即抛 paused → 上层按“已暂停”收尾
  try { if (pullAbort) pullAbort.abort(); } catch (e) { /* 忽略 */ }
  return true;
}
export function isPullPaused() { return pullPaused; }

export async function pullSnapshot(opts = {}) {
  const prog = { phase: "准备", downloaded: 0, total: 0 };
  try {
    return await pullSnapshotInner(opts, prog);
  } catch (e) {
    if (e && e.paused) {
      const p = pullProgress || {};
      pullPaused = false;
      pullProgress = { active: false, paused: true, stamp: opts.stamp, total: p.total || 0, all: p.all || 0,
        done: p.done || 0, bytes: p.bytes || 0, needBytes: p.needBytes || 0, present: p.present || 0,
        scope: p.scope || 0, scopeFiles: p.scopeFiles || 0, ready: p.ready || 0,
        missing: p.missing || 0, at: new Date().toISOString() };
      return { ok: false, paused: true, stamp: opts.stamp, downloaded: p.done || 0, bytes: p.bytes || 0,
        present: p.present || 0, needBytes: p.needBytes || 0, total: p.total || 0, missing: [] };
    }
    if (e instanceof NotFoundError) throw e;
    const msg = String((e && e.message) || e);
    if (/^下载中断|^已下载 /.test(msg)) throw e;
    const head = prog.total
      ? "已下载 " + prog.downloaded + "/" + prog.total + " 块，" + prog.phase + "阶段中断："
      : "一块都没下载下来（" + prog.phase + "阶段失败）：";
    throw new Error("下载中断 —— " + head + msg);
  }
}

// 收整个 opts（而不是解构成局部变量）：函数内部还要读 opts.hashes 做子集下载，解构会让 opts 变成未定义
async function pullSnapshotInner(opts = {}, prog = { phase: "准备", downloaded: 0, total: 0 }) {
  const { stamp, storeDir = storeDirOf(), logger = () => {} } = opts;
  pullPaused = false;
  pullAbort = new AbortController();
  const pullSignal = pullAbort.signal;
  const t0 = Date.now();
  const creds = loadCredentials() || {};
  const driveId = creds.drive_id || creds.default_drive_id;
  const at = await ensureAccessToken();
  const root = await ensureAppFolder();
  const st = loadRemoteState(storeDir);
  st.blobs = st.blobs || {};

  prog.phase = "清单";
  const { manifest } = await fetchRemoteManifest({ stamp, storeDir });
  const sizeOf = new Map();
  const hashes = [];
  for (const f of manifest.files || []) {
    if (!sizeOf.has(f.hash)) { sizeOf.set(f.hash, f.size || 0); hashes.push(f.hash); }
  }
  // 插件的打包产物（tarball）也属于这份快照：还原时装回插件要用
  for (const p of manifest.plugins || []) {
    if (!p || !p.blob) continue;
    if (!sizeOf.has(p.blob)) { sizeOf.set(p.blob, Number(p.bytes) || 0); hashes.push(p.blob); }
  }

  prog.total = hashes.length;
  pullProgress = { active: true, stamp, total: hashes.length, done: 0, bytes: 0, present: 0, missing: 0, at: new Date().toISOString() };
  logInfo("pull.start", { stamp, all: hashes.length, scope: (opts && opts.hashes && opts.hashes.length) || 0 });

  const crypto = await import("node:crypto");
  const digest = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

  // ① 本地已有且自洽的直接计入（并发 8，避免逐个串行 readFileSync + sha256）
  prog.phase = "本地校验";
  const localOk = new Set();
  await mapLimit(hashes, 8, async (hash) => {
    const dest = blobPathIn(storeDir, hash);
    try {
      if (!fs.existsSync(dest)) return;
      const size = fs.statSync(dest).size;
      if (sizeOf.get(hash) && size !== sizeOf.get(hash)) return;   // 尺寸不符直接重下
      if (digest(dest) === hash) localOk.add(hash);
    } catch { /* 读不了就当没有 */ }
  });
  pullProgress.present = localOk.size;

  // 可选：只拉这些 hash（缺省=整份快照）；用于“只下载需要的文件”类场景，避免为几个文件拉整份
  const wanted = (opts && Array.isArray(opts.hashes) && opts.hashes.length) ? new Set(opts.hashes) : null;
  const scopeHashes = wanted ? hashes.filter((h) => wanted.has(h)) : hashes;
  const need = scopeHashes.filter((h) => !localOk.has(h));
  // 进位统计：所选范围内的文件数与“本机已有”的块数（进度文案要能解释“为什么只需下载几块”）
  const scopeFiles = (manifest.files || []).filter((f) => !wanted || wanted.has(f.hash)).length;
  const scopeReady = scopeHashes.length - need.length;

  // ② 一次走完目录树拿到 hash → file_id（逐块重列目录会把调用数放大到上千次）
  prog.phase = "定位块";
  const fileIds = new Map();
  for (const h of need) {
    const c = st.blobs[h];
    if (c && c.file_id) fileIds.set(h, { file_id: c.file_id, size: c.size });
  }
  const unfound = need.filter((h) => !fileIds.has(h));
  if (unfound.length) {
    const top = await listAll(at, driveId, root.file_id);
    const objectsDir = top.find((x) => x.name === "objects" && x.type === "folder");
    const blobsDir = objectsDir
      ? (await listAll(at, driveId, objectsDir.file_id)).find((x) => x.name === "blobs" && x.type === "folder")
      : null;
    if (blobsDir) {
      const byD1 = new Map();
      for (const h of unfound) {
        const k1 = h.slice(0, 2), k2 = h.slice(2, 4);
        if (!byD1.has(k1)) byD1.set(k1, new Set());
        byD1.get(k1).add(k2);
      }
      const lvl1 = await listAll(at, driveId, blobsDir.file_id);
      const d1Id = new Map(lvl1.filter((x) => x.type === "folder").map((x) => [x.name, x.file_id]));
      const pairs = [];
      for (const [k1, k2s] of byD1) if (d1Id.has(k1)) for (const k2 of k2s) pairs.push({ k1: k1, d2: k2, id: d1Id.get(k1) });
      await mapLimit(pairs, 2, async (p) => {
        const lvl2 = await listAll(at, driveId, p.id);
        const hit = lvl2.find((x) => x.name === p.d2 && x.type === "folder");
        if (!hit) return;
        for (const it of await listAll(at, driveId, hit.file_id)) {
          if (it.type !== "file") continue;
          // 云端的块文件名是 hash.slice(4)（前 4 位拆成两级目录），键要还原成完整 hash，否则下载侧永远找不到
          const full = p.k1 + p.d2 + it.name;
          fileIds.set(full, { file_id: it.file_id, size: it.size });
          st.blobs[full] = { file_id: it.file_id, size: it.size };
        }
      });
      saveRemoteState(storeDir, st);
    }
  }

  // ③ 并发下载：块级并发 + 大块分段并行（单连接被限速，靠多连接叠加），直链边下边预热
  prog.phase = "下载";
  // 进度按“这次真正要下载的块数/字节数”计（本地已有的不计入分母，否则界面会长时间停在很小的百分比）
  prog.total = need.length;
  prog.all = scopeHashes.length;
  const needBytes = need.reduce(function (n, h) { const rf = fileIds.get(h); return n + ((rf && rf.size) || 0); }, 0);
  pullProgress.total = need.length;
  pullProgress.all = hashes.length;
  pullProgress.present = localOk.size;
  pullProgress.needBytes = needBytes;
  pullProgress.scope = scopeHashes.length;
  pullProgress.scopeFiles = scopeFiles;
  pullProgress.ready = scopeReady;
  const tPhase = { urls: 0, transfer: 0 };
  let downloaded = 0, bytes = 0;
  const missing = [];
  let firstErr = "";
  const envNum = function (name, dflt, lo, hi) {
    const v = Number(process.env[name]);
    return Math.max(lo, Math.min(hi, Number.isFinite(v) && v > 0 ? v : dflt));
  };
  const CONC = envNum("DSH_CLOUD_BACKUP_DOWNLOAD_CONC", 24, 1, 32);
  const PART_BYTES = envNum("DSH_CLOUD_BACKUP_DL_PART_BYTES", 3 * 1024 * 1024, 262144, 8 * 1024 * 1024);
  const PARTS_MAX = envNum("DSH_CLOUD_BACKUP_DL_PARTS", 6, 1, 8);
  const gate = makeGate(envNum("DSH_CLOUD_BACKUP_DL_CONN", 32, 2, 64));
  const urlMap = new Map();
  const PREFETCH = envNum("DSH_CLOUD_BACKUP_DL_PREFETCH", 6, 1, 8);
  const urlPool = mapLimit(need, PREFETCH, async function (h) {
    const rf = fileIds.get(h);
    if (!rf || !rf.file_id) return;
    try { urlMap.set(h, await getBlobUrl(driveId, rf.file_id)); } catch (e) { /* 传输时会再取一次并如实报错 */ }
  });
  await mapLimit(need, CONC, async (hash) => {
    const ref = fileIds.get(hash);
    const dest = blobPathIn(storeDir, hash);
    if (!ref || !ref.file_id) { missing.push(hash); pullProgress.missing = missing.length; return; }
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (pullPaused) throw pausedError();
      try {
        const url = urlMap.get(hash) || await getBlobUrl(driveId, ref.file_id);
        const size = Number(ref.size) || 0;
        const parts = size > 0 ? Math.max(1, Math.min(PARTS_MAX, Math.ceil(size / PART_BYTES))) : 1;
        if (parts > 1) {
          await downloadPartsParallel({ driveId, fileId: ref.file_id, url, destPath: dest, size, parts, gate, signal: pullSignal,
            onBytes: function (n) { bytes += n; pullProgress.bytes = bytes; } });
        } else {
          await gate.acquire();
          try {
            const r = await downloadBlob({ driveId, fileId: ref.file_id, destPath: dest, url, signal: pullSignal });
            bytes += r.bytes;
            pullProgress.bytes = bytes;
          } finally { gate.release(); }
        }
        if (digest(dest) !== hash) { try { fs.unlinkSync(dest); } catch (e) { /* 忽略 */ } throw new Error("hash 校验不符"); }
        downloaded += 1;
        prog.downloaded = downloaded;
        pullProgress.done = downloaded;
        if (downloaded === 1 || downloaded % 20 === 0 || downloaded === need.length) {
          // present 跟随实际落盘进度，别停在开始时的数字
          pullProgress.present = countPresent(storeDir, hashes);
          logInfo("pull.progress", { stamp, done: downloaded, total: need.length, bytes, needBytes, present: pullProgress.present, all: hashes.length });
          checkDownloadConsistency(pullProgress);
        }
        if (downloaded % 20 === 0) logger("pulled " + downloaded + " blob(s)");
        return;
      } catch (e) {
        if (e && e.paused) throw e;
        if (pullPaused) throw pausedError();   // abort 造成的中断按“已暂停”处理，不当成块失败
        lastErr = e;
        try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch (e2) { /* 忽略 */ }
        if (attempt < 2) await new Promise(function (r) { setTimeout(r, 250 * attempt); });
      }
    }
    const msg = String((lastErr && lastErr.message) || lastErr);
    if (!firstErr) firstErr = msg;
    logger("blob " + hash.slice(0, 12) + " 失败: " + msg);
    missing.push(hash);
    pullProgress.missing = missing.length;
  });
  await urlPool.catch(function () { /* 预热失败无关紧要 */ });
  pullAbort = null;
  saveRemoteState(storeDir, st);

  // 收尾重数一遍：开始时统计的 present 不含这一轮刚下完的块
  let presentEnd = countPresent(storeDir, hashes);
  const out = { ok: missing.length === 0, stamp, manifest, total: hashes.length, downloaded, present: presentEnd, missing, bytes, seconds: Math.round((Date.now() - t0) / 1000),
    needBytes, error: missing.length ? ("已下载 " + downloaded + "/" + need.length + " 块，仍有 " + missing.length + " 块没下来（" + (firstErr || "未知原因") + "）") : undefined };
  pullProgress = { active: false, stamp, total: need.length, all: hashes.length, done: downloaded, bytes, needBytes, present: presentEnd, scope: scopeHashes.length, scopeFiles, ready: scopeReady, missing: missing.length, seconds: out.seconds, at: new Date().toISOString() };
  {
    const complete = missing.length === 0 && out.ok !== false;
    const fields = { stamp, done: downloaded, total: need.length, bytes, needBytes, present: presentEnd, all: hashes.length, missing: missing.length, seconds: out.seconds, firstError: out.firstError };
    if (complete) logInfo("pull.complete", fields); else logWarn("pull.incomplete", fields);
    checkDownloadConsistency(pullProgress);
  }
  logger("pull " + stamp + ": " + downloaded + " downloaded / " + presentEnd + " local / " + missing.length + " missing");
  return out;
}

/** 本地 blob 路径（与 lib/engine/blob.js 的 blobPath 同规则，避免循环依赖） */
function countPresent(storeDir, hashes) {
  let n = 0;
  for (const h of hashes) { try { if (fs.existsSync(blobPathIn(storeDir, h))) n++; } catch { /* 读不到就当没有 */ } }
  return n;
}

function blobPathIn(storeDir, hash) {
  return path.join(storeDir, "objects", "blobs", hash.slice(0, 2), hash.slice(2, 4), hash.slice(4));
}

// 把一次快照同步到云端：blob 只传缺的，manifest 与 index 每次都刷新。返回 {ok, uploaded, skipped, bytes, snapshots, error?}。
async function syncSnapshotInner({ storeDir = storeDirOf(), manifest, blobs, logger = () => {} } = {}, prog) {
  invalidateRemoteSnapshotCache();   // 云端结构要变了，列表缓存作废
  const t0 = Date.now();
  prog.phase = "准备";
  await ensureAccessToken();                       // 必要时先续期（返回的是 token 字符串，不是凭据对象）
  const creds = loadCredentials() || {};
  const driveId = creds.drive_id || creds.default_drive_id;
  if (!driveId) return { ok: false, error: "凭据里没有 drive_id" };

  const rootFolder = await ensureAppFolder();
  const rootId = rootFolder.file_id;
  const st = loadRemoteState(storeDir);
  st.folders = st.folders || {};
  st.blobs = st.blobs || {};

  // 1) 需要的 blob
  const need = [];
  const seen = new Set();
  const planEntries = [];
  for (const f of manifest.files || []) planEntries.push({ hash: f.hash, size: f.size });
  for (const p of manifest.plugins || []) if (p && p.blob) planEntries.push({ hash: p.blob, size: Number(p.bytes) || 0 });
  for (const f of planEntries) {
    if (seen.has(f.hash)) continue;
    seen.add(f.hash);
    const cached = st.blobs[f.hash];
    const blobFile = path.join(storeDir, "objects", "blobs", f.hash.slice(0, 2), f.hash.slice(2, 4), f.hash.slice(4));
    const localSize = (() => { try { return fs.statSync(blobFile).size; } catch { return -1; } })();
    if (localSize < 0) { logger("blob missing locally, skip: " + f.hash); continue; }
    if (cached && cached.size === localSize) continue;    // 云端已有
    need.push({ hash: f.hash, file: blobFile, size: localSize });
  }
  logger("upload plan: " + need.length + " new blob(s), " + (manifest.files || []).length + " file entries");
  prog.total = need.length;
  prog.phase = "数据块";

  let uploaded = 0, bytes = 0;
  const atFirst = await ensureAccessToken();
  const objectsId = await ensurePath(atFirst, driveId, rootId, ["objects", "blobs"], st.folders);

  // 目录先串行建好（避免并发重复建同名目录），文件再并发传
  const d2ByKey = new Map();
  for (const b of need) {
    const k = b.hash.slice(0, 2) + "/" + b.hash.slice(2, 4);
    if (d2ByKey.has(k)) continue;
    const d1 = await ensureFolder(atFirst, driveId, objectsId, b.hash.slice(0, 2), st.folders, "objects/blobs/" + b.hash.slice(0, 2));
    const d2 = await ensureFolder(atFirst, driveId, d1, b.hash.slice(2, 4), st.folders, "objects/blobs/" + k);
    d2ByKey.set(k, d2);
  }

  const CONC = Number(process.env.DSH_CLOUD_BACKUP_UPLOAD_CONC || 4);
  const queue = need.slice();
  const worker = async () => {
    for (;;) {
      const b = queue.shift();
      if (!b) return;
      const at = await ensureAccessToken();
      const d2 = d2ByKey.get(b.hash.slice(0, 2) + "/" + b.hash.slice(2, 4));
      const blobSize = fs.statSync(b.file).size;
      let r;
      try {
        r = await uploadFromFile(at, driveId, d2, b.hash.slice(4), b.file, blobSize);
      } catch (e) {
        const msg = String((e && e.message) || e);
        const err = new Error((uploaded > 0
          ? "已传 " + uploaded + "/" + need.length + " 块后失败：" + msg
          : "一块都没传上去，失败原因：" + msg));
        err.uploaded = uploaded;
        err.total = need.length;
        err.bytes = bytes;
        err.detail = msg;
        throw err;
      }
      st.blobs[b.hash] = { file_id: r.file_id, size: b.size };
      uploaded++;
      bytes += b.size;
      prog.uploaded = uploaded;
      if (uploaded % 20 === 0) { saveRemoteState(storeDir, st); logger("uploaded " + uploaded + "/" + need.length + " (" + (bytes / 1048576).toFixed(1) + " MB)"); }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(CONC, need.length)) }, worker));
  saveRemoteState(storeDir, st);

  // 2) 快照清单
  prog.phase = "清单";
  const at2 = await ensureAccessToken();
  const snapsId = await ensurePath(at2, driveId, rootId, ["snapshots"], st.folders);

  // 2.0) 补齐快照清单：blob 已全部在云端但 manifest 缺失（上次上传中途失败）时补传，
  //      否则恢复端看不到那份快照（本地/云端快照集合不一致）。
  let backfilled = 0;
  try {
    const mf = await import("../engine/manifest.js");
    for (const sn of mf.listSnapshots(storeDir)) {
      const stamp = sn.stamp || sn.name;
      if (stamp === manifest.stamp) continue;
      const man = mf.readManifest(mf.manifestPath(storeDir, stamp));
      if (!man) continue;
      if (!(man.files || []).every((f) => st.blobs[f.hash])) continue;
      const dir = await ensurePath(at2, driveId, snapsId, [stamp], st.folders, "snapshots");
      const listing = await listAll(at2, driveId, dir);
      if (listing.some((x) => x.name === "manifest.json")) continue;
      await uploadBuffer(at2, driveId, dir, "manifest.json", Buffer.from(JSON.stringify(man)));
      backfilled++;
    }
    if (backfilled) logger("backfilled " + backfilled + " snapshot manifest(s)");
  } catch (e) { logger("backfill skipped: " + ((e && e.message) || e)); }

  const snapId = await ensurePath(at2, driveId, snapsId, [manifest.stamp], st.folders, "snapshots");
  const mfBuf = Buffer.from(JSON.stringify(manifest));
  const mfName = "manifest.json";
  manifestWriting += 1;
  try {
    const existing = await listAll(at2, driveId, snapId);
    if (existing.some((x) => x.name === mfName)) {
      // 覆盖语义：阿里云盘没有覆盖上传，先回收旧文件再传（此窗口内禁止孤儿清理）
      const old = existing.find((x) => x.name === mfName);
      try { await api("/v2/recyclebin/trash", { at: at2, body: { drive_id: driveId, file_id: old.file_id } }); } catch {}
    }
    await uploadBuffer(at2, driveId, snapId, mfName, mfBuf);
  } finally { manifestWriting -= 1; }

  // 2.5) 备份索引（列表用的元数据面）：一份快照一行，写失败不影响备份本身
  try {
    await upsertBackupIndex({
      [manifest.stamp]: {
        files: (manifest.files || []).length,
        bytes: manifest.stats?.bytes ?? 0,
        created_at: manifest.created_at || null,
        uploaded_at: new Date().toISOString(),
        plugins: (manifest.plugins || []).length,
      },
    });
  } catch (e) { logger("backup-index write skipped: " + ((e && e.message) || e)); }

  // 3) 根索引
  prog.phase = "索引";
  const idxFile = path.join(storeDir, "index.json");
  if (fs.existsSync(idxFile)) {
    const idxBuf = fs.readFileSync(idxFile);
    const rootList = await listAll(at2, driveId, rootId);
    const oldIdx = rootList.find((x) => x.name === "index.json");
    if (oldIdx) { try { await api("/v2/recyclebin/trash", { at: at2, body: { drive_id: driveId, file_id: oldIdx.file_id } }); } catch {} }
    await uploadBuffer(at2, driveId, rootId, "index.json", idxBuf);
  }

  saveRemoteState(storeDir, st);
  const out = { ok: true, uploaded, skipped: need.length - uploaded, backfilled, bytes, snapshots: [manifest.stamp], seconds: Math.round((Date.now() - t0) / 1000) };
  logger("cloud sync OK: " + uploaded + " uploaded / " + (bytes / 1048576).toFixed(2) + " MB / " + out.seconds + "s");
  return out;
}

/** 上传失败时把「进行到哪一步、传了多少块」写进错误里：用户能分清是没开始传，还是传到一半断的。 */
export async function syncSnapshot(opts = {}) {
  const prog = { phase: "准备", uploaded: 0, total: 0 };
  const head = () => (prog.uploaded > 0
    ? "已传 " + prog.uploaded + "/" + prog.total + " 块，" + prog.phase + "阶段失败："
    : "一块都没传上去（" + prog.phase + "阶段失败）：");
  try {
    const out = await syncSnapshotInner(opts, prog);
    // 有的失败是“返回错误对象”而不是抛异常，也要带上进度（否则界面只剩一句原始报错）
    if (out && out.ok === false && out.error) {
      return Object.assign({}, out, { error: head() + String(out.error), uploaded: prog.uploaded, total: prog.total, phase: prog.phase });
    }
    return out;
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (msg.indexOf("一块都没传上去") === 0 || /^已传 \d+\/\d+ 块/.test(msg)) throw e;
    const err = new Error(head() + msg);
    err.uploaded = prog.uploaded;
    err.total = prog.total;
    err.detail = msg;
    err.phase = prog.phase;
    throw err;
  }
}

/** 让 runBackup 直接可用的 uploader。 */
export function createUploader({ storeDir = storeDirOf(), logger = () => {} } = {}) {
  return async (ctx) => syncSnapshot({ storeDir: ctx.storeDir || storeDir, manifest: ctx.manifest, blobs: ctx.blobs, logger: ctx.logger || logger });
}

// 真实核对：用远端目录列表确认 manifest 与每个 blob 确实存在；只信远端返回，不信本地 remote-index 缓存。
export async function verifyRemote({ storeDir = storeDirOf(), manifest, sample = 0, logger = () => {} } = {}) {
  const at = await ensureAccessToken();
  const creds = loadCredentials() || {};
  const driveId = creds.drive_id || creds.default_drive_id;
  const rootFolder = await ensureAppFolder();
  const rootId = rootFolder.file_id;
  const st = loadRemoteState(storeDir);

  // 1) 快照目录里必须有 manifest.json
  const snapsRoot = st.folders["snapshots"];
  if (!snapsRoot) return { ok: false, error: "远端没有 snapshots 目录" };
  const snapId = st.folders["snapshots/" + manifest.stamp] || st.folders[manifest.stamp];
  if (!snapId) return { ok: false, error: "远端没有快照目录 " + manifest.stamp + "（缓存键缺失，先跑一次同步）" };
  const snapFiles = await listAll(at, driveId, snapId);
  const hasManifest = snapFiles.some((f) => f.name === "manifest.json");

  // 2) blob 抽查（sample=0 表示全查，但只列表不下载）
  const hashes = [...new Set((manifest.files || []).map((f) => f.hash))];
  const pick = sample > 0 ? hashes.filter((_, i) => i % Math.max(1, Math.floor(hashes.length / sample)) === 0).slice(0, sample) : hashes;
  const dirCache = new Map();
  let present = 0;
  const missing = [];
  for (const h of pick) {
    const k = h.slice(0, 2) + "/" + h.slice(2, 4);
    if (!dirCache.has(k)) {
      const id = st.folders["objects/blobs/" + k];
      dirCache.set(k, id ? await listAll(at, driveId, id) : []);
    }
    const names = dirCache.get(k).map((x) => x.name);
    if (names.includes(h.slice(4))) present++; else missing.push(h);
  }
  logger("verify: manifest=" + hasManifest + " blobs " + present + "/" + pick.length + " present, missing " + missing.length);
  return { ok: hasManifest && missing.length === 0, hasManifest, checked: pick.length, present, missing: missing.slice(0, 10), totalHashes: hashes.length };
}

// 备份索引：云盘侧元数据面（应用根目录 backup-index.json）。列表阶段不能把每份 manifest 都拉一遍，故缓存 files/bytes/created_at/uploaded_at；只是元数据缓存，永远可从快照目录重建，丢了不影响数据正确性。
const BIDX_NAME = "backup-index.json";
let bidxCache = null;          // { entries }

function invalidateBackupIndex() { bidxCache = null; }

/** 读云端备份索引（fresh=true 强制回源；失败时退化为上一次缓存/空表，不抛）。 */
export async function getBackupIndex({ fresh = false } = {}) {
  if (!fresh && bidxCache) return { ok: true, entries: bidxCache.entries, cached: true };
  try {
    const at = await ensureAccessToken();
    const creds = loadCredentials() || {};
    const driveId = creds.drive_id || creds.default_drive_id;
    if (!driveId) throw new Error("凭据里没有 drive_id");
    const root = await ensureAppFolder();
    const list = await listAll(at, driveId, root.file_id);
    const f = list.find((x) => x.name === BIDX_NAME && x.type !== "folder");
    let entries = {};
    if (f) {
      const tmp = path.join(os.tmpdir(), "dshcb-bidx-" + process.pid + "-" + Date.now() + ".json");
      try {
        await downloadTo(at, driveId, f.file_id, tmp);
        const j = JSON.parse(fs.readFileSync(tmp, "utf8"));
        if (j && typeof j.entries === "object" && j.entries) entries = j.entries;
      } catch (e) {
        logger0("backup-index unreadable, treat as empty: " + ((e && e.message) || e));
      } finally { try { fs.unlinkSync(tmp); } catch (e) { /* 忽略 */ } }
    }
    bidxCache = { entries };
    return { ok: true, entries, cached: false };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), entries: bidxCache ? bidxCache.entries : {}, cached: true };
  }
}

// 合并写入备份索引（upsert 语义；stamps 里给 null 表示删除该项）。
export async function upsertBackupIndex(patch = {}) {
  const before = await getBackupIndex({ fresh: true });
  if (!before.ok) return { ok: false, count: Object.keys(before.entries || {}).length, error: before.error || "读索引失败（跳过写入）" };
  const merged = { ...(before.entries || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v == null) delete merged[k]; else merged[k] = v;
  }
  try {
    const at = await ensureAccessToken();
    const creds = loadCredentials() || {};
    const driveId = creds.drive_id || creds.default_drive_id;
    const root = await ensureAppFolder();
    const list = await listAll(at, driveId, root.file_id);
    const old = list.find((x) => x.name === BIDX_NAME && x.type !== "folder");
    if (old) { try { await api("/v2/recyclebin/trash", { at, body: { drive_id: driveId, file_id: old.file_id } }); } catch (e) { /* 回收失败不阻塞 */ } }
    const body = JSON.stringify({ v: 1, updated_at: new Date().toISOString(), entries: merged });
    await uploadBuffer(at, driveId, root.file_id, BIDX_NAME, Buffer.from(body));
    bidxCache = { entries: merged };
    return { ok: true, count: Object.keys(merged).length };
  } catch (e) {
    return { ok: false, count: Object.keys(merged).length, error: (e && e.message) || String(e) };
  }
}

/** 本地小工具：这些函数在模块顶层用不到 logger 参数，退化到 console.debug。 */
function logger0(m) { try { if (process.env.DSH_CLOUD_BACKUP_DEBUG) console.debug("[dsh-cloud-backup] " + m); } catch (e) { /* 忽略 */ } }
