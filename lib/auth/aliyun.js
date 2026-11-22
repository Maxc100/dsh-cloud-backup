// lib/auth/aliyun.js —— 阿里云盘授权与最小文件操作

import { loadCredentials, saveCredentials, clearCredentials, needsRefresh } from "../store/credentials.js";
import { AUTH_BASE, ADOPT_CLIENT_ID } from "./adrive-local.js";
import { dataDir, writeFileAtomic } from "../store/paths.js";
import { logWarn } from "../util/log.js";
import zlib from "node:zlib";

export const PROVIDER = "aliyun";
export const CLIENT_ID = "25dzX3vbYqktVxyX";           // 网页端 client_id（可用 DSH_CLOUD_BACKUP_CLIENT_ID 覆盖）
export const PASSPORT = "https://passport.aliyundrive.com";
export const API = "https://api.aliyundrive.com";
export { AUTH_BASE };                                    // 客户端令牌的续期端点（auth.aliyundrive.com，不校验 client_id）
export const APP_FOLDER = "dsh-cloud-backup";           // 云端根目录下的应用目录
// 隔离实例（独立 DSH_HOME 的测试环境）用独立云端目录，避免与真实实例的快照互相可见
export const appFolderName = () => String(process.env.DSH_CLOUD_BACKUP_APP_FOLDER || "").trim() || APP_FOLDER;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const clientId = () => process.env.DSH_CLOUD_BACKUP_CLIENT_ID || CLIENT_ID;

export class AuthError extends Error {
  constructor(message, extra = {}) { super(message); this.name = "AuthError"; Object.assign(this, extra); }
}

async function http(url, { method = "GET", headers = {}, body, timeoutMs = 15000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("timeout " + timeoutMs + "ms")), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body, signal: ac.signal, redirect: "follow" });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: res.status, text, json };
  } finally { clearTimeout(timer); }
}

function form(headers = {}) {
  return { "user-agent": UA, referer: PASSPORT + "/mini_login.htm", origin: PASSPORT, "content-type": "application/x-www-form-urlencoded", ...headers };
}

function apiHeaders(accessToken, { json = true } = {}) {
  return {
    "user-agent": UA, referer: "https://www.aliyundrive.com/", origin: "https://www.aliyundrive.com",
    ...(json ? { "content-type": "application/json" } : {}),
    ...(accessToken ? { authorization: "Bearer " + accessToken } : {}),
  };
}

export async function startQrSession() {
  const html = await http(`${PASSPORT}/mini_login.htm?lang=zh_cn&appName=aliyun_drive&appEntrance=web_default&styleType=auto&bizParams=&notLoadSsoView=false&notKeepLogin=false&isMobile=false`, { headers: form() });
  if (html.status !== 200) throw new AuthError("登录页获取失败 HTTP " + html.status);
  const m = html.text.match(/window\.viewData\s*=\s*(\{[\s\S]*?\});/);
  if (!m) throw new AuthError("登录页结构变化：未找到 window.viewData");
  let viewData;
  try { viewData = JSON.parse(m[1]); } catch (e) { throw new AuthError("viewData 解析失败: " + e.message); }
  const lf = viewData.loginFormData || {};
  if (!lf._csrf_token) throw new AuthError("登录页缺少 _csrf_token");

  const qs = new URLSearchParams({
    appName: lf.appName, appEntrance: lf.appEntrance, fromSite: String(lf.fromSite ?? ""),
    _csrf_token: lf._csrf_token, umidToken: lf.umidToken, hsiz: lf.hsiz, bizParams: lf.bizParams ?? "",
  });
  const gen = await http(`${PASSPORT}/newlogin/qrcode/generate.do?${qs}`, { headers: form() });
  const data = gen.json && gen.json.content && gen.json.content.data;
  if (!data || !data.codeContent) throw new AuthError("二维码生成失败: " + gen.text.slice(0, 200));

  return {
    id: "qr-" + Date.now().toString(36) + "-" + Math.random().toString(16).slice(2, 8),
    codeContent: data.codeContent, t: data.t, ck: data.ck, lf,
    createdAt: Date.now(), expireMs: 3 * 60 * 1000,
  };
}

