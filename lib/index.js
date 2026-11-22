// dsh-cloud-backup 宿主侧：授权、备份与维护路由。

import fs, { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { authStatus, startQrSession, pollQrSession, refreshTokens, disconnect, userGet, ensureAppFolder, ensureAccessToken, exchangeCode, openPlatformAuthorizeUrl, exchangeOpenPlatformCode, ALIPAN_OAUTH, CLIENT_ID, appFolderName, AuthError } from "./auth/aliyun.js";
import { qrPageHtml, oauthAuthorizeUrl } from "./auth/qr-page.js";
import { adoptLocalClient } from "./auth/adrive-local.js";
import { importRefreshToken, peekLoginState } from "./auth/drive-login-state.js";
import { qrSvg } from "./qr.js";
import { dataDir, storeDir } from "./store/paths.js";
import { backend } from "./store/secret.js";
import { loadState, saveState } from "./store/state.js";
import { loadConfig, saveConfig } from "./store/config.js";
import { runBackup, auditStore } from "./engine/run.js";
import { createUploader, listRemoteSnapshots, pullSnapshot, getPullProgress, pausePull, isPullPaused, cleanupRemoteOrphans, gcRemoteSnapshots, pruneRemoteSnapshots, getRemoteManifest, dropManifestCache, invalidateRemoteSnapshotCache } from "./providers/aliyun.js";
import { pruneLocalSnapshots } from "./engine/prune.js";
import { listBackups, deleteBackup, pruneCache, cacheStats, uploadBackup } from "./engine/backups.js";
import { compatInfo } from "./engine/host-version.js";
import { isStamp, isLoopbackHost, isLocalOrigin, hasCsrfHeader, clampInt } from "./util/validate.js";
import { logInfo, logWarn, logError, tailLines, logStats, logDir, logPath, checkDownloadConsistency } from "./util/log.js";
import { loadCredentials, needsRefresh } from "./store/credentials.js";
import { listRestorable, previewRestore, restoreSnapshot, verifyRestore, snapshotTree, treeFromManifest } from "./engine/restore.js";
import { installPluginPacks, buildRestorePrompt, localPluginsDir } from "./engine/plugin-install.js";
import { detectHost, sameHost } from "./engine/host-info.js";
import { launchSpec, describeLaunch, restartRefusal, servingPort, scheduleRestart } from "./engine/restart.js";
import { readManifest, manifestPath } from "./engine/manifest.js";

// 开放平台 OAuth：state 表 + 回跳地址（用请求 Host 推导，避免端口写死）
const oauthStates = new Map();
// 同一时刻只允许一份快照在下载：进度与暂停状态是 provider 级单例，并发会让它们互相覆盖
let pullInFlight = null;
// 还原进度：面板在还原期间轮询 /status 读它；取消只置标志，停止点由 restoreSnapshot 在文件之间判定
let rsProgress = null;
function oauthCallbackUri(req, cfg) {
  if (cfg && cfg.oauthRedirectUri) return String(cfg.oauthRedirectUri);
  const host = String((req.headers && req.headers.host) || "127.0.0.1");
  return "http://" + host + BASE + "/auth/oauth/callback";
}
function oauthStart(req, cfg) {
  const callbackUri = oauthCallbackUri(req, cfg);
  if (!cfg.oauthClientId || !cfg.oauthClientSecret) {
    return {
      ok: false, callbackUri,
      hint: "还没配置开放平台 App：去阿里云盘开放平台创建应用并把回调地址填成 " + callbackUri +
        "，再把 App ID / App Secret 填进面板「开放平台 App（可选）」，即可用浏览器一键授权。",
    };
  }
  for (const [k, v] of oauthStates) { if (Date.now() - v.at > 10 * 60 * 1000) oauthStates.delete(k); }
  const state = "st-" + Date.now().toString(36) + "-" + Math.random().toString(16).slice(2, 10);
  const redirectUri = cfg.oauthRedirectUri ? String(cfg.oauthRedirectUri) : callbackUri;
  oauthStates.set(state, { at: Date.now(), redirectUri });
  return { ok: true, url: openPlatformAuthorizeUrl({ clientId: cfg.oauthClientId, redirectUri, state }), redirectUri, callbackUri };
}

export const name = "dsh-cloud-backup";
export const inject = ["webServer"];

const BASE = "/api/dsh-cloud-backup";
const LOGIN_URL = "https://www.alipan.com/";   // 网页版首页（兜底）
const OAUTH_REDIRECT = "https://www.aliyundrive.com/sign/callback";   // 官方授权页的回调（注册在客户端里）
const LEGACY_BASE = "/dsh-cloud-backup";        // 旧版路径，保留 status 别名便于排障
const QR_TTL_SEC = 180;
const SESSION_GC_MS = 10 * 60 * 1000;

/** 进行中的扫码会话（内存态：重启即失效，符合安全直觉） */
const sessions = new Map();

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}
const ok = (res, value = {}) => json(res, 200, { ok: true, ...value });
const bad = (res, status, message, extra = {}) => json(res, status, { ok: false, error: String(message), ...extra });

async function readJson(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) { req.resume?.(); return undefined; }   // 超限也要把流读干，否则连接悬挂
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return undefined; }
}

// 路由前置守卫：统一做方法校验与来源校验
// 只读路由；其余一律要求 POST。非 GET 请求必须来自本机来源且 content-type 为 application/json
function readRuntimeOf(storeDir, stamp) {
  try {
    const m = readManifest(manifestPath(storeDir, stamp));
    return (m && m.runtime) || null;
  } catch { return null; }
}

function currentHost() {
  return detectHost({ dshHome: process.env.DSH_HOME || "", argv: process.argv, env: process.env, versions: process.versions });
}

const GET_PATHS = new Set(["/plugins/prompt","/status", "/backup/status", "/backups", "/restore/snapshots", "/restore/tree", "/auth/qr/page", "/auth/oauth-url", "/auth/oauth/start", "/auth/oauth/callback", "/logs", "/restore/history"]);
function routeTail(p) {
  for (const prefix of [BASE, LEGACY_BASE]) if (p.indexOf(prefix) === 0) return p.slice(prefix.length);
  return p;
}
function guard(method, inner) {
  return async (req, res) => {
    try {
      const m = String(req.method || "GET").toUpperCase();
      if (!isLoopbackHost(req.headers && req.headers.host)) return bad(res, 403, "只接受本机访问");
      if (m === "OPTIONS") return bad(res, 405, "不支持的方法");
      if (method === "GET") {
        if (m !== "GET" && m !== "HEAD") return bad(res, 405, "该接口只接受 GET");
      } else {
        if (m !== "POST") return bad(res, 405, "该接口只接受 POST");
        if (!isLocalOrigin(req.headers && req.headers.origin)) return bad(res, 403, "跨站请求被拒绝");
        const ct = String((req.headers && req.headers["content-type"]) || "");
        if (ct && ct.indexOf("application/json") < 0) return bad(res, 415, "content-type 必须是 application/json");
        // 跨站脚本无法伪造自定义头（带自定义头会先发预检，而预检被上面的 405 拒），因此这一项关掉 CSRF。
        if (!hasCsrfHeader(req.headers)) return bad(res, 403, "缺少 CSRF 标记头（x-dshcb-csrf: 1）");
      }
      return await inner(req, res);
    } catch (error) {
      const status = error instanceof AuthError ? 400 : (error && error.status === 404) ? 404 : 500;
      logError("route.error", { via: "guard", status, message: (error && error.message) || String(error), stack: (error && error.stack) ? String(error.stack).split("\n").slice(0, 4).join(" | ") : undefined });
      bad(res, status, (error && error.message) || String(error));
    }
  };
}

