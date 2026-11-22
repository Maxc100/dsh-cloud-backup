// 子进程一律 spawn + 参数数组：不把用户可控字符串拼进命令行，避免注入。
// Windows 下 .cmd/.bat 不能用 shell:false 直spawn（EINVAL），只能经 cmd.exe 转发并逐参数转义。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MAX_OUT_BYTES = 8 * 1024 * 1024;

/** 把「可执行名」解析成磁盘上真实存在的文件（补 .cmd/.exe/.bat，再沿 PATH 找）。 */
export function resolveExe(cmd) {
  const c = String(cmd || "").trim();
  if (!c) return null;
  const direct = [c, c + ".cmd", c + ".exe", c + ".bat"];
  for (const p of direct) {
    try { if (fs.existsSync(p)) return p; } catch { /* 忽略不可读候选 */ }
  }
  const seg = c.split(path.sep).pop() || c;
  if (seg) {
    // 带扩展名的可执行优先：PATH 里常有同名的无扩展脚本（nvm 的 npm），
    // 它无法被 spawn 直接执行，必须先找 .cmd/.exe/.bat。
    const exts = [".cmd", ".exe", ".bat", ""];
    for (const ext of exts) {
      for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
        if (!dir) continue;
        const full = path.join(dir, seg + ext);
        try { if (fs.existsSync(full)) return full; } catch { /* 忽略不可读候选 */ }
      }
    }
  }
  return c;
}

/** cmd.exe 安全引号：整体包双引号，内部双引号翻倍、% 翻倍。 */
function cmdQuote(arg) {
  const s = String(arg);
  if (s === "") return '""';
  // 只翻倍双引号，避免参数被引号截断。cmd.exe 对未定义变量（%VAR%）与单 % 号原样保留，
  // 翻倍 % 反而会把所有 % 写成 %%，破坏取值。已定义环境变量会被 cmd.exe 展开，
  // 属其固有行为，命令行层面无法完全规避。
  return '"' + s.replace(/"/g, '""') + '"';
}

function isShim(file) {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(String(file || ""));
}

// 参数以数组传入；返回 { ok, code, killed, timedOut, stdout, stderr, error }
export function runCmd(file, args, { cwd, timeoutMs, env } = {}) {
  return new Promise((resolve) => {
    const resolved = resolveExe(file);
    const list = (Array.isArray(args) ? args : []).map((a) => String(a));
    const shim = isShim(resolved);
    // .cmd/.bat 必须经 cmd.exe 转发（shell:false 直接 spawn 会 EINVAL）。
    // /S 会剥掉命令串最外层一对引号，所以整条命令行再包一层引号；
    // 内层每个参数各自加引号（内部 " 翻倍、% 翻倍），不会被解释成命令分隔符。
    const argv = shim
      ? [process.env.ComSpec || "cmd.exe", "/d", "/s", "/c", '"' + [cmdQuote(resolved), ...list.map(cmdQuote)].join(" ") + '"']
      : [resolved, ...list];

    const out = { ok: false, code: 1, killed: false, timedOut: false, stdout: "", stderr: "", error: null };
    const chunks = { stdout: "", stderr: "" };
    let done = false;
    const finish = (extra) => {
      if (done) return;
      done = true;
      Object.assign(out, extra);
      out.stdout = chunks.stdout;
      out.stderr = chunks.stderr;
      resolve(out);
    };

    let child = null;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        shell: false,
        env,
        windowsVerbatimArguments: shim,
      });
    } catch (e) {
      finish({ error: String((e && e.message) || e) });
      return;
    }
    if (child.error) {
      finish({ error: String((child.error && child.error.message) || child.error) });
      return;
    }
    if (child.stdout) child.stdout.on("data", (d) => { if (chunks.stdout.length < MAX_OUT_BYTES) chunks.stdout += String(d); });
    if (child.stderr) child.stderr.on("data", (d) => { if (chunks.stderr.length < MAX_OUT_BYTES) chunks.stderr += String(d); });
    child.on("error", (e) => { finish({ error: String((e && e.message) || e) }); });
    child.on("close", (code, signal) => {
      const killed = !!signal;
      finish({
        ok: code === 0,
        code: typeof code === "number" ? code : 1,
        killed,
        timedOut: !!(killed && timeoutMs),
        error: code === 0 ? null : (killed ? "命令被终止（" + String(signal || "signal") + "）" : "退出码 " + String(code)),
      });
    });
  });
}
