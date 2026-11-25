// 自重启：交给脱离进程的助手脚本先等端口释放、再拉起新宿主并确认应答；Windows 需 -WindowStyle Hidden 包一层。
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const INSPECT_FLAG = /^--inspect(-brk|-port|-wait)?(=|$)/;
const HELPER_NAME = "restart-helper.mjs";

// 助手源码：避免模板插值，全部用字符串拼接
const HELPER_SOURCE = [
  'import fs from "node:fs";',
  'import net from "node:net";',
  'import http from "node:http";',
  'import { spawn } from "node:child_process";',
  "",
  "const cfg = JSON.parse(fs.readFileSync(process.argv[2], \"utf8\"));",
  "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));",
  "function note(line) {",
  "  try { fs.appendFileSync(cfg.logFile, new Date().toISOString() + \" \" + line + \"\\n\"); } catch (e) { /* 日志写不进去不影响重启 */ }",
  "}",
  "function portBusy(port) {",
  "  return new Promise((resolve) => {",
  "    const s = net.connect({ host: \"127.0.0.1\", port: port });",
  "    let done = false;",
  "    const fin = (v) => { if (done) return; done = true; try { s.destroy(); } catch (e) {} resolve(v); };",
  "    s.once(\"connect\", () => fin(true));",
  "    s.once(\"error\", () => fin(false));",
  "    s.setTimeout(500, () => fin(false));",
  "  });",
  "}",
  "function ready(port) {",
  "  return new Promise((resolve) => {",
  "    const req = http.get({ host: \"127.0.0.1\", port: port, path: \"/\", timeout: 1500 }, (res) => { res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 500); });",
  "    req.on(\"error\", () => resolve(false));",
  "    req.on(\"timeout\", () => { req.destroy(); resolve(false); });",
  "  });",
  "}",
  "(async function () {",
  "  let freed = false;",
  "  for (let i = 0; i < 160; i++) { if (!(await portBusy(cfg.port))) { freed = true; break; } await sleep(250); }",
  "  note(\"old host released port=\" + cfg.port + \" freed=\" + String(freed));",
  "  const child = spawn(cfg.spawn.file, cfg.spawn.args, { cwd: cfg.cwd || undefined, env: process.env, detached: !!cfg.spawn.detached, windowsHide: true, stdio: \"ignore\", shell: false });",
  "  child.on(\"error\", (e) => note(\"spawn failed: \" + ((e && e.message) || String(e))));",
  "  note(\"spawned pid=\" + String(child.pid) + \" file=\" + cfg.spawn.file);",
  "  let up = false;",
  "  for (let i = 0; i < 120; i++) { if (await ready(cfg.port)) { up = true; break; } await sleep(500); }",
  "  note(up ? \"host is serving again on port=\" + cfg.port : \"host did not answer on port=\" + cfg.port);",
  "  process.exit(up ? 0 : 1);",
  "})().catch((e) => { note(\"helper failed: \" + ((e && e.message) || String(e))); });",
  "",
].join("\n");

/** 运行本进程的 node：argv0 是绝对路径且存在时就用它，否则退回 execPath。 */
export function nodeExecutable(argv0 = process.argv0, execPath = process.execPath) {
  if (typeof argv0 === "string" && argv0 && path.isAbsolute(argv0) && fs.existsSync(argv0)) return argv0;
  return execPath;
}

/** 自重启的前置否决：返回原因字符串即拒绝，返回 null 表示可以重启。 */
export function restartRefusal(env = process.env, execArgv = process.execArgv, argv = process.argv) {
  if (String((env && env.DSH_CLOUD_BACKUP_NO_RESTART) || "") === "1") return "已用 DSH_CLOUD_BACKUP_NO_RESTART=1 关闭自重启";
  const all = (execArgv || []).concat(argv || []);
  for (const a of all) if (INSPECT_FLAG.test(String(a))) return "宿主处于调试模式（--inspect），自重启被拒绝";
  return null;
}

/** 复现宿主的启动方式：入口是 CLI 时用 node 把同一入口拉起；入口不认识时退回 PATH 上的 dsh（Windows 上是 .cmd，只能交给 shell）。 */
export function launchSpec(argv1 = process.argv[1], execArgv = process.execArgv, extraArgs = process.argv.slice(2), platform = process.platform) {
  const asString = typeof argv1 === "string" ? argv1 : "";
  const desktopCli = /[\\/]node_modules[\\/]@deepseek-ai[\\/]dsh-desktop-host[\\/]lib[\\/]cli\.js$/.test(asString);
  if (asString && (desktopCli || /[\\/](?:bin\.(?:js|ts)|dsh)$/.test(asString))) {
    const abs = path.resolve(asString);
    // 源码启动会传相对入口，子进程按自己的 cwd 解析会 MODULE_NOT_FOUND，所以一律用绝对路径；
    // 入口在 app.asar 里时 Electron 能读、操作系统不能 chdir，故桌面形态不给 cwd。
    return { kind: "cli", file: nodeExecutable(), args: [...(execArgv || []), abs, ...(extraArgs || [])], cwd: desktopCli ? undefined : path.dirname(abs), viaShell: false };
  }
  return { kind: "path", file: "dsh", args: [...(extraArgs || [])], cwd: undefined, viaShell: platform === "win32" };
}

