// lib/store/secret.js —— 凭据加密（Windows DPAPI 优先，非 Windows 退化为本机密钥 AES-256-GCM）

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { keyPath } from "./paths.js";

const DPAPI_PREFIX = "dpapi:v1:";
const AES_PREFIX = "aesgcm:v1:";

/** 是否为 dpapi:v1 密文 */
export function isProtected(text) {
  return typeof text === "string" && (text.startsWith(DPAPI_PREFIX) || text.startsWith(AES_PREFIX));
}

function dpapiSupported() {
  return process.platform === "win32" && process.env.DSH_CLOUD_BACKUP_DISABLE_DPAPI !== "1";
}

// DPAPI：经 powershell.exe 调用，base64 进出避免编码问题。
// 待处理的数据走 stdin：命令行参数对本机其它进程可读（任务管理器 / WMI / EDR），
// 把明文 base64 拼进 -Command 等于把凭据暴露在进程命令行里。
function psRun(script, stdinText) {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8", windowsHide: true, timeout: 20000, input: stdinText === undefined ? undefined : String(stdinText),
  });
  if (r.error) throw new Error("powershell 启动失败: " + r.error.message);
  if (r.status !== 0) throw new Error("powershell 退出码 " + r.status + ": " + String(r.stderr || "").trim().slice(0, 300));
  return String(r.stdout || "").trim();
}

function dpapi(mode, b64) {
  const asm = "Add-Type -AssemblyName System.Security;";
  const read = "$s=[Console]::In.ReadToEnd().Trim(); $b=[Convert]::FromBase64String($s);";
  const body = mode === "protect"
    ? "$o=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'); [Convert]::ToBase64String($o)"
    : "$o=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'); [Convert]::ToBase64String($o)";
  const out = psRun(asm + " " + read + " " + body, b64);
  if (!/^[A-Za-z0-9+/=]+$/.test(out)) throw new Error("DPAPI 返回非 base64: " + out.slice(0, 120));
  return out;
}

// 兜底：AES-256-GCM
function aesKey() {
  const file = keyPath();
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, "utf8").trim();
    const key = Buffer.from(raw, "base64");
    if (key.length === 32) return key;
  }
  const key = crypto.randomBytes(32);
  const dir = path.dirname(file);      // 用 dirname 取目录：手写 lastIndexOf("\\") 在 POSIX 上会切出 "…/.ke" 这类垃圾目录
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, key.toString("base64") + "\n", { encoding: "utf8", mode: 0o600 });
  return key;
}

function aesEncrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", aesKey(), iv);
  const ct = Buffer.concat([c.update(Buffer.from(text, "utf8")), c.final()]);
  return AES_PREFIX + [iv.toString("base64"), ct.toString("base64"), c.getAuthTag().toString("base64")].join(":");
}

function aesDecrypt(payload) {
  const [ivB64, ctB64, tagB64] = payload.split(":");
  const d = crypto.createDecipheriv("aes-256-gcm", aesKey(), Buffer.from(ivB64, "base64"));
  d.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([d.update(Buffer.from(ctB64, "base64")), d.final()]).toString("utf8");
}

export function backend() { return dpapiSupported() ? "dpapi" : "aesgcm"; }

/** 加密字符串 → 带前缀的密文（可安全写文件） */
export function protect(text) {
  const s = String(text);
  if (dpapiSupported()) {
    try { return DPAPI_PREFIX + dpapi("protect", Buffer.from(s, "utf8").toString("base64")); }
    catch (e) { if (process.env.DSH_CLOUD_BACKUP_STRICT_DPAPI === "1") throw e; /* 退化为 AES */ }
  }
  return aesEncrypt(s);
}

/** 解密（自动识别前缀；明文原样返回，便于迁移旧文件） */
export function unprotect(token) {
  const s = String(token);
  if (s.startsWith(DPAPI_PREFIX)) {
    const b64 = dpapi("unprotect", s.slice(DPAPI_PREFIX.length));
    return Buffer.from(b64, "base64").toString("utf8");
  }
  if (s.startsWith(AES_PREFIX)) return aesDecrypt(s.slice(AES_PREFIX.length));
  return s;
}
