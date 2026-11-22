// lib/auth/drive-login-state.js —— 本机「已登录的阿里云盘」登录态采集与导入（免扫码）

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveCredentials } from "../store/credentials.js";

export const AUTH_BASE = "https://auth.aliyundrive.com";
export const ADOPT_CLIENT_ID = "pJZInNHN2dZWk8qg";     // 桌面客户端 client_id（auth 端点不校验，仅形式完整）
export const WEB_CLIENT_ID = "25dzX3vbYqktVxyX";        // 官方网页版 client_id（所有社区工具都用它）

const RT_PATTERNS = [
  /"refresh_token"\s*:\s*"([0-9a-fA-F]{16,64})"/g,
  /\\"refresh_token\\"\s*:\s*\\"([0-9a-fA-F]{16,64})\\"/g,
];
const CID_PATTERNS = [
  /"client_id"\s*:\s*"([A-Za-z0-9_-]{6,64})"/g,
  /\\"client_id\\"\s*:\s*\\"([A-Za-z0-9_-]{6,64})\\"/g,
];
const FILE_RE = /\.(ldb|log|json|txt|bin|dat)$/i;

const localAppData = () => process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const roamingAppData = () => process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");

/** 候选来源根目录（存在才返回），kind 决定优先用哪条续期端点 */
export function storeRoots() {
  const local = localAppData();
  const roaming = roamingAppData();
  const cands = [
    { kind: "client", root: path.join(roaming, "aDrive") },
    { kind: "client", root: path.join(roaming, "aDrive", "Partitions", "adrive") },
    { kind: "client", root: path.join(local, "aDrive") },
    { kind: "web", root: path.join(local, "Google", "Chrome", "User Data") },
    { kind: "web", root: path.join(local, "Microsoft", "Edge", "User Data") },
    { kind: "web", root: path.join(local, "BraveSoftware", "Brave-Browser", "User Data") },
    { kind: "web", root: path.join(local, "Chromium", "User Data") },
  ];
  const out = [];
  for (const c of cands) {
    try { if (fs.statSync(c.root).isDirectory()) out.push(c); } catch { /* 不存在 */ }
  }
  return out;
}

function walk(dir, depth, out, maxDepth, cap) {
  if (depth > maxDepth || out.length >= cap) return;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (out.length >= cap) return;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p, depth + 1, out, maxDepth, cap); continue; }
    if (!FILE_RE.test(e.name)) continue;
    // 只关心登录态会落地的地方，避免把整个 User Data 翻一遍
    if (!/local storage|leveldb|session storage|adrive/i.test(p)) continue;
    out.push(p);
  }
}

/**
 */
export function harvestRefreshTokens({ maxDepth = 6, maxBytes = 12 * 1024 * 1024, maxFiles = 800, roots = null, minMtimeMs = 0 } = {}) {
  const bases = Array.isArray(roots) && roots.length
    ? roots.map((r) => (typeof r === "string" ? { kind: "client", root: r } : r))
    : storeRoots();
  const cands = [];
  for (const b of bases) {
    const files = [];
    walk(b.root, 0, files, maxDepth, maxFiles);
    for (const f of files) {
      let st;
      try { st = fs.statSync(f); } catch { continue; }
      if (!st.isFile() || st.size === 0 || st.size > maxBytes) continue;
      let buf;
      try { buf = fs.readFileSync(f); } catch { continue; }
      const s = buf.toString("latin1");
      // 同一文件里 client_id 与 refresh_token 按出现顺序配对，取最近一次出现的 client_id
      let cid = "";
      for (const re of CID_PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(s)) !== null) cid = m[1];
      }
      for (const re of RT_PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(s)) !== null) {
          cands.push({ token: m[1].toLowerCase(), kind: b.kind, clientId: cid, file: f, mtimeMs: st.mtimeMs });
        }
      }
    }
  }
  // 优先级：桌面客户端登录态优先（长期有效、不依赖浏览器 profile 是否还在用），
  const rank = function (k) { return k === "client" ? 0 : 1; };
  cands.sort(function (a, b) {
    const r = rank(a.kind) - rank(b.kind);
    if (r !== 0) return r;
    return b.mtimeMs - a.mtimeMs;
  });
  const seen = new Set(), out = [];
  const floor = Number(minMtimeMs) > 0 ? Number(minMtimeMs) : 0;   // 只要比这个时刻更新的登录态
  for (const c of cands) {
    if (floor && !(c.mtimeMs >= floor)) continue;   // 只要这一刻之后写入的登录态
    if (seen.has(c.token)) continue;
    seen.add(c.token);
    out.push(c);
  }
  return out;
}

/** 走 auth 端点换令牌（桌面客户端令牌这条路） */
export async function exchangeViaAuth(refreshToken, { clientId = ADOPT_CLIENT_ID, timeoutMs = 15000 } = {}) {
  return postJson(AUTH_BASE + "/v2/account/token", { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }, timeoutMs);
}

/** 走网页版 refresh 端点换令牌（网页版令牌这条路） */
export async function exchangeViaWeb(refreshToken, { clientId = WEB_CLIENT_ID, timeoutMs = 15000 } = {}) {
  return postJson("https://api.aliyundrive.com/token/refresh", { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }, timeoutMs);
}

async function postJson(url, body, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(function () { ac.abort(new Error("timeout")); }, timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
    if (res.status !== 200 || !json || !json.access_token) {
      return { ok: false, status: res.status, detail: text.slice(0, 200), endpoint: url };
    }
    return { ok: true, json, endpoint: url };
  } catch (e) {
    return { ok: false, status: 0, detail: (e && e.message) || String(e), endpoint: url };
  } finally { clearTimeout(timer); }
}

