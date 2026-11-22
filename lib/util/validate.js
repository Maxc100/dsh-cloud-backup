// lib/util/validate.js —— 入参白名单校验（stamp/hash 未校验即拼路径 → 路径穿越）

/** 合法快照 ID：主格式 YYYYMMDD-HHMMSS，或受限的字母数字变体（≤64，不含路径分隔符与 ..） */
export const STAMP_RE = /^(?:\d{8}-\d{6}|[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/;
/** 合法 blob 键：sha256 十六进制 */
export const HASH_RE = /^[0-9a-f]{64}$/;

export function isStamp(v) {
  return typeof v === "string" && STAMP_RE.test(v) && v.indexOf("..") < 0;
}

export function isHash(v) {
  return typeof v === "string" && HASH_RE.test(v);
}

/** 校验通过返回原值；不通过抛错（错误文案可直接给用户看） */
export function assertHash(v, what = "hash") {
  if (!isHash(v)) throw new Error(`非法 ${what}（必须是 64 位十六进制）：${String(v).slice(0, 64)}`);
  return v;
}

/** Host 头必须是回环名。webServer 按最长前缀直接分派路由，不经过 /api 网关的信任检查，
 *  因此每个处理函数都要自己钉住 Host，否则 DNS 重绑定可让外部页面以本机身份调用。 */
export function isLoopbackHost(host) {
  const s = String(host || "").trim().toLowerCase();
  if (!s) return false;
  const m = /^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::\d+)?$/.exec(s);
  if (!m) return false;
  const name = m[1];
  return name === "localhost" || name === "[::1]" || name === "::1" || /^127(?:\.\d{1,3}){3}$/.test(name);
}

/** 是否本机来源：缺失（Node/脚本调用，浏览器跨站请求必带 Origin）、127.0.0.1、localhost、[::1]。
 *  "null" 不放行：沙箱 iframe、file:// 与被重定向的跨站请求都会带它，等同跨站。 */
export function isLocalOrigin(origin) {
  if (!origin) return true;
  const s = String(origin).trim().toLowerCase();
  if (s === "null") return false;
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(s);
}

/** 非 GET 请求必须带的标记头。跨站脚本加自定义头会触发预检，而预检被 405 拒，等同关闭 CSRF。 */
export const CSRF_HEADER = "x-dshcb-csrf";
export function hasCsrfHeader(headers) {
  return String((headers && headers[CSRF_HEADER]) || "").trim() === "1";
}

/** 夹取整数：非有限数一律回落 fallback，再夹到 [min,max] */
export function clampInt(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
