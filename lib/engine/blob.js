// lib/engine/blob.js —— 内容寻址存储（sha256）

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertHash } from "../util/validate.js";

export function blobPath(storeDir, hash) {
  assertHash(hash, "blob hash");     // hash 未校验即拼路径 → 恶意清单可越界读写
  return path.join(storeDir, "objects", "blobs", hash.slice(0, 2), hash.slice(2, 4), hash.slice(4));
}

export function sha256File(file) {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      h.update(buf.subarray(0, n));
    }
  } finally { fs.closeSync(fd); }
  return h.digest("hex");
}

/** 把一个文件纳入 blob 存储；已存在则只返回 created:false（去重命中）。 */
export function putBlob(storeDir, abs, { hash = null } = {}) {
  const h = hash || sha256File(abs);
  const dest = blobPath(storeDir, h);
  if (fs.existsSync(dest)) return { hash: h, path: dest, created: false, size: fs.statSync(dest).size };
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + ".tmp-" + process.pid + "-" + Math.random().toString(16).slice(2, 8);
  fs.copyFileSync(abs, tmp);
  const h2 = sha256File(tmp);
  if (h2 !== h) { try { fs.unlinkSync(tmp); } catch {} throw new Error("blob hash mismatch after copy: " + abs); }
  fs.renameSync(tmp, dest);
  return { hash: h, path: dest, created: true, size: fs.statSync(dest).size };
}

export function listBlobs(storeDir) {
  const root = path.join(storeDir, "objects", "blobs");
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const d1 of fs.readdirSync(root, { withFileTypes: true })) {
    if (!d1.isDirectory()) continue;
    for (const d2 of fs.readdirSync(path.join(root, d1.name), { withFileTypes: true })) {
      if (!d2.isDirectory()) continue;
      for (const f of fs.readdirSync(path.join(root, d1.name, d2.name), { withFileTypes: true })) {
        if (!f.isFile() || f.name.startsWith(".")) continue;
        const full = path.join(root, d1.name, d2.name, f.name);
        out.push({ hash: d1.name + d2.name + f.name, path: full, size: fs.statSync(full).size });
      }
    }
  }
  return out;
}

/** 删除未被任何清单引用的 blob。refSet 必须是 Set<string> 且非空（空集合 = 没有任何引用，视为误调用，拒绝执行）。 */
export function gcBlobs(storeDir, refSet, { dryRun = false } = {}) {
  if (!(refSet instanceof Set)) throw new Error("gcBlobs: refSet must be a Set");
  // 空集合必须拒绝：清单全部读不懂时若照常清理，会把所有 blob 当孤儿删掉
  if (refSet.size === 0) throw new Error("gcBlobs: 空引用集合，拒绝回收（疑似清单读取失败）");
  const all = listBlobs(storeDir);
  const del = [];
  let freed = 0;
  for (const b of all) {
    if (refSet.has(b.hash)) continue;
    del.push(b);
    freed += b.size;
    if (!dryRun) { try { fs.unlinkSync(b.path); } catch {} }
  }
  for (const b of del) {
    const d = path.dirname(b.path);
    for (const dir of [d, path.dirname(d)]) {
      try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch {}
    }
  }
  return { deleted: del.length, freed, total: all.length, dryRun };
}
