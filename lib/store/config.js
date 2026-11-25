
import fs from "node:fs";
import path from "node:path";
import { dataDir, writeFileAtomic } from "./paths.js";

export const DEFAULT_CONFIG = {
  enabled: true,
  autoUpload: true,
  intervalMinutes: 60,
  workspace: "all",              // "all" | 具体工作区目录名（sessions/ 下那一层）
  remoteFolder: "dsh-cloud-backup",
  recentKeep: 24,
  retryFailed: 3,
  dailyKeep: 7,
  weeklyKeep: 4,
  monthlyKeep: 6,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 3 * 1024 * 1024 * 1024,
  skipPlugins: false,            // true = 只备份会话与 storages
  packPlugins: true,             // true = 备份时把本地/社区插件打成 tarball 一起上云
  maxPluginPackMB: 20,           // 单个插件包上限（MB），超过则只记 spec
  maxPluginPacks: 20,            // 单次备份最多打包多少个插件
  sidebarEntry: true,            // true = 在侧栏底部显示「云盘备份」入口（设置里的入口始终保留）
  // 开放平台 App（可选）：填了才能用“浏览器 OAuth 一键授权”；留空则只用扫码/免扫码
  oauthClientId: "",
  oauthClientSecret: "",
  oauthRedirectUri: "",           // 留空 = 自动用 http://<你在访问的 Host>/api/dsh-cloud-backup/auth/oauth/callback
};

export function configPath() { return path.join(dataDir(), "config.json"); }

export function loadConfig() {
  let raw = {};
  try { if (fs.existsSync(configPath())) raw = JSON.parse(fs.readFileSync(configPath(), "utf8")) || {}; } catch { raw = {}; }
  const cfg = { ...DEFAULT_CONFIG };
  for (const k of Object.keys(DEFAULT_CONFIG)) {
    if (k in raw && raw[k] !== null && raw[k] !== undefined) cfg[k] = raw[k];
  }
  return cfg;
}

export function saveConfig(patch = {}) {
  // 只接受白名单键 + 类型与范围归一化，避免任意键值落盘
  const clean = {};
  const inRange = (v, min, max) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Math.floor(Number(v)))) : undefined);
  const BOUNDS = {
    intervalMinutes: [5, 7 * 24 * 60], recentKeep: [0, 999], dailyKeep: [0, 999], weeklyKeep: [0, 999], monthlyKeep: [0, 999],
    retryFailed: [0, 20],
    maxFileBytes: [1024, 8 * 1024 * 1024 * 1024], maxTotalBytes: [1024 * 1024, 512 * 1024 * 1024 * 1024],
    maxPluginPackMB: [1, 200], maxPluginPacks: [0, 100],
  };
  for (const k of Object.keys(DEFAULT_CONFIG)) {
    if (!(k in patch) || patch[k] === null || patch[k] === undefined) continue;
    const v = patch[k];
    const dv = DEFAULT_CONFIG[k];
    if (typeof dv === "boolean") clean[k] = v === true || v === "true";
    else if (typeof dv === "number") { const b = BOUNDS[k] || [0, Number.MAX_SAFE_INTEGER]; const n = inRange(v, b[0], b[1]); if (n === undefined) continue; clean[k] = n; }
    else clean[k] = String(v).slice(0, 200);
  }
  const next = { ...loadConfig(), ...clean };
  writeFileAtomic(configPath(), JSON.stringify(next, null, 2));
  return next;
}
