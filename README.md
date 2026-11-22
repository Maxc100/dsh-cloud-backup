# dsh-cloud-backup

把 DSH 的**会话与配置**做**内容寻址去重**后备份到**免费云盘**（阿里云盘首发）：设置页点一下 → 扫码授权 → 之后每小时自动备份 → 需要时一键还原。

- 零外部依赖：不需要装云盘客户端、Node 用 DSH 自带的。
- 只上传去重后的数据块：内容不变的快照几乎不额外占空间。
- 凭据用 Windows DPAPI 加密存放，明文不落盘、不进日志、不上云。

## 功能一览

| 能力 | 说明 |
|---|---|
| 授权 | 设置页出二维码（本机生成）→ 手机阿里云盘 App 扫码 → 自动建云端目录；也支持「从本机客户端导入（免扫码）」 |
| 备份 | 采集 `sessions` / `storages` / `profiles/*/package.json` 等 → sha256 分块去重 → 增量上传 → 逐块校验 |
| 调度 | 每小时自动（可关）+ 手动「立即备份」 |
| 保留 | GFS 四层：近 24 份 + 日 7 + 周 4 + 月 6 |
| 恢复 | 列快照 → 预览（写哪些、覆盖哪些）→ 还原到指定目录 → 校验；可从**云端**拉缺失数据块后还原 |
| 安全 | 写盘路径强制留在目标目录内；覆盖前先留 `.bak-restore-<stamp>`；写 `DSH_HOME` 需要二次确认 |

## 界面里的目录树（中文名对照）

展开一份「快照」时，顶层目录以中文名显示，后面跟灰字原始目录名与说明：

| 目录 | 界面中文名 | 说明行 |
|---|---|---|
| `sessions/` | 会话 | 各工作区的会话记录（.jsonl） |
| `storages/` | 存储 | Harness 持久化缓存与工作区登记 |
| `profiles/` | 插件配置 | 每个 profile 的插件清单与 patch 文件 |
| `(根)` | 根文件 | AGENTS.md、prompt-inject.md 等 |

## 卡片里的三个 ⓘ 说明

| 位置 | 解释什么 |
|---|---|
| 「快照 / 块」行右侧 | 为什么云端存的是「块 / 清单 / 索引」：内容寻址去重、增量、可逐块 sha256 校验、云端目录平坦、换云只换上传层、命中同内容可秒传 |
| 「清理本地旧快照」按钮右侧 | 只删本地：删整份副本目录（含清单）+ 回收仅它引用的数据块；共用块保留；云端一个字节不动；删前确认云端有该清单，没有则跳过 |
| 「还原」区标题右侧 | 一份副本 = 那一刻整份 DSH 数据的完整拷贝，不是一个文件、也不只存变化 |

## 安装

装到桌面版 DSH 的某个 profile 上（`desktop` 是默认 profile）：

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop add dsh-cloud-backup
```

也可以直接从 GitHub 装，取仓库默认分支的最新提交：

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop add github:Maxc100/dsh-cloud-backup
```

装完**完全退出并重启桌面版 DSH**（后端路由随进程启动，不重启不生效）。
重启后：设置（Ctrl+Alt+,）→ 左侧「云盘备份」。

### 从源码调试

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop add "<本机仓库绝对路径>"
```

> 桌面版不在 `%LOCALAPPDATA%` 下时，把上面的路径换成自己的 `dsh.cmd` 绝对路径。本地路径务必用绝对路径，相对路径会被 DSH 解析错。

## 首次使用

1. 设置 → 云盘备份 → 点「连接阿里云盘」，卡片里出现二维码。
2. 手机「阿里云盘」App 扫码 → 手机上确认。
3. 卡片变成「已连接」，云端出现目录 `dsh-cloud-backup`（可在设置里改名）。
4. 点「立即备份」跑第一次全量；之后每小时自动跑（可在 `config.json` 里 `enabled: false` 关掉）。

## 恢复

| 场景 | 做法 |
|---|---|
| 误删了某个会话 | 选最近一份快照 → 预览 → 还原到默认目标，只补缺失文件（默认不覆盖） |
| 换了电脑 / 重装 | 先连接同一账号 → 「含云端」列出云端快照 → 选中 → 「从云端拉取」（把数据块下载回本地）→ 再还原 |
| 演练 | 预览 → 还原到临时目录 → 「校验」逐文件比对 sha256 |

还原到 `DSH_HOME` 本身属于破坏性操作，接口要求显式二次确认；覆盖已有文件时原文件先改名为 `.bak-restore-<stamp>`。

## 数据放在哪

- 本机状态：`%DSH_HOME%\cloud-backup\`（`credentials.json` DPAPI 密文、`config.json`、`store/` 本地数据块与快照、`state.json`）
- 云端：`<你配置的目录>/objects/blobs/<ab>/<cd>/<sha256>`、`snapshots/<stamp>/manifest.json`、`index.json`
- **上传集合是白名单**：只有 `objects/`、`snapshots/`、`index.json` 三样会上云；`.keys`、`credentials.json`、日志永远不上云。

## 接口（宿主侧，给排障用）

前缀 `/api/dsh-cloud-backup`（兼容别名 `/dsh-cloud-backup`，仅 status）。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/status` | 状态、版本、授权、上次备份、配置 |
| POST | `/auth/qr/start` | 生成扫码会话与二维码 |
| POST | `/auth/qr/poll` | 轮询扫码结果 |
| POST | `/auth/refresh` / `/auth/verify` / `/auth/logout` | 续期 / 验证 / 断开 |
| GET | `/backup/status` | 备份与审计 |
| POST | `/backup/run` | 立即备份（`{upload:false}` 只做本地） |
| POST | `/backup/config` | 改备份配置 |
| GET | `/restore/snapshots` | 列出可还原快照（`?remote=1` 附云端） |
| POST | `/restore/preview` / `/restore/run` / `/restore/verify` / `/restore/from-cloud` | 预览 / 还原 / 校验 / 从云端拉块 |
| POST | `/maintenance/cleanup` | 清云端孤儿快照目录（默认 dryRun） |

**状态码排查**：`404` = 插件没被加载（没重启、或没进 `dsh.profile.bundles`）；`401 unauthorized` = 路径不在 `/api/<ns>` 前缀下，被宿主的 `/api` 前置校验拦下。

## 目录

```
dsh-cloud-backup/
├─ package.json          exports ./client + dsh.bundle.patch + dsh.client.platform=web
├─ cordis.patch.yml      - insert: - id: dsh-cloud-backup / name: dsh-cloud-backup
├─ client.js             前端：设置页卡片（window.__ModuleLoader__ 工厂包，无需构建链）
├─ lib/
│  ├─ index.js           后端：export name / inject=["webServer"] / apply(ctx)，17 条 exact 路由
│  ├─ qr.js              二维码（矩阵 / SVG / data URL）
│  ├─ auth/aliyun.js     扫码会话、换 token、续期、建目录、业务错误归一
│  ├─ auth/adrive-local.js 免扫码：复用本机阿里云盘客户端登录态
│  ├─ store/             paths / secret(DPAPI) / credentials / state / config
│  ├─ engine/            collect / blob / manifest / rotation / run / restore / prune
│  ├─ providers/aliyun.js 云端读写：上传、列目录、拉块、回收站、孤儿清理
│  └─ vendor/qrcode-generator.cjs  自包含二维码编码器（避免外部依赖）
└─ README.md
```


## License

本项目以 GPL-3.0-or-later 发布，全文见仓库根目录 `LICENSE`。
