import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCmd } from "../util/proc.js";
import { blobPath } from "./blob.js";
import { logInfo, logWarn } from "../util/log.js";
import { fileURLToPath } from "node:url";

/** 本插件自身：还原时不需要（也不应该）用 CLI 重装，只要保证 profile 里指向本体的链接可用。 */
const SELF_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SELF_NAME = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(SELF_DIR, "package.json"), "utf8")).name || ""; } catch { return ""; }
})();

// 还原插件本体：把备份里的 tarball 或来源说明交回 dsh CLI 安装。
// 默认不执行包内的 postinstall（--ignore-scripts）；安装失败要能退回原清单，避免把 profile 弄坏。
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
// pnpm 11 的供应链策略（minimumReleaseAge）会在锁文件校验阶段拦下“刚发布”的版本。
// 快照清单里的版本是用户自己备份时的既成事实，按精确版本放行一次，并把放行记录回写进安装结果。
const AGE_MARKER = "ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION";

/** 从报错里挑出被拦下的 精确 name@version（含本次要装的条目本身）。 */
export function ageBlockedPins(entry, output) {
  const out = [];
  const name = String((entry && entry.name) || "");
  const ver = String((entry && entry.version) || "");
  if (name && ver && ver !== "unknown") out.push(name + "@" + ver);
  const src = String(output || "");
  const at = src.indexOf(AGE_MARKER);
  const block = at >= 0 ? src.slice(at, at + 4000) : src;
  const re = /(?:^|[\s"'\[(])((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)@(\d+\.\d+\.\d+(?:-[\w.-]+)?)/gi;
  let m = null;
  while ((m = re.exec(block))) {
    const pin = m[1] + "@" + m[2];
    if (out.indexOf(pin) < 0) out.push(pin);
    if (out.length >= 12) break;
  }
  return out;
}

/** 把精确版本写进 profile 的 pnpm-workspace.yaml → minimumReleaseAgeExclude（幂等，保留原有条目）。 */
export function addReleaseAgeExclude(profileDir, pins) {
  const list = (Array.isArray(pins) ? pins : []).map((x) => String(x)).filter(Boolean);
  const file = path.join(profileDir, "pnpm-workspace.yaml");
  const res = { file, added: [], existing: [] };
  if (!list.length) return res;
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { text = ""; }
  const eol = text.indexOf("\r\n") >= 0 ? "\r\n" : "\n";
  const lines = text.length ? text.split(/\r?\n/) : [];
  const key = lines.findIndex((y) => /^minimumReleaseAgeExclude\s*:/.test(y));
  const kept = [];
  if (key >= 0) {
    for (let i = key + 1; i < lines.length; i++) {
      const y = lines[i];
      if (!y.trim()) continue;
      if (/^\s*-/.test(y)) { kept.push(y.replace(/^\s*-\s*/, "").replace(/^['"]|['"]$/g, "").trim()); continue; }
      break;
    }
  }
  res.existing = kept.slice();
  for (const pin of list) if (kept.indexOf(pin) < 0) { kept.push(pin); res.added.push(pin); }
  if (!res.added.length) return res;
  const block = ["minimumReleaseAgeExclude:"].concat(kept.map((x) => "  - '" + x + "'"));
  let out;
  if (key >= 0) {
    let end = key + 1;
    for (let i = key + 1; i < lines.length; i++) {
      const y = lines[i];
      if (!y.trim()) { end = i + 1; continue; }
      if (/^\s*-/.test(y)) { end = i + 1; continue; }
      break;
    }
    out = lines.slice(0, key).concat(block, lines.slice(end));
  } else {
    out = lines.slice();
    while (out.length && !out[out.length - 1].trim()) out.pop();
    out = out.concat(block);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  try { fs.writeFileSync(file, out.join(eol) + eol); } catch (e) { res.added = []; res.error = String((e && e.message) || e); }
  return res;
}


// dsh CLI 不在 PATH 上是常态（桌面版自带一份），且用户目录可能不在系统盘，
// 因此按「显式路径 → 环境变量 → 运行时相对路径 → 已知安装位置（含跨盘探测）」依次找。
function cliCandidates(explicit) {
  const rel = ["Programs", "DeepSeek Harness", "resources", "runtime", "cli", "bin", "dsh.cmd"];
  const roots = [];
  const local = process.env.LOCALAPPDATA;
  const home = os.homedir();
  if (local) roots.push(local);
  if (home) roots.push(path.join(home, "AppData", "Local"));
  const user = path.basename(home || "");
  if (user && process.platform === "win32") {
    for (const d of "CDEFGHIJKLMNOPQRSTUVWXYZ") roots.push(d + ":/Users/" + user + "/AppData/Local");
  }
  const out = [explicit, process.env.DSH_CLOUD_BACKUP_DSH_CMD, process.env.DSH_BIN];
  const exe = process.execPath || "";
  const marker = exe.indexOf("DeepSeek Harness");
  if (marker > 0) out.push(path.join(exe.slice(0, marker), "DeepSeek Harness", ...rel));
  for (const r of roots) out.push(path.join(r, ...rel));
  return out.filter(Boolean);
}

export function localPluginsDir(dshHome) {
  return path.join(dshHome, "cloud-backup", "local-plugins");
}

export function resolveDshCmd(explicit = null) {
  for (const c of cliCandidates(explicit)) {
    try {
      if (fs.existsSync(c)) return { ok: true, cmd: c, via: "abs" };
    } catch { /* 忽略不可读候选 */ }
  }
  return { ok: true, cmd: "dsh", via: "path" };
}
export function addTargetFor(entry, tgzPath = null) {
  const name = String(entry.name || "");
  if (tgzPath) return { via: "tarball", target: tgzPath };
  const spec = String(entry.spec || "");
  const version = String(entry.version || "");
  if (entry.source_kind === "registry") {
    if (version && version !== "unknown") return { via: "spec", target: name + "@" + version };
    return { via: "spec", target: name };
  }
  // github:/https:/file: 之类的来源原样交给 pnpm，避免改写后指向不存在的版本
  return { via: "spec", target: spec || name };
}

// 只对 tarball 生效：把内容寻址的块复制成 CLI 能吃的文件。
// 必须落在稳定目录：profile 的 package.json 会记住这个路径，临时目录被清掉会让后续 pnpm 安装失败。
function materialize(storeDir, blob, name, version, keepDir, tmpDir) {
  const src = blobPath(storeDir, blob);
  if (!fs.existsSync(src)) return { ok: false, error: "blob 不在本地（先下载该快照）" };
  const safe = String(name).replace(/[^a-zA-Z0-9._@-]+/g, "-");
  // 文件名带内容前缀：块内容变了就是新文件，pnpm 不会拿旧 lockfile 的校验和来比对新内容
  const fileName = safe + "-" + String(version || "0") + "-" + String(blob).slice(0, 8) + ".tgz";
  try {
    fs.mkdirSync(keepDir, { recursive: true });
    const kept = path.join(keepDir, fileName);
    if (!fs.existsSync(kept)) fs.copyFileSync(src, kept);
    return { ok: true, path: kept, kept: true };
  } catch {
    const out = path.join(tmpDir, fileName);
    fs.copyFileSync(src, out);
    return { ok: true, path: out, kept: false };
  }
}

// profile 的 bundles 里若留着「已经不在 node_modules」的插件，宿主会拒绝再装任何插件
// 装之前先摘掉失效条目（否则报 cannot resolve profile bundle），运行时的 @deepseek-ai/* 保留。
function sanitizeBundles(dshHome, profiles, log) {
  const dropped = [];
  for (const p of profiles || []) {
    const pkgPath = path.join(dshHome, "profiles", String(p), "package.json");
    let pkg = null;
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")); } catch { continue; }
    const list = pkg && pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles;
    if (!Array.isArray(list) || !list.length) continue;
    const nm = path.join(dshHome, "profiles", String(p), "node_modules");
    const keep = list.filter(function (name) {
      const n = String(name);
      if (n.indexOf("@deepseek-ai/") === 0) return true;
      return fs.existsSync(path.join(nm, n, "package.json"));
    });
    if (keep.length === list.length) continue;
    pkg.dsh.profile.bundles = keep;
    try { fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + String.fromCharCode(10)); } catch { continue; }
    for (const name of list) if (keep.indexOf(name) < 0) dropped.push(String(p) + "/" + String(name));
  }
  if (dropped.length && typeof log === "function") log({ phase: "cleanup", dropped });
  return dropped;
}

// 装回成功后把插件名补回 profile 的 dsh.profile.bundles，保证宿主重启时能加载它们
function restoreBundles(dshHome, installed, log) {
  const added = [];
  for (const rec of installed || []) {
    const name = String(rec.name);
    const p = String(rec.profile || "");
    if (!p) continue;
    const pkgPath = path.join(dshHome, "profiles", p, "package.json");
    let pkg = null;
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")); } catch { continue; }
    if (!pkg.dsh || !pkg.dsh.profile) continue;
    const list = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
    if (list.indexOf(name) >= 0) continue;
    if (!fs.existsSync(path.join(dshHome, "profiles", p, "node_modules", name, "package.json"))) continue;
    pkg.dsh.profile.bundles = list.concat([name]);
    try { fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + String.fromCharCode(10)); added.push(p + "/" + name); } catch { /* 写不回就保持原样 */ }
  }
  if (added.length && typeof log === "function") log({ phase: "bundles-restored", added });
  return added;
}

function snapshotManifests(dshHome, profiles) {
  const saved = {};
  for (const p of profiles) {
    const dir = path.join(dshHome, "profiles", p);
    for (const f of ["package.json", "pnpm-lock.yaml"]) {
      const abs = path.join(dir, f);
      try {
        saved[p + "/" + f] = fs.existsSync(abs) ? fs.readFileSync(abs) : null;
      } catch { saved[p + "/" + f] = null; }
    }
  }
  return saved;
}

function rollbackManifests(dshHome, saved) {
  const undone = [];
  for (const key of Object.keys(saved)) {
    const abs = path.join(dshHome, "profiles", key);
    const buf = saved[key];
    try {
      if (buf === null) { if (fs.existsSync(abs)) fs.unlinkSync(abs); }
      else fs.writeFileSync(abs, buf);
      undone.push(key);
    } catch (e) { logWarn("plugin.install.rollback-failed", { file: key, error: String((e && e.message) || e) }); }
  }
  return undone;
}

export async function installPluginPacks({
  dshHome,
  storeDir,
  plugins = [],
  profiles = null,
  allowScripts = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cliPath = null,
  dryRun = false,
  onLog = null,
} = {}) {
  const list = Array.isArray(plugins) ? plugins.filter((x) => x && x.name) : [];
  const wanted = Array.isArray(profiles) && profiles.length ? new Set(profiles.map(String)) : null;
  const cli = resolveDshCmd(cliPath);
  const log = typeof onLog === "function" ? onLog : () => {};
  const out = { ok: true, cli, via: {}, installed: [], skipped: [], failed: [], rollback: null, depsOk: true };

  if (!list.length) { out.ok = false; out.error = "清单里没有 plugins 记录"; return out; }
  if (!dryRun && !cli.ok) { out.ok = false; out.error = cli.error; return out; }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dshcb-plugin-"));
  const targetProfiles = [];
  for (const e of list) for (const p of (e.profiles || [])) if (!wanted || wanted.has(String(p))) if (targetProfiles.indexOf(p) < 0) targetProfiles.push(p);
  const saved = dryRun ? {} : snapshotManifests(dshHome, targetProfiles);

  try {
    const droppedBundles = sanitizeBundles(dshHome, Array.from(wanted || []), log);
    for (const entry of list) {
      const name = String(entry.name);
      const profs = (entry.profiles || []).filter((p) => !wanted || wanted.has(String(p)));
      if (!profs.length) { out.skipped.push({ name, reason: "profile-not-in-scope" }); continue; }

      // 自身插件：装自己会把它变成指向 .pnpm 的断链（原本是 link: 到工作区），故只重建链接、不走 CLI
      if (SELF_NAME && name === SELF_NAME) {
        const rec = { name, profile: profs[0], via: "self", target: SELF_DIR, ok: true, seconds: 0, error: null, output: null };
        try {
          for (const p2 of profs) {
            const nm = path.join(dshHome, "profiles", p2, "node_modules");
            fs.mkdirSync(nm, { recursive: true });
            const dst = path.join(nm, name);
            let good = false;
            try { good = !!fs.realpathSync(dst) && fs.existsSync(path.join(dst, "package.json")); } catch { good = false; }
            if (!good) {
              try { fs.rmSync(dst, { recursive: true, force: true }); } catch { /* 断链删不掉就继续建 */ }
              fs.symlinkSync(SELF_DIR, dst, "junction");
            }
            if (!fs.existsSync(path.join(dst, "package.json"))) rec.ok = false;
          }
        } catch (e) { rec.ok = false; rec.error = "无法恢复自身链接：" + String((e && e.message) || e); }
        if (rec.ok) { out.installed.push(rec); log({ phase: "self", name, profile: rec.profile }); }
        else { out.failed.push(rec); out.depsOk = false; log({ phase: "failed", name, profile: rec.profile, error: rec.error }); }
        logInfo("plugin.install." + (rec.ok ? "done" : "failed"), { name, profile: rec.profile, via: "self", error: rec.error || "" });
        continue;
      }

      let prep = { ok: true, path: null };
      if (entry.state === "packed" && entry.blob) prep = materialize(storeDir, entry.blob, name, entry.version, path.join(dshHome, "cloud-backup", "local-plugins"), tmpDir);
      if (!prep.ok && /^file:/i.test(String(entry.spec || ""))) {
        out.skipped.push({ name, reason: prep.error, fallback: null });
        continue;   // 条目来源就是本机 tarball，包没了重试也没意义
      }
      const { via, target } = prep.ok && prep.path ? addTargetFor(entry, prep.path) : addTargetFor(entry, null);
      if (!prep.ok) out.skipped.push({ name, reason: prep.error, fallback: "spec" });
      // 来源是本机 tarball（例如上次安装写进 package.json 的 file: 路径）但文件已经不在了：跳过，别硬装
      if (via === "spec" && /^file:/i.test(String(target || ""))) {
        const p = String(target).replace(/^file:/i, "");
        if (!fs.existsSync(p)) { out.skipped.push({ name, reason: "本机没有这个 tarball（来源已失效）", fallback: null }); continue; }
      }

      for (const p of profs) {
        // 参数数组直传：profile 名与包名/spec 里的引号、&、&& 都只是普通参数，不会被 cmd.exe 解释
        const args = ["plugin", "--profile", p, "add"];
        if (!allowScripts) args.push("--ignore-scripts");
        args.push(target);
        if (dryRun) { out.installed.push({ name, profile: p, via, target, dryRun: true }); continue; }
        log({ phase: "start", name, profile: p, via });
        const cmdEnv = { ...process.env, DSH_HOME: dshHome, CI: "true", ...(allowScripts ? {} : { npm_config_ignore_scripts: "true" }) };
        const installedAt = path.join(dshHome, "profiles", p, "node_modules", name, "package.json");
        const attempt = function (r) {
          const present = fs.existsSync(installedAt);
          const rec = {
            name, profile: p, via, target,
            ok: r.ok && present,
            seconds: null,
            error: r.ok ? (present ? null : "安装后未在 node_modules 找到该插件") : (r.timedOut ? "命令超时（" + Math.round(timeoutMs / 1000) + "s）" : r.error),
            output: (r.stdout + "\n" + r.stderr).trim().split("\n").slice(-3).join(" | ").slice(0, 300) || null,
          };
          if (!rec.ok) rec.detail = pnpmDiagnostics((r.stdout || "") + "\n" + (r.stderr || ""));
          return rec;
        };
        let r = await runCmd(cli.cmd, args, { cwd: dshHome, env: cmdEnv, timeoutMs });
        let rec = attempt(r);
        // 被供应链年龄策略拦下：按精确版本放行一次再重试（版本来自用户自己的快照清单）
        if (!rec.ok && ((r.stdout || "") + "\n" + (r.stderr || "")).indexOf(AGE_MARKER) >= 0) {
          const raw = (r.stdout || "") + "\n" + (r.stderr || "");
          const applied = addReleaseAgeExclude(path.join(dshHome, "profiles", p), ageBlockedPins(entry, raw));
          if (applied.added.length) {
            logWarn("plugin.install.ageExclude", { name, profile: p, pins: applied.added });
            log({ phase: "retry", name, profile: p, via, reason: "minimumReleaseAge" });
            r = await runCmd(cli.cmd, args, { cwd: dshHome, env: cmdEnv, timeoutMs });
            rec = attempt(r);
            rec.ageExcluded = applied.added;
          }
        }
        if (rec.ok) { out.installed.push(rec); log({ phase: "done", name, profile: p, via }); }
        else { out.failed.push(rec); out.depsOk = false; log({ phase: "failed", name, profile: p, via, error: rec.error }); }
        logInfo("plugin.install." + (rec.ok ? "done" : "failed"), { name, profile: p, via, error: rec.error || "", detail: rec.detail || "" });
      }
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结论 */ }
  }

  // 装成功后把本次装上的插件补回 profile 的 bundles（装前为过 bundle 校验临时摘掉过）
  if (!dryRun && out.installed.length) restoreBundles(dshHome, out.installed, log);

  if (!dryRun && out.failed.length) {
    out.rollback = rollbackManifests(dshHome, saved);
    logWarn("plugin.install.rollback", { files: out.rollback.length, failed: out.failed.length });
  }
  out.ok = out.failed.length === 0;
  return out;
}

/** 插件 CLI 失败时把「真正的原因」抠出来：先看它自己的输出，再看它指出的诊断日志；都没有就给日志路径。 */
export function pnpmDiagnostics(text) {
  const src = String(text || "");
  const rows = (x) => x.split(/\r?\n/).map((y) => y.trim()).filter(Boolean);
  const strong = (x) => x.filter((y) => /ERR_PNPM|ERR_|EACCES|ENOENT|not match|integrity|404/i.test(y));
  const weak = (x) => x.filter((y) => !/^Command failed with exit code/i.test(y) && /error|failed/i.test(y));
  const fmt = (x) => x.slice(-2).join(" | ").slice(0, 300);

  const named = (x) => x.filter((y) => /ERR_PNPM/i.test(y));
  // 年龄策略会把「哪些条目被拦」列在后面几行，一并留下，否则事后无从追查
  const ageBlock = function (list) {
    const i = list.findIndex(function (y) { return y.indexOf(AGE_MARKER) >= 0; });
    return i < 0 ? null : list.slice(i, i + 5).join(" | ").slice(0, 300);
  };
  const fromOut = named(rows(src));
  if (fromOut.length) return ageBlock(rows(src)) || fromOut[0].slice(0, 300);
  const fromStrong = strong(rows(src));
  if (fromStrong.length) return fmt(fromStrong);

  const m = /([A-Za-z]:[^\s"']*?\.log)/.exec(src);
  if (m) {
    try {
      const lines = rows(fs.readFileSync(m[1], "utf8"));
      const st = named(lines);
      if (st.length) return st[0].slice(0, 300);
      const st2 = strong(lines);
      if (st2.length) return fmt(st2);
      const wk = weak(lines);
      if (wk.length) return fmt(wk);
      return ("pnpm 退出码非 0；诊断日志：" + m[1]).slice(0, 300);
    } catch { return ("pnpm 退出码非 0；诊断日志：" + m[1]).slice(0, 300); }
  }
  const w = weak(rows(src));
  return w.length ? fmt(w) : null;
}

/** 生成「插件还原提示词」：给没装本插件的机器上的 agent 用；纯文本、不含凭据。 */
export function buildRestorePrompt({ stamp, plugins = [], profiles = [], tarballDir = "", dshHome = "", fromProfile = null, toProfile = null } = {}) {
  const list = (plugins || []).filter((p) => p && p.name);
  const packed = list.filter((p) => p.state === "packed");
  const others = list.filter((p) => p.state !== "packed");
  const profs = (profiles && profiles.length
    ? profiles
    : [...new Set(list.flatMap((p) => p.profiles || []))]).join(", ") || "(未知)";
  let HOME = String(dshHome || "").split("\\").join("/");
  while (HOME.length > 1 && HOME.slice(-1) === "/") HOME = HOME.slice(0, -1);
  const port = function (p) {
    let s = String(p || "").split("\\").join("/");
    while (s.length > 1 && s.slice(-1) === "/") s = s.slice(0, -1);
    if (!s) return "<DSH_HOME>";
    if (HOME && s.toLowerCase().indexOf(HOME.toLowerCase()) === 0) return "<DSH_HOME>" + s.slice(HOME.length);
    return s;
  };
  if (!list.length) {
    return "该快照（" + String(stamp || "") + "）里没有记录插件包，无需按插件步骤还原；"
      + "它只包含配置与数据，直接按快照还原即可。";
  }
  const L = [];
  L.push("请把 DSH 快照 " + String(stamp || "") + " 里的插件装回这台机器（务必不要执行包内的 install/postinstall 脚本）。");
  L.push("");
  L.push("背景：这是 DSH（DeepSeek Harness）的配置快照，插件本体已随快照上传并按内容寻址存放；涉及 profile：" + profs + "。");
  if (fromProfile && toProfile && fromProfile !== toProfile) {
    L.push("注意：该快照来自 profile \"" + fromProfile + "\"，当前环境是 \"" + toProfile + "\"；下面的 --profile 请填你要装回的目标 profile。");
  }
  L.push("");
  let step = 0;
  if (packed.length) {
    step++;
    L.push(step + ") 取回插件包：快照目录下的 blobs/<hash> 就是该插件包（gzip tar）。");
    for (const p of packed) {
      const h = String(p.blob || "?");
      L.push("   - " + p.name + "@" + (p.version || "?") + "  blob=" + h.slice(0, 16) + "  → 另存为 " + p.name + "-" + (p.version || "0") + ".tgz");
    }
    if (tarballDir) L.push("   （若本机装了 cloud-backup 插件，包已在：" + port(tarballDir) + "）");
  }
  if (others.length) {
    step++;
    L.push(step + ") 以下条目未打包，直接用来源重装：");
    for (const p of others) L.push("   - " + p.name + "@" + (p.version || "?") + "  来源：" + (p.spec || p.via || "(未知)"));
  }
  step++;
  L.push(step + ") 安装命令（逐条执行，tarball 一律带 --ignore-scripts）：");
  const tgt = toProfile || "<profile>";
  for (const p of packed) L.push('   dsh plugin --profile ' + tgt + ' add --ignore-scripts "<绝对路径>/' + p.name + "-" + (p.version || "0") + '.tgz"');
  for (const p of others) L.push('   dsh plugin --profile ' + tgt + ' add "' + (p.spec || p.name) + '"');
  step++;
  L.push(step + ") 校验：<DSH_HOME>/profiles/<profile>/node_modules/<name>/package.json 必须存在，版本与上面一致。");
  step++;
  L.push(step + ") 任一条失败就停下并保留报错原文，不要静默跳过。");
  L.push("");
  L.push("注意：<DSH_HOME> 指本机 DSH 主目录（Windows 默认 C:/Users/<你的用户名>/.dsh）；路径一律用绝对路径；不要改动快照里的 storages/ 与 sessions/ 数据。");
  return L.join(String.fromCharCode(10));
}