/** 两条端点都试：按来源优先，失败再试另一条；两条都不行才算失败 */
export async function exchangeAnyEndpoint(refreshToken, { prefer = "client", clientId = "" } = {}) {
  const tries = prefer === "web"
    ? [() => exchangeViaWeb(refreshToken, clientId ? { clientId } : {}), () => exchangeViaAuth(refreshToken)]
    : [() => exchangeViaAuth(refreshToken, clientId ? { clientId } : {}), () => exchangeViaWeb(refreshToken)];
  const log = [];
  for (const t of tries) {
    const r = await t();
    log.push({ endpoint: r.endpoint, status: r.status, ok: !!r.ok, detail: r.detail });
    if (r.ok) return { ok: true, r, log };
  }
  return { ok: false, log };
}

function credsFrom(json, { endpoint, via, source, refreshToken }) {
  const now = Date.now();
  return {
    provider: "aliyun",
    access_token: json.access_token,
    refresh_token: json.refresh_token || refreshToken,
    token_type: json.token_type || "Bearer",
    expires_at: now + (Number(json.expires_in) || 7200) * 1000,
    drive_id: json.default_drive_id || json.defaultDriveId || json.drive_id,
    domain_id: json.domain_id,
    user_id: json.user_id,
    user_name: json.user_name,
    nick_name: json.nick_name,
    avatar: json.avatar,
    auth_base: String(endpoint || "").indexOf("api.aliyundrive.com") >= 0 ? "https://api.aliyundrive.com" : AUTH_BASE,
    client_id: String(endpoint || "").indexOf("api.aliyundrive.com") >= 0 ? WEB_CLIENT_ID : ADOPT_CLIENT_ID,
    last_token_via: via,
    adopted_from: source || null,
    created_at: new Date(now).toISOString(),
    updated_at: new Date(now).toISOString(),
  };
}

/** 只看有没有「新的」登录态（不换令牌、不发任何网络请求）——用于等待浏览器登录 */
export function peekLoginState({ roots = null, minMtimeMs = 0 } = {}) {
  const list = harvestRefreshTokens(Object.assign(
    { minMtimeMs },
    roots ? (Array.isArray(roots) && typeof roots[0] === "string" ? { roots } : { roots }) : {},
  ));
  const top = list[0] || null;
  return {
    found: !!top,
    kind: top ? top.kind : null,
    source: top ? top.file : null,
    mtimeMs: top ? top.mtimeMs : 0,
    total: list.length,
  };
}

/** 一键导入：扫本机（客户端 + 浏览器）找到能用的登录态 */
export async function adoptLocalClient({ logger, maxTry = 6, roots = null, minMtimeMs = 0 } = {}) {
  const tokens = harvestRefreshTokens(Object.assign(
    { minMtimeMs },
    roots ? (Array.isArray(roots) && typeof roots[0] === "string" ? { roots } : { roots }) : {},
  ));
  if (!tokens.length) {
    return { ok: false, error: "本机未找到阿里云盘的登录态（没装客户端、也没在浏览器登录过网页版）", found: 0, tried: [] };
  }
  const tried = [];
  for (const t of tokens.slice(0, maxTry)) {
    const r = await exchangeAnyEndpoint(t.token, { prefer: t.kind, clientId: t.clientId || "" });
    if (!r.ok) { tried.push({ file: t.file, kind: t.kind, log: r.log }); continue; }
    const creds = credsFrom(r.r.json, { endpoint: r.r.endpoint, via: t.kind === "web" ? "web-local" : "adrive-local", source: t.file, refreshToken: t.token });
    saveCredentials(creds);
    logger?.info?.("[dsh-cloud-backup] adopted local login state from " + t.file);
    return {
      ok: true, source: t.file, kind: t.kind, tried: tried.length + 1, creds,
      account: { user_name: creds.user_name, nick_name: creds.nick_name, user_id: creds.user_id, drive_id: creds.drive_id, domain_id: creds.domain_id },
    };
  }
  return {
    ok: false,
    error: "找到 " + tokens.length + " 份本机登录态，但都没能换成新令牌（可能已过期或已退出登录）",
    found: tokens.length, tried,
  };
}

/** 手工粘贴 refresh_token 导入（社区标准做法，也是最直接的一条） */
export async function importRefreshToken(refreshToken, { logger, clientId = "" } = {}) {
  const rt = String(refreshToken || "").trim().replace(/^"|"$/g, "");
  if (!rt) return { ok: false, error: "refresh_token 为空" };
  if (!/^[A-Za-z0-9._~\-+=]{16,512}$/.test(rt)) return { ok: false, error: "refresh_token 形态不对（不是合法字符或长度异常）" };
  const r = await exchangeAnyEndpoint(rt, { prefer: clientId ? "client" : "web", clientId });
  if (!r.ok) {
    return { ok: false, error: "两条续期端点都没能换到令牌（refresh_token 可能已失效）", tried: r.log };
  }
  const creds = credsFrom(r.r.json, { endpoint: r.r.endpoint, via: "web-local", source: "pasted", refreshToken: rt });
  saveCredentials(creds);
  logger?.info?.("[dsh-cloud-backup] imported pasted refresh_token");
  return {
    ok: true, tried: 1, creds,
    account: { user_name: creds.user_name, nick_name: creds.nick_name, user_id: creds.user_id, drive_id: creds.drive_id, domain_id: creds.domain_id },
  };
}
