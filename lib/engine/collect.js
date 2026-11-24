// lib/engine/collect.js —— 决定"备份什么"，只读、不改源文件

import fs from "node:fs";
import path from "node:path";

export const PROFILE_FILES = ["package.json", "cordis.patch.yml", "cordis.yml", "pnpm-lock.yaml"];
export const ROOT_FILES = ["AGENTS.md", "prompt-inject.md", "composer-predict.json"];
export const PLUGIN_STATE_DIRS = [
  ["our-free-model", /\.json$/i],
  ["dsh-market", /\.json$/i],
  ["dsh-purge-community", /\.json$/i],
  ["dsh-ops", /\.json$/i],
];

/**
 */
export const PLUGIN_STATE_DENY = new Set([
  "profiles", "sessions", "storages", "cache", "attachments", "logs", "skills", "skills-disabled",
  "cloud-backup", "dsh-runtimes", "rea-mcp", "ghidra", "dist", "data", "node_modules",
  ".keys", ".git", ".cache", ".dsh", ".tmp",
]);

/** 名字像凭据的 json 不收（别把 token/账号类文件送到云盘）；按「词段」匹配，避免误伤 printed-build-keys.json。 */
export const PLUGIN_STATE_SKIP = /(^|[._-])(tokens?|credentials?|secrets?|passwords?|passwd|cookies?|sessions?|licen[cs]es?|accounts?|auth)([._-]|\d|$)/i;

/** 自动发现目录的上限：文件数 / 累计字节，超了就跳过（宁缺勿滥）。 */
export const PLUGIN_STATE_LIMIT = { files: 40, bytes: 4 * 1024 * 1024 };

const HARD_EXCLUDE = [
  /(^|[\\/])node_modules([\\/]|$)/i,
  /(^|[\\/])\.keys([\\/]|$)/i,
  /(^|[\\/])\.run-lock$/,
  /\.tmp-\d+/,
  /\.bak[-.]/i,
  /\.log$/i,
  /(^|[\\/])\.DS_Store$/,
];

function excluded(rel) { return HARD_EXCLUDE.some((re) => re.test(rel)); }

/** 相对 DSH_HOME 的 posix 路径（skipped 记录用）。 */
function relOf(root, abs) { return path.relative(root, abs).split(path.sep).join("/"); }

function statSafe(p) { try { return fs.statSync(p); } catch { return null; } }
/** 只看链接本身、不跟随：用来识别符号链接与目录联接（junction）。 */
function lstatSafe(p) { try { return fs.lstatSync(p); } catch { return null; } }

export function collectFiles({ dshHome, config = {} } = {}) {
  const maxFileBytes = config.maxFileBytes ?? 64 * 1024 * 1024;
  const maxTotalBytes = config.maxTotalBytes ?? 3 * 1024 * 1024 * 1024;
  const wsFilter = config.workspace && config.workspace !== "all" ? config.workspace : null;
  const skipPlugins = !!config.skipPlugins;

  const files = [];
  const skipped = [];
  let bytes = 0;

  const add = (abs) => {
    const rel = path.relative(dshHome, abs).split(path.sep).join("/");
    if (excluded(rel)) { skipped.push({ rel, reason: "excluded" }); return; }
    const lp = lstatSafe(abs);
    if (lp && lp.isSymbolicLink()) { skipped.push({ rel, reason: "link" }); return; }
    const st = statSafe(abs);
    if (!st || !st.isFile()) return;
    if (st.size > maxFileBytes) { skipped.push({ rel, reason: "too-large:" + st.size }); return; }
    if (bytes + st.size > maxTotalBytes) { skipped.push({ rel, reason: "quota" }); return; }
    files.push({ rel, abs, size: st.size, mtime: st.mtimeMs });
    bytes += st.size;
  };

  const walk = (dir, depth = 0) => {
    if (depth > 8) return;
    let es = [];
    try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(dir, e.name);
      // 符号链接与目录联接（junction）一律不跟随、不采集，记为 skipped，
      // 避免把链接目标（可能在 DSH_HOME 之外）的内容静默当成普通文件收进备份。
      if (e.isSymbolicLink()) { skipped.push({ rel: relOf(dshHome, p), reason: "link" }); continue; }
      if (e.isDirectory()) { if (!excluded(path.relative(dshHome, p))) walk(p, depth + 1); }
      else add(p);
    }
  };

  const sroot = path.join(dshHome, "sessions");
  for (const ws of readdirDirsLinked(sroot, skipped, dshHome)) {
    if (wsFilter && ws !== wsFilter) continue;
    walk(path.join(sroot, ws), 0);
  }

  // 2) storages（工作区列表、成本、会话投影缓存）
  walk(path.join(dshHome, "storages"), 0);

  for (const prof of readdirDirsLinked(path.join(dshHome, "profiles"), skipped, dshHome)) {
    for (const f of PROFILE_FILES) add(path.join(dshHome, "profiles", prof, f));
  }

  for (const f of ROOT_FILES) add(path.join(dshHome, f));

  // 5) 插件状态（只挑 json，别把它们的 downloads/backups 拖进来）
  if (!skipPlugins) {
    const dirs = new Map(PLUGIN_STATE_DIRS);
    // 白名单之外，再自动发现一级目录（顶层有 json 且不在 DENY 里的，视为插件状态目录）
    for (const name of readdirDirsLinked(dshHome, skipped, dshHome)) {
      if (dirs.has(name) || PLUGIN_STATE_DENY.has(name)) continue;
      const base = path.join(dshHome, name);
      if (readdirFiles(base).some((f) => /\.json$/i.test(f))) dirs.set(name, /\.json$/i);
    }
    for (const [dir, re] of dirs) {
      const base = path.join(dshHome, dir);
      const picked = readdirFiles(base).filter((f) => re.test(f)).sort();
      let pickedBytes = 0;
      const staged = [];
      for (const f of picked) {
        const abs = path.join(base, f);
        if (PLUGIN_STATE_SKIP.test(f)) { skipped.push({ rel: relOf(dshHome, abs), reason: "sensitive-name" }); continue; }
        const st = statSafe(abs);
        if (!st || !st.isFile()) continue;
        if (staged.length >= PLUGIN_STATE_LIMIT.files || pickedBytes + st.size > PLUGIN_STATE_LIMIT.bytes) {
          skipped.push({ rel: relOf(dshHome, abs), reason: "plugin-dir-limit" });
          continue;
        }
        staged.push(abs);
        pickedBytes += st.size;
      }
      for (const abs of staged) add(abs);
    }
  }

  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { files, skipped, stats: { count: files.length, bytes, skipped: skipped.length } };
}

/** 列子目录名；遇到符号链接/目录联接时记为 skipped（link），不跟随、不采集。 */
function readdirDirsLinked(dir, skipped, root) {
  try {
    const es = fs.readdirSync(dir, { withFileTypes: true });
    const dirs = [];
    for (const e of es) {
      if (e.isSymbolicLink()) { skipped.push({ rel: relOf(root, path.join(dir, e.name)), reason: "link" }); continue; }
      if (e.isDirectory()) dirs.push(e.name);
    }
    return dirs;
  } catch { return []; }
}
function readdirFiles(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name); } catch { return []; }
}