/** 校验快照 ID（会直接拼路径），不合法直接 400 */
function badStamp(res, value) {
  if (!isStamp(value)) { bad(res, 400, "非法 stamp（只接受快照 ID，如 20261028-210209）"); return true; }
  return false;
}

function sweep(now = Date.now()) {
  for (const [id, s] of sessions) if (now - s.createdAt > SESSION_GC_MS) sessions.delete(id);
}

/** 统一包裹：任何异常都转成 JSON，避免宿主只回 500 空体 */
function handler(fn) {
  return async (req, res) => {
    try { await fn(req, res); }
    catch (error) {
      const status = error instanceof AuthError ? 400 : (error && error.status === 404) ? 404 : 500;
      logError("route.error", { via: "handler", path: String((req && req.url) || ""), status, message: (error && error.message) || String(error), stack: (error && error.stack) ? String(error.stack).split("\n").slice(0, 4).join(" | ") : undefined });
      bad(res, status, (error && error.message) || String(error));
    }
  };
}

let _audit = { at: 0, value: null };
const AUDIT_TTL_MS = 20 * 1000;
function safeAudit({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && _audit.value && now - _audit.at < AUDIT_TTL_MS) return _audit.value;
  try { _audit = { at: now, value: auditStore() }; } catch (e) { _audit = { at: now, value: { error: String((e && e.message) || e) } }; }
  return _audit.value;
}

/** 调度器运行态：给界面显示「下次自动备份」。进程内变量，宿主重启后重建。 */
const sched = { nextAt: 0, intervalMin: 0, running: false };

/**
 */
function pluginVersion() {
  try {
    const here = fileURLToPath(new URL("../package.json", import.meta.url));
    return JSON.parse(readFileSync(here, "utf8")).version || "0.1.0";
  } catch {
    return "0.1.0";
  }
}
const VERSION = pluginVersion();

function statusPayload() {
  const st = loadState();
  return {
    version: VERSION,
    provider: "aliyun",
    providerLabel: "阿里云盘",
    appFolder: appFolderName(),
    stateDir: dataDir(),
    secretBackend: backend(),
    folder: st.folder || null,
    lastVerifiedAt: st.verified_at || null,
    auth: authStatus(),
    bootId: BOOT_ID,
    compat: compatInfo(),
    backup: { last: st.last_backup || null, lastRestore: st.last_restore || null,
      needsRestart: !!(st.last_restore && st.last_restore.bootId === BOOT_ID && (st.last_restore.restored || 0) > 0),
      audit: safeAudit(), config: loadConfig(), host: currentHost() },
    schedule: {
      enabled: loadConfig().enabled !== false,
      intervalMinutes: Number(loadConfig().intervalMinutes) || 60,
      nextAt: sched.nextAt ? new Date(sched.nextAt).toISOString() : null,
      running: !!sched.running,
    },
    restore: { dshHome: process.env.DSH_HOME || "", defaultTarget: "", progress: rsProgress },
    pull: getPullProgress(),
  };
}

// 每次进程启动生成一个标识：面板据此判断“还原之后有没有重启过”
const BOOT_ID = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
const HISTORY_MAX = 10;   // 只留最近 10 条还原记录（够回溯，也不让弹窗无限长）

function historyPath() { return path.join(dataDir(), "restore-history.json"); }

function readRestoreHistory() {
  try {
    const j = JSON.parse(fs.readFileSync(historyPath(), "utf8"));
    return Array.isArray(j.items) ? j.items : [];
  } catch { return []; }
}

function appendRestoreHistory(entry) {
  try {
    const items = [entry].concat(readRestoreHistory()).slice(0, HISTORY_MAX);
    fs.mkdirSync(path.dirname(historyPath()), { recursive: true });
    fs.writeFileSync(historyPath(), JSON.stringify({ v: 1, items }, null, 2));
    return true;
  } catch (e) { logWarn("restore.history.fail", { message: (e && e.message) || String(e) }); return false; }
}

function storeDirHint() { return process.env.DSH_CLOUD_BACKUP_STORE || ""; }

