import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// 宿主运行版本就是 `dsh --version`（@deepseek-ai/dsh / dsh-app-boot 的版本）。
// 插件兼容门禁比对插件声明的 engines.dsh，面板自检共用同一取值逻辑。
const SELF_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function readVersion(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8")).version;
    return typeof v === "string" && v ? v : null;
  } catch { return null; }
}

/** 插件自己声明的兼容范围（engines.dsh）；没声明返回空串。 */
export function declaredRange() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(SELF_DIR, "package.json"), "utf8"));
    const v = pkg && pkg.engines && pkg.engines.dsh;
    return typeof v === "string" ? v : "";
  } catch { return ""; }
}

// 宿主 CLI 的入口路径形如 .../node_modules/@deepseek-ai/<pkg>/lib/cli.js；
// desktop 版这一层在 app.asar 里，Electron 的 fs 兼容层能直接读。
function sibling(entry, name) {
  const m = /^(.*[\/]node_modules[\/]@deepseek-ai[\/])[^\/]+[\/]/.exec(String(entry || ""));
  return m ? path.join(m[1], name, "package.json") : null;
}

// 桌面版把 dsh 运行时装进 app.asar：<resources>/app.asar/dsh/package.json 的版本
// 就是 `dsh --version` 报的那个（包名 @deepseek-ai/dsh-desktop-runtime）。
function asarCandidates(entries) {
  const roots = [];
  const res = (process && process.resourcesPath) || "";
  if (res) roots.push(path.join(res, "app.asar"));
  for (const e of entries) {
    const m = /^(.*[\\/]app\.asar)[\\/]/.exec(String(e == null ? "" : e));
    if (m && roots.indexOf(m[1]) < 0) roots.push(m[1]);
  }
  const out = [];
  for (const r of roots) {
    out.push(path.join(r, "dsh", "package.json"));
    for (const n of ["dsh", "dsh-app-boot", "dsh-desktop-runtime"]) {
      out.push(path.join(r, "dsh", "node_modules", "@deepseek-ai", n, "package.json"));
    }
  }
  return out;
}

export function runtimeVersion(argv1 = process.argv[1], env = process.env, argv = process.argv) {
  const forced = env && env.DSH_CLOUD_BACKUP_DSH_VERSION;
  if (forced) return { version: String(forced), source: "env" };
  try {
    const req = createRequire(import.meta.url);
    for (const n of ["@deepseek-ai/dsh", "@deepseek-ai/dsh-app-boot"]) {
      try {
        const v = readVersion(req.resolve(n + "/package.json"));
        if (v) return { version: v, source: "resolve" };
      } catch { /* 该包不在本插件的解析路径上，继续换法子 */ }
    }
  } catch { /* createRequire 不可用时只走路径反推 */ }
  const args = Array.isArray(argv) ? argv.slice() : [];
  if (argv1 && args.indexOf(argv1) < 0) args.unshift(argv1);
  for (const a of args) {
    for (const n of ["dsh", "dsh-app-boot", "dsh-desktop-runtime"]) {
      const p = sibling(a, n);
      if (p) { const v = readVersion(p); if (v) return { version: v, source: "argv" }; }
    }
  }
  for (const p of asarCandidates(args)) {
    const v = readVersion(p);
    if (v) return { version: v, source: "asar" };
  }
  return { version: null, source: "unknown" };
}

function parse(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v == null ? "" : v).trim());
  if (!m) return null;
  return { main: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}
function cmpId(a, b) {
  const an = /^\d+$/.test(a), bn = /^\d+$/.test(b);
  if (an && bn) return Number(a) - Number(b) < 0 ? -1 : (Number(a) === Number(b) ? 0 : 1);
  if (an) return -1;   // 数字标识符优先级低于字母标识符
  if (bn) return 1;
  return a === b ? 0 : (a < b ? -1 : 1);
}

/** 标准 semver 优先级比较；无法解析返回 null。 */
export function compareVersions(a, b) {
  const x = parse(a), y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.main[i] !== y.main[i]) return x.main[i] < y.main[i] ? -1 : 1;
  if (!x.pre.length && !y.pre.length) return 0;
  if (!x.pre.length) return 1;
  if (!y.pre.length) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (x.pre[i] === undefined) return -1;
    if (y.pre[i] === undefined) return 1;
    const c = cmpId(x.pre[i], y.pre[i]);
    if (c) return c;
  }
  return 0;
}

/** 只支持空格分隔的比较符（>=、>、<=、<、=），足够表达引擎声明；预发布按 semver 优先级参与。 */
export function satisfies(version, range) {
  const parts = String(range == null ? "" : range).trim().split(/\s+/).filter(Boolean);
  if (!parts.length || !parse(version)) return null;
  for (const p of parts) {
    const m = /^(>=|<=|>|<|=)?(.+)$/.exec(p);
    const op = m[1] || "=";
    const c = compareVersions(version, m[2]);
    if (c === null) return null;
    const ok = op === ">=" ? c >= 0 : op === ">" ? c > 0 : op === "<=" ? c <= 0 : op === "<" ? c < 0 : c === 0;
    if (!ok) return false;
  }
  return true;
}

// 与宿主一致：没声明就视为任何版本都兼容；声明了但范围无法解析则给 null（未知）。
export function compatVerdict(runtime, declared) {
  const range = String(declared == null ? "" : declared).trim();
  if (!runtime) return { runtime: null, declared: range, ok: null, reason: "no-runtime" };
  if (!range) return { runtime, declared: "", ok: true, reason: "no-declaration" };
  const r = satisfies(runtime, range);
  if (r === null) return { runtime, declared: range, ok: null, reason: "bad-range" };
  return { runtime, declared: range, ok: r, reason: r ? "ok" : "out-of-range" };
}

export function compatInfo(argv1, env) {
  const rt = runtimeVersion(argv1, env);
  const v = compatVerdict(rt.version, declaredRange());
  return { runtime: v.runtime, declared: v.declared, ok: v.ok, reason: v.reason, source: rt.source };
}
