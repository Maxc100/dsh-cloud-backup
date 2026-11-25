import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { runCmd } from "../util/proc.js";
import { logInfo, logWarn } from "../util/log.js";

const INBOX = new Set([
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "@deepseek-ai/dsh-headless",
]);

const LINK_PREFIX = "link:";
const FILE_PREFIX = "file:";
const NON_REGISTRY = /^(github:|gitlab:|bitbucket:|git\+|file:|link:|workspace:|https?:)/i;

export function classifySpec(spec) {
  if (typeof spec !== "string") return "registry";
  const s = spec.trim();
  if (s === "") return "registry";
  const lower = s.toLowerCase();
  if (lower.startsWith(LINK_PREFIX)) return "link";
  if (lower.startsWith(FILE_PREFIX)) return "file";
  if (/^https?:\/\//i.test(s)) return "https";
  if (/^(github:|gitlab:|bitbucket:|git\+)/i.test(s)) return "github";
  return "registry";
}

export function isInbox(name) {
  return INBOX.has(String(name || ""));
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

function realDirOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return fs.existsSync(p) ? p : null;
  }
}

/** 判定一个已解包目录是不是 DSH 插件：package.json 带 dsh 字段，或带 cordis.patch.yml。 */
function looksLikePlugin(dir) {
  const pkg = readJsonSafe(path.join(dir, "package.json"));
  if (!pkg) return null;
  const name = String(pkg.name || "");
  if (!name || isInbox(name) || /^@deepseek-ai\//.test(name)) return null;
  if (!pkg.dsh && !fs.existsSync(path.join(dir, "cordis.patch.yml"))) return null;
  return { name, version: String(pkg.version || ""), dir };
}

/** 扫 profile 已解包的插件，用于清单被宿主重写后的归属兜底。
 * 只看 node_modules 顶层：`.pnpm` 会留下卸载后没人清理的旧副本，扫它就会把早已移除的包当成已安装。
 */
function scanInstalledPlugins(profileDir) {
  const found = [];
  const seen = new Set();
  const take = (dir) => {
    const info = looksLikePlugin(dir);
    if (!info || seen.has(info.name)) return;
    seen.add(info.name);
    found.push(info);
  };
  const scanContainer = (root) => {
    for (const e of listDirs(root)) {
      if (e === ".bin" || e === ".pnpm") continue;
      if (e.startsWith("@")) {
        for (const s of listDirs(path.join(root, e))) take(path.join(root, e, s));
      } else {
        take(path.join(root, e));
      }
    }
  };
  const top = path.join(profileDir, "node_modules");
  scanContainer(top);
  return found;
}

export function listProfilePlugins({ dshHome } = {}) {
  const out = [];
  if (!dshHome) return out;
  for (const profile of listDirs(path.join(dshHome, "profiles"))) {
    const profileDir = path.join(dshHome, "profiles", profile);
    const pkg = readJsonSafe(path.join(profileDir, "package.json"));
    const deps = (pkg && pkg.dependencies) || {};
    for (const name of Object.keys(deps)) {
      if (isInbox(name)) continue;
      // 运行时随宿主分发的包（@deepseek-ai/*）属于应用本体，不随用户备份打包；它们会随桌面版一起装回
      if (/^@deepseek-ai\//.test(name)) continue;
      const spec = String(deps[name] || "");
      const kind = classifySpec(spec);
      const installedDir = realDirOrNull(path.join(profileDir, "node_modules", name));
      const installedPkg = installedDir ? readJsonSafe(path.join(installedDir, "package.json")) : null;
      const version = (installedPkg && installedPkg.version) || (/^[~^]?\d+\.\d+\.\d+/.test(spec) ? spec.replace(/^[~^]/, "") : "");
      out.push({ profile, name, spec, kind, version, dir: installedDir, hasScripts: !!installedPkg, declared: true });
    }
    // 兜底：宿主会重写 profiles/<p>/package.json，已解包的插件可能不再出现在 dependencies 里。
    // 插件自带的多包结构（如 dsh-mnemon-*）也在 node_modules 顶层，它们是被依赖的子包而不是用户装的插件，
    // 用「别的插件依赖了它」把这类子包排除掉，否则清单里的插件数会被虚高。
    const candidates = scanInstalledPlugins(profileDir).filter(function (it) {
      return !Object.prototype.hasOwnProperty.call(deps, it.name);
    });
    const subPackages = new Set();
    for (const name of Object.keys(deps)) {
      const dir = realDirOrNull(path.join(profileDir, "node_modules", name));
      if (!dir) continue;
      const pj = readJsonSafe(path.join(dir, "package.json")) || {};
      for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
        for (const dep of Object.keys(pj[field] || {})) subPackages.add(dep);
      }
    }
    for (const it of candidates) {
      if (subPackages.has(it.name)) continue;
      out.push({ profile, name: it.name, spec: "", kind: "installed", version: it.version, dir: it.dir, hasScripts: true, declared: false });
    }
  }
  return out;
}

/** 打包前把包复制成普通副本：pnpm 硬链接（link count > 1）会让 npm pack 直接崩、不产出文件。
 * node_modules 默认不进 tarball，复制时跳过；包声明 bundledDependencies 时保留。
 */
function stagePlainCopy(dir, stagingRoot) {
  const staged = path.join(stagingRoot, "package");
  const pkg = readJsonSafe(path.join(dir, "package.json")) || {};
  const bundled = Array.isArray(pkg.bundledDependencies) ? pkg.bundledDependencies : Array.isArray(pkg.bundleDependencies) ? pkg.bundleDependencies : [];
  const skipModules = bundled.length === 0;
  const topModules = path.resolve(path.join(dir, "node_modules"));
  fs.cpSync(dir, staged, { recursive: true, filter: (src) => !(skipModules && path.resolve(src) === topModules) });
  return staged;
}

function packOnce(dir, outDir, timeoutMs) {
  return new Promise((resolve) => {
    let stagingRoot = null;
    let staged = null;
    try {
      stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dshcb-stage-"));
      staged = stagePlainCopy(dir, stagingRoot);
    } catch (e) {
      if (stagingRoot) {
        try { fs.rmSync(stagingRoot, { recursive: true, force: true }); } catch {}
      }
      resolve({ ok: false, file: null, error: "复制打包暂存目录失败：" + String((e && e.message) || e) });
      return;
    }
    const cleanup = () => {
      try { fs.rmSync(stagingRoot, { recursive: true, force: true }); } catch {}
    };
    // 参数数组直传：暂存目录与输出目录只作为独立参数，不参与命令行拼接
    runCmd("npm", ["pack", "--ignore-scripts", "--pack-destination", outDir, staged], { cwd: path.dirname(staged), timeoutMs })
      .then((r) => {
        if (!r.ok) {
          const detail = String((r.stderr || "").trim() || (r.error || "")).split("\n").slice(0, 3).join(" ");
          cleanup();
          resolve({ ok: false, file: null, error: "npm pack 失败：" + detail });
          return;
        }
        const lines = String(r.stdout || "").trim().split("\n");
        const tail = lines[lines.length - 1] || "";
        const file = path.isAbsolute(tail) ? tail : path.join(outDir, tail.trim());
        const ok = fs.existsSync(file);
        cleanup();
        resolve({ ok, file: ok ? file : null, error: ok ? null : "npm pack 未产出 tarball" });
      });
  });
}

/** 打包一次并给出可诊断的原因；失败通常是确定的（源目录属性所致），不做无意义的重试。 */
export async function runNpmPack(dir, outDir, timeoutMs) {
  return await packOnce(dir, outDir, timeoutMs);
}

function tarEntries(tgzPath, limit = 4096) {
  const names = [];
  try {
    const buf = zlib.gunzipSync(fs.readFileSync(tgzPath));
    let off = 0;
    while (off + 512 <= buf.length && names.length < limit) {
      const header = buf.subarray(off, off + 512);
      if (header.every((b) => b === 0)) break;
      const rawName = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
      const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
      const name = prefix ? prefix + "/" + rawName : rawName;
      const sizeOctal = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
      const size = parseInt(sizeOctal, 8) || 0;
      if (name) names.push(name);
      off += 512 + Math.ceil(size / 512) * 512;
    }
  } catch {
    return null;
  }
  return names;
}

export function selfCheck({ srcDir, tgzPath }) {
  const names = tarEntries(tgzPath);
  if (!names) return { ok: false, warning: "tarball-unreadable" };
  const has = (suffix) => names.some((n) => n === "package/" + suffix || n.endsWith("/" + suffix) || n.startsWith("package/" + suffix + "/") || n.indexOf("/" + suffix + "/") >= 0);
  const deps = [];
  let hasScripts = [];
  const srcPkg = readJsonSafe(path.join(srcDir, "package.json")) || {};
  for (const d of Object.keys(srcPkg.dependencies || {})) deps.push(d);
  for (const s of Object.keys(srcPkg.scripts || {})) {
    if (["preinstall", "install", "postinstall", "prepare", "prepack"].includes(s)) hasScripts.push(s);
  }
  let nestedDeps = false;
  try {
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (entry.isDirectory() && fs.existsSync(path.join(srcDir, entry.name, "node_modules"))) { nestedDeps = true; break; }
    }
    if (!nestedDeps && fs.existsSync(path.join(srcDir, "node_modules"))) nestedDeps = true;
  } catch {
    nestedDeps = false;
  }
  const warnings = [];
  if (!has("package.json")) warnings.push("missing-package-json");
  for (const must of ["client.js", "cordis.patch.yml", "lib"]) {
    if (fs.existsSync(path.join(srcDir, must)) && !has(must)) warnings.push("missing-" + must);
  }
  return { ok: warnings.length === 0, warning: warnings.join(",") || null, deps, has_scripts: hasScripts, nested_deps: nestedDeps, files: names.length };
}