export function apply(ctx) {
  const logger = ctx.logger ?? console;
  try { logInfo("plugin.start", { pid: process.pid, node: process.version, platform: process.platform + "/" + process.arch, dshHome: process.env.DSH_HOME || "", store: storeDirHint() }); } catch {}

  // 预热：把凭据解密、state 读取、最新快照清单读进缓存，面板第一次 /status 不必替我们付冷启动的钱
  setTimeout(function () {
    try {
      authStatus();
      loadState();
      const list = listBackups({ storeDir: storeDirHint() });
      const first = (list && list.items && list.items[0]) || null;
      if (first) snapshotTree({ stamp: first.stamp, depth: 1 });
    } catch (e) { /* 预热失败不影响功能 */ }
  }, 200);

  ctx.inject(["webServer"], (sctx) => {
    sctx.effect(() => {
      const routes = [
        {
          kind: "exact", path: BASE + "/restore/history",
          handler: handler(async (req, res) => ok(res, { items: readRestoreHistory(), bootId: BOOT_ID })),
        },
        {
          kind: "exact", path: BASE + "/logs",
          handler: handler(async (req, res) => {
            const q = String(req.url || "");
            const at = q.indexOf("tail=");
            const n = at >= 0 ? Number(q.slice(at + 5).split("&")[0]) : 300;
            const st = logStats();
            ok(res, { ok: true, path: st.file, dir: st.dir, bytes: st.bytes, rotatedBytes: st.rotatedBytes, lines: tailLines(n) });
          }),
        },
        {
          kind: "exact", path: BASE + "/logs/open",
          handler: handler(async (req, res) => {
            const dir = logDir();
            const cp = await import("node:child_process");
            const cmd = process.platform === "win32" ? ["explorer.exe", [dir]] : process.platform === "darwin" ? ["open", [dir]] : ["xdg-open", [dir]];
            try {
              const child = cp.spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" });
              child.unref();
            } catch (e) {
              logWarn("logs.open.fail", { message: (e && e.message) || String(e) });
            }
            logInfo("logs.open", { dir });
            ok(res, { ok: true, dir, file: logPath() });
          }),
        },
        {
          kind: "exact", path: BASE + "/status",
          handler: handler(async (req, res) => {
            sweep();
            // 自愈放到后台：读状态不能被网络与 DPAPI 解密拖慢
            try {
              const c = loadCredentials();
              if (c && needsRefresh(c)) ensureAccessToken().catch(() => {});
            } catch {}
            ok(res, statusPayload());
          }),
        },
        {
          kind: "exact", path: BASE + "/auth/qr/start",
          handler: handler(async (req, res) => {
            sweep();
            const body = await readJson(req);
            if (body === undefined) return bad(res, 400, "请求体不是合法 JSON");
            // 每次只保留一个活跃会话，避免多个二维码同时被扫
            for (const [oldId, oldS] of sessions) { if (Date.now() - oldS.createdAt > oldS.expireMs + 30_000) sessions.delete(oldId); }
            while (sessions.size > 4) { const firstKey = sessions.keys().next().value; sessions.delete(firstKey); }
            const session = await startQrSession();
            sessions.set(session.id, session);
            const hostHdr = String((req.headers && (req.headers.host || req.headers.Host)) || "127.0.0.1");
            const absBase = "http://" + hostHdr;
            const pagePath = BASE + "/auth/qr/page?session=" + encodeURIComponent(session.id);
            const svg = qrSvg(session.codeContent, { cellSize: 4, margin: 2, alt: "阿里云盘登录二维码" });
            const dataUrl = "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
            logger.info?.(`[dsh-cloud-backup] QR session ${session.id} created`);
            ok(res, {
              sessionId: session.id, qr: dataUrl, qrUrl: session.codeContent, loginUrl: LOGIN_URL,
              pageUrl: pagePath, pageUrlAbs: absBase + pagePath,
              oauthUrl: null,
              expiresInSec: QR_TTL_SEC,
              hint: "用阿里云盘 App 扫码确认；也可以用本机浏览器打开登录页确认（浏览器已登录阿里云盘时最快）",
            });
          }),
        },
        {
          kind: "exact", path: BASE + "/auth/qr/poll",
          handler: handler(async (req, res) => {
            const body = await readJson(req);
            if (!body || !body.sessionId) return bad(res, 400, "缺少 sessionId");
            const session = sessions.get(body.sessionId);
            if (!session) return ok(res, { status: "expired", reason: "会话不存在或已失效，请重新生成二维码" });
            const r = await pollQrSession(session);
            const nextPollMs = r.status === "connecting" ? 700 : (r.status === "scanned" ? 800 : 2000);
            // 令牌在 pollQrSession 内只解析一次并落库；这里只“汇报”，而且不再删会话。
            if (r.status === "confirmed") {
              let folder = null;
              try { folder = await ensureAppFolder(); saveState({ folder }); } catch (e) { logger.warn?.(("[dsh-cloud-backup] ensureAppFolder failed: " + ((e && e.message) || e))); }
              return ok(res, { status: "connected", account: r.account, auth: authStatus(), folder, nextPollMs: 0, done: true });
            }
            if (r.status === "failed") {
              return ok(res, { status: "failed", reason: r.reason, diagPath: r.diagPath, bizExtRawPath: r.bizExtRawPath, nextPollMs: 0 });
            }
            ok(res, { status: r.status, raw: r.raw, attempt: r.attempt, diagPath: r.diagPath, nextPollMs });
          }),
        },
        {
          kind: "exact", path: BASE + "/auth/qr/page",
          handler: handler(async (req, res) => {
            const url = new URL(String(req.url || "/"), "http://localhost");
            const id = url.searchParams.get("session") || "";
            const session = sessions.get(id);
            const svg = session ? qrSvg(session.codeContent, { cellSize: 6, margin: 3, alt: "阿里云盘登录二维码" }) : "";
            const dataUrl = session ? "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64") : "";
            const html = qrPageHtml({
              sessionId: session ? id : "",
              qr: dataUrl,
              apiBase: BASE,
              expiresInSec: QR_TTL_SEC,
              oauthUrl: oauthAuthorizeUrl(CLIENT_ID, OAUTH_REDIRECT),
            });
            const buf = Buffer.from(html, "utf8");
            res.writeHead(200, {
              "content-type": "text/html; charset=utf-8",
              "content-length": buf.length,
              "cache-control": "no-store",
            });
            res.end(buf);
          }),
        },
        {
          kind: "exact", path: BASE + "/auth/oauth-url",
          handler: handler(async (req, res) => {
            const cfg = loadConfig();
            const start = oauthStart(req, cfg);
            if (!start.ok) return ok(res, { ok: true, needConfig: true, callbackUri: start.callbackUri, hint: start.hint, scope: ALIPAN_OAUTH.scope });
            ok(res, { ok: true, url: start.url, redirectUri: start.redirectUri, scope: ALIPAN_OAUTH.scope });
          }),
        },
        {
          kind: "exact", path: BASE + "/auth/oauth/start",
          handler: handler(async (req, res) => {
            const cfg = loadConfig();
            const start = oauthStart(req, cfg);
            if (!start.ok) return bad(res, 400, start.hint);
            ok(res, { ok: true, url: start.url, redirectUri: start.redirectUri, scope: ALIPAN_OAUTH.scope });
          }),
        },
        {
          kind: "exact", path: BASE + "/auth/oauth/callback",
          handler: handler(async (req, res) => {
            const url = new URL(String(req.url || "/"), "http://localhost");
            const code = url.searchParams.get("code") || "";
            const state = url.searchParams.get("state") || "";
            const err = url.searchParams.get("error") || "";
            const cfg = loadConfig();
            const cbUri = oauthCallbackUri(req, cfg);
            const escHtml = (v) => String(v === undefined || v === null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
            const page = (titleIn, bodyIn, tone) => {
              const title = escHtml(titleIn);
              const body = escHtml(bodyIn);
              const color = tone === "ok" ? "#0a7d32" : "#b42318";
              res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
              res.end("<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>" + title + "</title>" +
                "<style>body{font:14px/1.7 -apple-system,Segoe UI,Microsoft YaHei,sans-serif;background:#fff;color:#1b1c1e;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}" +
                ".c{max-width:520px;padding:28px 30px;border:1px solid #e6e7eb;border-radius:14px}.t{font-size:18px;font-weight:600;color:" + color + "}" +
                ".b{margin-top:10px;color:#3c4046;white-space:pre-wrap;word-break:break-word}.h{margin-top:14px;color:#6b6f76;font-size:12.5px}</style></head><body>" +
                "<div class=c><div class=t>" + title + "</div><div class=b>" + body + "</div><div class=h>本页由本机 DSH（云盘备份插件）提供，可以关闭。</div></div></body></html>");
            };
            if (err) return page("授权被拒绝", "阿里云盘返回：" + err + "\n可以关掉本页，回到 DSH 面板重试。", "err");
            if (!code) return page("缺少授权码", "回调地址里没有 code。请从「用开放平台 App 授权」重新发起一次。", "err");
            const st = oauthStates.get(state);
            if (!st) return page("授权会话已失效", "state 校验不通过（可能超过 10 分钟，或不是在同一个 DSH 实例里发起）。请重新发起授权。", "err");
            oauthStates.delete(state);
            try {
              const creds = await exchangeOpenPlatformCode({ code, clientId: cfg.oauthClientId, clientSecret: cfg.oauthClientSecret, redirectUri: st.redirectUri || cbUri });
              let folder = null;
              try { folder = await ensureAppFolder(); saveState({ folder }); } catch (e) {}
              saveState({ last_oauth: { at: new Date().toISOString(), ok: true, account: (creds && creds.nick_name) || null } });
              page("登录成功", "已自动完成授权" + (creds && creds.nick_name ? "：" + creds.nick_name : "") + (folder && (folder.name || folder) ? "\n云端目录：" + (folder.name || folder) : "") + "\nDSH 面板会立刻显示「已连接」。", "ok");
            } catch (e) {
              const msg = (e && e.message) || String(e);
              saveState({ last_oauth: { at: new Date().toISOString(), ok: false, error: msg } });
              page("授权失败", msg + "\n\n常见原因：App ID/Secret 不对；回调地址与开放平台后台登记的不一致；该 App 未开通对应 scope。", "err");
            }
          }),
        },
        {
          kind: "exact", path: BASE + "/auth/code",
          handler: handler(async (req, res) => {
            const body = await readJson(req);
            if (!body || !body.code) return bad(res, 400, "缺少 code（从浏览器地址栏 code= 后面那段复制出来）");
            const code = String(body.code).trim();
            if (!/^[A-Za-z0-9._~\-+=]{8,512}$/.test(code)) return bad(res, 400, "code 形态不合法");
            const creds = await exchangeCode(code);
            let folder = null;
            try { folder = await ensureAppFolder(); saveState({ folder }); } catch { /* 不影响授权结果 */ }
            logger.info?.("[dsh-cloud-backup] 授权码登录成功（user_id=" + (creds && creds.user_id) + "）");
            const auth = authStatus();
            ok(res, { account: auth.account || null, auth, folder });
          }),
        },
        {
          kind: "exact", path: BASE + "/auth/refresh",
          handler: handler(async (req, res) => {
            await refreshTokens();
            ok(res, { auth: authStatus() });
          }),
        },
        {
          // 免扫码捷径：读本机已登录的阿里云盘客户端登录态（只读本机文件，用户点一下才跑）
          kind: "exact", path: BASE + "/auth/import-local",
          handler: handler(async (req, res) => {
            const body = await readJson(req);
            if (body === undefined) return bad(res, 400, "请求体不是合法 JSON");
            const r = await adoptLocalClient({ logger, minMtimeMs: Number(body.since) > 0 ? Number(body.since) : 0 });
            if (!r.ok) return bad(res, 400, r.error || "未在本机找到可用的阿里云盘登录态", { found: r.found, tried: r.tried });
            let folder = null;
            try {
              folder = await ensureAppFolder();
              saveState({ folder, verified_at: new Date().toISOString() });
            } catch (e) { logger.warn?.("[dsh-cloud-backup] ensureAppFolder failed after import: " + ((e && e.message) || e)); }
            logger.info?.("[dsh-cloud-backup] imported local client session (tried " + r.tried + ")");
            ok(res, { imported: true, source: r.source, tried: r.tried, account: r.account, folder, auth: authStatus() });
          }),
        },

        {
          // 等待浏览器登录：只回答「有没有比 since 更新的登录态」，不换令牌、不发网络
          kind: "exact", path: BASE + "/auth/watch-local",
          handler: handler(async (req, res) => {
            const body = (await readJson(req)) || {};
            const since = Number(body.since) > 0 ? Number(body.since) : 0;
            const r = peekLoginState({ minMtimeMs: since });
            ok(res, { since, found: r.found, kind: r.kind, source: r.source, mtimeMs: r.mtimeMs, total: r.total });
          }),
        },
        {
          kind: "exact", path: BASE + "/auth/import-token",
          handler: handler(async (req, res) => {
            const body = await readJson(req);
            if (body === undefined) return bad(res, 400, "请求体不是合法 JSON");
            const rt = body && body.refreshToken;
            const r = await importRefreshToken(rt, { logger, clientId: String((body && body.clientId) || "") });
            if (!r.ok) return bad(res, 400, r.error || "导入失败", { tried: r.tried });
            let folder = null;
            try {
              folder = await ensureAppFolder();
              saveState({ folder, verified_at: new Date().toISOString() });
            } catch (e) { logger.warn?.("[dsh-cloud-backup] ensureAppFolder failed after token import: " + ((e && e.message) || e)); }
            logger.info?.("[dsh-cloud-backup] imported refresh_token from user input");
            ok(res, { imported: true, account: r.account, folder, auth: authStatus() });
          }),
        },
        {
          kind: "exact", path: BASE + "/auth/verify",
          handler: handler(async (req, res) => {
            const at = await userGet(await (await import("./auth/aliyun.js")).ensureAccessToken());
            const folder = await ensureAppFolder();
            saveState({ folder, verified_at: new Date().toISOString() });
            ok(res, { auth: authStatus(), folder, user: { user_id: at.user_id, name: at.name, nick_name: at.nick_name } });
          }),
        },
        {
          kind: "exact", path: BASE + "/auth/logout",
          handler: handler(async (req, res) => {
            const logoutBody = (await readJson(req)) || {};
            if (logoutBody.confirm !== true) return bad(res, 400, "退出登录需要确认（confirm: true）");
            dropManifestCache();      // 换了凭证/断开：旧清单不可信
            disconnect();
            sessions.clear();
            logger.info?.("[dsh-cloud-backup] disconnected");
            ok(res, { auth: authStatus() });
          }),
        },
        {
          kind: "exact", path: BASE + "/backup/status",
          handler: handler(async (req, res) => {
            const cfgOut = { ...loadConfig() };
            if (cfgOut.oauthClientSecret) { cfgOut.hasOauthSecret = true; cfgOut.oauthClientSecret = ""; }
            ok(res, { config: cfgOut, audit: safeAudit(), last: loadState().last_backup || null, lastRestore: loadState().last_restore || null });
          }),
        },
        {
          kind: "exact", path: BASE + "/backup/run",
          handler: handler(async (req, res) => {
            const body = (await readJson(req)) || {};
            const auth = authStatus();
            if (!auth.connected) return bad(res, 400, "未连接云盘，无法备份");
            if (body.confirm !== true) return bad(res, 400, "启动备份需要确认（confirm: true）");
            const uploader = body.upload === false ? null : createUploader({ logger });
            logger.info?.("[dsh-cloud-backup] manual backup start (upload=" + (!!uploader) + ")");
            const result = await runBackup({
              trigger: body.trigger || "manual",
              forceUpload: body.upload === true,
              uploader,
              logger: (m) => logger.info?.("[dsh-cloud-backup] " + m),
            });
            logger.info?.("[dsh-cloud-backup] manual backup done: " + JSON.stringify({ ok: result.ok, files: result.files, new: result.newBlobs, upload: result.upload && result.upload.ok }));
            // 上传成功才顺手清云端孤儿目录（只删没有 manifest 的空壳，有清单的一律不动）
            let orphans = null;
            if (uploader && result.upload && result.upload.ok) {
              try { orphans = await cleanupRemoteOrphans({ logger: (m) => logger.info?.("[dsh-cloud-backup] " + m) }); }
              catch (e) { logger.warn?.("[dsh-cloud-backup] orphan cleanup skipped: " + ((e && e.message) || e)); }
            }
            ok(res, { result, orphans, audit: safeAudit(), last: loadState().last_backup || null });
          }),
        },
        {
          kind: "exact", path: BASE + "/backup/config",
          handler: handler(async (req, res) => {
            const body = await readJson(req);
            if (!body) return bad(res, 400, "请求体不是合法 JSON");
            const next = saveConfig(body);
            ok(res, { config: next });
          }),
        },
        {
          kind: "exact", path: BASE + "/restore/snapshots",
          handler: handler(async (req, res) => {
            const url = new URL(req.url, "http://127.0.0.1");
            let remote = null;
            if (url.searchParams.get("remote") === "1") {
              // fresh=1：跳过云端清单缓存，切换视图/删除后立刻看到最新
              const fresh = url.searchParams.get("fresh") === "1";
              try { remote = await listRemoteSnapshots({ fresh }); } catch (e) { remote = { ok: false, error: String((e && e.message) || e), snapshots: [] }; }
            }
            ok(res, { local: listRestorable({}), remote, dshHome: process.env.DSH_HOME || "" });
          }),
        },
        {
          kind: "exact", path: BASE + "/plugins/prompt",
          handler: handler(async (req, res) => {
            const u = new URL(req.url || "", "http://x");
            const stamp = u.searchParams.get("stamp") || "";
            if (!stamp) return bad(res, 400, "缺少 stamp");
            if (badStamp(res, stamp)) return;
            let man = null;
            const local = snapshotTree({ stamp, depth: 1 });
            if (local && local.ok) man = { plugins: local.plugins || [] };
            else if (authStatus().connected) {
              const got = await getRemoteManifest(stamp);
              man = got && got.manifest ? got.manifest : null;
            }
            if (!man) return bad(res, 400, "拿不到该快照的清单（先同步或下载这份快照）");
            const plugins = (Array.isArray(man.plugins) ? man.plugins : []).map((p) => ({
              name: p.name, version: p.version, state: p.state, spec: p.spec || null,
              source_kind: p.source_kind || null, profiles: p.profiles || [], blob: p.blob || null,
            }));
            const raw = u.searchParams.get("profiles");
            const profiles = raw ? raw.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 10) : [];
            const text = buildRestorePrompt({
              stamp, plugins, profiles,
              fromProfile: (function () { const sd2 = storeDirHint(); const rt = (sd2 && stamp) ? readRuntimeOf(sd2, stamp) : null; return (rt && rt.profile) || null; })(),
              toProfile: currentHost().profile,
              tarballDir: localPluginsDir(process.env.DSH_HOME || ""),
              dshHome: process.env.DSH_HOME || "",
            });
            ok(res, { ok: true, stamp, count: plugins.length, plugins, text });
          }),
        },
        { kind: "exact", path: BASE + "/restore/tree",
          handler: handler(async (req, res) => {
            const u = new URL(req.url || "", "http://x");
            const depth = clampInt(u.searchParams.get("depth") || 1, 1, 1, 3);
            const stamp = u.searchParams.get("stamp") || "";
            if (!stamp) return bad(res, 400, "缺少 stamp");
            if (badStamp(res, stamp)) return;
            if (u.searchParams.get("remote") === "1") {
              // 只看目录树、不拉数据：manifest 从云端取，不在本地 store 留半份快照
              if (!authStatus().connected) return bad(res, 400, "未连接云盘");
              const { manifest, cached } = await getRemoteManifest(stamp);
              const t = treeFromManifest(manifest, depth);
              if (!t.ok) return bad(res, 502, t.error || "云端清单不可用");
              return ok(res, { ok: true, stamp: t.stamp || stamp, depth, remote: true, cached, top: t.top, plugins: t.plugins || [] });
            }
            const treeLocal = snapshotTree({ stamp, depth });
            if (treeLocal && treeLocal.ok === false) return bad(res, 404, treeLocal.error || "快照不存在");
            ok(res, treeLocal);
          }),
        },
        {
          // 恢复：只算不写的预览
          kind: "exact", path: BASE + "/restore/preview",
          handler: handler(async (req, res) => {
            const body = await readJson(req);
            if (!body || !body.stamp) return bad(res, 400, "缺少 stamp");
            if (badStamp(res, body.stamp)) return;
            const targetRoot = String(body.targetRoot || process.env.DSH_HOME || "");
            if (!targetRoot) return bad(res, 400, "缺少目标目录 targetRoot");
            const p = previewRestore({ stamp: body.stamp, targetRoot, overwrite: !!body.overwrite, flat: !!body.flat });
            ok(res, { preview: p, targetRoot });
          }),
        },
        {
          // 恢复：真正写盘。写 DSH_HOME 属于高危动作，必须带 confirm:true
          kind: "exact", path: BASE + "/restore/run",
          handler: handler(async (req, res) => {
            const body = await readJson(req);
            if (!body || !body.stamp) return bad(res, 400, "缺少 stamp");
            if (badStamp(res, body.stamp)) return;
            const targetRoot = String(body.targetRoot || process.env.DSH_HOME || "");
            if (!targetRoot) return bad(res, 400, "缺少目标目录 targetRoot");
            const dshHome = process.env.DSH_HOME || "";
            // 必须用 path.resolve 归一化后再比较：字符串去尾比较可被 "DSH_HOME\sessions\.." 绕过
            const hitsHome = !!dshHome && path.resolve(targetRoot) === path.resolve(dshHome);
            if (hitsHome && body.confirm !== true) {
              return bad(res, 400, "目标就是当前 DSH_HOME，会覆盖正在使用的会话与配置；请先备份并把 confirm 设为 true 再执行", { needsConfirm: true, targetRoot });
            }
            logger.warn?.("[dsh-cloud-backup] restore start -> " + targetRoot + " (overwrite=" + (!!body.overwrite) + ")");
            const rels = Array.isArray(body.rels) ? body.rels.map((x) => String(x)).filter(Boolean) : null;
            if (rels && (rels.length > 200 || rels.some((x) => x.length > 512))) return bad(res, 400, "rels 过多或过长（≤200 条、单条 ≤512 字符）");
            const wantPlugins = body.plugins === true;
            const allowScripts = body.allowScripts === true;
            const here = currentHost();
            const pluginProfiles = Array.isArray(body.pluginProfiles) && body.pluginProfiles.length
              ? body.pluginProfiles.map((x) => String(x)).filter(Boolean).slice(0, 10)
              : (here.profile ? [here.profile] : null);
            rsProgress = { active: true, stamp: body.stamp, done: 0, total: 0, cancelled: false, startedAt: Date.now() };
            const r = restoreSnapshot({
              stamp: body.stamp, targetRoot,
              overwrite: !!body.overwrite, flat: !!body.flat, rels,
              backupOverwritten: body.backupOverwritten !== false,
              logger: (m) => logger.info?.("[dsh-cloud-backup] " + m),
              onStep: (done, total) => { if (rsProgress) { rsProgress.done = done; rsProgress.total = total; } },
              shouldStop: () => !!(rsProgress && rsProgress.cancelled),
            });
            if (rsProgress) { rsProgress.active = false; rsProgress.cancelled = false; }
            logger.warn?.("[dsh-cloud-backup] restore done: " + JSON.stringify({ ok: r.ok, restored: r.restored, skipped: r.skipped,
              skippedSame: r.skippedSame, skippedDiff: r.skippedDiff, failed: r.failed.length, mergedWorkspace: r.mergedWorkspace ? { added: r.mergedWorkspace.added, kept: r.mergedWorkspace.kept, sessionsAdded: r.mergedWorkspace.sessionsAdded } : null }));
            if (r && r.ok === false && !r.restored && /快照不存在|清\s*单损坏/.test(String(r.error || ""))) return bad(res, 404, r.error);
            let pluginResult = null;
            let pluginScope = null;
            if (wantPlugins) {
              try {
                const man = readManifest(manifestPath(storeDir(), body.stamp));
                pluginResult = await installPluginPacks({
                  dshHome, storeDir: storeDir(), plugins: (man && man.plugins) || [],
                  profiles: pluginProfiles, allowScripts,
                  onLog: (ev) => logger.info?.("[dsh-cloud-backup] plugin " + JSON.stringify(ev)),
                });
                const scopeTarget = pluginProfiles || [];
                const scopeAll = [];
                ((man && man.plugins) || []).forEach((x) => { ((x && x.profiles) || []).forEach((y) => { if (scopeAll.indexOf(y) < 0) scopeAll.push(y); }); });
                pluginScope = { target: scopeTarget, others: scopeAll.filter((y) => scopeTarget.indexOf(y) < 0) };
                logInfo("plugin.install.summary", {
                  installed: pluginResult.installed.length, skipped: pluginResult.skipped.length,
                  failed: pluginResult.failed.length, allowScripts: allowScripts ? 1 : 0,
                });
              } catch (e) {
                pluginResult = { ok: false, error: String((e && e.message) || e), installed: [], skipped: [], failed: [] };
                logError("plugin.install.summary", { error: pluginResult.error });
              }
            }
            // 落盘一次结果：面板/页面刷新后仍能看到“上次还原”发生了什么
            try {
              const fail0 = (r.failed && r.failed[0]) || null;
              const sd = storeDirHint();
              const snapHost = (sd && body.stamp) ? readRuntimeOf(sd, body.stamp) : null;
              const hostInfo = { from: snapHost, to: here, mismatch: !sameHost(snapHost, here) };
              const lrEntry = {
                at: new Date().toISOString(), stamp: body.stamp || null, targetRoot, bootId: BOOT_ID,
                host: hostInfo,
                ok: r.ok !== false, restored: r.restored || 0, skipped: r.skipped || 0,
                skippedSame: r.skippedSame || 0, skippedDiff: r.skippedDiff || 0,
                skippedDiffSample: (r.skippedDiffSample || []).slice(0, 8),
                mergedWorkspace: r.mergedWorkspace || null,
                overwritten: r.overwritten || 0, failed: (r.failed || []).length,
                firstError: fail0 ? String(fail0.rel) + "：" + String(fail0.error) : null,
                plugins: pluginResult ? {
                  ok: pluginResult.ok !== false, error: pluginResult.error || null,
                  installed: (pluginResult.installed || []).map((x) => ({ name: x.name, profile: x.profile, via: x.via })),
                  skipped: (pluginResult.skipped || []).map((x) => ({ name: x.name, reason: x.reason || null })),
                  skippedScoped: (pluginResult.skipped || []).filter((x) => x && x.reason === "profile-not-in-scope").length,
                  skippedBlob: (pluginResult.skipped || []).filter((x) => x && /blob/i.test(String(x.reason || ""))).length,
                  failed: (pluginResult.failed || []).map((x) => ({ name: x.name, profile: x.profile, error: x.error || null, detail: x.detail || null })),
                  rollback: pluginResult.rollback || null, allowScripts, scope: pluginScope,
                } : null,
              };
              saveState({ last_restore: lrEntry });
              appendRestoreHistory(lrEntry);
            } catch (e) { logger.warn?.("[dsh-cloud-backup] save last_restore failed: " + ((e && e.message) || e)); }
            if (pluginResult) {
              const skipList = pluginResult.skipped || [];
              const skippedScoped = skipList.filter((x) => x && x.reason === "profile-not-in-scope").length;
              const skippedBlob = skipList.filter((x) => x && /blob/i.test(String(x.reason || ""))).length;
              r.pluginSummary = {
                installed: (pluginResult.installed || []).length,
                skipped: skipList.length,
                skippedScoped,
                skippedBlob,
                failed: (pluginResult.failed || []).length,
                target: (pluginScope && pluginScope.target) || [],
                others: (pluginScope && pluginScope.others) || [],
                error: pluginResult.error || null,
              };
            }
            ok(res, { result: r, plugins: pluginResult, pluginScope });
          }),
        },
        {
          kind: "exact", path: BASE + "/restore/cancel",
          handler: handler(async (req, res) => {
            await readJson(req).catch(() => null);
            if (!rsProgress || !rsProgress.active) return ok(res, { ok: true, cancelled: false, idle: true });
            rsProgress.cancelled = true;
            logger.warn?.("[dsh-cloud-backup] restore cancel requested: " + String(rsProgress.done || 0) + "/" + String(rsProgress.total || 0));
            return ok(res, { ok: true, cancelled: true, done: rsProgress.done || 0, total: rsProgress.total || 0 });
          }),
        },
        {
          kind: "exact", path: BASE + "/restore/pause",
          handler: handler(async (req, res) => {
            await readJson(req).catch(() => null);
            const did = pausePull();
            ok(res, { paused: did || isPullPaused(), pull: getPullProgress() });
          }),
        },
        {
          kind: "exact", path: BASE + "/restore/from-cloud",
          handler: handler(async (req, res) => {
            const body = await readJson(req);
            if (!body || !body.stamp) return bad(res, 400, "缺少 stamp");
            if (badStamp(res, body.stamp)) return;
            if (!authStatus().connected) return bad(res, 400, "未连接云盘");
            // 可选 rels：只下载这些路径（文件或目录前缀）用到的块，避免为几个文件拉整份快照
            const rels = Array.isArray(body.rels) ? body.rels.map((x) => String(x)).filter(Boolean) : null;
            if (rels && (rels.length > 200 || rels.some((r) => r.length > 512))) return bad(res, 400, "rels 过多或过长（≤200 条、单条 ≤512 字符）");
            // 进度与暂停状态是 provider 级单例：同一时刻只允许一个下载（同 stamp 重复点击也会互相污染字节计数）
            if (pullInFlight) return bad(res, 409, "已有下载在进行（" + pullInFlight + "），请等它结束或先暂停");
            // 先做参数校验（404/400 直接返回），校验通过才占锁——否则提前 return 会把锁永久留在外面
            let hashes = null;
            if (rels && rels.length) {
              const got = await getRemoteManifest(body.stamp);
              const man = got && got.manifest;
              if (!man || !Array.isArray(man.files)) return bad(res, 400, "云端清单不可用，无法按路径下载");
              const hit = man.files.filter((f) => rels.some((r) => f.rel === r || f.rel.indexOf(r.replace(/\/+$/, "") + "/") === 0));
              if (!hit.length) return bad(res, 404, "这些路径在快照里不存在");
              hashes = [...new Set(hit.map((f) => f.hash))];
            }
            // 占位与释放必须在同一 try/finally 内，任何异常都要把锁放掉
            pullInFlight = body.stamp;
            let r = null;
            try {
              r = await pullSnapshot({ stamp: body.stamp, hashes, logger: (m) => logger.info?.("[dsh-cloud-backup] " + m) });
            } finally { pullInFlight = null; }
            ok(res, { pull: r, scope: hashes ? { files: hashes.length, rels } : null });
          }),
        },
        {
          // 自重启：默认只回报计划（入口找不找得到、会不会走 shell），confirm:true 才真的替换进程。
          // 计划要先落盘再动手，这样即使新宿主没起来，日志里也能看出它当时打算怎么拉起来。
          kind: "exact", path: BASE + "/restart",
          handler: handler(async (req, res) => {
            const body = (await readJson(req)) || {};
            const spec = launchSpec();
            const plan = describeLaunch(spec);
            const refusal = restartRefusal();
            const port = servingPort(req);
            const base = { plan, port, refusal, host: currentHost() };
            if (body.confirm !== true) return ok(res, Object.assign({ dryRun: true }, base));
            if (refusal) return bad(res, 400, refusal);
            if (!plan || !plan.resolvable) return bad(res, 400, "找不到宿主启动入口，无法自重启（可手动重启 DSH）");
            if (pullInFlight) return bad(res, 409, "下载/还原正在进行（" + pullInFlight + "），等它结束再重启");
            const r = scheduleRestart({ spec, port, logDir: logDir() });
            if (!r.ok) return bad(res, 500, r.error || "自重启失败");
            logInfo("restart.scheduled", { port, file: r.spawn && r.spawn.file, helperPid: r.helperPid, logFile: r.logFile });
            ok(res, Object.assign({ dryRun: false, launch: r }, base));
          }),
        },
        {
          // 恢复：还原后逐文件校验（stamp 走白名单校验）
          kind: "exact", path: BASE + "/restore/verify",
          handler: handler(async (req, res) => {
            const body = await readJson(req);
            if (!body || !body.stamp) return bad(res, 400, "缺少 stamp");
            if (badStamp(res, body.stamp)) return;
            const targetRoot = String(body.targetRoot || process.env.DSH_HOME || "");
            if (!targetRoot) return bad(res, 400, "缺少目标目录 targetRoot");
            ok(res, { verify: verifyRestore({ stamp: body.stamp, targetRoot, flat: !!body.flat }) });
          }),
        },
        {
          // 「备份 = 云端，本地只是缓存」的两个入口
          kind: "exact", path: BASE + "/backups",
          handler: handler(async (req, res) => {
            const url = new URL(String(req.url || "/"), "http://localhost");
            const fresh = url.searchParams.get("fresh") === "1";
            ok(res, await listBackups({ fresh }));
          }),
        },
        {
          kind: "exact", path: BASE + "/backups/delete",
          handler: handler(async (req, res) => {
            const body = (await readJson(req)) || {};
            if (badStamp(res, body.stamp)) return;
            const r = await deleteBackup({
              stamp: body.stamp,
              dryRun: body.dryRun !== false,
              allowLast: body.allowLast === true,
              logger: (m) => logger.info?.("[dsh-cloud-backup] " + m),
            });
            if (!r.ok && r.code === "lastCloudCopy") return bad(res, 409, r.error);
            if (!r.ok && r.code === "notFound") return bad(res, 404, r.error);
            if (!r.ok) return bad(res, 400, r.error || "删除失败");
            if ((r.plan || {}).lastCloudCopy && body.allowLast !== true) {
              return bad(res, 409, "这是云端最后一份备份；确认要删请带 allowLast:true（会清空云端备份）");
            }
            if (!r.dryRun) saveState(Object.assign(loadState() || {}, { last_delete: { at: new Date().toISOString(), stamp: body.stamp } }));
            ok(res, r);
          }),
        },
        {
          kind: "exact", path: BASE + "/backups/upload",
          handler: handler(async (req, res) => {
            const body = (await readJson(req)) || {};
            if (badStamp(res, body.stamp)) return;
            if (!authStatus().connected) return bad(res, 400, "未连接云盘");
            const r = await uploadBackup({ stamp: body.stamp, logger: (m) => logger.info?.("[dsh-cloud-backup] " + m) });
            if (!r.ok) return bad(res, 400, r.error || "上传失败");
            invalidateRemoteSnapshotCache();
            try {
              const st0 = loadState();
              const lb = st0 && st0.last_backup;
              if (lb && lb.snapshot === body.stamp) {
                lb.upload = { ok: true, via: "manual", at: new Date().toISOString() };
                saveState({ last_backup: lb });
              }
            } catch (e) { logger.warn?.("[dsh-cloud-backup] last_backup sync skipped: " + ((e && e.message) || e)); }
            ok(res, r);
          }),
        },
        {
          kind: "exact", path: BASE + "/maintenance/cache",
          handler: handler(async (req, res) => {
            const body = (await readJson(req)) || {};
            if (body.dryRun !== false) return ok(res, { dryRun: true, stats: cacheStats() });
            if (!authStatus().connected) return bad(res, 400, "未连接云盘：无法确认哪些缓存已上传，拒绝清理（避免删掉唯一副本）");
            const cloud = await listRemoteSnapshots({ fresh: true });
            if (!cloud.ok) return bad(res, 400, cloud.error || "读云端快照列表失败");
            const set = new Set((cloud.snapshots || []).filter((x) => x.hasManifest).map((x) => x.stamp));
            if (body.keep !== undefined && body.keep !== null && !Number.isFinite(Number(body.keep))) {
              return bad(res, 400, "keep 必须是数字（收到：" + JSON.stringify(body.keep) + "）");
            }
            const keep = Number.isFinite(Number(body.keep)) ? Math.max(0, Math.floor(Number(body.keep))) : 3;
            ok(res, pruneCache({ keep, cloudStamps: set }));
          }),
        },
        {
          kind: "exact", path: BASE + "/maintenance/cleanup",
          handler: handler(async (req, res) => {
            const body = (await readJson(req)) || {};
            if (!authStatus().connected) return bad(res, 400, "未连接云盘");
            const dryRun = body.dryRun !== false;   // 默认只演练，必须显式 dryRun:false 才真删
            const lg = (m) => logger.info?.("[dsh-cloud-backup] " + m);
            const orphans = await cleanupRemoteOrphans({ dryRun, logger: lg });
            let gc = null;
            if (body.gc === true) {
              gc = await gcRemoteSnapshots({ keepRecent: clampInt(body.keepRecent, 8, 1, 999), dryRun, logger: lg });
            }
            ok(res, { dryRun, orphans, gc });
          }),
        },
        {
          // 维护：清理本地旧快照（删前查云端 hasManifest；默认 dryRun 只返回计划）
          kind: "exact", path: BASE + "/maintenance/prune-local",
          handler: handler(async (req, res) => {
            const body = (await readJson(req)) || {};
            // keepRecent 必须是 ≥0 的整数：非数字会让保留份数变 NaN → 清空本地快照（已复现），这里直接拒
            let keepRecent = 5;
            if (body.keepRecent !== undefined) {
              const n = Number(body.keepRecent);
              if (!Number.isFinite(n) || n < 0) return bad(res, 400, "keepRecent 必须是 ≥0 的数字（收到：" + JSON.stringify(body.keepRecent) + "）");
              keepRecent = Math.floor(n);
            }
            // stamps 会直接拼进路径，必须逐个过白名单
            let stamps = null;
            if (Array.isArray(body.stamps)) {
              if (body.stamps.length > 200) return bad(res, 400, "stamps 一次最多 200 条");
              const badOne = body.stamps.filter((s) => !isStamp(s));
              if (badOne.length) return bad(res, 400, "非法 stamp：" + JSON.stringify(badOne.slice(0, 3)));
              stamps = body.stamps.slice();
            }
            const r = await pruneLocalSnapshots({
              keepRecent: keepRecent,
              stamps: stamps,
              dryRun: body.dryRun !== false,
              requireCloud: body.requireCloud !== false,
              reclaim: body.reclaim !== false,
              logger: (m) => logger.info?.("[dsh-cloud-backup] " + m),
            });
            _audit = { at: 0, value: null };     // 快照数变了，体检缓存作废
            ok(res, r);
          }),
        },
        {
          // 维护：删云端旧快照（进阿里云盘回收站，30 天可在云盘 UI 找回）。
          // 默认 dryRun；默认拒删「本地仍有副本」与「云端最后一份」，必须显式放行。
          kind: "exact", path: BASE + "/maintenance/prune-remote",
          handler: handler(async (req, res) => {
            const body = (await readJson(req)) || {};
            if (!authStatus().connected) return bad(res, 400, "未连接云盘");
            let stamps = null;
            if (Array.isArray(body.stamps)) {
              if (body.stamps.length > 200) return bad(res, 400, "stamps 一次最多 200 条");
              const badOne = body.stamps.filter((s) => !isStamp(s));
              if (badOne.length) return bad(res, 400, "非法 stamp：" + JSON.stringify(badOne.slice(0, 3)));
              stamps = body.stamps.slice();
            }
            let keepRecent = null;
            if (body.keepRecent !== undefined) {
              const n = Number(body.keepRecent);
              if (!Number.isFinite(n) || n < 1) return bad(res, 400, "keepRecent 必须是 ≥1 的数字（收到：" + JSON.stringify(body.keepRecent) + "）");
              keepRecent = Math.floor(n);
            }
            if (!stamps && keepRecent === null) return bad(res, 400, "需要 stamps（按份删）或 keepRecent（按保留份数）");
            const r = await pruneRemoteSnapshots({
              stamps: stamps,
              keepRecent: keepRecent,
              dryRun: body.dryRun !== false,
              allowLocalCopy: body.allowLocalCopy === true,
              allowLastCopy: body.allowLastCopy === true,
              logger: (m) => logger.info?.("[dsh-cloud-backup] " + m),
            });
            if (!r.ok) return bad(res, 400, r.error || "云端删除失败");
            ok(res, r);
          }),
        },
        {
          kind: "exact", path: LEGACY_BASE + "/status",
          handler: handler(async (req, res) => { sweep(); ok(res, statusPayload()); }),
        },
      ];

      const disposers = [];
      for (const route of routes) {
        try {
          const method = GET_PATHS.has(routeTail(route.path)) ? "GET" : "POST";
          const dispose = sctx.webServer.register({ ...route, handler: guard(method, route.handler) });
          disposers.push(typeof dispose === "function" ? dispose : () => {});
        } catch (error) {
          logger.warn?.(`[dsh-cloud-backup] route ${route.path} 注册失败: ${(error && error.message) || error}`);
        }
      }
      logger.info?.(`[dsh-cloud-backup] 已挂载 ${disposers.length}/${routes.length} 条路由，前缀 ${BASE}，状态目录 ${dataDir()}`);

      // 定时备份：进程内定时器（宿主重启即重建）。每分钟检查一次，到点且满足条件才跑。
      const tick = () => {
        try {
          const cfg = loadConfig();
          const every = Math.max(1, Number(cfg.intervalMinutes) || 60) * 60 * 1000;
          const mins = Math.round(every / 60000);
          // 间隔被改过 → 从现在起重新计时（否则要等上一次调度走完才生效）
          if (sched.intervalMin !== mins) {
            if (sched.intervalMin) logger.info?.("[dsh-cloud-backup] schedule interval -> " + mins + " min");
            sched.intervalMin = mins;
            sched.nextAt = Date.now() + every;
          }
          if (!cfg.enabled) return;
          if (!sched.nextAt) sched.nextAt = Date.now() + every;
          if (Date.now() < sched.nextAt) return;
          sched.nextAt = Date.now() + every;
          if (!authStatus().connected) return;
          if (sched.running) return;
          sched.running = true;
          logger.info?.("[dsh-cloud-backup] scheduled backup start");
          runBackup({ trigger: "schedule", uploader: createUploader({ logger }), logger: (m) => logger.info?.("[dsh-cloud-backup] " + m) })
            .then((r) => logger.info?.("[dsh-cloud-backup] scheduled backup done " + JSON.stringify({ ok: r.ok, files: r.files, new: r.newBlobs })))
            .catch((e) => logger.warn?.("[dsh-cloud-backup] scheduled backup failed: " + ((e && e.message) || e)))
            .finally(() => { sched.running = false; _audit = { at: 0, value: null }; });
        } catch (e) { logger.warn?.("[dsh-cloud-backup] scheduler tick failed: " + ((e && e.message) || e)); }
      };
      const timer = setInterval(tick, 60 * 1000);
      try { tick(); } catch {}          // 立刻排一次，界面才能显示「下次自动备份」时间
      // 预热：把 DPAPI 解密（单次约 3 秒）挪到后台，用户点开卡片时命中缓存
      const warm = setTimeout(() => { try { loadCredentials(); safeAudit(); } catch {} }, 1500);
      if (warm.unref) warm.unref();
      if (typeof timer.unref === "function") timer.unref();

      return () => { clearInterval(timer); for (const d of disposers) { try { d(); } catch {} } sessions.clear(); };
    }, "dsh-cloud-backup: http routes");
  });
}
