// lib/store/credentials.js —— 凭据持久化（密文 + 明文元信息分离）

import fs from "node:fs";
import { credentialsPath, writeFileAtomic } from "./paths.js";
import { protect, unprotect, isProtected } from "./secret.js";

/** 文件结构：{\"v\":1,\"provider\":\"aliyun\",\"meta\":{非机密展示信息},\"secret\":\"<加密后的 token 块>\"} */
const V = 1;

// DPAPI 解密一次约 3 秒（要起 PowerShell）；按文件 mtime+size 缓存，命中即返回。
let _cache = null; // { key, file, value }

function stampKey(file) {
  try { const st = fs.statSync(file); return st.mtimeMs + ":" + st.size; } catch { return null; }
}

/** 读取凭据；不存在或损坏返回 null（损坏时另存 .bad-<ts> 便于排查，不静默丢弃） */
export function loadCredentials() {
  const file = credentialsPath();
  const key = stampKey(file);
  if (!key) { _cache = null; return null; }
  if (_cache && _cache.file === file && _cache.key === key) return _cache.value;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) {
    try { fs.renameSync(file, `${file}.bad-${Date.now()}`); } catch {}
    return null;
  }
  if (!raw || raw.v !== V) return null;
  try {
    const secret = raw.secret && isProtected(raw.secret) ? JSON.parse(unprotect(raw.secret)) : {};
    const value = { ...raw.meta, ...secret, provider: raw.provider, _savedAt: raw.savedAt };
    _cache = { file, key, value };
    return value;
  } catch (e) {
    return null; // 换机/换用户后 DPAPI 解不开，等同未连接
  }
}

/** 保存凭据：token 等机密进 secret 块（加密），其余明文便于 UI 未解密时展示 */
export function saveCredentials(c) {
  const { provider = "aliyun", _savedAt, ...rest } = c || {};
  // 机密键：一律进加密块；其余（账号展示名、过期时间、计数器…）明文存放，便于未解密时渲染 UI。
  // 注意必须用"非机密即明文"的写法，不能用白名单——白名单会静默丢字段（updated_at/refreshed_count 曾因此丢失）。
  const SECRET_KEYS = ["access_token", "refresh_token", "id_token", "token_type", "device_id"];
  const secret = {}, meta = {};
  for (const [k, v] of Object.entries(rest)) (SECRET_KEYS.includes(k) ? secret : meta)[k] = v;
  const body = {
    v: V, provider, savedAt: new Date().toISOString(),
    meta,
    secret: protect(JSON.stringify(secret)),
  };
  writeFileAtomic(credentialsPath(), JSON.stringify(body, null, 2));
  _cache = null;
  return body;
}

export function clearCredentials() {
  const file = credentialsPath();
  try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
  _cache = null;
  return true;
}

/** 是否"看起来已过期"（提前 skewMs 视为需要刷新） */
export function needsRefresh(creds, skewMs = 600_000) {
  if (!creds || !creds.expires_at) return true;
  return Number(creds.expires_at) - Date.now() <= skewMs;
}