const cache = new Map();

function cacheKey(item) {
  try {
    const st = fs.statSync(path.join(item.dir, "package.json"));
    return item.name + "@" + item.version + ":" + st.mtimeMs + ":" + st.size;
  } catch {
    return item.name + "@" + item.version;
  }
}

export async function collectPluginPacks({ dshHome, maxBytes = 20 * 1024 * 1024, maxCount = 40, timeoutMs = 120000, onPack = null } = {}) {
  const items = listProfilePlugins({ dshHome });
  const seen = new Map();
  const plugins = [];
  const stats = { candidates: items.length, packed: 0, specOnly: 0, skipped: 0, bytes: 0, runtimeBundles: 0 };
  let taken = 0;
  for (const item of items) {
    if (!item.dir) { stats.skipped++; continue; }
    const prev = seen.get(item.name);
    if (prev) {
      if (prev.profiles.indexOf(item.profile) < 0) prev.profiles.push(item.profile);
      continue;
    }
    const slot = { profiles: [item.profile] };
    seen.set(item.name, slot);
    const cacheHit = cache.get(cacheKey(item));
    if (item.kind === "registry" && !cacheHit) {
      plugins.push({
        name: item.name, version: item.version, spec: item.spec, source_kind: "registry", profiles: slot.profiles,
        resolved_ref: null, blob: null, size: 0, files: 0, state: "spec-only",
        nested_deps: false, deps: [], has_scripts: [], warning: null, packed_at: new Date().toISOString(),
      });
      stats.specOnly++;
      continue;
    }
    if (taken >= maxCount) {
      logWarn("plugin.pack.skipped", { name: item.name, reason: "too-many" });
      stats.skipped++;
      continue;
    }
    taken++;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dshcb-pack-"));
    const t0 = Date.now();
    logInfo("plugin.pack.start", { name: item.name, version: item.version, kind: item.kind, dir: item.dir });
    const packed = await runNpmPack(item.dir, tmp, timeoutMs);
    let entry = null;
    if (packed.ok && packed.file) {
      const bytes = fs.statSync(packed.file).size;
      if (bytes > maxBytes) {
        logWarn("plugin.pack.skipped", { name: item.name, reason: "too-large", bytes });
        stats.skipped++;
      } else {
        const check = selfCheck({ srcDir: item.dir, tgzPath: packed.file });
        const sha = crypto.createHash("sha256").update(fs.readFileSync(packed.file)).digest("hex");
        entry = {
          name: item.name, version: item.version, spec: item.spec, source_kind: item.kind, profiles: slot.profiles,
          resolved_ref: null, blob: sha, size: bytes, files: check.files || 0,
          state: check.ok ? "packed" : "spec-only", nested_deps: !!check.nested_deps,
          deps: check.deps || [], has_scripts: check.has_scripts || [], warning: check.warning || null,
          packed_at: new Date().toISOString(), tgzPath: packed.file,
        };
        if (!check.ok) stats.specOnly++; else { stats.packed++; stats.bytes += bytes; }
        logInfo(check.ok ? "plugin.pack.done" : "plugin.pack.failed", {
          name: item.name, version: item.version, bytes, seconds: ((Date.now() - t0) / 1000).toFixed(1), warning: check.warning || "",
        });
      }
    } else {
      logWarn("plugin.pack.failed", { name: item.name, error: packed.error });
      stats.skipped++;
    }
    if (!entry) {
      entry = {
        name: item.name, version: item.version, spec: item.spec, source_kind: item.kind, profiles: slot.profiles,
        resolved_ref: null, blob: null, size: 0, files: 0, state: "spec-only",
        nested_deps: false, deps: [], has_scripts: [], warning: packed.error || "pack-failed",
        packed_at: new Date().toISOString(),
      };
    }
    if (entry.blob && entry.tgzPath) cache.set(cacheKey(item), { blob: entry.blob, size: entry.size, files: entry.files });
    plugins.push(entry);
    if (typeof onPack === "function" && entry.tgzPath) {
      try { await onPack(entry); } catch (e) { logWarn("plugin.pack.upload-failed", { name: entry.name, error: String((e && e.message) || e) }); }
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录残留不影响结果 */ }
  }
  return { plugins, stats };
}