// 授权结果解析：bizExt 形态多变，逐层兜底

const SECRET_KEY_RE = /(token|secret|password|passwd|signature|credential|umid|code|^ck$|^t$)/i;
const TOKEN_ALIASES = {
  accesstoken: "access_token", access_token: "access_token",
  refreshtoken: "refresh_token", refresh_token: "refresh_token",
  tokentype: "token_type", token_type: "token_type",
  expiresin: "expires_in", expires_in: "expires_in",
  defaultdriveid: "default_drive_id", default_drive_id: "default_drive_id",
  defaultsboxdriveid: "default_sbox_drive_id", default_sbox_drive_id: "default_sbox_drive_id",
  domainid: "domain_id", domain_id: "domain_id",
  userid: "user_id", user_id: "user_id",
  username: "user_name", user_name: "user_name",
  nickname: "nick_name", nick_name: "nick_name",
  avatar: "avatar", deviceid: "device_id", device_id: "device_id", role: "role",
};
const CODE_KEY_RE = /^(code|auth_?code|login_?code|oauth_?code)$/i;

export function tryJson(text) { try { return JSON.parse(text); } catch { return undefined; } }

/** base64（含 base64url、含 data: 前缀）→ UTF-8 文本；不像 base64 或解出乱码则 undefined */
export function b64ToString(s) {
  const t = String(s).trim().replace(/^data:[^,]*,/, "").replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  if (t.length < 8 || !/^[A-Za-z0-9+/=]+$/.test(t)) return undefined;
  try {
    const out = Buffer.from(t + "=".repeat((4 - (t.length % 4)) % 4), "base64").toString("utf8");
    if (!out || out.includes("\uFFFD")) return undefined;
    return out;
  } catch { return undefined; }
}

/**
 */
