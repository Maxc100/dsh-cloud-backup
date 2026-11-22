#!/usr/bin/env node
// 发布闸门：打包前审计 npm 包；--release 时审计附件再上传。规则来自 git-publish 技能。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');

function scriptsDir() {
  if (process.env.GIT_PUBLISH_SCRIPTS) return process.env.GIT_PUBLISH_SCRIPTS;
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'skills', 'git-publish', 'scripts');
}

function auditScript(name) {
  const dir = scriptsDir();
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) {
    console.error(`发布闸门无法运行：找不到 ${p}`);
    console.error('请安装 git-publish 技能，或用 GIT_PUBLISH_SCRIPTS 指定其 scripts 目录。');
    process.exit(1);
  }
  return p;
}

function run(script, args) {
  execFileSync(process.execPath, [script, ...args], { stdio: 'inherit', cwd: pkgRoot });
}

const argv = process.argv.slice(2);

if (argv[0] === '--release') {
  const [tag, ...files] = argv.slice(1);
  if (!tag || files.length === 0) {
    console.error('用法：node scripts/publish-guard.mjs --release <tag> <文件...>');
    process.exit(2);
  }
  const missing = files.filter((f) => !fs.existsSync(f));
  if (missing.length) {
    console.error(`找不到附件：${missing.join(', ')}`);
    process.exit(2);
  }
  run(auditScript('audit-release.mjs'), files);
  execFileSync('gh', ['release', 'upload', tag, ...files, '--clobber'], {
    stdio: 'inherit',
    cwd: pkgRoot,
  });
} else {
  run(auditScript('audit-release.mjs'), ['--npm', '--cwd', pkgRoot]);
}
