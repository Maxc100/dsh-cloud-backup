// lib/store/paths.js —— 运行时目录推导（不依赖宿主 API，纯 Node）

import os from "node:os";
import path from "node:path";

/** DSH 主目录：DSH_HOME > 启用了 profiles 的 cwd 推导 > ~/.dsh */
export function dshHome() {
  const env = process.env.DSH_HOME;
  if (env && env.trim()) return path.resolve(env.trim());
  const cwd = process.cwd();
  if (path.basename(cwd).toLowerCase() === ".dsh" || cwd.includes(`${path.sep}profiles${path.sep}`)) return cwd;
  return path.join(os.homedir(), ".dsh");
}

/** 本插件的数据目录：%DSH_HOME%/cloud-backup */
export function dataDir() {
  const override = process.env.DSH_CLOUD_BACKUP_HOME;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(dshHome(), "cloud-backup");
}

export function credentialsPath() { return path.join(dataDir(), "credentials.json"); }

/** 备份库目录：%DSH_HOME%/cloud-backup/store（与凭据/配置分开，便于整体搬迁或删除） */
export function storeDir() {
  const override = process.env.DSH_CLOUD_BACKUP_STORE;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(dataDir(), "store");
}
export function statePath() { return path.join(dataDir(), "state.json"); }
export function keyPath() { return path.join(dataDir(), ".key"); }

/** 原子写：同目录 .tmp-<pid>-<rand> 落盘后 rename，避免半截文件。 */
export function writeFileAtomic(file, text) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`);
  fsWriteFile(tmp, text);
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}
import fs from "node:fs";
function fsWriteFile(file, text) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, text, { encoding: "utf8", mode: 0o600 });
}