export function decodeCandidates(raw) {
  const list = [];
  const seen = new Set();
  const logEntries = [];
  const put = (tag, text) => {
    if (typeof text !== "string" || !text) return;
    const key = text.slice(0, 64) + ":" + text.length;
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ tag: tag, text: text, replacement: (text.match(/\uFFFD/g) || []).length });
  };
  // passport 的 bizExt = base64(1887B)，UTF-8 解出约 52 个坏字节（尾部含二进制/加密段）；
  // 但前半段仍是可读 JSON，整体解码会因替换字符失败，需要逐段解码；
  const b64Loose = (str, tag) => {
    const t = String(str).replace(/^data:[^,]*,/, "").replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    const kept = t.replace(/[^A-Za-z0-9+/=]/g, "");
    if (kept.length < 8) { logEntries.push({ tag: tag, ok: false, why: "too-short" }); return null; }
    try {
      const buf = Buffer.from(kept + "=".repeat((4 - (kept.length % 4)) % 4), "base64");
      const text = buf.toString("utf8");
      const repl = (text.match(/\uFFFD/g) || []).length;
      logEntries.push({ tag: tag, ok: true, len: text.length, bytes: buf.length, dropped: t.length - kept.length, replacement: repl });
      if (repl === 0) put(tag, text);
      else {
        // 有替换字符：JSON 解析不可信，但令牌键名多半仍是 ASCII —— 留一份 lossy 文本只给正则兜底用
        const key = "lossy:" + tag;
        const hasTokenKey = /(access_token|refresh_token|pds_login_result|accessToken|refreshToken)/i.test(text);
        if (hasTokenKey && !seen.has(key)) {
          seen.add(key);
          list.push({ tag: key, text: text, replacement: repl, lossy: true });
          logEntries.push({ tag: tag + ":lossy", ok: true, len: text.length, replacement: repl, tokenKey: true });
        } else if (repl) {
          logEntries.push({ tag: tag + ":lossy", ok: false, why: "no-token-key", replacement: repl });
        }
      }
      try {
        const u16 = buf.toString("utf16le");
        if (u16 && u16.indexOf("\u0000") < 0 && /[{]/.test(u16)) {
          logEntries.push({ tag: tag + ":utf16le", ok: true, len: u16.length });
          put(tag + ":utf16le", u16);
        }
      } catch (e) {}
      // mojibake：payload 被多编码一层（latin1 → utf8）
      try {
        const re = Buffer.from(text, "latin1").toString("utf8");
        if (re && re !== text && /[{]/.test(re) && (re.match(/\uFFFD/g) || []).length === 0) {
          logEntries.push({ tag: tag + ":latin1-utf8", ok: true, len: re.length });
          put(tag + ":latin1-utf8", re);
        }
      } catch (e) {}
      for (const how of ["inflateSync", "gunzipSync", "inflateRawSync"]) {
        try {
          const out = zlib[how](buf).toString("utf8");
          if (out && /[{(\[]/.test(out)) {
            logEntries.push({ tag: tag + ":" + how, ok: true, len: out.length });
            put(tag + ":" + how, out);
          }
        } catch (e) { /* 不是压缩流，正常 */ }
      }
      return text;
    } catch (e) { logEntries.push({ tag: tag, ok: false, why: "decode-throw" }); return null; }
  };
  const s0 = String(raw == null ? "" : raw).trim();
  logEntries.push({ tag: "shape", len: s0.length, base64ish: /^[A-Za-z0-9+/=_-]{16,}$/.test(s0), hasPercent: s0.indexOf("%") >= 0 });
  if (!s0) return { candidates: list, log: logEntries };

  put("raw", s0);
  try { const u = decodeURIComponent(s0); if (u !== s0) put("url", u); } catch (e) { logEntries.push({ tag: "url", ok: false }); }
  const mPrefix = /^(?:bizext|data|result|payload)\s*=\s*([\s\S]+)$/i.exec(s0);
  if (mPrefix) { logEntries.push({ tag: "prefix", ok: true }); put("prefix-body", mPrefix[1].trim()); }
  const mJsonWrap = /^\{\s*"?(?:bizExt|data|content|result)"?\s*:\s*"([^"]{16,})"/i.exec(s0);
  if (mJsonWrap) { logEntries.push({ tag: "json-wrap", ok: true }); put("json-wrap-body", mJsonWrap[1]); }

  const lb = s0.indexOf("{"), rb = s0.lastIndexOf("}");
  if (lb >= 0 && rb > lb + 20) { logEntries.push({ tag: "json-slice", ok: true }); put("json-slice", s0.slice(lb, rb + 1)); }

  const d1 = b64Loose(s0, "b64");
  if (d1) {
    try { const u1 = decodeURIComponent(d1); if (u1 !== d1) put("b64+url", u1); } catch (e) {}
    const d2 = b64Loose(d1, "b64x2");
    if (d2) { try { const u2 = decodeURIComponent(d2); if (u2 !== d2) put("b64x2+url", u2); } catch (e) {} }
  }
  return { candidates: list, log: logEntries };
}

/**
 */
export function authFromText(text) {
  if (typeof text !== "string" || !text) return null;
  const grab = (key, minLen) => {
    const re = new RegExp('"?' + key + '"?\\s*[:=]\\s*"?([^",}\\s]{' + (minLen || 8) + ',})"?', "i");
    const m = re.exec(text);
    return m && !/\uFFFD/.test(m[1]) ? m[1] : null;
  };
  const access = grab("access_token");
  const refresh = grab("refresh_token");
  if (!access || !refresh) return null;
  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
  return { kind: "tokens", tokens: {
    access_token: access,
    refresh_token: refresh,
    expires_in: num(grab("expires_in", 1)),
    token_type: grab("token_type") || "Bearer",
    user_id: grab("user_id"),
    user_name: grab("user_name"),
    nick_name: grab("nick_name"),
    avatar: grab("avatar"),
    default_drive_id: grab("default_drive_id"),
    default_sbox_drive_id: grab("default_sbox_drive_id"),
    domain_id: grab("domain_id"),
    device_id: grab("device_id"),
  } };
}

/** JSON 文本 / base64(JSON) / URL 编码 JSON / 双重编码字符串 一律解析成对象 */
export function parseMaybeJson(text, depth = 0) {
  if (typeof text !== "string" || depth > 6) return undefined;
  const t = text.trim();
  if (!t) return undefined;
  const direct = tryJson(t);
  if (direct !== undefined) {
    if (typeof direct === "string") return parseMaybeJson(direct, depth + 1) ?? direct;
    return direct;
  }
  const dec = b64ToString(t);
  if (dec !== undefined) { const v = parseMaybeJson(dec, depth + 1); if (v !== undefined) return v; }
  for (const c of decodeCandidates(t).candidates) {
    if (c.text === t) continue;
    const v = parseMaybeJson(c.text, depth + 1);
    if (v !== undefined) return v;
  }
  try { const u = decodeURIComponent(t); if (u !== t) { const v = parseMaybeJson(u, depth + 1); if (v !== undefined) return v; } } catch {}
  return undefined;
}

/** 深度搜索：字符串里若还包着 JSON/base64 会继续下钻（passport 偶发把结果塞成字符串字段） */
function searchAuth(node, depth = 0) {
  if (depth > 8) return null;
  if (typeof node === "string") {
    const v = node.trim();
    if (v.length >= 8 && (v.startsWith("{") || v.startsWith("[") || /^[A-Za-z0-9+/=_-]{16,}$/.test(v))) {
      const p = parseMaybeJson(v);
      if (p !== undefined && typeof p !== "string") return searchAuth(p, depth + 1);
    }
    return null;
  }
  if (node === null || typeof node !== "object") return null;
  if (!Array.isArray(node)) {
    const toks = normalizeTokens(node);
    if (toks) return { kind: "tokens", tokens: toks };
  }
  const items = Array.isArray(node) ? node : Object.values(node);
  for (const v of items) { const r = searchAuth(v, depth + 1); if (r) return r; }
  if (!Array.isArray(node)) {
    for (const [k, v] of Object.entries(node)) {
      if (CODE_KEY_RE.test(k) && typeof v === "string") {
        const val = v.trim();
        if (val.length >= 8 && val.length <= 512 && !/\s/.test(val)) return { kind: "code", code: val };
      }
    }
  }
  return null;
}

/** 任意对象 → 规范化令牌对象（camelCase 与 snake_case 都认）；无 access_token 则 null */
function normalizeTokens(node) {
  const out = {};
  for (const [k, v] of Object.entries(node || {})) {
    const canon = TOKEN_ALIASES[String(k).toLowerCase()];
    if (canon && (typeof v === "string" || typeof v === "number")) out[canon] = typeof v === "string" ? v.trim() : v;
  }
  return out.access_token ? out : null;
}

/** 从任意解析结果（对象或字符串）里找出「令牌」或「授权码」；找不到返回 null */
export function findAuth(node) {
  if (node === null || node === undefined) return null;
  return searchAuth(node);
}

/** 形状描述：键名 + 类型/长度；敏感键（token/code/ck/t…）只留长度不留值 */
export function describeShape(value, depth = 0, key = "") {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") {
    const masked = SECRET_KEY_RE.test(key) || value.length > 60;
    return { type: "string", len: value.length, ...(masked ? {} : { value }) };
  }
  if (t !== "object") return { type: t, ...(t === "number" || t === "boolean" ? { value } : {}) };
  if (depth >= 4) return { type: Array.isArray(value) ? "array" : "object", truncated: true };
  if (Array.isArray(value)) return { type: "array", len: value.length, items: value.slice(0, 5).map((v) => describeShape(v, depth + 1, key)) };
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = describeShape(v, depth + 1, k);
  return out;
}

function writeQrDiag(tag, payload) {
  try { writeFileAtomic(dataDir() + "\\last-qr-" + tag + ".json", JSON.stringify(payload, null, 2) + "\n"); } catch {}
}

function accountOf(creds) {
  return { user_name: creds.user_name, nick_name: creds.nick_name, user_id: creds.user_id, drive_id: creds.drive_id };
}

export async function pollQrSession(s) {
  if (!s || !s.t || !s.ck) throw new AuthError("无效的扫码会话");
  // 一次性交付：确认后只解一次令牌，面板与浏览器登录页共享同一个结果；
  if (s.done) return { status: "confirmed", raw: "CONFIRMED", account: s.account || null, done: true };
  if (s.finishing) return s.finishing;
  if (Date.now() - s.createdAt > s.expireMs + 30_000) return { status: "expired" };
  const qs = new URLSearchParams({
    t: String(s.t), ck: s.ck, ua: "", appName: s.lf.appName, appEntrance: s.lf.appEntrance, fromSite: String(s.lf.fromSite ?? ""),
    _csrf_token: s.lf._csrf_token, umidToken: s.lf.umidToken, hsiz: s.lf.hsiz,
    navlanguage: "zh-CN", navUserAgent: UA, navPlatform: "Win32",
  });
  const r = await http(`${PASSPORT}/newlogin/qrcode/query.do?${qs}`, { method: "POST", headers: form(), body: "" });
  const d = r.json && r.json.content && r.json.content.data;
  if (!d) throw new AuthError("查询失败: " + r.text.slice(0, 200));
  const raw = String(d.qrCodeStatus || "").toUpperCase();
  const status = raw === "NEW" ? "new" : raw === "SCANED" || raw === "SCANNED" ? "scanned" : raw === "CONFIRMED" ? "confirmed" : raw === "EXPIRED" ? "expired" : "unknown";

  if (status !== "confirmed") return { status, raw };

  // 确认后取授权结果：SingleFlight —— 并发观察者共享同一次解析
  const run = (async () => {
    let diagVia = null;
    const cand = decodeCandidates(d.bizExt);
    const candidateShapes = cand.candidates.slice(0, 6).map((c) => {
      let shape = null;
      try { const v = tryJson(c.text); if (v !== undefined) shape = describeShape(v); } catch (e) {}
      return { tag: c.tag, lossy: !!c.lossy, len: c.text.length, json: shape };
    });
    const parsed = parseMaybeJson(d.bizExt);
    let found = findAuth(parsed);
    if (!found) found = findAuth(d);
    if (!found) {
      for (const c of cand.candidates) {
        const byRe = authFromText(c.text);
        if (byRe) { found = byRe; diagVia = "regex:" + c.tag; break; }
        if (c.lossy) continue;
        const byJson = findAuth(parseMaybeJson(c.text));
        if (byJson) { found = byJson; diagVia = "candidate:" + c.tag; break; }
      }
    }
    const shapeOf = () => ({
      at: new Date().toISOString(),
      qrCodeStatus: raw,
      bizExtType: d.bizExt === undefined ? "absent" : typeof d.bizExt,
      bizExtLen: typeof d.bizExt === "string" ? d.bizExt.length : null,
      bizExtBase64ish: typeof d.bizExt === "string" ? /^[A-Za-z0-9+/=_-]{16,}$/.test(d.bizExt.trim()) : null,
      bizExtParsed: describeShape(parsed === undefined ? null : parsed),
      bizExtRawPath: dataDir() + "\\last-qr-bizext.txt",
      decodeLog: cand.log,
      candidateShapes: candidateShapes,
      decodeVia: diagVia,
      dataShape: describeShape(d),
    });
    const settle = (creds) => {
      s.done = true;
      s.account = creds ? accountOf(creds) : null;
      return { status: "confirmed", raw, account: s.account, done: true };
    };

    if (found && found.kind === "tokens") {
      const creds = persistTokens(found.tokens, { via: "qr" });
      writeQrDiag("ok", { via: "tokens(direct)", ...shapeOf() });
      return settle(creds);
    }
    if (found && found.kind === "code") {
      const creds = await exchangeCode(found.code);
      writeQrDiag("ok", { via: "code", ...shapeOf() });
      return settle(creds);
    }

    s.confirmTries = (s.confirmTries || 0) + 1;
    try { writeFileAtomic(dataDir() + "\\last-qr-bizext.txt", String(d.bizExt == null ? "" : d.bizExt)); } catch (e) {}
    writeQrDiag("diag", { tries: s.confirmTries, ...shapeOf() });
    const diagPath = dataDir() + "\\last-qr-diag.json";
    if (s.confirmTries <= 40) return { status: "connecting", attempt: s.confirmTries, raw, diagPath };
    return { status: "failed", raw, diagPath, reason: "已确认但取不到授权结果（bizExt 形态未识别），已写诊断 " + diagPath };
  })();
  s.finishing = run;
  try { return await run; } finally { s.finishing = null; }
}

export async function exchangeCode(code) {
  const r = await http(`${API}/token/get`, { method: "POST", headers: apiHeaders(null), body: JSON.stringify({ client_id: clientId(), code }) });
  if (r.status !== 200 || !r.json || !r.json.access_token) {
    throw new AuthError("换取令牌失败 HTTP " + r.status + ": " + r.text.slice(0, 200));
  }
  return persistTokens(r.json, { via: "qr" });
}

export async function refreshTokens() {
  const cur = loadCredentials();
  if (!cur || !cur.refresh_token) throw new AuthError("未连接阿里云盘（无 refresh_token）");
  const cid = cur.client_id || clientId();
  const apiTry = { tag: "api", base: API, url: `${API}/token/refresh`, client_id: cid };
  const authTry = { tag: "auth", base: AUTH_BASE, url: `${AUTH_BASE}/v2/account/token`, client_id: cur.client_id || ADOPT_CLIENT_ID };
  const tries = cur.auth_base === AUTH_BASE ? [authTry, apiTry] : [apiTry, authTry];
  let last = null;
  for (const t of tries) {
    const r = await http(t.url, { method: "POST", headers: apiHeaders(null), body: JSON.stringify({ grant_type: "refresh_token", refresh_token: cur.refresh_token, client_id: t.client_id }) });
    if (r.status === 200 && r.json && r.json.access_token) {
      return persistTokens(r.json, {
        via: "refresh", created_at: cur.created_at, refreshed_count: (cur.refreshed_count || 0) + 1,
        auth_base: t.base, client_id: t.client_id,
      });
    }
    last = { tag: t.tag, status: r.status, code: String((r.json && (r.json.code || r.json.error)) || ""), text: r.text };
  }
  logWarn("cloud.token.refresh.failed", { status: last.status, code: last.code, tag: last.tag, error: String(last.text).slice(0, 200) });
  const err = new AuthError("续期失败 HTTP " + last.status + "（" + last.tag + "）"
    + (last.code ? " [" + last.code + "]" : "") + ": " + String(last.text).slice(0, 200), { status: last.status });
  err.code = last.code;
  throw err;
}

function persistTokens(j, extra = {}) {
  const prev = loadCredentials() || {};
  const now = Date.now();
  const c = {
    provider: PROVIDER,
    access_token: j.access_token,
    refresh_token: j.refresh_token || prev.refresh_token,
    token_type: j.token_type || "Bearer",
    expires_at: now + (Number(j.expires_in) || 7200) * 1000,
    drive_id: j.default_drive_id || j.drive_id || prev.drive_id,
    default_sbox_drive_id: j.default_sbox_drive_id || prev.default_sbox_drive_id,
    domain_id: j.domain_id || prev.domain_id,
    auth_base: extra.auth_base || prev.auth_base || API,
    client_id: extra.client_id || prev.client_id,
    user_id: j.user_id || prev.user_id,
    user_name: j.user_name || prev.user_name,
    nick_name: j.nick_name || prev.nick_name,
    avatar: j.avatar || prev.avatar,
    device_id: j.device_id || prev.device_id,
    role: j.role || prev.role,
    created_at: extra.created_at || prev.created_at || new Date(now).toISOString(),
    updated_at: new Date(now).toISOString(),
    ...(extra.via ? { last_token_via: extra.via } : {}),
    ...(extra.refreshed_count != null ? { refreshed_count: extra.refreshed_count } : {}),
  };
  saveCredentials(c);
  return c;
}

// 取可用的 access_token
let _refreshInflight = null;
export async function ensureAccessToken({ force = false } = {}) {
  const cur = loadCredentials();
  if (!cur || !cur.access_token) throw new AuthError("未连接阿里云盘");
  if (!force && !needsRefresh(cur)) return cur.access_token;
  if (!_refreshInflight) {
    _refreshInflight = refreshTokens().finally(() => { _refreshInflight = null; });
  }
  const fresh = await _refreshInflight;
  const now = loadCredentials();
  return (now && now.access_token) || (fresh && fresh.access_token);
}

export const OPENAPI = "https://openapi.alipan.com";

/**
 */
export async function userGet(accessToken) {
  const via = (() => { try { return (loadCredentials() || {}).last_token_via || ""; } catch { return ""; } })();
  const bases = via === "oauth" ? [OPENAPI, API] : [API, OPENAPI];
  let last = null;
  for (const base of bases) {
    try {
      const r = await http(`${base}/adrive/v2/user/get`, { method: "POST", headers: apiHeaders(accessToken), body: "{}" });
      if (r.status === 200 && r.json) return r.json;
      last = new AuthError(`user/get 失败 HTTP ${r.status}（${base}）：` + r.text.slice(0, 200));
    } catch (e) {
      last = e;
    }
  }
  throw last || new AuthError("user/get 失败");
}


// 应用目录（幂等）
export async function ensureAppFolder({ name = appFolderName() } = {}) {
  const at = await ensureAccessToken();
  const creds = loadCredentials();
  const created = await http(`${API}/adrive/v2/file/createWithFolders`, {
    method: "POST", headers: apiHeaders(at),
    body: JSON.stringify({ drive_id: creds.drive_id, parent_file_id: "root", name, type: "folder", check_name_mode: "refuse" }),
  });
  if (created.status === 201 && created.json && created.json.file_id) {
    return { file_id: created.json.file_id, created: true, drive_id: created.json.drive_id || creds.drive_id, name };
  }
  const found = await http(`${API}/adrive/v2/file/search`, {
    method: "POST", headers: apiHeaders(at),
    body: JSON.stringify({ drive_id: creds.drive_id, query: `name = '${name.replace(/'/g, "")}' and type = 'folder'`, limit: 5 }),
  });
  const hit = found.json && Array.isArray(found.json.items) && found.json.items[0];
  if (hit && hit.file_id) return { file_id: hit.file_id, created: false, drive_id: creds.drive_id, name };
  throw new AuthError("无法创建或定位应用目录: 建目录 HTTP " + created.status + " / 搜索 HTTP " + found.status);
}

export function disconnect() { clearCredentials(); return true; }

/** 状态汇总（供 UI 与后端路由） */
export function authStatus() {
  const c = loadCredentials();
  if (!c || !c.access_token) return { connected: false, provider: PROVIDER };
  return {
    connected: true, provider: PROVIDER,
    account: { user_name: c.user_name, nick_name: c.nick_name, user_id: c.user_id, avatar: c.avatar },
    drive_id: c.drive_id, domain_id: c.domain_id,
    expires_at: c.expires_at, expires_in_sec: Math.max(0, Math.round(((c.expires_at || 0) - Date.now()) / 1000)),
    created_at: c.created_at, updated_at: c.updated_at, last_token_via: c.last_token_via,
    refreshed_count: c.refreshed_count || 0,
  };
}


// 开放平台 OAuth：需要用户自建 App 的 App ID/Secret
export const ALIPAN_OAUTH = {
  authorize: "https://openapi.alipan.com/oauth/authorize",
  token: "https://openapi.alipan.com/oauth/access_token",
  scope: "user:base,file:all:read,file:all:write",
};

/** 拼开放平台授权页地址（用户浏览器打开 → 登录/扫码 → 回跳我们本机回调 → 自动换令牌） */
export function openPlatformAuthorizeUrl({ clientId, redirectUri, state }) {
  const q = new URLSearchParams({
    client_id: String(clientId || ""),
    redirect_uri: String(redirectUri || ""),
    response_type: "code",
    scope: ALIPAN_OAUTH.scope,
    state: String(state || ""),
  });
  return ALIPAN_OAUTH.authorize + "?" + q.toString();
}

/** 授权码 → 令牌（开放平台通道）；成功后写入同一份凭据文件 */
export async function exchangeOpenPlatformCode({ code, clientId, clientSecret, redirectUri }) {
  // 输入白名单：宁可本地报错，也不要把空值发出去（服务端只会回含糊的 AppNotExists）
  const c0 = String(code || "").trim();
  const id0 = String(clientId || "").trim();
  const sec0 = String(clientSecret || "").trim();
  const red0 = String(redirectUri || "").trim();
  if (!c0) throw new AuthError("授权码为空：请把浏览器地址栏里的 code 完整复制过来");
  if (!/^[A-Za-z0-9._~\-+=]{8,512}$/.test(c0)) throw new AuthError("授权码形态不对（含非法字符或长度异常），请重新复制");
  if (!id0 || !sec0) throw new AuthError("缺少开放平台 App ID / App Secret：先在面板里填好再授权");
  if (!red0) throw new AuthError("缺少回调地址 redirect_uri");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: id0,
    client_secret: sec0,
    code: c0,
    redirect_uri: red0,
  });
  const r = await http(ALIPAN_OAUTH.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA, accept: "application/json" },
    body: body.toString(),
  });
  if (r.status !== 200 || !r.json) {
    const msg = (r.json && (r.json.error_description || r.json.message || r.json.error)) || r.text.slice(0, 300);
    throw new AuthError("开放平台换取令牌失败 HTTP " + r.status + "：" + msg);
  }
  if (!r.json.access_token && !r.json.refresh_token) {
    throw new AuthError("开放平台返回里没有令牌：" + r.text.slice(0, 200));
  }
  const creds = persistTokens(r.json, { via: "oauth", client_id: String(clientId || "") });
  // 开放平台通常不返回昵称，补一次用户信息（失败不影响授权）
  try {
    const me = await userGet();
    if (me && (me.nick_name || me.user_name)) {
      const c = loadCredentials() || creds;
      // 开放平台令牌不带 drive_id/domain_id —— 必须从 user/get 的 default_drive_id 补上，
      // 否则后续 createWithFolders / list / upload 都会因为缺 drive_id 失败。
      const driveId = c.drive_id || me.default_drive_id || (me.default_drive && me.default_drive.drive_id) || "";
      const domainId = c.domain_id || me.domain_id || (me.default_drive && me.default_drive.domain_id) || "";
      const merged = persistTokens({
        ...c,
        nick_name: me.nick_name || c.nick_name,
        user_name: me.user_name || c.user_name,
        user_id: me.user_id || c.user_id,
        avatar: me.avatar || c.avatar,
        phone: me.phone || c.phone,
        drive_id: driveId,
        domain_id: domainId,
        default_drive_id: driveId,
      }, { via: "oauth", client_id: String(clientId || "") });
      return merged;
    }
  } catch (e) {}
  return creds;
}