/** 把启动方案整理成可判定的计划：能不能找到入口，先看清楚再决定要不要杀进程。 */
export function describeLaunch(spec, platform = process.platform, env = process.env) {
  if (!spec) return null;
  let resolvable = false;
  if (!spec.viaShell) {
    try { resolvable = fs.existsSync(spec.file); } catch { resolvable = false; }
  } else {
    const names = platform === "win32" ? ["dsh.cmd", "dsh.bat", "dsh.exe"] : ["dsh"];
    const dirs = String((env && env.PATH) || "").split(path.delimiter).filter(Boolean);
    resolvable = dirs.some((d) => names.some((n) => { try { return fs.existsSync(path.join(d, n)); } catch { return false; } }));
  }
  return { kind: spec.kind, file: spec.file, args: spec.args, cwd: spec.cwd || null, viaShell: !!spec.viaShell, resolvable };
}

/** 平台正确的拉起方式（Windows 包一层隐藏 PowerShell）。 */
export function respawnInvocation(spec, platform = process.platform) {
  if (!spec) return null;
  if (platform !== "win32") return { file: spec.file, args: spec.args, detached: true, viaShell: !!spec.viaShell };
  // PowerShell 单引号只需转义内层单引号；显式点名 .cmd，避免被优先选中的 .ps1 撞上执行策略
  const quote = (part) => "'" + String(part).replace(/'/g, "''") + "'";
  const file = spec.viaShell && !/\.(?:cmd|bat)$/iu.test(spec.file) ? spec.file + ".cmd" : spec.file;
  return {
    file: "powershell.exe",
    args: ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ["& " + quote(file)].concat((spec.args || []).map(quote)).join(" ")],
    detached: false,
    viaShell: false,
  };
}

/** 当前服务的端口：优先取连接本端端口，其次解析 Host 头。 */
export function servingPort(req) {
  try {
    const local = req && req.socket && req.socket.localPort;
    if (Number.isFinite(local) && local > 0) return Number(local);
  } catch { /* 落到 Host 头 */ }
  const host = String((req && req.headers && (req.headers.host || req.headers.HOST)) || "");
  const m = /:(\d{2,5})\s*$/.exec(host);
  return m ? Number(m[1]) : null;
}

/** Electron 里的 execPath 是应用本身，助手要当纯 node 跑，必须显式降级。 */
function helperEnv(env = process.env, versions = process.versions) {
  const out = { ...env };
  if (versions && versions.electron) out.ELECTRON_RUN_AS_NODE = "1";
  return out;
}

export function helperPath(logDir) {
  return path.join(logDir, HELPER_NAME);
}

/** 写出助手脚本；内容随源码更新，文件已存在且一致时不再写盘。 */
export function ensureHelper(logDir) {
  const file = helperPath(logDir);
  try {
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    let current = null;
    try { current = fs.readFileSync(file, "utf8"); } catch { current = null; }
    if (current !== HELPER_SOURCE) fs.writeFileSync(file, HELPER_SOURCE, "utf8");
    return file;
  } catch { return null; }
}

/** 交给助手重启，并在延迟后结束本进程；计划先落盘，拉起失败也能从日志看出它尝试了什么。 */
export function scheduleRestart({ spec, port, logDir, delayMs = 600, platform = process.platform, logFile = null }) {
  const helper = ensureHelper(logDir);
  if (!helper) return { ok: false, error: "助手脚本写不出去：" + String(logDir) };
  const spawnSpec = respawnInvocation(spec, platform);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const log = logFile || path.join(logDir, "restart-" + stamp + ".log");
  const configPath = path.join(logDir, "restart-" + stamp + ".json");
  const config = {
    port: port || null,
    spawn: spawnSpec,
    cwd: spec && spec.cwd ? spec.cwd : null,
    logFile: log,
    startedAt: new Date().toISOString(),
    atPid: process.pid,
  };
  try { fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8"); } catch (e) {
    return { ok: false, error: "重启配置写不出去：" + String((e && e.message) || e) };
  }
  let child = null;
  try {
    child = spawn(nodeExecutable(), [helper, configPath], { detached: true, stdio: "ignore", env: helperEnv(), windowsHide: true });
    child.unref();
  } catch (e) {
    return { ok: false, error: "助手启动失败：" + String((e && e.message) || e), configPath, logFile: log };
  }
  const timer = setTimeout(() => { try { process.kill(process.pid, "SIGTERM"); } catch { /* 退出失败只能人工关掉宿主 */ } }, delayMs);
  if (timer.unref) timer.unref();
  return { ok: true, helperPid: child.pid, configPath, logFile: log, spawn: spawnSpec, delayMs };
}
