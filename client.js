// dsh-cloud-backup 前端：设置页「云盘备份」分区（授权 / 自动备份 / 快照列表 / 还原）。
window.__ModuleLoader__.load({
  id: "dsh-cloud-backup",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    let react = require("react");
    let react_jsx_runtime = require("react/jsx-runtime");
    // react-dom 只用于 createPortal（弹窗挂到 body，避免被卡片滚动容器裁剪）
    let react_dom = null;
    try { react_dom = require("react-dom"); } catch (e) { react_dom = null; }

    const NS = "dsh-cloud-backup";
    const API = "/api/dsh-cloud-backup";
    const POLL_MS = 2000;

    // 云端读取失败要多快才提示：登录 / 续期刚起步的几秒不打扰用户
// 能被用例用 __DSHCB_GRACE_MS 覆盖（浏览器里没有这个全局，仍是 6 秒）
const CLOUD_GRACE_MS = (function () {
  const g = (typeof globalThis !== "undefined") ? globalThis.__DSHCB_GRACE_MS : undefined;
  const v = (g === undefined || g === null) ? NaN : Number(g);
  return Number.isFinite(v) && v >= 0 ? v : 6000;
})();

// 列表上方消息层的自隐时长：纯通知（没有操作按钮）3 秒后消失，带操作的一直留到用户处理
// 能被用例用 __DSHCB_LANE_TTL_MS 覆盖
const LANE_TTL_MS = (function () {
  const g = (typeof globalThis !== "undefined") ? globalThis.__DSHCB_LANE_TTL_MS : undefined;
  const v = (g === undefined || g === null) ? NaN : Number(g);
  return Number.isFinite(v) && v >= 0 ? v : 3000;
})();

const DICT = {
      zh: {
        more: "更多",
        secAuth: "授权信息",
        secRecent: "最近备份",
        schedOffShort: "关闭",
        schedOnShort: "开启",
        schedOnLine: "自动备份已开启，",
        schedNextLine: "下次自动备份时间",
selIdNone: "尚未选择快照（点列表中的任意一份）",
listRefreshed: "列表已刷新",
recentInfoTip: "为什么每行的按钮不一样：已上传且本地有缓存 → 只有「删除」；待上传（仅本地）→「上传」把这份送到云盘；已上传但本地无缓存 →「下载」把云端那份取回本地；云端未同步 →「重试」重新读取该份状态。",
        dlgCopy: "复制",
        promptTitle: "插件还原提示词",
        promptLead: "把下面这段整段复制，粘贴给任意 agent（或用命令行自己执行）即可把插件本体装回来。",
        promptCopied: "提示词已复制到剪贴板",
        batchOp: "批量操作",
        batchCancel: "取消",
        batchCount: "已选 {n} 项 · 共 {mb}",
        batchNone: "未选择任何快照",
        batchDeleteBtn: "删除选中",
        batchTitle: "删除 {n} 份快照？",
        batchLead: "云端会移到回收站（可在阿里云盘回收站找回 30 天），本机缓存一并清除。",
        batchLast: "其中 {n} 份是云端最后一份快照（删除后云端将没有任何备份）—— 仍要继续？",
        batchDeleting: "正在删除 {i} / {n} …",
        batchDone: "已删除 {n} 份",
        batchFailStop: "第 {i} 份失败，已停止：{err}",
        selId: "已选还原文件快照ID：",
        snapWord: "快照",
        nav: "云盘备份",
        title: "云盘备份",
        subtitle: "把 DSH 会话与配置按内容去重后备份到免费云盘（阿里云盘首发）",
        loading: "读取状态中…",
        phaseLoading: "读取中",
        rowConnect: "连接状态",
        rowAccount: "账号",
        rowDrive: "云盘",
        rowFolder: "云盘目录",
        rowRefresh: "自动续期",
        renewOn: "开启",
        rowStateDir: "状态目录",
        rowCrypto: "凭据加密",
        connected: "已连接",
        notConnected: "未连接",
        connect: "连接阿里云盘",
        refresh: "刷新状态",
        verify: "验证连接",
        disconnect: "断开连接",
        busy: "处理中…",
        qrTitle: "用「阿里云盘」App 扫码",
        secLocal: "① 免扫码：从本机导入",
        qrNew: "等待扫码…",
        qrScanned: "已扫码，请在手机上点击确认",
        qrConnecting: "已确认，正在获取令牌…",
        qrFailed: "获取令牌失败",
        qrRegen: "重新生成二维码",
        qrExpireIn: "剩余",
        seconds: "秒",
        qrFail: "获取二维码失败",
        qrNote: "二维码只在本机生成与轮询；令牌由宿主加密保存，不上传云端。",
        restoreSkippedMix: "其中 {d} 个已存在但内容不同（勾选「覆盖同名文件」才会写入）",
  wsMergedNote: "工作区登记表已合并：新增 {a} 个、保留本机 {k} 个、补回会话 {j} 个",
  rgPlSkipMix: "插件跳过 {n} 个（其它 profile {s} · 本地缺包 {b}）",
  lrPlBlob: "本地缺包 {b}",
  rgPlSkip: "插件跳过 {n} 个（属于 {p}，本实例不装）",
  rgRestart: "工作区 / 会话的改动要重启 DSH 才看得到",
  lrPlSkip: "跳过插件 {n}",
  lrRestart: "需重启 DSH",
  lrHist: "还原记录",
  lrHistHide: "收起记录",
  lrHistEmpty: "还没有还原记录",
  rsRestartChip: "需要重启才生效",
  rsBusyText: "正在还原，请勿切换界面或退出",
  rsCancel: "取消",
  rsStopping: "正在停止…",
  rsCancelled: "已取消还原，已写入的文件保留",
  rsDoneText: "已还原 {s} 快照",
  rsDoneSep: "，",
  rsNeedApply: "需重启后生效",
  cacheCleanTag: "缓存已清理",
  restartNow: "立即重启",
  restarting: "重启中…",
  restartDone: "已发出重启指令，DSH 正在重启…",
  restartPort: "端口 ",
  lrHideNote: "收起这条提示",
        watchWait: "\u7b49\u5f85\u6d4f\u89c8\u5668\u767b\u5f55\u2026",
        watchCancel: "\u53d6\u6d88\u7b49\u5f85",
        watchTimeout: "\u6ca1\u7b49\u5230\u6d4f\u89c8\u5668\u767b\u5f55",
        watchDismiss: "\u53d6\u6d88",
        watchAutoDone: "\u5df2\u81ea\u52a8\u5bfc\u5165\u6d4f\u89c8\u5668\u767b\u5f55\u6001\uff0c\u8fde\u63a5\u6210\u529f",
        openBrowserLogin: "打开阿里云盘网页版登录",
        qrZoom: "放大二维码",
        qrZoomOut: "恢复大小",
        copyLink: "复制链接",
        linkCopied: "链接已复制，粘到浏览器地址栏打开即可",
        linkCopyManual: "复制未成功，请手动复制这个地址：",
        qrTry: "尝试",
        qrDiagAt: "诊断：",
        yes: "开启（到期前 10 分钟自动刷新）",
        no: "未启用",
        verified: "最近验证",
        never: "从未",
        importLocal: "从本机导入（免扫码）",
        openBrowser: "在浏览器中打开登录页",
        copyUrl: "或复制此链接到浏览器：",
        backupNow: "立即备份",
        backupRunning: "备份中…",
        rowLastBackup: "上次备份",
        backupFiles: "文件",
        backupUploaded: "已传云端",
        backupUploadFail: "上传失败",
        backupUploadSkipped: "未上传（本次跳过）",
        importHint: "若本机已安装并登录「阿里云盘」客户端，可直接点击从本机导入按钮，不必扫码；只读本机文件，令牌仍由宿主加密保存。",
        secRestore: "最近备份",
        restoreNone: "还没有快照（先做一次备份）",
  stateUploaded: "已上传",
  statePending: "待上传",
  stateFailed: "上传失败",
  stateNoSync: "云端未同步",
  listSummaryNosync: "云端暂时读不到 · 本机缓存 {n} 份",
  cloudDownTitle: "云盘暂时连不上",
  cloudDownHint: "下面显示的是上次同步成功的结果",
  cloudDownRetry: "重试",
  cloudAuthTitle: "登录已失效",
  cloudAuthHint: "重新登录云盘后可正常读取",
  cloudConfigTitle: "登录信息不完整",
  cloudConfigHint: "重新登录一次即可补齐",
  cloudRelogin: "重新登录",
  cloudCachedTag: "（上次同步的结果）",
  dlAskTitle: "这份快照只剩在云端",
  dlAskLead: "本地清单与数据块已删除，要先把快照下载到本地，再执行还原",
  dlAskOk: "下载",
  dlAskNo: "取消",
  stateUnknown: "状态未知",
  backupSkip: "备份未执行：",
  listSummary: "云端 {n} 份备份",
  listSummaryPending: " · {k} 份待上传",
  listSummaryFailed: " · {m} 份需重传",
  delBackupBtn: "删除",
  delBackupTitle: "删除这份备份",
  delBackupLead: "删除后这份备份不再出现在列表里；云端会进阿里云盘回收站（30 天内可找回）。",
  delBackupCloud: "云端：进回收站，可在云盘界面恢复",
  delBackupCache: "本地缓存：一并清理，释放 {mb}",
  delBackupLast: "这是最后一份云端备份，删掉后云端就没有历史了。",
  delDone: "已删除",
  cacheCleanBtn: "清理缓存",
  cacheCleanTitle: "清理本地缓存",
  cacheCleanLead: "只删本机为了还原而下载的副本；云端备份不受影响。保留最近的若干份，其余回收。",
  cacheCleanKeep: "保留最近 {n} 份缓存",
  cacheCleanNone: "没有可清理的缓存",
  cacheCleanDone: "已清理 {n} 份缓存 · 释放 {mb}",
  uploadBtn: "上传",
  retryUpload: "重传",
  uploadDone: "已上传",
  emptyList: "还没有备份（点「立即备份」把当前状态存到云盘）",
  listUnavailable: "云端暂时读不到，列表不可用",
        restoreLoadFail: "读取失败：",
        restoreRemote: "含云端",
        restoreRemoteOn: "本地",
        restoreTarget: "还原到目录",
        restoreTargetHint: "留空即当前 DSH_HOME（会覆盖正在用的数据，执行前会再让你确认一次）",
        restorePreview: "预览",
        restoreRun: "立即还原",
        homeAskTitle: "还原到当前 DSH_HOME？",
        homeAskLead: "目标就是本机正在使用的 DSH 目录：还原会覆盖当前的会话、存储与插件配置。",
        homeAskTo: "目标目录",
        homeAskL1: "· 覆盖前会把原文件备份为 <文件名>.bak-restore-<时间戳>",
        homeAskL2: "· 还原完成后建议重启桌面版，让会话与配置重新加载",
        homeAskYes: "确认还原",
        restoreVerify: "校验还原结果",
        openLogs: "打开日志",
        logsOpened: "已打开日志目录",
        plugNote: "插件已打包的随快照保存，未打包的只记来源，装回时联网下载",
        plugNotePack: "其中 {p} 个已打包随快照保存，{s} 个只记来源，装回时联网下载",
        pluginPacks: "插件",
        pluginCount: "本快照含 {n} 个插件",
        pluginCountMany: "插件 {n} 个（{p}）",
        pluginCountIn: "{p} · 本快照含 {n} 个插件",
        rowHost: "运行环境",
        hostDesktop: "桌面端",
        hostWeb: "Web 端",
        hostGeneric: "命令行（未能判定 profile）",
        lrHostNote: " · 来自 {from}，当前 {to}",
        pluginPrompt: "手动生成提示词",
        plugOr: "或",
        compatBad: "当前 DSH {v} 超出兼容范围 {r}，宿主可能跳过本插件",
        compatBadRange: "兼容范围无法解析：{r}",
        compatNone: "未声明兼容范围",
        pluginPromptTip: "不自动装：复制一段提示词，交给任意 agent 手动装。",
        pluginPromptOk: "提示词已复制，可粘贴给任意 agent",
        pluginPromptFail: "生成失败：",
        restoreWithPlugins: "还原时同时装回插件",
        lrPluginsOk: "装回插件",
        lrPluginsFail: "插件失败",
        lrTitle: "上次还原：",
        lrWritten: "写入",
        lrSkipped: "跳过",
        lrFailed: "失败",
  snapRefresh: "刷新列表",
  pruneCancel: "取消",
  pruneOneBtn: "删除",
  dlgDelete: "确定删除",
  dlgCloseAria: "关闭弹窗",
  dirSessions: "会话",
  dirStorages: "存储",
  dirProfiles: "插件配置",
  dirOurFree: "插件数据 · our-free-model",
  dirMarket: "插件数据 · dshmarket",
  dirRoot: "根文件",
  dirSessionsNote: "各工作区的会话记录（.jsonl）",
  dirStoragesNote: "Harness 持久化缓存与工作区登记",
  dirProfilesNote: "每个 profile 的插件清单与 patch 文件",
  dirOurFreeNote: "插件状态文件（目录 / 可用性 / 备份清单）",
  dirMarketNote: "插件市场状态文件",
  dirRootNote: "AGENTS.md、prompt-inject.md 等",
  dirWorkspaceNote: "工作区目录（DSH 把路径里的 : 和 \\ 编码成 -）",
  pullItem: "下载",
  pullNoNeed: "本地已完整，无需下载",
  pullGot: "已下载",
  pullSnapTotal: "快照共",
  pullFiles: "文件",
  pullBlobs: "块",
  schedTitle: "自动备份",
  schedOn: "已开启",
  schedHours: "小时",
  schedPending: "已排期",
  schedOffHint: "自动备份已关闭，只能手动「立即备份」。",
  syncTitle: "同步云盘",
  syncOff: "关闭",
  syncOn: "开启",
  syncOnLine: "新备份会自动上传到云盘；列表里的「已上传」就是云端那一份。",
  sideEntry: "侧栏入口",
  sideEntryOn: "开启后，在侧栏显示「云盘备份」入口。设置里的入口不变。",
  sideEntryOff: "关闭后只在「设置」里保留入口。",
  syncOffLine: "已关闭：新备份只保存到本机，不上传云盘（单份仍可手动上传）。",
  savedLocalOnly: "已保存到本机 · 未上传",
  restorePull: "从云端下载",
        restoreConfirm: "我确认覆盖目标目录里的同名文件（自动留 .bak-restore 备份）",
        restoreRunning: "还原中…",
        restorePulling: "下载中…",
        restoreFiles: "文件",
        sizeWord: "大小",
        restoreMiss: "缺块",
        restoreNoManifest: "缺清单",
  viewBusy: "更新中…",
  pullProg: "下载中",
  pullWhole: "快照完整度",
  pullScopeBlocks: "所选 {s} 块（本机已有 {r}）",
  pullPausedTag: "已暂停",
  pullPause: "暂停",
  pullResume: "继续",
  selAll: "全选",
  selNone: "全不选",
  selCount: "已选 {n} / {m} 项",
  selEmpty: "一个目录都没选：先在文件树里勾选",
        restorePickFirst: "请先选一份快照",
      },
      en: {
        more: "More",
        secAuth: "Authorization",
        secRecent: "Recent backups",
        schedOffShort: "Off",
        schedOnShort: "On",
        schedOnLine: "Auto backup on, ",
        schedNextLine: "Next auto backup",
selIdNone: "No snapshot selected (click one in the list)",
listRefreshed: "List refreshed",
recentInfoTip: "Why rows differ: uploaded + cached locally \u2192 Delete only; pending (local only) \u2192 Upload sends it to the cloud; uploaded without local cache \u2192 Download fetches it back; cloud not synced \u2192 Retry re-reads that snapshot state.",
        dlgCopy: "Copy",
        promptTitle: "Plugin restore prompt",
        promptLead: "Copy the whole text below and paste it to any agent to install the plugin bodies back.",
        promptCopied: "Prompt copied to clipboard",
        batchOp: "Batch select",
        batchCancel: "Cancel",
        batchCount: "{n} selected · {mb}",
        batchNone: "No snapshot selected",
        batchDeleteBtn: "Delete selected",
        batchTitle: "Delete {n} snapshots?",
        batchLead: "They move to the cloud trash (restorable for 30 days) and local caches are cleared too.",
        batchLast: "{n} of them is the last cloud copy (the cloud would have no backup left) — continue?",
        batchDeleting: "Deleting {i} / {n} …",
        batchDone: "Deleted {n}",
        batchFailStop: "Failed at #{i}, stopped: {err}",
        selId: "Selected snapshot ID: ",
        snapWord: "snapshot",
        nav: "Cloud Backup",
        title: "Cloud Backup",
        subtitle: "Content-addressed backup of DSH sessions and config to a free cloud drive (Aliyun Drive first).",
        loading: "Loading…",
        phaseLoading: "loading",
        rowConnect: "Connection",
        rowAccount: "Account",
        rowDrive: "Drive",
        rowFolder: "Drive folder",
        rowRefresh: "Auto refresh",
        renewOn: "On",
        rowStateDir: "State dir",
        rowCrypto: "Credential encryption",
        connected: "Connected",
        notConnected: "Not connected",
        connect: "Connect Aliyun Drive",
        refresh: "Refresh",
        verify: "Verify",
        disconnect: "Disconnect",
        busy: "Working…",
        qrTitle: "Scan with the Aliyun Drive app",
        secLocal: "1) No QR: import from this machine",
        qrNew: "Waiting for scan…",
        qrScanned: "Scanned — confirm on your phone",
        qrConnecting: "Confirmed — fetching token…",
        qrFailed: "Failed to fetch token",
        qrRegen: "Regenerate QR code",
        qrExpireIn: "expires in",
        seconds: "seconds",
        qrFail: "Failed to get QR code",
        qrNote: "The QR code is generated and polled locally; tokens are encrypted by the host and never uploaded.",
        restoreSkippedMix: "{d} of them exist with different content (tick “Overwrite files with the same name” to write them)",
  wsMergedNote: "Workspace registry merged: +{a} new, {k} kept, {j} sessions re-linked",
  rgPlSkipMix: "plugins skipped {n} (other profiles {s} · blob missing {b})",
  lrPlBlob: "blob missing {b}",
  rgPlSkip: "plugins skipped {n} (owned by {p}, not installed here)",
  rgRestart: "restart DSH to see workspace / session changes",
  lrPlSkip: "plugins skipped {n}",
  lrRestart: "restart DSH",
  lrHist: "Restore log",
  lrHistHide: "Hide log",
  lrHistEmpty: "No restores yet",
  rsRestartChip: "restart to apply",
  rsBusyText: "Restoring \u2014 don't switch pages or quit",
  rsCancel: "Cancel",
  rsStopping: "Stopping\u2026",
  rsCancelled: "Restore cancelled; files already written are kept",
  rsDoneText: "Restored snapshot {s}",
  rsDoneSep: ", ",
  rsNeedApply: "restart to apply",
  cacheCleanTag: "cache cleared",
  restartNow: "Restart now",
  restarting: "Restarting…",
  restartDone: "Restart requested; DSH is restarting…",
  restartPort: "port ",
  lrHideNote: "Hide this note",
  watchWait: "Waiting for browser sign-in\u2026",
  watchCancel: "Stop waiting",
  watchTimeout: "No browser sign-in detected",
  watchDismiss: "Dismiss",
  watchAutoDone: "Imported the browser session automatically \u2014 connected",

  openBrowserLogin: "Open Aliyun Drive web login",
  qrZoom: "Enlarge QR code",
  qrZoomOut: "Restore size",
  copyLink: "Copy link",
  linkCopied: "Link copied \u2014 paste it into your browser",
  linkCopyManual: "Copy failed, please copy this address manually: ",
        qrTry: "attempt",
        qrDiagAt: "diagnostics: ",
        yes: "on (auto refresh 10 min before expiry)",
        no: "disabled",
        verified: "Last verified",
        never: "never",
        importLocal: "Import from this machine (no QR)",
        openBrowser: "Open sign-in page in browser",
        copyUrl: "Or paste this link into a browser:",
        backupNow: "Back up now",
        backupRunning: "Backing up…",
        rowLastBackup: "Last backup",
        backupFiles: "files",
        backupUploaded: "uploaded",
        backupUploadFail: "upload failed",
        backupUploadSkipped: "not uploaded (skipped)",
        importHint: "If the Aliyun Drive desktop client is installed and signed in on this machine, click Import from this machine — no QR scan needed. Only local files are read; the host still stores tokens encrypted.",
  secRestore: "Recent backups",
  restoreNone: "No snapshots yet (run a backup first)",
  stateUploaded: "uploaded",
  statePending: "pending upload",
  stateFailed: "upload failed",
  stateNoSync: "cloud unavailable",
  listSummaryNosync: "cloud unreachable · {n} cached locally",
  cloudDownTitle: "Can't reach the cloud drive",
  cloudDownHint: "showing the last successful sync",
  cloudDownRetry: "Retry",
  cloudAuthTitle: "Sign-in expired",
  cloudAuthHint: "sign in to the drive again to read backups",
  cloudConfigTitle: "Sign-in info incomplete",
  cloudConfigHint: "sign in again to complete it",
  cloudRelogin: "Sign in again",
  cloudCachedTag: "(last successful sync)",
  dlAskTitle: "This snapshot is only in the cloud",
  dlAskLead: "Its local manifest and data blocks are gone; download it first, then restore",
  dlAskOk: "Download",
  dlAskNo: "Cancel",
  stateUnknown: "state unknown",
  backupSkip: "Backup skipped: ",
  listSummary: "{n} backups in the cloud",
  listSummaryPending: " · {k} pending",
  listSummaryFailed: " · {m} to retry",
  delBackupBtn: "Delete",
  delBackupTitle: "Delete this backup",
  delBackupLead: "It disappears from the list; the cloud copy moves to the Aliyun Drive recycle bin (recoverable for 30 days).",
  delBackupCloud: "Cloud: moved to the recycle bin, recoverable in Aliyun Drive",
  delBackupCache: "Local cache: removed too, frees {mb}",
  delBackupLast: "This is the last cloud backup; deleting it leaves no cloud history.",
  delDone: "Deleted",
  cacheCleanBtn: "Clear cache",
  cacheCleanTitle: "Clear local cache",
  cacheCleanLead: "Only the copies downloaded to this machine for restore; cloud backups are untouched. Keeps the newest few, reclaims the rest.",
  cacheCleanKeep: "Keep the newest {n} cache copies",
  cacheCleanNone: "Nothing to clean",
  cacheCleanDone: "Cleared {n} cache copies, freed {mb}",
  uploadBtn: "Upload",
  retryUpload: "Retry",
  uploadDone: "Uploaded",
  emptyList: "No backups yet (press Backup now to store the current state in the cloud)",
  listUnavailable: "Cloud not reachable \u2014 list unavailable",
  restoreLoadFail: "Failed to read: ",
  restoreRemote: "with cloud",
  restoreRemoteOn: "Local",
  restoreTarget: "Restore into",
  restoreTargetHint: "Empty = current DSH_HOME (overwrites live data; you'll be asked to confirm once more)",
  restorePreview: "Preview",
  restoreRun: "Restore now",
  homeAskTitle: "Restore into the live DSH_HOME?",
  homeAskLead: "The target is this machine's live DSH directory: restoring overwrites current sessions, storage and plugin config.",
  homeAskTo: "Target",
  homeAskL1: "· Existing files are backed up as <name>.bak-restore-<stamp> before overwrite",
  homeAskL2: "· Restart the desktop app afterwards so sessions and config reload",
  homeAskYes: "Restore",
  restoreVerify: "Verify result",
  openLogs: "Open logs",
  logsOpened: "Opened log folder",
  plugNote: "Packed plugins travel with the snapshot, the rest only keep their source, downloaded when reinstalling",
  plugNotePack: " — {p} packed with the snapshot, {s} recorded by source only, downloaded when reinstalling",
  pluginPacks: "Plugins",
  pluginCount: "This snapshot carries {n} plugins",
  pluginCountMany: "{n} plugins ({p})",
  pluginCountIn: "{p} · {n} plugin packages",
  rowHost: "Runtime",
  hostDesktop: "Desktop",
  hostWeb: "Web",
  hostGeneric: "CLI (profile unknown)",
  lrHostNote: " · from {from}, currently {to}",
  pluginPrompt: "generate a prompt manually",
  plugOr: "or",
  compatBad: "Running DSH {v} is outside the supported range {r}; the host may skip this plugin",
  compatBadRange: "Unreadable compatibility range: {r}",
  compatNone: "No compatibility range declared",
  pluginPromptTip: "Skip auto-install: copy a prompt and let any agent do it.",
  pluginPromptOk: "Prompt copied — paste it to any agent",
  pluginPromptFail: "Failed: ",
  restoreWithPlugins: "Also install plugins on restore",
  lrPluginsOk: "plugins installed",
  lrPluginsFail: "plugins failed",
  lrTitle: "Last restore:",
  lrWritten: "written",
  lrSkipped: "skipped",
  lrFailed: "failed",
  snapRefresh: "Refresh",
  pruneCancel: "Cancel",
  pruneOneBtn: "Delete",
  dlgDelete: "Delete",
  dlgCloseAria: "Close dialog",
  dirSessions: "Sessions",
  dirStorages: "Storages",
  dirProfiles: "Plugin config",
  dirOurFree: "Plugin data · our-free-model",
  dirMarket: "Plugin data · dshmarket",
  dirRoot: "Root files",
  dirSessionsNote: "session logs per workspace (.jsonl)",
  dirStoragesNote: "Harness persistent cache and workspace registry",
  dirProfilesNote: "plugin manifest and patch per profile",
  dirOurFreeNote: "plugin state files (catalog / availability / backup list)",
  dirMarketNote: "plugin market state file",
  dirRootNote: "AGENTS.md, prompt-inject.md and friends",
  dirWorkspaceNote: "workspace dir (DSH encodes : and \\ as -)",
  pullItem: "Download",
  pullNoNeed: "Already complete locally \u2014 nothing to download",
  pullGot: "downloaded",
  pullSnapTotal: "snapshot total",
  pullFiles: "files",
  pullBlobs: "blobs",
  schedTitle: "Automatic backup",
  schedOn: "On",
  schedHours: "h",
  schedPending: "scheduled",
  schedOffHint: "Automatic backup is off — only manual \"Backup now\" runs.",
  syncTitle: "Cloud sync",
  syncOff: "Off",
  syncOn: "On",
  syncOnLine: "New backups upload to the cloud automatically; a row marked Uploaded is that cloud copy.",
  sideEntry: "Sidebar entry",
  sideEntryOn: "When on, a Cloud Backup entry appears in the sidebar. The entry in Settings stays.",
  sideEntryOff: "When off, the entry lives in Settings only.",
  syncOffLine: "Off: new backups stay on this machine only (a single backup can still be uploaded by hand).",
  savedLocalOnly: "Saved on this machine (cloud sync is off, nothing was uploaded).",
  restorePull: "Download from cloud",
  restoreConfirm: "Overwrite files with the same name (a .bak-restore copy is kept)",
  restoreRunning: "Restoring…",
  restorePulling: "Downloading…",
  restoreFiles: "files",
  sizeWord: "size",
  restoreMiss: "missing",
  restoreNoManifest: "no manifest",
  viewBusy: "refreshing…",
  pullProg: "Downloading",
  pullWhole: "snapshot complete",
  pullScopeBlocks: "{s} blocks in scope ({r} already downloaded)",
  pullPausedTag: "paused",
  pullPause: "Pause",
  pullResume: "Resume",
  selAll: "Select all",
  selNone: "Select none",
  selCount: "{n} / {m} selected",
  selEmpty: "Nothing selected: pick directories in the tree first",
  restorePickFirst: "Pick a snapshot first",
      },
    };

    // 本地兜底：locale 服务不可用（或字典未加载）时仍能出文案
    let t = function (key) { return DICT.zh[key] || key; };

    const css = `/* dsh-cloud-backup：按「全新 UI 效果图」重绘（浅色为基准，深色自动派生） */
/* 主题令牌：卡片与弹窗共用（弹窗经 portal 挂在 body 下，不在卡片作用域内） */
.dshcb-card,.dshcb-modalroot,.dshcb-toast{
  --cb-fg:#303030; --cb-fg2:#555557; --cb-fg3:#8b8c8f; --cb-fg4:#aaaabb;
  --cb-icon:#6f7276; --cb-line:#ededee; --cb-border:#e2e3e5; --cb-fill:#f7f7f9;
  --cb-accent:#0c90e6; --cb-primary:#303030; --cb-onprimary:#fff;
  --cb-surface:#fff; --cb-hover:#fafafa; --cb-warn:#b45309; --cb-err:#d92c2c;
}
.dshcb-card{position:relative;overflow:hidden}
/* 「读取中」时的卡片底部边缘流光：只在首屏拿不到 /status 时出现 */
.dshcb-card.dshcb-loading::after{content:"";position:absolute;left:0;right:0;bottom:0;height:2px;
  background:linear-gradient(90deg,transparent 0%,var(--cb-accent) 50%,transparent 100%);background-size:38% 100%;
  animation:dshcb-edge 1.35s linear infinite;pointer-events:none}
@keyframes dshcb-edge{0%{background-position:-40% 0}100%{background-position:140% 0}}
@media (prefers-reduced-motion:reduce){.dshcb-card.dshcb-loading::after{animation:none;background:var(--cb-accent);opacity:.5}}
.dshcb-card{
  font-family:var(--dsw-font-family,var(--dsh-font-family-text,-apple-system,"SF Pro Text","PingFang SC","Segoe UI",system-ui,sans-serif));
  font-size:12px; line-height:1.5; color:var(--cb-fg);
  background:var(--cb-surface);
  border:1px solid var(--cb-line); border-radius:16px;
  box-shadow:0 1px 2px rgba(0,0,0,.04), 0 12px 32px rgba(0,0,0,.07);
  padding:18px 20px 16px; margin:0 0 12px; box-sizing:border-box;
}
/* 深色：跟随宿主（宿主给 body 打 data-ds-dark-theme）。不用 prefers-color-scheme，
   否则「系统深色 + DSH 选浅色」时卡片会被刷成深色，与周围设置面板不一致。 */
body[data-ds-dark-theme] .dshcb-card,
body[data-ds-dark-theme] .dshcb-modalroot,
body[data-ds-dark-theme] .dshcb-toast{
  --cb-fg:#f2f3f5; --cb-fg2:#c9ccd1; --cb-fg3:#a2a6ac; --cb-fg4:#878b91;
  --cb-icon:#a2a6ac; --cb-line:rgba(255,255,255,.10); --cb-border:rgba(255,255,255,.16);
  --cb-fill:rgba(255,255,255,.07); --cb-accent:#3ea6f5; --cb-primary:#f2f3f5; --cb-onprimary:#17181a;
  --cb-surface:#1e1f21; --cb-hover:rgba(255,255,255,.045); --cb-warn:#e0a144; --cb-err:#ff6b6b;
}
.dshcb-ico{display:block;flex:0 0 auto}
.dshcb-card *,.dshcb-modalroot *{box-sizing:border-box}

/* ① 标题行 */
.dshcb-head{display:flex;align-items:center;gap:10px}
.dshcb-headL{display:flex;align-items:center;gap:8px;min-width:0}
.dshcb-headL .dshcb-ico{color:var(--cb-fg)}
.dshcb-h1{font-size:16.5px;font-weight:600;letter-spacing:.01em;white-space:nowrap}
.dshcb-ver{font-size:11px;color:var(--cb-fg3);background:var(--cb-fill);border-radius:6px;padding:1px 6px;font-variant-numeric:tabular-nums}
.dshcb-headR{margin-left:auto;display:flex;align-items:center;gap:14px}
.dshcb-state{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--cb-fg2);white-space:nowrap}
/* 状态点：宿主 StateDot 的做法（同色 10% 光晕 + 实心核心），四态四色 + 呼吸动效 */
.dshcb-dot{position:relative;width:7px;height:7px;flex:0 0 7px;border-radius:50%;display:inline-block;color:var(--cb-fg4)}
.dshcb-dot::before{content:"";position:absolute;inset:0;border-radius:50%;background:currentColor;
  animation:dshcb-breathe 2.6s ease-in-out infinite}
.dshcb-dot::after{content:"";position:absolute;inset:1.5px;border-radius:50%;background:currentColor}
.dshcb-state.s-ok .dshcb-dot{color:var(--cb-accent)}
.dshcb-state.s-busy .dshcb-dot{color:var(--dsw-alias-state-warn-primary,var(--cb-warn))}
.dshcb-state.s-busy .dshcb-dot::before{animation-duration:1.2s}
.dshcb-state.s-err .dshcb-dot{color:var(--dsw-alias-state-error-primary,var(--cb-err))}
.dshcb-state.s-err .dshcb-dot::before{animation-duration:1.6s}
.dshcb-state.s-off .dshcb-dot{color:var(--cb-fg4)}
.dshcb-state.s-off .dshcb-dot::before{animation-duration:3.6s}
@keyframes dshcb-breathe{0%,100%{opacity:.14;transform:scale(1)}50%{opacity:.34;transform:scale(1.5)}}
@media (prefers-reduced-motion: reduce){.dshcb-dot::before{animation:none;opacity:.28}}
.dshcb-morewrap{position:relative}
.dshcb-more{appearance:none;border:0;background:transparent;font:inherit;font-size:12px;color:var(--cb-fg2);
  display:inline-flex;align-items:center;gap:4px;padding:2px 4px;border-radius:6px;cursor:pointer}
.dshcb-more:hover{background:var(--cb-fill)}
.dshcb-menu{position:absolute;right:0;top:calc(100% + 4px);z-index:100;min-width:150px;padding:4px;border-radius:10px;
  background:var(--dsw-specific-menu,var(--cb-surface));border:1px solid var(--dsw-alias-border-inverted,var(--cb-border));
  box-shadow:var(--dsw-shadow-lv3,0 0 1px rgba(0,0,0,.2),0 0 4px rgba(0,0,0,.02),0 12px 32px rgba(0,0,0,.08));
  animation:dshcb-pop .12s ease-out}
.dshcb-mi{display:block;width:100%;text-align:left;appearance:none;border:0;background:transparent;font:inherit;
  font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,var(--cb-fg));min-height:31px;padding:5px 9px;
  border-radius:9px;cursor:pointer;white-space:nowrap}
.dshcb-mi:hover{background:var(--dsw-alias-interactive-bg-hover,var(--cb-fill))}
.dshcb-mi.danger{color:var(--cb-err)}
@keyframes dshcb-pop{from{opacity:0;transform:translateY(-4px) scale(.98)}to{opacity:1;transform:none}}

/* 弹窗：完全对齐宿主 Modal 规格（fixed 满屏层 + mask 模糊，点遮罩即取消；r24 卡片 / shadow-lv3 /
   标题 16·500 / 描述 14·22 / 页脚右对齐胶囊按钮 h36 r18） */
.dshcb-modalroot{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px}
.dshcb-mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.24));
  backdrop-filter:var(--dsw-mask-blur,blur(2px))}
.dshcb-dialog{position:relative;z-index:1;display:flex;flex-direction:column;gap:20px;width:min(440px,100%);
  max-height:calc(100vh - 48px);padding:0 0 24px;overflow:hidden;border-radius:24px;
  border:1px solid var(--dsw-alias-border-inverted,var(--cb-border));
  background:var(--dsw-alias-bg-layer-2,var(--cb-surface));
  box-shadow:var(--dsw-shadow-lv3,0 0 1px rgba(0,0,0,.2),0 0 4px rgba(0,0,0,.02),0 12px 32px rgba(0,0,0,.08));
  animation:dshcb-dlg-in .16s cubic-bezier(.2,0,.2,1)}
.dshcb-dlgContent{display:flex;flex-direction:column;min-height:0;overflow-y:auto;overscroll-behavior:contain}
.dshcb-dlgHead{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:22px 14px 12px 24px}
.dshcb-dlgTitle{margin:0;font-size:15px;line-height:22px;font-weight:500;
  color:var(--dsw-alias-label-primary,var(--cb-fg))}
.dshcb-dlgClose{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;
  border:0;border-radius:8px;background:transparent;cursor:pointer;
  color:var(--dsw-alias-label-secondary,var(--cb-fg3))}
.dshcb-dlgClose:hover{background:var(--dsw-alias-interactive-bg-hover,var(--cb-fill))}
.dshcb-dlgLead{margin:0;padding:0 22px;font-size:13px;line-height:20px;
  color:var(--dsw-alias-label-primary,var(--cb-fg))}
.dshcb-dlgBody{display:flex;flex-direction:column;gap:12px;margin-top:20px;padding:0 24px}
.dshcb-dlgWarn{display:flex;align-items:flex-start;gap:10px;font-size:13px;line-height:20px;
  color:var(--dsw-alias-label-secondary,var(--cb-fg2))}
.dshcb-dlgWarn p{margin:0}
.dshcb-dlgWarnIco{flex:none;margin-top:2px;color:var(--dsw-alias-state-error-primary,var(--cb-err))}
.dshcb-dlgList{margin:0;padding:9px 11px;list-style:none;max-height:200px;overflow-y:auto;overscroll-behavior:contain;
  border:1px solid var(--cb-line);border-radius:10px;background:var(--cb-fill);
  font-size:12px;line-height:18px;color:var(--cb-fg2);font-variant-numeric:tabular-nums}
.dshcb-dlgList li+li{margin-top:6px}
.dshcb-dlgSkip{margin:0;font-size:12px;line-height:18px;color:var(--cb-fg3)}
.dshcb-dlgPre{margin:0;padding:10px 12px;max-height:240px;overflow:auto;overscroll-behavior:contain;white-space:pre-wrap;word-break:break-all;
  font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11.5px;line-height:1.55;
  color:var(--cb-fg2);background:var(--cb-fill);border:1px solid var(--cb-line);border-radius:10px}
.dshcb-dlgFoot{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:0 24px}
.dshcb-dbtn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:32px;
  min-width:66px;padding:0 12px;border:0;border-radius:16px;font:inherit;font-size:13px;line-height:20px;
  cursor:pointer;color:var(--dsw-alias-label-primary,var(--cb-fg))}
.dshcb-dbtn.outline{border:1px solid var(--dsw-alias-border-l2,var(--cb-border));background:transparent}
.dshcb-dbtn.outline:hover{background:var(--dsw-alias-interactive-bg-hover,var(--cb-hover))}
.dshcb-dbtn.primary{font-weight:500;
  background:var(--dsw-alias-button-primary-fill,var(--cb-primary));
  color:var(--dsw-alias-label-primary-foreground,var(--cb-onprimary))}
.dshcb-dbtn.primary:hover{background:var(--dsw-alias-button-primary-hover,var(--cb-primary));opacity:.92}
@keyframes dshcb-dlg-in{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion: reduce){.dshcb-dialog,.dshcb-menu{animation:none}}
.dshcb-mi.danger{color:var(--cb-err)}
.dshcb-sub{margin:4px 0 0;font-size:12px;color:var(--cb-fg3)}

/* ②③④ 分区 */
.dshcb-sec{margin-top:12px;padding-top:12px;border-top:1px solid var(--cb-line)}
.dshcb-sech{display:flex;align-items:center;gap:10px;width:100%;padding:0;text-align:left;
  appearance:none;border:0;background:transparent;font:inherit;color:inherit}
button.dshcb-sech{cursor:pointer}
.dshcb-sechT{flex:0 0 auto;font-size:13.5px;font-weight:600;color:var(--cb-fg)}
.dshcb-sechS{min-width:0;font-size:11.5px;color:var(--cb-fg3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshcb-sechR{margin-left:auto;display:flex;align-items:center;gap:8px}
.dshcb-sechIco{margin-left:auto;display:inline-flex;color:var(--cb-fg4)}
.dshcb-infoIco{flex:0 0 auto;display:inline-flex;align-items:center;color:var(--cb-fg4);cursor:help}
/* 说明浮层：跟随主题的黑/白半透明气泡（自绘，替代原生 title） */
.dshcb-tipHost{position:relative;display:inline-flex;align-items:center;outline:none}
.dshcb-tip{position:absolute;left:-6px;bottom:calc(100% + 8px);z-index:90;width:max-content;max-width:min(300px,72vw);
  padding:7px 10px;border-radius:8px;font-size:11.5px;line-height:1.55;font-weight:400;text-align:left;white-space:normal;
  color:#fff;background:rgba(28,29,31,.92);box-shadow:0 3px 10px rgba(0,0,0,.04);
  opacity:0;visibility:hidden;transition:opacity .12s ease,visibility .12s;pointer-events:none}
.dshcb-tip::after{content:"";position:absolute;left:14px;top:100%;border:5px solid transparent;border-top-color:rgba(28,29,31,.92)}
.dshcb-tipHost:hover .dshcb-tip,.dshcb-tipHost:focus .dshcb-tip,.dshcb-tipHost:focus-within .dshcb-tip{opacity:1;visibility:visible}
body[data-ds-dark-theme] .dshcb-tip{color:#1b1c1e;background:rgba(244,245,247,.94);box-shadow:0 3px 10px rgba(0,0,0,.10)}
body[data-ds-dark-theme] .dshcb-tip::after{border-top-color:rgba(244,245,247,.94)}
@media (prefers-reduced-motion:reduce){ .dshcb-tip{transition:none} }
.dshcb-infoIco:hover{color:var(--cb-fg2)}

.dshcb-table{margin-top:10px;border:1px solid var(--cb-line);border-radius:10px;overflow:hidden}
.dshcb-tr{display:flex;align-items:center;gap:10px;min-height:29px;padding:5px 12px;border-top:1px solid var(--cb-line)}
.dshcb-tr:first-child{border-top:0}
.dshcb-tk{flex:0 0 auto;color:var(--cb-fg3)}
.dshcb-tv{margin-left:auto;min-width:0;text-align:right;color:var(--cb-fg);word-break:break-all;font-variant-numeric:tabular-nums}

/* 主面板页：只负责页面留白 / 居中 / 滚动，卡片外观与「设置」里完全一致 */
.dshcb-page{box-sizing:border-box;min-height:100%;overflow:auto;display:flex;justify-content:center;
  align-items:flex-start;padding:22px 28px 48px}
.dshcb-page .dshcb-card{width:100%;max-width:1120px;margin:0}

/* 行内悬浮提示（自绘；半透明黑，深色下改浅色） */
.dshcb-hoverTip{position:fixed;z-index:90;width:max-content;max-width:min(320px,72vw);padding:5px 9px;border-radius:7px;
  font-size:11px;line-height:1.45;white-space:normal;overflow-wrap:break-word;background:rgba(22,23,26,.86);color:#fff;
  box-shadow:0 2px 6px rgba(0,0,0,.03);pointer-events:none;transform:none}
body[data-ds-dark-theme] .dshcb-hoverTip{background:rgba(244,245,247,.94);color:#111;box-shadow:0 3px 10px rgba(0,0,0,.10)}

/* 分段控件（滑块在选项之间平滑滑动，缩略图由 .dshcb-segthumb 承担） */
.dshcb-seg{position:relative;display:inline-flex;align-items:center;gap:2px;box-sizing:border-box;height:30px;padding:2px;border-radius:9px;background:var(--cb-fill)}
.dshcb-seg.dis{opacity:.5;pointer-events:none}
.dshcb-seg.sm .dshcb-segi{font-size:11px;padding:0 9px}
.dshcb-segthumb{position:absolute;left:0;top:2px;bottom:2px;z-index:0;border-radius:7px;pointer-events:none;
  background:var(--cb-surface);border:1px solid var(--cb-border);box-shadow:0 1px 2px rgba(0,0,0,.06);
  will-change:transform,width;
  transition:transform .26s cubic-bezier(.22,1,.36,1),width .26s cubic-bezier(.22,1,.36,1)}
.dshcb-segthumb.notrans{transition:none}
.dshcb-segi{position:relative;z-index:1;appearance:none;border:1px solid transparent;background:transparent;font:inherit;
  font-size:12px;color:var(--cb-fg2);box-sizing:border-box;height:26px;display:inline-flex;align-items:center;padding:0 12px;border-radius:7px;cursor:pointer;white-space:nowrap;
  transition:color .2s ease}
.dshcb-segi:hover{color:var(--cb-fg)}
.dshcb-segi.on{color:var(--cb-fg);font-weight:600}
@media (prefers-reduced-motion: reduce){.dshcb-segthumb{transition:none}}

/* 说明行 + 按钮 */
.dshcb-line{margin-top:12px;display:flex;align-items:center;gap:12px}
.dshcb-lineText{font-size:12px;color:var(--cb-fg3)}
.dshcb-line .dshcb-btn{margin-left:auto}
.dshcb-btn{appearance:none;border:1px solid var(--cb-border);background:var(--cb-surface);color:var(--cb-fg);
  font:inherit;font-size:12px;font-weight:500;padding:6px 12px;border-radius:9px;cursor:pointer;
  transition:background .15s ease,opacity .15s ease;white-space:nowrap}
.dshcb-btn:hover{background:var(--cb-hover)}
.dshcb-btn.d2{background:var(--cb-primary);border-color:var(--cb-primary);color:var(--cb-onprimary)}
.dshcb-btn.d2:hover{opacity:.86;background:var(--cb-primary)}
.dshcb-btn:disabled{opacity:.45;cursor:default;background:var(--cb-primary);background-color:var(--cb-primary)}
.dshcb-btn:not(.d2):disabled{background:var(--cb-surface)}
.dshcb-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}

.dshcb-tools{flex-wrap:wrap;justify-content:flex-end;gap:0;row-gap:2px}
.dshcb-batchSum{color:var(--cb-fg3);cursor:default}
.dshcb-item.dshcb-batch .dshcb-iacts,.dshcb-item.dshcb-batch .dshcb-ichev{display:none}
.dshcb-tool{appearance:none;border:0;background:transparent;font:inherit;font-size:12px;color:var(--cb-fg2);
  display:inline-flex;align-items:center;gap:5px;padding:4px 6px;border-radius:7px;cursor:pointer;white-space:nowrap}
.dshcb-tool .dshcb-ico{color:var(--cb-icon)}
.dshcb-tool:hover{background:var(--cb-fill)}
.dshcb-tool.on,.dshcb-tool.on .dshcb-ico{color:var(--cb-accent)}
.dshcb-tool:disabled{opacity:.45;cursor:default;background:transparent}


/* ⑤ 快照列表（高度封顶 + 内部滚动，卡片不会随快照数量无限变高） */
.dshcb-list{margin-top:10px;border:1px solid var(--cb-line);border-radius:10px;
  max-height:min(46vh,380px);overflow-y:auto;overflow-x:hidden;overscroll-behavior:auto;
  scrollbar-width:thin;scrollbar-color:var(--cb-line) transparent}
.dshcb-list::-webkit-scrollbar{width:8px}
.dshcb-list::-webkit-scrollbar-track{background:transparent}
.dshcb-list::-webkit-scrollbar-thumb{background:var(--cb-line);border-radius:4px}
.dshcb-list::-webkit-scrollbar-thumb:hover{background:var(--cb-fg4)}
.dshcb-listSkel{padding:5px 9px}
.dshcb-skel{height:46px;border-radius:9px;margin:5px 0;background-color:var(--cb-fill);
  background-image:linear-gradient(90deg,transparent 0%,var(--cb-line) 50%,transparent 100%);
  background-size:220% 100%;background-repeat:no-repeat;animation:dshcb-shimmer 1.35s linear infinite}
@keyframes dshcb-shimmer{0%{background-position:-120% 0}100%{background-position:140% 0}}
.dshcb-listHint{padding:5px 11px 3px;font-size:11px;color:var(--cb-fg3)}
.dshcb-spin{display:inline-block;width:12px;height:12px;margin-right:7px;vertical-align:-2px;border-radius:50%;
  border:2px solid var(--cb-fill);border-top-color:var(--cb-accent);animation:dshcb-spin .8s linear infinite}
@keyframes dshcb-spin{to{transform:rotate(360deg)}}
.dshcb-grpEmpty{padding:10px 12px;font-size:11px;line-height:16px;color:var(--cb-fg4);border-bottom:1px solid var(--cb-line)}
.dshcb-item{display:flex;align-items:center;gap:10px;padding:8px 12px;border-top:1px solid var(--cb-line);
  cursor:pointer;flex-wrap:wrap}   /* item 允许换行：展开的目录树要独占一行 */
.dshcb-rowMain{display:flex;align-items:center;gap:10px;min-width:0;flex:1 0 100%}
/* 行内（勾选/图标/标题/动作/箭头）永不换行：标题过长只省略，不许把「下载/删除」挤到第二行 */
.dshcb-item:first-child{border-top:0}
.dshcb-item.on{background:var(--cb-fill)}   /* 当前选中/待还原的那一行 */
.dshcb-badge{flex:0 0 auto;height:15px;line-height:15px;padding:0 6px;border-radius:8px;font-size:9.5px;font-weight:500;
  color:var(--cb-fg3);background:var(--cb-fill);font-variant-numeric:tabular-nums}
.dshcb-badge.muted{background:var(--cb-fill);color:var(--cb-fg3)}
.dshcb-tool.warn{color:var(--cb-err)}
.dshcb-badge.warn{color:var(--cb-err);background:transparent}
.dshcb-badge.err{color:#fff;background:var(--cb-err)}
/* 消息层：一处组件、三种等级；由状态派生，不落库、不重复 */
.dshcb-lane{display:flex;flex-direction:column;gap:8px;margin-top:10px}
.dshcb-lane .dshcb-pullRow{margin-top:0}
.dshcb-msg{display:flex;align-items:flex-start;gap:9px;padding:8px 10px;border-radius:10px;
  background:var(--cb-fill);box-shadow:inset 0 0 0 1px var(--cb-line)}
.dshcb-msgMain{flex:1;min-width:0;display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 10px}
.dshcb-msgT{font:500 11.5px/17px var(--cb-font);color:var(--cb-fg)}
.dshcb-msgD{font:11px/17px var(--cb-font);color:var(--cb-fg3);word-break:break-word}
.dshcb-msgAct{flex:none;display:flex;align-items:center;gap:6px;align-self:center}
.dshcb-msg--blocker .dshcb-msgT{color:var(--cb-err)}
.dshcb-msg--warn .dshcb-msgT{color:var(--cb-warn)}
.dshcb-msg--info .dshcb-msgT{color:var(--cb-fg)}
/* 只有一行正文时让这一行落在卡片水平中心；多行保持左对齐，读起来更稳 */
.dshcb-msgClose{border:0;background:transparent;cursor:pointer;padding:0 2px;font-size:12px;line-height:1;color:var(--cb-fg3)}
.dshcb-msgClose:hover{color:var(--cb-fg)}
/* 主按钮旁的就地说明 */
/* 列表首次加载的占位（骨架）：比白屏 / “暂无备份”更诚实 */
.dshcb-skelrow{cursor:default;pointer-events:none}
.dshcb-skelico,.dshcb-skelbar{background-color:var(--cb-fill);
  background-image:linear-gradient(90deg,transparent 0%,var(--cb-line) 50%,transparent 100%);
  background-size:220% 100%;background-repeat:no-repeat;animation:dshcb-shimmer 1.35s linear infinite}
.dshcb-skelico{flex:0 0 auto;width:20px;height:20px;border-radius:5px}
.dshcb-skelbar{display:block;height:10px;border-radius:5px;margin:3px 0}
.dshcb-skelbar2{height:8px}
.dshcb-plugRow{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:2px 0 4px}
.dshcb-needRestart{color:var(--cb-err);font-weight:500}
.dshcb-plugChk{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--cb-fg2);cursor:pointer}
.dshcb-or{font-size:12px;color:var(--cb-fg3)}
.dshcb-plugChk input{width:14px;height:14px;margin:0}
.dshcb-plugRow .dshcb-link{margin-left:0}
.dshcb-pickedBar{display:inline-block;width:132px;height:9px;border-radius:5px;vertical-align:-1px}
@media (prefers-reduced-motion: reduce){.dshcb-skelico,.dshcb-skelbar,.dshcb-skel,.dshcb-pickedBar{animation:none}}
.dshcb-sechMeta{margin-left:8px;font-size:10.5px;font-weight:400;color:var(--cb-fg3)}
.dshcb-item:hover{background:var(--cb-hover)}
/* 勾选框：与宿主复选框一致的「方格勾」 */
.dshcb-radio{width:16px;height:16px;flex:0 0 16px;border-radius:4.5px;border:1.5px solid var(--cb-fg4);
  display:inline-flex;align-items:center;justify-content:center;color:var(--cb-onprimary);background:transparent;
  transition:background .15s ease,border-color .15s ease}
.dshcb-radio:hover{border-color:var(--cb-fg3)}
.dshcb-radio.on{background:var(--cb-primary);border-color:var(--cb-primary)}
.dshcb-fico{display:inline-flex;color:var(--cb-icon)}
.dshcb-itxt{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto}
.dshcb-ititle{display:flex;align-items:center;gap:6px;min-width:0;font-size:12.5px;font-weight:600;color:var(--cb-fg)}
.dshcb-itname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshcb-itag{font-size:10.5px;font-weight:500;color:var(--cb-fg3);margin-left:2px}
.dshcb-isub{font-size:10.5px;color:var(--cb-fg3);font-variant-numeric:tabular-nums;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshcb-iacts{margin-left:auto;display:flex;align-items:center;gap:2px;flex:0 0 auto}
.dshcb-ichev{display:inline-flex;color:var(--cb-fg4);flex:0 0 auto;transition:transform .15s ease}
.dshcb-tree{flex:1 0 100%;margin:7px 0 0;padding:8px 0 2px;border-top:1px solid var(--cb-line)}
.dshcb-treeLoad{font-size:11px;color:var(--cb-fg3)}
.dshcb-errLine{color:var(--cb-err)}
.dshcb-tn{display:flex;align-items:flex-start;gap:8px;padding:6px 0 6px 7px}
.dshcb-tnHead{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:0 0 6px;border-bottom:1px dashed var(--cb-line);margin-bottom:4px}
.dshcb-tnSel{font-size:11px;color:var(--cb-fg3);font-variant-numeric:tabular-nums}
.dshcb-tnActs{display:flex;gap:14px}
.dshcb-tn{cursor:pointer;border-radius:6px}
.dshcb-tn:hover{background:color-mix(in srgb,currentColor 4%,transparent)}
.dshcb-tn .dshcb-radio{width:16px;height:16px;flex:0 0 16px;margin-top:1px}
.dshcb-pullRow{display:flex;align-items:center;justify-content:space-between;gap:10px}
.dshcb-pullTxt{min-width:0}
.dshcb-btn.ghost{height:28px;padding:0 10px;font-size:12px;border-radius:8px;background:transparent;border:1px solid var(--cb-line);color:var(--cb-fg)}
.dshcb-btn.ghost:hover{background:color-mix(in srgb,currentColor 7%,transparent)}
.dshcb-tnBody{min-width:0}
.dshcb-tnName{font-size:12px;font-weight:600;color:var(--cb-fg)}
.dshcb-tnSub{font-size:11px;color:var(--cb-fg3);word-break:break-word}
.dshcb-tnMeta{margin-left:auto;flex:0 0 auto;font-size:11px;color:var(--cb-fg3);
  font-variant-numeric:tabular-nums;padding-top:2px}

/* ⑥ 还原操作区 */
.dshcb-picked{margin-top:12px;font-size:12px;color:var(--cb-fg2)}
.dshcb-pickedWait{display:inline-flex;align-items:center;gap:6px;color:var(--cb-fg3)}
.dshcb-pickedId{color:var(--cb-fg);font-variant-numeric:tabular-nums}
.dshcb-picked{position:relative}
.dshcb-picked .dshcb-tipHost{position:static;margin-left:5px;vertical-align:-3px}
.dshcb-picked .dshcb-tip{left:0;bottom:calc(100% + 6px);max-width:min(340px,100%)}
.dshcb-picked .dshcb-tip::after{display:none}
.dshcb-rbar{margin-top:8px;display:flex;align-items:center;gap:10px}
.dshcb-rsCard{margin-top:8px;display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;background:var(--cb-fill);font-size:12px;color:var(--cb-fg2)}
.dshcb-rsTxt{min-width:0;flex:0 1 auto;overflow-wrap:anywhere}
.dshcb-rsGap{flex:1 1 auto}
.dshcb-rsNeed{color:var(--cb-err);font-weight:500}
.dshcb-rsBar{flex:1 1 auto;min-width:60px;height:4px;border-radius:2px;background:var(--cb-line);overflow:hidden}
.dshcb-rsBar>i{position:relative;display:block;height:100%;background:var(--cb-accent);transition:width .3s ease;overflow:hidden}
.dshcb-rsBar:not(.dshcb-rsBar--indet)>i::after{content:"";position:absolute;top:0;bottom:0;left:0;right:0;background-image:linear-gradient(90deg,rgba(255,255,255,0) 0,rgba(255,255,255,.55) 50%,rgba(255,255,255,0) 100%);background-size:32px 100%;background-repeat:repeat-x;animation:dshcb-rsFlow 1.1s linear infinite}
@keyframes dshcb-rsFlow{from{background-position:-32px 0}to{background-position:32px 0}}
.dshcb-rsBar--indet>i{width:35%;animation:dshcb-rsMove 1.2s ease-in-out infinite}
@keyframes dshcb-rsMove{0%{margin-left:-35%}100%{margin-left:100%}}
.dshcb-input{flex:1 1 auto;min-width:0;height:34px;padding:0 11px;font:inherit;font-size:12px;color:var(--cb-fg);
  background:var(--cb-surface);border:1px solid var(--cb-border);border-radius:10px;outline:none}
.dshcb-input:focus{border-color:var(--cb-accent)}
.dshcb-input::placeholder{color:var(--cb-fg4)}
.dshcb-foot{margin-top:12px;display:flex;align-items:center;gap:8px;font-size:12px;color:var(--cb-fg2)}
.dshcb-foot input[type=checkbox]{width:15px;height:15px;flex:0 0 15px;margin:0;accent-color:var(--cb-primary)}
.dshcb-link{margin-left:auto;appearance:none;border:0;background:transparent;font:inherit;font-size:12px;
  color:var(--cb-accent);cursor:pointer;padding:2px 0 2px 4px;white-space:nowrap}
.dshcb-link:hover{text-decoration:underline}
.dshcb-link:disabled{opacity:.5;cursor:default;text-decoration:none}
/* 还原记录：按钮行 + 弹窗 + 重启标记 */
.dshcb-footBtns{display:flex;align-items:center;gap:10px;margin-left:auto}
.dshcb-footBtns .dshcb-link{margin-left:0}
/* 还原记录弹窗：宽度跟着记录文本走（窄记录就窄框，长记录才拉宽到上限再折行） */
.dshcb-dialog.dshcb-dlgHist{width:fit-content;min-width:min(300px,92vw);max-width:min(760px,92vw)}
.dshcb-histList{margin:0 24px 24px;max-height:min(52vh,380px);font-variant-numeric:tabular-nums}
.dshcb-dialog.dshcb-dlgHist .dshcb-dlgHead,.dshcb-dialog.dshcb-dlgHist .dshcb-dlgContent{min-width:0}
.dshcb-histEmptyLi{color:var(--dsw-alias-label-secondary,var(--cb-fg3))}
/* 浮层 tips：一次性提示，几秒后自动消失 */
.dshcb-toast{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:80;max-width:min(420px,86vw);
  padding:8px 12px;border-radius:10px;font-size:12px;background:#1c1d1f;background-color:#1c1d1f;border:1px solid rgba(255,255,255,.08);backdrop-filter:none;
  box-shadow:0 3px 10px rgba(0,0,0,.06);color:#fff;font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;font-size:12px;line-height:18px;
  animation:dshcb-toastin .16s ease-out}
.dshcb-toast.ok{border-color:rgba(255,255,255,.16)}
.dshcb-toast.err{border-color:rgba(255,255,255,.16)}
body[data-ds-dark-theme] .dshcb-toast.err{border-color:rgba(0,0,0,.10)}
body[data-ds-dark-theme] .dshcb-toast{background:#f2f3f5;background-color:#f2f3f5;border-color:rgba(0,0,0,.06);box-shadow:0 3px 10px rgba(0,0,0,.3);color:#1b1c1e}
@keyframes dshcb-toastin{from{opacity:0;transform:translate(-50%,-50%) scale(.96)}to{opacity:1;transform:translate(-50%,-50%) scale(1)}}
@media (prefers-reduced-motion: reduce){.dshcb-toast{animation:none}
  .dshcb-spin{animation:none}}

.dshcb-qrbox{margin-top:14px;padding:14px;border:1px solid var(--cb-line);border-radius:12px;
  display:flex;flex-direction:column;align-items:center;gap:8px}
.dshcb-qrhead{font-size:13px;font-weight:600}
.dshcb-qr{width:180px;height:180px;border-radius:8px;background:#fff}
.dshcb-qrstate{font-size:11px;color:var(--cb-fg3)}
.dshcb-qrstate.ok{color:var(--cb-accent)}
.dshcb-qrhint{font-size:11px;color:var(--cb-fg3);text-align:center}
.dshcb-btn.sm{height:30px;padding:0 10px;font-size:12px;flex:0 0 auto}
  padding:6px 8px;border-radius:7px;margin-top:6px;user-select:all;white-space:nowrap;overflow-x:auto;overflow-y:hidden;font-variant-numeric:tabular-nums}
.dshcb-qr.big{width:320px;height:320px;cursor:zoom-out}
.dshcb-qr{cursor:zoom-in}
.dshcb-qrrow{display:flex;flex-wrap:wrap;gap:6px 14px;justify-content:center;align-items:center}
.dshcb-watch{display:flex;flex-wrap:wrap;gap:6px 10px;justify-content:center;align-items:center;font-size:11.5px;color:var(--cb-fg3)}
.dshcb-linkbtn{padding:0;border:0;background:none;font:inherit;font-size:12px;color:var(--cb-accent);cursor:pointer}
.dshcb-linkbtn:hover{text-decoration:underline}
`;
    const cssRestore = "";   // 新版样式已合并进 css

    function ensureCss() {
      if (typeof document === "undefined") return;
      if (document.getElementById("dshcb-css")) return;
      const el = document.createElement("style");
      el.id = "dshcb-css";
      el.textContent = css + cssRestore;
      document.head.appendChild(el);
    }

    // 复制文本：优先剪贴板 API，失败退回 textarea + execCommand（桌面 webview 里常有权限限制）

    async function call(pathname, body) {
      const init = body === undefined
        ? { cache: "no-store" }
        : { method: "POST", headers: { "content-type": "application/json", "x-dshcb-csrf": "1" }, body: JSON.stringify(body || {}) };
      const res = await fetch(API + pathname, init);
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (e) {}
      if (!json) throw new Error("响应不是 JSON（HTTP " + res.status + "）");
      if (json.ok === false) throw new Error(json.error || ("HTTP " + res.status));
      if (!res.ok) throw new Error("HTTP " + res.status);
      return json;
    }

    function joinNum(label, n) {
      return /[A-Za-z]$/.test(String(label)) ? String(label) + " " + n : String(label) + n;
    }

    function fmtStamp(s) {
      if (!s) return "—";
      const d = new Date(s);
      if (isNaN(d.getTime())) return String(s);
      const p = (n) => String(n).padStart(2, "0");
      return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    }

    const DIR_KEY = {
      sessions: "dirSessions",
      storages: "dirStorages",
      profiles: "dirProfiles",
      "our-free-model": "dirOurFree",
      "dsh-market": "dirMarket",
      "(根)": "dirRoot",
    };
    const DIR_NOTE_KEY = {
      sessions: "dirSessionsNote",
      storages: "dirStoragesNote",
      profiles: "dirProfilesNote",
      "our-free-model": "dirOurFreeNote",
      "dsh-market": "dirMarketNote",
      "(根)": "dirRootNote",
    };
    function dirLabel(name) {
      return DIR_KEY[name] ? t(DIR_KEY[name]) : String(name);
    }
    function dirRaw(name) {
      return name === "(根)" ? "" : String(name) + "/";
    }
    function dirNote(name) {
      if (DIR_NOTE_KEY[name]) return t(DIR_NOTE_KEY[name]);
      // 工作区目录：DSH 把路径编码成 --C-Users-...-- （分隔符变 -），给他一句人话
      if (/^--.+--$/.test(String(name))) return t("dirWorkspaceNote");
      return "";
    }

  // 选中项跨“切页面 / 卡片卸载重挂”保留：侧栏换页会卸载再挂载，组件内 state 会回到初始值。
  let rpickKeep = null;
  let pickSelKeep = null;
  // 悬停浮层：模块级 store + 独立组件。悬停只重渲染这一层，不牵动整卡（分段控件因此不会再被连累重排/闪烁）。
  const tipStore = {
    v: null,
    subs: [],
    on: function (fn) { this.subs.push(fn); },
    off: function (fn) { this.subs = this.subs.filter(function (g) { return g !== fn; }); },
    set: function (v) { this.v = v; this.subs.slice().forEach(function (fn) { try { fn(v); } catch (e) { /* 单个订阅者出错不影响其它 */ } }); },
  };
  // 提示文案压成一行、过长截断（界面只要简短明确，细节看失败原因行与日志）
  function shortTip(text) {
    const s0 = String(text === undefined || text === null ? "" : text).replace(/\s+/g, " ").trim();
    return s0.length > 42 ? s0.slice(0, 42) + "\u2026" : s0;
  }
  // 浮层定位：以鼠标为中心、默认在其上方 12px；贴边就翻到指针侧边（近边恒定 12px），最后才钳进视口。
  function tipPlace(t, w, h) {
    const pad = 8;
    const gap = 12;
    const vw = (typeof window !== "undefined" && window.innerWidth) || 1024;
    const vh = (typeof window !== "undefined" && window.innerHeight) || 768;
    let left = w ? t.x - w / 2 : t.x + gap;
    let top = h ? t.y - h - gap : t.y + gap;
    if (w) {
      if (left < pad) left = t.x + gap;
      if (left + w > vw - pad) left = t.x - w - gap;
      if (left < pad) left = pad;
      if (left + w > vw - pad) left = Math.max(pad, vw - w - pad);
    }
    if (h) {
      if (top < pad) top = t.y + gap;
      if (top + h > vh - pad) top = Math.max(pad, vh - h - pad);
      if (top < pad) top = pad;
    }
    return { left: left, top: top };
  }
  let tipRAF = 0;
  let tipLast = { x: 0, y: 0 };
  function tipPush(text, x, y, immediate) {
    if (!text) { tipStore.set(null); return; }
    if (immediate) { tipLast = { x: x, y: y }; tipStore.set({ text: text, x: x, y: y }); return; }
    if (Math.abs(x - tipLast.x) < 2 && Math.abs(y - tipLast.y) < 2) return;
    tipLast = { x: x, y: y };
    if (tipRAF) return;
    const schedule = typeof requestAnimationFrame === "function" ? requestAnimationFrame : function (cb) { return setTimeout(cb, 16); };
    tipRAF = schedule(function () { tipRAF = 0; tipStore.set({ text: text, x: tipLast.x, y: tipLast.y }); });
  }
  function TipLayer() {
    const [, bump] = react.useState(0);
    const boxRef = react.useRef(null);
    const size = react.useRef({ w: 0, h: 0 });
    const t = tipStore.v;                                      // 直接读 store：渲染即最新，不依赖 setState 传值
    const notify = function () { bump(function (n) { return n + 1; }); };
    if (tipStore.subs.indexOf(notify) < 0) tipStore.on(notify);  // 渲染期懒注册（宿主不跑 effect 时也能订阅）
    react.useLayoutEffect(function () {
      const el = boxRef.current;
      if (!el) return;
      const w = el.offsetWidth || 0;
      const h = el.offsetHeight || 0;
      if (!w || (size.current.w === w && size.current.h === h)) return;
      size.current = { w: w, h: h };
      notify();
    });
    react.useEffect(function () {
      if (!t) return undefined;
      const clear = function () { tipStore.set(null); };
      if (typeof window !== "undefined") {
        window.addEventListener("scroll", clear, true);
        window.addEventListener("resize", clear);
      }
      return function () {
        if (typeof window !== "undefined") {
          window.removeEventListener("scroll", clear, true);
          window.removeEventListener("resize", clear);
        }
      };
    }, [!!t]);
    if (!t || !t.text) return null;
    const pos = tipPlace(t, size.current.w, size.current.h);
    return react_jsx_runtime.jsx("span", { className: "dshcb-hoverTip", ref: boxRef,
      style: { left: pos.left + "px", top: pos.top + "px" }, children: t.text }, "rowtip");
  }

    function CloudBackupCard() {
      const [status, setStatus] = react.useState(null);
      // ① 一次性结果 / 失败原因 → showTip 浮层，几秒后自动消失，不占版面
      const [tip, setTip] = react.useState(null);
      const tipSeq = react.useRef(0);
      const tipTimer = react.useRef({ handle: null, remain: 0, startedAt: 0 });
      const showTip = function (text, kind) {
        if (!text) return;
        tipSeq.current += 1;
        const id = tipSeq.current;
        setTip({ text: String(text).replace(/\s+/g, " ").trim(), kind: kind || "info", id: id });
        const ms = kind === "err" ? 4000 : kind === "ok" ? 3000 : 2400;
        tipTimer.current.remain = ms;
        tipTimer.current.startedAt = Date.now();
        clearTimeout(tipTimer.current.handle);
        tipTimer.current.handle = setTimeout(function () {
          setTip(function (cur) { return cur && cur.id === id ? null : cur; });
        }, ms);
      };
      const tipHold = function (on) {
        const t = tipTimer.current;
        if (on) {
          if (!t.handle) return;
          clearTimeout(t.handle);
          t.handle = null;
          t.remain = Math.max(600, t.remain - (Date.now() - t.startedAt));
        } else if (t.remain > 0) {
          t.startedAt = Date.now();
          t.handle = setTimeout(function () { setTip(null); }, t.remain);
        }
      };
      const setError = function (m) { if (m) showTip(m, "err"); };
      // 兼容自检只报异常：宿主版本超出声明范围（或声明本身不可解析）时用浮层提示一次，正常时面板上不出现。
      const compatSaid = react.useRef(false);
      react.useEffect(function () {
        const c = status && status.compat;
        if (!c || compatSaid.current || c.ok === true) return;
        const r = String(c.declared || "");
        if (c.ok === false) {
          compatSaid.current = true;
          showTip(r ? t("compatBad").replace("{v}", String(c.runtime || "?")).replace("{r}", r) : t("compatNone"), "err");
        } else if (c.reason === "bad-range") {
          compatSaid.current = true;
          showTip(t("compatBadRange").replace("{r}", r), "err");
        }
      }, [status && status.compat ? String(status.compat.ok) + "|" + String(status.compat.reason) : ""]);
      const [error] = react.useState(null);
      const [busy, setBusy] = react.useState(false);
      // 连接类动作（断连/验证/扫码/免扫码）各自计忙：不占用「立即备份」的 busy，避免误显示「处理中…」
      const [authBusy, setAuthBusy] = react.useState("");
      const [qr, setQr] = react.useState(null);
      const [qrState, setQrState] = react.useState("new"); // new | scanned | done | expired
      const [left, setLeft] = react.useState(0);
      const [bstate, setBstate] = react.useState({ running: false, note: "" });
      const [snaps, setSnaps] = react.useState(null);          // { items:[], totals:{} }
      // 下载收尾后会接着跑还原 / 预览：那些回调闭包来自发起时的那次渲染，
      // 直接用 snaps 会看到「还没下载」的旧状态，于是又弹一次下载确认
      const snapsRef = react.useRef(null);
      snapsRef.current = snaps;
      const snapCache = react.useRef(null);          // 上次成功的结果（切面板先渲染，不白屏）
      const [slowList, setSlowList] = react.useState(false);   // 加载提示延迟出现：有缓存时不再闪字
      react.useEffect(function () {
        if (snaps) { setSlowList(false); return; }
        const id = setTimeout(function () { setSlowList(true); }, 180);
        return function () { clearTimeout(id); };
      }, [!!snaps]);
      const treeCache = react.useRef({});            // stamp -> { root, nodes }：展开时先给上次结果
      const [rpick, setRpickState] = react.useState(rpickKeep);  // 选中的 stamp（还原目标；跨重挂载保留）
      const setRpick = function (v) {
        const next = typeof v === "function" ? v(rpickKeep) : v;
        rpickKeep = next;
        setRpickState(next);
      };
      const [rexpand, setRexpand] = react.useState(null);      // 展开目录树的 stamp（点同一行可收起）
      const [rtarget, setRtarget] = react.useState("");        // 还原目标目录
      const [rconfirm, setRconfirm] = react.useState(true);  // 默认勾选：目标为当前 DSH_HOME 时仍会先弹宿主风格确认框
      const [rstate, setRstate] = react.useState({ busy: "", note: "", result: null });
      const [rsProg, setRsProg] = react.useState(null);       // 还原进度 { done, total, cancelled }：还原期间轮询 /status
      const [batch, setBatch] = react.useState(false);
      const [bsel, setBsel] = react.useState([]);
      const [batchAt, setBatchAt] = react.useState("");
      const [pickSel, setPickSelState] = react.useState(pickSelKeep);  // { stamp, on }：还原前勾选（默认全选，跨重挂载保留）
      const setPickSel = function (v) {
        const next = typeof v === "function" ? v(pickSelKeep) : v;
        pickSelKeep = next;
        setPickSelState(next);
      };
      const [pullPaused, setPullPaused] = react.useState(false); // 下载暂停（后端同样保留进度）
      const [viewBusy, setViewBusy] = react.useState(false);
      const [qrBig, setQrBig] = react.useState(false);
      const [rhist, setRhist] = react.useState(null);
      // 还原提示只在“用户这次真的点了还原”之后出现，打开面板不显示；30 秒后自动收起，也可手动关掉
      const [lrNote, setLrNote] = react.useState(null);
      const lrTimer = react.useRef(null);
      const [histOpen, setHistOpen] = react.useState(false);   // 面板内放大二维码（手机好扫）   // 切视图时后台刷新中
    function copyText(txt) {
      try {
        if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(txt).catch(function () { copyTextFallback(txt); });
          return true;
        }
      } catch (e) {}
      return copyTextFallback(txt);
    }
    function copyTextFallback(txt) {
      try {
        const ta = document.createElement("textarea");
        ta.value = txt;
        ta.setAttribute("readonly", "readonly");
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        const okk = document.execCommand && document.execCommand("copy");
        document.body.removeChild(ta);
        return !!okk;
      } catch (e) { return false; }
    }

    function openLoginInBrowser() {
      const url = loginPageUrl();
      if (!url) return;
      try {
        window.open(url, "_blank", "noopener,noreferrer");
      } catch (e) { /* 静默：真打不开可用「复制链接」 */ }
      startWatch();   // 打开登录页就开始等：登录一完成就自动导入
    }
    const watchRef = react.useRef(null);
    const [watch, setWatch] = react.useState(null);
    function stopWatch(reason) {
      const w = watchRef.current;
      if (!w) return;
      watchRef.current = null;
      if (w.timer) clearTimeout(w.timer);
      // 超时：把「等待中」原地换成一句提示，并留一个取消按钮，而不是悄悄消失
      setWatch(reason === "timeout" ? { timeout: true } : null);
    }
    function startWatch() {
      if (watchRef.current) return;
      const st = { since: Date.now(), deadline: Date.now() + 90000, tries: 0, timer: null };
      watchRef.current = st;
      setWatch({ since: st.since, tries: 0 });
      const tick = async function () {
        const cur = watchRef.current;
        if (!cur) return;
        cur.tries += 1;
        setWatch({ since: cur.since, tries: cur.tries });
        try {
          const r = await call("/auth/watch-local", { since: cur.since });
          if (r && r.found) {
            const imp = await call("/auth/import-local", { since: cur.since });
            if (imp && imp.imported) {
              stopWatch();
              setError(null);
              setQrState("done");
              setQr(null);
              showTip(t("watchAutoDone"), "ok");
              await refresh();
              return;
            }
          }
        } catch (e) { /* 探测失败不打断等待 */ }
        if (Date.now() > cur.deadline) { stopWatch("timeout"); return; }
        cur.timer = setTimeout(tick, 2000);
      };
      st.timer = setTimeout(tick, 1200);
    }
    const WEB_LOGIN_URL = "https://www.alipan.com/sign/in";
    function loginPageUrl() { return WEB_LOGIN_URL; }
      const [sbusy, setSbusy] = react.useState("");            // "" | list | prune-plan | prune-run
      const [rowBusy, setRowBusy] = react.useState("");        // 行内「重试」只让这一行转，不动整表
      const [prune, setPrune] = react.useState({ plan: null, note: "" });
      const [infoOpen, setInfoOpen] = react.useState(false);  // 「连接状态…凭据加密」抽屉（默认收起）
      const [menu, setMenu] = react.useState(false);          // 「更多 ⋮」下拉菜单
      // 弹窗（对齐宿主 Modal 样式）：askDlg 返回 Promise<boolean>，遮罩/取消/Esc 一律 false
      const [dlg, setDlg] = react.useState(null);
      // 排队：同一时刻只显示一个弹窗。若弹窗未关又有人要问，后来的排在队尾，
      // 前一个答完再显示——否则单槽覆盖会让先前的调用方永远 await。
      const dlgQueue = react.useRef([]);
      const askDlg = function (spec) {
        return new Promise(function (resolve) {
          const q = dlgQueue.current;
          const idle = q.length === 0;
          q.push({ spec: spec, resolve: resolve });
          if (idle) setDlg(spec);
        });
      };
      const answerDlg = function (ok) {
        const q = dlgQueue.current;
        const head = q.shift();
        if (head) { try { head.resolve(!!ok); } catch (e) { /* 忽略：调用方已卸载 */ } }
        setDlg(q.length ? q[0].spec : null);
      };
      react.useEffect(function () {
        if (!dlg) return;
        const onKey = function (ev) { if (ev.key === "Escape") answerDlg(false); };
        document.addEventListener("keydown", onKey);
        return function () { document.removeEventListener("keydown", onKey); };
      }, [dlg]);
      // 卸载兜底：组件销毁时若弹窗仍挂着，把 Promise 收掉，避免调用方永久 await
      react.useEffect(function () {
        return function () {
          if (pullPollRef.current) { try { clearInterval(pullPollRef.current); } catch (e) { /* 忽略 */ } pullPollRef.current = null; }
          const q = dlgQueue.current;
          dlgQueue.current = [];
          q.forEach(function (it) { try { it.resolve(false); } catch (e) { /* 忽略：调用方已卸载 */ } });
        };
      }, []);
      react.useEffect(function () {
        if (!menu) return;
        const onDown = function (ev) {
          const el = ev.target;
          if (el && el.closest && el.closest(".dshcb-morewrap")) return;
          setMenu(false);
        };
        document.addEventListener("pointerdown", onDown, true);
        return function () { document.removeEventListener("pointerdown", onDown, true); };
      }, [menu]);
      const [schedBusy, setSchedBusy] = react.useState(false);
      const [schedDraft, setSchedDraft] = react.useState(null);   // 乐观本地值：点击立刻跟手，服务端回来再对齐
      const schedNextDraftState = react.useState(null);   // 乐观的下次自动备份时间
      const schedNextDraft = schedNextDraftState[0], setSchedNextDraft = schedNextDraftState[1];
      const schedSeq = react.useRef(0);                          // 快速连点保护：只认最后一次请求的结果
      const [tree, setTree] = react.useState({ stamp: null, loading: false, root: null, nodes: [], error: "" });
      const [pullInfo, setPullInfo] = react.useState(null);   // { done, total, bytes }：下载状态（轮询 /status）
      const loadSnapsRetry = react.useRef(null);
      const attachedRef = react.useRef(false);          // 正在显示「别人的」在途下载进度
      const pendingPullRef = react.useRef(null);         // 因已有下载被挡下的那次请求，等当前下载结束后自动开始              // 预热/自动对齐的静默重试定时器

      const refresh = react.useCallback(async function () {
        try { setStatus(await call("/status")); setError(null); }
        catch (e) { setError(String((e && e.message) || e)); }
      }, []);

      react.useEffect(function () {
        ensureCss(); refresh(); loadSnaps(false);
        // 预热云端缓存（静默，失败不影响本地视图）
        const warm = setTimeout(function () {
          loadSnaps(true).catch(function () {});
          loadSnapsRetry.current = setTimeout(function () { loadSnaps(true).catch(function () {}); }, 2600);
        }, 400);
        // 状态自动更新：面板可见时每 20 秒对齐一次（走缓存，不打云端）
        const auto = (typeof setInterval === "function") ? setInterval(function () {
          try {
            if (typeof document !== "undefined" && document.visibilityState && document.visibilityState !== "visible") return;
          } catch (e) {}
          refresh().catch(function () {});
          loadSnaps(false).catch(function () {});
        }, 20000) : null;
        // 在途下载的接管：进度是后端单例，重开面板/换页回来同样可见
        const tick = function () {
          try {
            if (typeof document !== "undefined" && document.visibilityState && document.visibilityState !== "visible") return;
          } catch (e) {}
          call("/status").then(function (st) {
            const p = st && st.pull;
            if (p && (p.active || p.paused)) {
              attachedRef.current = true;
              setPullPaused(!!p.paused);
              setPullInfo({ stamp: p.stamp || null, done: p.done || 0, total: p.total || 0, bytes: p.bytes || 0,
                needBytes: p.needBytes || 0, all: p.all || 0, present: p.present || 0, paused: !!p.paused,
                scope: p.scope || 0, scopeFiles: p.scopeFiles || 0, ready: p.ready || 0 });
              return;
            }
            if (!attachedRef.current) return;
            attachedRef.current = false;
            setPullInfo(null);
            const q = pendingPullRef.current;
            pendingPullRef.current = null;
            if (q) { doPull(q); } else { loadSnaps({ fresh: false }).catch(function () {}); }
          }).catch(function () {});
        };
        const watchTimer = (typeof setInterval === "function") ? setInterval(tick, 1500) : null;
        tick();                                    // 先立即对一次：打开面板就能看到已经在跑的下载，不用等 1.5 秒
        return function () { clearTimeout(warm); if (loadSnapsRetry.current) clearTimeout(loadSnapsRetry.current); if (auto) clearInterval(auto); if (watchTimer) clearInterval(watchTimer); };
      }, [refresh]);

      react.useEffect(function () {
        if (!qr) return undefined;
        let stopped = false;
        let inflight = false;        // 慢响应保护：上一次请求未返回前不再发起下一次
        let nextMs = POLL_MS;
        const tickOnce = async function () {
          if (stopped) return;
          setLeft(Math.max(0, Math.ceil((qr.expiresAt - Date.now()) / 1000)));
          if (Date.now() > qr.expiresAt) { setQrState("expired"); setQr(null); return; }
          try {
            const r = await call("/auth/qr/poll", { sessionId: qr.sessionId });
            if (Number.isFinite(r && r.nextPollMs) && r.nextPollMs > 0) {
              nextMs = Math.min(Math.max(Number(r.nextPollMs), 600), 4000);
            }
            if (stopped) return;
            if (r.status === "connected" || r.status === "confirmed") { setQrState("done"); setQr(null); await refresh(); return; }
            if (r.status === "scanned") setQrState("scanned");
            else if (r.status === "connecting") {
              setQrState("connecting");
              if (r.attempt) setQr(function (q) { return q ? Object.assign({}, q, { attempt: r.attempt }) : q; });
            }
            else if (r.status === "failed") {
              setQrState("failed");
              setError((r.reason || t("qrFailed")) + (r.diagPath ? " · " + t("qrDiagAt") + r.diagPath : "") + (r.bizExtRawPath ? " · " + r.bizExtRawPath : ""));
              setQr(null);
              return;
            }
            else if (r.status === "expired") { setQrState("expired"); setQr(null); return; }
          } catch (e) { setError(String((e && e.message) || e)); }
        };
        const tick = async function () {
          if (stopped || inflight) return;
          inflight = true;
          try { await tickOnce(); } finally { inflight = false; }
        };
        let timer = null;
        const loop = async function () {
          await tick();
          if (!stopped) timer = setTimeout(loop, nextMs);
        };
        loop();
        return function () { stopped = true; if (timer) clearTimeout(timer); };
      }, [qr && qr.sessionId, refresh]);

      const startQr = async function () {
        setAuthBusy("qr");
        try {
          const r = await call("/auth/qr/start", {});
          setError(null);
          setQrState("new");
          setQr({
            sessionId: r.sessionId, qr: r.qr, url: r.qrUrl || null,
            page: r.pageUrlAbs || r.pageUrl, pageAbs: r.pageUrlAbs || "" || null, oauth: r.oauthUrl || null,
            expiresAt: Date.now() + (r.expiresInSec || 180) * 1000,
          });
        } catch (e) { setError(String((e && e.message) || e)); setQrState("error"); }
        finally { setAuthBusy(""); }
      };

      const doImportLocal = async function () {
        setAuthBusy("import");
        try {
          await call("/auth/import-local", {});
          setError(null);
          setQrState("done");
          setQr(null);
          await refresh();
        } catch (e) { setError(String((e && e.message) || e)); }
        finally { setAuthBusy(""); }
      };

      const doBackup = async function () {
        setBusy(true); setBstate({ running: true, note: "" });
        try {
          const r = await call("/backup/run", { confirm: true });
          const res = (r && r.result) || {};
          const u = res.upload;
          const refused = res.ok === false ? (t("backupSkip") + (res.reason || "unknown")) : null;
          // 同步云盘关闭时，上传被有意跳过 → 明确告诉用户“只存在本机”，别让人以为备份没做
          const skipped = res.ok !== false && syncOn === false ? t("savedLocalOnly") : "";
          setError(refused);
          setBstate({ running: false, note: skipped || (u ? (u.ok ? "" : String(u.error || "")) : "") });
          await refresh();
          if (res.ok !== false && res.snapshot) {
            const st = res.snapshot;
            const cloudOkRow = !(u && u.ok === false);
            setSnaps(function (cur) {
              const items = (cur && cur.items) || [];
              if (items.some(function (y) { return y.stamp === st; })) return cur;
              const row = { stamp: st, state: cloudOkRow ? "uploaded" : "pending", inCloud: cloudOkRow, hasCache: true,
                files: res.files || null, bytes: res.bytes || null, createdAt: null, uploadedAt: null, cacheBytes: 0 };
              return { items: [row].concat(items), totals: (cur && cur.totals) || {}, cloud: (cur && cur.cloud) || null,
                cloudOk: cur ? cur.cloudOk : true };
            });
            setRpick(function (p) { return p || st; });
            loadSnaps({ fresh: true }).catch(function () {});
          }
          if (refused) setError(refused);
        } catch (e) {
          setError(String((e && e.message) || e));
          setBstate({ running: false, note: "" });
        } finally { setBusy(false); }
      };

      const doOpenLogs = async function () {
        try {
          const r = await call("/logs/open", {});
          showTip((r && r.dir) ? (t("logsOpened") + "：" + r.dir) : t("logsOpened"), "ok");
        } catch (e) {
          showTip(String((e && e.message) || e), "err");
        }
      };
      const doVerify = async function () {
        setAuthBusy("verify");
        try { await call("/auth/verify", {}); setError(null); await refresh(); }
        catch (e) { setError(String((e && e.message) || e)); }
        finally { setAuthBusy(""); }
      };

      const doDisconnect = async function () {
        setAuthBusy("disconnect");
        try { await call("/auth/logout", { confirm: true }); setQr(null); await refresh(); }
        catch (e) { setError(String((e && e.message) || e)); }
        finally { setAuthBusy(""); }
      };

      // remote：调用方的目标视图；opts.fresh = 跳过服务端 45s 清单缓存（切换视图 / 变更后必用）
      const loadSnaps = async function (opts) {
        const fresh = !!(opts && opts.fresh);
        try {
          const r = await call("/backups" + (fresh ? "?fresh=1" : ""));
          const obj = { items: r.items || [], totals: r.totals || {}, cloud: r.cloud || null, cloudOk: r.cloudOk !== false && !(r.cloud && r.cloud.ok === false) };
          snapCache.current = obj;
          setSnaps(obj);
          // 可还原 = 云端有或本机有缓存；默认取最新一条，退回首条
          const usable = obj.items.filter(function (x) { return x.hasCache || x.inCloud; });
          const first = usable[0] || obj.items[0];
          // 必须函数式判断：loadSnaps 会被 20s 自动对齐用“挂载时”的闭包调用，直接读 rpick 会拿到 null 并覆盖用户的选择
          if (first) setRpick(function (p) {
            const alive = p && obj.items.some(function (x) { return x.stamp === p; });
            return alive ? p : first.stamp;
          });
          return true;
        } catch (e) { setError(String((e && e.message) || e)); return false; }
      };

      // 只有「云端有、本地缓存已清」的快照才需要先下载；到点击那一刻才问，界面上不常驻提示
      const pendAct = react.useRef("");                         // 下载完成后要接着做的事：run | preview
      const pullPollRef = react.useRef(null);                   // 下载进度轮询：卸载时要能清掉
      const needDownload = function (stamp) {
        const y = (((snapsRef.current && snapsRef.current.items) || [])).filter(function (it) { return it.stamp === stamp; })[0];
        return !!(y && y.hasCache === false && y.inCloud === true);
      };
      const gateDownload = async function (act) {
        if (!rpick || !needDownload(rpick)) return true;
        const go = await askDlg({ title: t("dlAskTitle"), lead: t("dlAskLead"), confirm: t("dlAskOk"), cancel: t("dlAskNo") });
        if (!go) return false;
        pendAct.current = act;
        doPull(rpick);
        return false;
      };
      // 云端拒绝时（授权失效 / 凭据不完整）：就地给一个重新登录入口
      const doRelogin = function () { openLoginInBrowser(); };

      const doPreview = async function (skipGate) {
        if (!rpick) { setError(t("restorePickFirst")); return; }
        if (!skipGate && !(await gateDownload("preview"))) return;
        setRstate({ busy: "preview", note: "", result: null });
        try {
          const r = await call("/restore/preview", { stamp: rpick, targetRoot: rtarget || undefined, overwrite: rconfirm });
          const p = r.preview || {};
          setRstate({ busy: "", note: t("restoreTarget") + ": " + r.targetRoot + "\n"
            + "total " + p.total + " / write " + p.willWrite + " / skip " + p.willSkip
            + " / overwrite " + p.willOverwrite + " / " + t("restoreMiss") + " " + p.missingBlobs
            + " / " + fmtSize(p.bytes), result: null });
          setError(null);
        } catch (e) { setError(String((e && e.message) || e)); setRstate({ busy: "", note: "", result: null }); }
      };

      const normPath = function (p) { return String(p || "").trim().replace(/[\\/]+$/, "").toLowerCase(); };
      const dshHome = function () { return (status && status.restore && status.restore.dshHome) || ""; };
      const hitsHome = function () {
        const h = dshHome();
        if (!h) return false;
        const typed = normPath(rtarget);
        return typed ? typed === normPath(h) : true;
      };

      const [withPlugins, setWithPlugins] = react.useState(true);  // 默认勾选：快照里带插件时一并装回

      const doPluginPrompt = async function () {
        if (!rpick) return;
        try {
          const r = await call("/plugins/prompt?stamp=" + encodeURIComponent(rpick));
          if (!r || !r.text) { setError(t("pluginPromptFail") + " " + ((r && r.error) || "")); return; }
          // 先让用户看到内容再决定：弹窗里可滚动阅读，确认按钮即「复制」
          const go = await askDlg({ title: t("promptTitle"), lead: t("promptLead"), text: r.text, confirm: t("dlgCopy") });
          if (!go) return;
          const copied = await copyText(r.text);
          showTip(copied ? t("promptCopied") : t("pluginPromptFail") + "（请手动复制）", copied ? "ok" : "err");
        } catch (e) { setError(t("pluginPromptFail") + String((e && e.message) || e)); }
      };

      // 还原期间只轮询 /status：面板此时被这次还原占着，别再发别的请求
      react.useEffect(function () {
        if (rstate.busy !== "run") { setRsProg(null); return undefined; }
        let stop = false;
        const tick = async function () {
          try {
            const st2 = await call("/status");
            if (!stop) setRsProg((st2 && st2.restore && st2.restore.progress) || null);
          } catch (e) { /* 读不到进度不影响还原本身 */ }
        };
        tick();
        const tm = setInterval(function () { tick(); }, 700);
        return function () { stop = true; clearInterval(tm); };
      }, [rstate.busy]);

      // 取消：只请求停止后续写入，正在写的那一个照写完；已写入的保留，不再自动回滚
      const doCancelRestore = async function () {
        setRsProg(function (p) { return Object.assign({ cancelled: true }, p || {}); });
        try { await call("/restore/cancel", {}); } catch (e) { setError(String((e && e.message) || e)); }
      };

      const doRestore = async function (skipGate) {
        if (!rpick) { setError(t("restorePickFirst")); return; }
        if (!skipGate && !(await gateDownload("run"))) return;
        // 后端对 DSH_HOME 目标强制 confirm:true（lib/index.js restore/run）；这里先弹宿主风格确认框，确认后才带上该字段
        const home = hitsHome();
        if (home) {
          const go = await askDlg({
            title: t("homeAskTitle"),
            lead: t("homeAskLead"),
            summary: t("homeAskTo") + ": " + dshHome(),
            lines: [t("homeAskL1"), t("homeAskL2")],
            skip: "",
            confirm: t("homeAskYes"),
          });
          if (!go) { setRstate({ busy: "", note: "", result: null }); setError(null); return; }
        }
        setRstate({ busy: "run", note: "", result: null });
        try {
          const r = await call("/restore/run", { stamp: rpick, targetRoot: rtarget || undefined, overwrite: rconfirm,
            rels: pickRels(rpick), confirm: home ? true : undefined, plugins: withPlugins === true });
          const x = r.result || {};
          setRstate({ busy: "", note: "", result: x });
          setError(null);
          if (x.stopped) showTip(t("rsCancelled"), "info");
          await loadSnaps({ fresh: true });
          await refresh();   // 立刻把“上次还原 / 需重启”读回来，不必等 20 秒的自动对齐
          try {
            const st2 = await call("/status");
            showLrNote((st2 && st2.backup && st2.backup.lastRestore) || null, !!(st2 && st2.backup && st2.backup.needsRestart));
          } catch (e) { showLrNote({ at: new Date().toISOString(), stamp: rpick, restored: x.restored || 0, skipped: x.skipped || 0, plugins: x.plugins || null, targetRoot: x.targetRoot || "" }); }
        } catch (e) { setError(String((e && e.message) || e)); setRstate({ busy: "", note: "", result: null }); }
      };

      // 自重启：后端只负责排计划与接管端口，这里把“点了之后到进程退出”这段时间交代清楚
      const doRestartHost = async function () {
        if (rstate.busy) return;
        setRstate(function (r) { return Object.assign({}, r, { busy: "restart" }); });
        try {
          const r = await call("/restart", { confirm: true });
          const portTxt = (r && r.port) ? (" · " + t("restartPort") + r.port) : "";
          showTip(t("restartDone") + portTxt, "ok");
        } catch (e) {
          setRstate(function (r) { return Object.assign({}, r, { busy: "" }); });
          setError(String((e && e.message) || e));
        }
      };

      const doPull = async function (stamp) {
        const which = (typeof stamp === "string" && stamp) || rpick;
        if (!which) { setError(t("restorePickFirst")); return; }
        setRpick(function (p) { return p || which; });
        setRstate({ busy: "pull", note: "", result: null });
        setPullPaused(false);
        setPullInfo({ done: 0, total: 0, bytes: 0 });
        let stopPoll = false;
        let idlePolls = 0;
        let attached = false;                                     // 被已有下载挡下时：接管进度，别清掉刚设好的进度行
        let live = false;                                         // 后端还在下载：轮询要继续跑，别在 finally 里把它掐掉
        const pollTimer = pullPollRef.current = (typeof setInterval === "function")
          ? setInterval(async function () {
              if (stopPoll) return;
              try {
                const st2 = await call("/status");
                const p = st2 && st2.pull;
                if (p && (p.active || p.paused)) {
                  idlePolls = 0;
                  setPullPaused(!!p.paused);
                  setPullInfo({ stamp: p.stamp || which, done: p.done || 0, total: p.total || 0, bytes: p.bytes || 0,
                    needBytes: p.needBytes || 0, all: p.all || 0, present: p.present || 0, paused: !!p.paused,
                    scope: p.scope || 0, scopeFiles: p.scopeFiles || 0, ready: p.ready || 0 });
                  return;
                }
                  // 后端已经不在下载了：进度与忙碌态就地收尾，避免界面停在「下载中」
                idlePolls += 1;
                if (idlePolls >= 3) {
                  stopPoll = true;
                  pullPollRef.current = null; if (pollTimer) clearInterval(pollTimer);
                  setPullInfo(null);
                  // 下载已结束：把列表与按钮状态刷回正常（工具条与「立即还原」按 rstate 恢复）
                  setRstate(function (r) { return r && r.busy === "pull" ? { busy: "", note: r.note || "", result: r.result || null } : r; });
                  try { await loadSnaps({ fresh: false }); } catch (e) { /* 刷新失败不影响 */ }
                  // 下载是为某个动作服务的：下完就接着做，不让用户再点一次
                  const act = pendAct.current; pendAct.current = "";
                  if (act === "run") { try { await doRestore(true); } catch (e) { /* 已报错 */ } }
                  else if (act === "preview") { try { await doPreview(true); } catch (e) { /* 已报错 */ } }
                }
              } catch (e) { /* 轮询失败不影响主流程 */ }
            }, 1200)
          : null;
        try {
          const rels = pickRels(which);
          if (rels && !rels.length) { setRstate({ busy: "", note: "", result: null }); setError(t("selEmpty")); return; }
          const r = await call("/restore/from-cloud", { stamp: which, rels });
          const p = r.pull || {};
          // 暂停：后端已经停下并保留进度，界面保持“可继续”
          if (p.paused) {
            setPullPaused(true);
            setPullInfo({ stamp: which, done: p.downloaded || 0, total: p.total || 0, bytes: p.bytes || 0,
              needBytes: p.needBytes || 0, all: p.all || 0, present: p.present || 0, paused: true,
              scope: p.scope || 0, scopeFiles: p.scopeFiles || 0, ready: p.ready || 0 });
            setRstate({ busy: "", note: "", result: null });
            setError(null);
            return;
          }
          // 部分块没下来：如实报错（别显示成“下载完成”）
          if (p.ok === false && p.error) {
            pendAct.current = "";
            setRstate({ busy: "", note: "", result: null });
            setError(String(p.error));
            await loadSnaps({ fresh: true });
            return;
          }
          live = true;                                            // 请求返回 ≠ 下载结束：等轮询确认后端停下再收尾
          const dl = p.downloaded || 0;
          const head = dl === 0
            ? which + " · " + t("pullNoNeed")                        // 本地已完整：说清楚不是没下载
            : which + " · " + t("pullGot") + " " + dl + " " + t("pullBlobs") + " / " + fmtSize(p.bytes);
          const srow = ((snaps && snaps.items) || []).filter(function (x) { return x.stamp === which; })[0];
          const snapTxt = (srow && srow.bytes)
            ? (" · " + t("pullSnapTotal") + " " + fmtSize(srow.bytes) + (srow.files ? " / " + srow.files + " " + t("pullFiles") : ""))
            : "";
          setRstate({ busy: "", note: dl === 0 ? t("pullNoNeed") : (t("pullGot") + " " + dl + " " + t("pullBlobs")
              + " \u00b7 " + fmtSize(p.bytes) + " \u00b7 " + (p.seconds || 0) + "s" + snapTxt), result: null });
          setError(null);
          await loadSnaps({ fresh: true });
        } catch (e) {
          const msg = String((e && e.message) || e);
          if (msg.indexOf("\u5df2\u6709\u4e0b\u8f7d\u5728\u8fdb\u884c") >= 0 || msg.indexOf("已有下载在进行") >= 0) {
            // 已经有下载在跑：接管它的进度，并把这次请求排队（否则用户只看到一条 409，什么也做不了）
            attached = true;
            pendingPullRef.current = which;
            attachedRef.current = true;
            setError(null);
            setRstate({ busy: "pull", note: "", result: null });
            try {
              const st3 = await call("/status");
              const p3 = st3 && st3.pull;
              if (p3 && (p3.active || p3.paused)) {
                setPullPaused(!!p3.paused);
                setPullInfo({ stamp: p3.stamp || null, done: p3.done || 0, total: p3.total || 0, bytes: p3.bytes || 0,
                  needBytes: p3.needBytes || 0, all: p3.all || 0, present: p3.present || 0, paused: !!p3.paused,
                  scope: p3.scope || 0, scopeFiles: p3.scopeFiles || 0, ready: p3.ready || 0 });
              }
            } catch (e3) { /* 接管失败就交给全局轮询 */ }
            return;
          }
          setError(msg); setRstate({ busy: "", note: "", result: null });
        }
        finally { if (!live) { stopPoll = true; pullPollRef.current = null; if (pollTimer) clearInterval(pollTimer); if (!attached) setPullInfo(null); } }
      };

      // 展开第一层目录树（只读 manifest，懒加载）
      // 插件数量：目录树里有就用树的，否则用列表项（随快照清单/云盘索引带回来的计数）——
      // 这样“选中那一刻”就能显示插件行，不必等目录树加载完，也不会因树的请求失败而消失
      const plugCountOf = function (stamp) {
        if (!stamp) return 0;
        if (tree && tree.stamp === stamp && Array.isArray(tree.plugins) && tree.plugins.length) return tree.plugins.length;
        const it = (snaps && snaps.items ? snaps.items : []).filter(function (y) { return y.stamp === stamp; })[0];
        return it && Number.isFinite(it.plugins) ? it.plugins : 0;
      };

      const doLoadTree = async function (stamp, fromCloud) {
        if (!stamp) return;
        const prev = treeCache.current[stamp];
        setTree({ stamp: stamp, loading: true, root: prev ? prev.root : null,
          nodes: prev ? prev.nodes : [], error: "", cached: !!prev });
        try {
          const r = await call("/restore/tree?stamp=" + encodeURIComponent(stamp) + "&depth=2" + (fromCloud ? "&remote=1" : ""));
          const val = { root: r.top || null, nodes: (r.top && r.top.children) || [], plugins: Array.isArray(r.plugins) ? r.plugins : [], host: r.runtime || null };
          treeCache.current[stamp] = val;
          setTree({ stamp: stamp, loading: false, root: val.root, nodes: val.nodes, error: "", plugins: val.plugins, host: val.host });
          const selAll = {};
          (val.nodes || []).forEach(function (n) { selAll[n.name] = true; });
          const kept = (pickSelKeep && pickSelKeep.stamp === stamp && pickSelKeep.on) ? pickSelKeep.on : null;
          setPickSel({ stamp: stamp, on: kept || selAll });
          setError(null);
        } catch (e) {
          const keep = treeCache.current[stamp];
          setTree({ stamp: stamp, loading: false, root: keep ? keep.root : null,
            nodes: keep ? keep.nodes : [], error: String((e && e.message) || e) });
        }
      };

      // 勾选：树节点 = 顶层目录；默认全选，这样“下载/还原”默认就是整份
      const rowOf = function (stamp) {
    const items = snaps && snaps.items ? snaps.items : [];
    for (const x of items) if (x && x.stamp === stamp) return x;
    return null;
  };

  const plugBreakdown = function (stamp) {
    const open = tree && tree.stamp === stamp && Array.isArray(tree.plugins) && tree.plugins.length ? tree.plugins : null;
    if (open) {
      const per = {};
      let packed = 0;
      for (const p of open) {
        if (p && p.state === "packed") packed += 1;
        for (const pf of ((p && p.profiles) || [])) per[pf] = (per[pf] || 0) + 1;
      }
      return { n: open.length, packed: packed, per: per };
    }
    const row = rowOf(stamp);
    if (row && row.pluginProfiles) {
      return { n: Number.isFinite(row.plugins) ? row.plugins : 0,
        packed: Number.isFinite(row.pluginPacked) ? row.pluginPacked : null,
        per: row.pluginProfiles };
    }
    const n = plugCountOf(stamp);
    return n > 0 ? { n: n, packed: null, per: null } : null;
  };

  // 插件安装失败时把首个原因给出来（CLI 只回一句 Command failed，真正原因在 pnpm 诊断里）
function plFailTip(pl) {
  const bad = (pl && pl.failed) || [];
  if (!bad.length) return "";
  return bad.map(function (f) { return String((f && f.name) || "") + "：" + String((f && (f.detail || f.error)) || ""); }).join("\n");
}

const plugText = function (stamp) {
    const bd = plugBreakdown(stamp);
    if (!bd) return null;
    const n = String(bd.n);
    const keys = bd.per ? Object.keys(bd.per) : [];
    if (!keys.length) return t("pluginCount").replace("{n}", n);
    const parts = keys.map(function (k) { return k + " " + bd.per[k]; }).join(" · ");
    return t("pluginCountMany").replace("{p}", parts).replace("{n}", n);
  };

  const plugNoteText = function (stamp) {
    const bd = plugBreakdown(stamp);
    if (!bd || bd.packed == null) return t("plugNote");
    return bd.packed > 0
      ? t("plugNotePack").replace("{p}", String(bd.packed)).replace("{s}", String(bd.n - bd.packed))
      : t("plugNote");
  };

  const pickNames = function (stamp) {
        if (!pickSel || pickSel.stamp !== stamp) return null;
        return Object.keys(pickSel.on || {}).filter(function (k) { return pickSel.on[k]; });
      };
      const pickRels = function (stamp) {
        const names = pickNames(stamp);
        if (!names) return undefined;          // 树还没展开：按整份处理
        return names;
      };
      const setPickAll = function (stamp, nodes, on) {
        const map = {};
        (nodes || []).forEach(function (n) { map[n.name] = !!on; });
        setPickSel({ stamp: stamp, on: map });
      };
      const togglePick = function (stamp, name) {
        setPickSel(function (prev) {
          const base = (prev && prev.stamp === stamp && prev.on) ? Object.assign({}, prev.on) : {};
          base[name] = !base[name];
          return { stamp: stamp, on: base };
        });
      };
      const treeHead = function (stamp, nodes) {
        const names = pickNames(stamp) || [];
        const all = (nodes || []).length;
        return react_jsx_runtime.jsxs("div", { className: "dshcb-tnHead", children: [
          react_jsx_runtime.jsx("span", { className: "dshcb-tnSel",
            children: t("selCount").replace("{n}", String(names.length)).replace("{m}", String(all)) }),
          react_jsx_runtime.jsxs("span", { className: "dshcb-tnActs", children: [
            react_jsx_runtime.jsx("button", { type: "button", className: "dshcb-link",
              onClick: function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); setPickAll(stamp, nodes, true); },
              children: t("selAll") }),
            react_jsx_runtime.jsx("button", { type: "button", className: "dshcb-link",
              onClick: function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); setPickAll(stamp, nodes, false); },
              children: t("selNone") }),
          ] }),
        ] }, "tnhead");
      };
      const doPausePull = async function () {
        try { await call("/restore/pause", {}); setPullPaused(true); }
        catch (e) { setError(String((e && e.message) || e)); }
      };

      const dropRows = function (stamps) {
        const gone = new Set(stamps || []);
        if (!gone.size) return;
        setSnaps(function (prev) {
          if (!prev) return prev;
          return Object.assign({}, prev, { items: (prev.items || []).filter(function (x) { return !gone.has(x.stamp); }) });
        });
        setRpick(function (p) { return p && gone.has(p) ? null : p; });
        setRexpand(function (e) { return e && gone.has(e) ? null : e; });
        gone.forEach(function (st) { delete treeCache.current[st]; });
      };

      const doRefreshSnaps = async function (opts) {
        // 只重试某一行时，只让那一行显示忙碌；整表刷新（工具条）才用全局 busy
        const only = (opts && opts.stamp) || "";
        if (only) setRowBusy(only); else setSbusy("list");
        let good = false;
        try { good = await loadSnaps({ fresh: true }); }
        catch (e) { setError(String((e && e.message) || e)); }
        finally { if (only) setRowBusy(""); else setSbusy(""); }
        // 读不到就不能报「已刷新」：错误留在原地，用户才知道是刷新失败
        if (good) { setError(null); if (!only) showTip(t("listRefreshed"), "ok"); }
      };

      // 原生确认已换成宿主风格的弹窗（askDlg）；取消/遮罩/Esc 一律视为不同意
      // 体积按量级换单位：小于 1 MB 用 KB，小于 1 KB 用 B（小目录不会显示成 0.0 MB）
      const fmtSize = function (n) {
        const b = Number(n) || 0;
        if (b < 1024) return b + " B";
        if (b < 1048576) { const kb = b / 1024; return (kb < 10 ? kb.toFixed(1) : String(Math.round(kb))) + " KB"; }
        return (b / 1048576).toFixed(1) + " MB";
      };

      // 删除一份备份：云端进回收站 + 本地缓存一起清（一次确认，符合“一份备份”的心智）
      // 批量删除：进入多选 → 勾选 → 一次确认 → 逐份删（失败即停，已删不回滚）
      const doBatchOn = function () { setBatch(true); setBsel([]); setError(null); };
      const doBatchOff = function () { setBatch(false); setBsel([]); };
      const toggleBsel = function (stamp) {
        setBsel(function (cur) {
          const i = cur.indexOf(stamp);
          return i >= 0 ? cur.filter(function (s2) { return s2 !== stamp; }) : cur.concat([stamp]);
        });
      };
      const batchBytes = function () {
        const items = (snaps && snaps.items) || [];
        let total = 0;
        for (let i = 0; i < bsel.length; i++) {
          const it = items.find(function (x) { return x.stamp === bsel[i]; });
          if (it) total += Number(it.bytes) || 0;
        }
        return total;
      };
      const doBatchDelete = async function () {
        if (!bsel.length) return;
        const pick = bsel.slice();
        setSbusy("bdel");
        let idx = 0;
        try {
          const plans = [];
          for (let i = 0; i < pick.length; i++) {
            const r = await call("/backups/delete", { stamp: pick[i], dryRun: true });
            plans.push({ stamp: pick[i], plan: (r && r.plan) || {} });
          }
          const lastN = plans.filter(function (p) { return p.plan.lastCloudCopy === true; }).length;
          const lines = plans.map(function (p) {
            const row = (snaps && snaps.items ? snaps.items : []).find(function (x) { return x.stamp === p.stamp; }) || null;
            return p.stamp + " · " + fmtSize(p.plan.bytes != null ? p.plan.bytes : (row ? row.bytes : null));
          });
          const go = await askDlg({
            title: t("batchTitle").replace("{n}", String(plans.length)),
            lead: t("batchLead"),
            summary: lastN ? t("batchLast").replace("{n}", String(lastN)) : "",
            lines: lines,
            skip: "",
            confirm: t("dlgDelete"),
          });
          if (!go) { setSbusy(""); return; }
          let done = 0;
          for (idx = 0; idx < plans.length; idx++) {
            const p = plans[idx];
            setBatchAt(t("batchDeleting").replace("{i}", String(idx + 1)).replace("{n}", String(plans.length)));
            await call("/backups/delete", { stamp: p.stamp, dryRun: false, allowLast: p.plan.lastCloudCopy === true });
            done++;
            dropRows([p.stamp]);
            setBsel(function (cur) { return cur.filter(function (s2) { return s2 !== p.stamp; }); });
          }
          setError(null);
          const msg = t("batchDone").replace("{n}", String(done));
          showTip(msg, "ok");
          await loadSnaps({ fresh: true });
          await refresh();
          setBatch(false);
          setBsel([]);
        } catch (e) {
          const m = String((e && e.message) || e);
          const stop = t("batchFailStop").replace("{i}", String(idx + 1)).replace("{err}", m);
          setError(m);
          showTip(stop, "err");
        } finally { setBatchAt(""); setSbusy(""); }
      };

      const doDelete = async function (stamp) {
        if (!stamp) return;
        setSbusy("del"); setRpick(stamp);
        try {
          const planRes = await call("/backups/delete", { stamp: stamp, dryRun: true });
          const pl = (planRes && planRes.plan) || {};
          const cacheMb = fmtSize(pl.cacheBytes);
          const last = pl.lastCloudCopy === true;
          const lines = [stamp, t("delBackupCloud")];
          if (pl.hasCache) lines.push(t("delBackupCache").replace("{mb}", cacheMb));
          const go = await askDlg({
            title: t("delBackupTitle"),
            lead: t("delBackupLead"),
            summary: last ? t("delBackupLast") : "",
            lines: lines,
            skip: "",
            confirm: t("dlgDelete"),
          });
          if (!go) { setSbusy(""); return; }
          const r = await call("/backups/delete", { stamp: stamp, dryRun: false, allowLast: last });
          dropRows([stamp]);
          showTip(t("delDone") + " " + stamp + (r && r.cacheDeleted ? " · " + t("cacheCleanTag") : ""), "ok");
          setError(null);
          await loadSnaps({ fresh: true });
          await refresh();
        } catch (e) {
          const m = String((e && e.message) || e);
          setError(m); showTip(m, "err");
        } finally { setSbusy(""); }
      };

      // 清理本地缓存：只动本机为还原下载的副本，云端备份不受影响
      const doClearCache = async function () {
        setSbusy("cache");
        try {
          const pre = await call("/maintenance/cache", { dryRun: true });
          const st = (pre && pre.stats) || {};
          const keepN = 3;
          const cand = Math.max(0, (Number(st.copies) || 0) - keepN);
          if (!cand) { showTip(t("cacheCleanNone"), "info"); setSbusy(""); return; }
          const go = await askDlg({
            title: t("cacheCleanTitle"),
            lead: t("cacheCleanLead"),
            summary: t("cacheCleanKeep").replace("{n}", String(keepN)),
            lines: [(Number(st.copies) || 0) + " -> " + cand + " · " + fmtSize(st.bytes)],
            skip: "",
            confirm: t("cacheCleanBtn"),
          });
          if (!go) { setSbusy(""); return; }
          const r = await call("/maintenance/cache", { dryRun: false, keep: keepN });
          const nDel = (r && Array.isArray(r.deleted)) ? r.deleted.length : 0;
          showTip(t("cacheCleanDone").replace("{n}", String(nDel)).replace("{mb}", fmtSize(r && r.freed)), "ok");
          setError(null);
          await loadSnaps({ fresh: true });
        } catch (e) { const cm = String((e && e.message) || e); setError(cm); showTip(cm, "err"); }
        finally { setSbusy(""); }
      };

      const doUpload = async function (stamp) {
        if (!stamp) return;
        setSbusy("upload"); setRpick(stamp);
        try {
          await call("/backups/upload", { stamp: stamp });
          showTip(t("uploadDone") + " " + stamp, "ok");
          setError(null);
          await loadSnaps({ fresh: true });
          await refresh();
        } catch (e) { const cm = String((e && e.message) || e); setError(cm); showTip(cm, "err"); }
        finally { setSbusy(""); }
      };

      const saveSched = async function (patch) {
        setSchedDraft(function (prev) { return Object.assign({}, prev, patch); });
        if (patch.intervalMinutes !== undefined || patch.enabled !== undefined) {
          const cfgNow = ((status && status.backup && status.backup.config) || {});
          const minsNext = Number(patch.intervalMinutes !== undefined ? patch.intervalMinutes
            : (schedDraft && schedDraft.intervalMinutes !== undefined ? schedDraft.intervalMinutes : cfgNow.intervalMinutes)) || 60;
          const onNext = patch.enabled !== undefined ? !!patch.enabled
            : (schedDraft && schedDraft.enabled !== undefined ? !!schedDraft.enabled : cfgNow.enabled !== false);
          setSchedNextDraft(onNext ? { at: Date.now() + minsNext * 60000, base: (status && status.schedule && status.schedule.nextAt) || null } : null);
        }   // 先滑到新位置，不等网络
        setSchedBusy(true);
        schedSeq.current += 1;
        const seq = schedSeq.current;
        try {
          const cfg = ((status && status.backup && status.backup.config) || {});
          await call("/backup/config", Object.assign({
            enabled: cfg.enabled !== false, intervalMinutes: Number(cfg.intervalMinutes) || 60,
          }, patch));
          if (seq !== schedSeq.current) return;
          setError(null);
          await refresh();
          if (seq === schedSeq.current) setSchedDraft(null);   // 服务端值已落地，交回权威值
        } catch (e) {
          if (seq === schedSeq.current) { setSchedDraft(null); setSchedNextDraft(null); setError(String((e && e.message) || e)); }
        } finally { if (seq === schedSeq.current) setSchedBusy(false); }
      };

      const doVerifyRestore = async function () {
        if (!rpick) { setError(t("restorePickFirst")); return; }
        setRstate({ busy: "verify", note: "", result: null });
        try {
          const r = await call("/restore/verify", { stamp: rpick, targetRoot: rtarget || undefined });
          const v = r.verify || {};
          setRstate({ busy: "", note: "same " + v.same + " / diff " + v.diff + " / " + t("restoreMiss") + " " + v.missing
            + (v.ok ? "  ✓" : "  ✗"), result: null });
          setError(null);
        } catch (e) { setError(String((e && e.message) || e)); setRstate({ busy: "", note: "", result: null }); }
      };

      const noteBN = bstate && bstate.note;
      react.useEffect(function () {
        if (!noteBN) return;
        showTip(noteBN, "info");
        setBstate(function (cur) { return { running: !!cur.running, note: "" }; });
      }, [noteBN]);
      const noteRN = rstate && rstate.note;
      const resRN = rstate && rstate.result;
      react.useEffect(function () {
        if (!noteRN && !resRN) return;
        const wsM = resRN && resRN.mergedWorkspace;
        const pgS = resRN && resRN.pluginSummary;
        const pgNote = (pgS && (pgS.skipped || pgS.failed))
          ? " \u00b7 " + ((pgS.skippedBlob || 0) > 0
            ? t("rgPlSkipMix").replace("{n}", String(pgS.skipped || 0)).replace("{s}", String(pgS.skippedScoped || 0)).replace("{b}", String(pgS.skippedBlob || 0))
            : t("rgPlSkip").replace("{n}", String(pgS.skipped || 0)).replace("{p}", (pgS.others || []).join(", ") || "-"))
          : "";
        const rsNote = (resRN && resRN.restored > 0) ? " \u00b7 " + t("rgRestart") : "";
        const txt = noteRN || ("\u8fd8\u539f\u5b8c\u6210 \u00b7 \u5199\u5165 " + ((resRN && resRN.restored) || 0)
          + " \u00b7 \u8df3\u8fc7 " + ((resRN && resRN.skipped) || 0)
          + " \u00b7 \u8986\u76d6 " + ((resRN && resRN.overwritten) || 0)
          + ((resRN && resRN.skippedDiff > 0) ? " \u00b7 " + t("restoreSkippedMix").replace("{d}", String(resRN.skippedDiff)) : "")
          + (wsM ? " \u00b7 " + t("wsMergedNote").replace("{a}", String(wsM.added || 0)).replace("{k}", String(wsM.kept || 0)).replace("{j}", String(wsM.sessionsAdded || 0)) : "")
          + pgNote + rsNote);
        if (!(resRN && resRN.stopped)) showTip(txt, resRN && resRN.ok === false ? "err" : "ok");
        setRstate(function (cur) { return { busy: "", note: "", result: null }; });
      }, [noteRN, resRN]);
      // 清理/删除/上传的收尾说明统一进消息层，不再另外弹 toast（同一件事只说一次）

      const auth = status && status.auth;
      const connected = !!(auth && auth.connected);
      const account = (auth && auth.account) || {};
      // 状态点四态：ok 蓝（已连接）/ busy 琥珀（刷新·备份进行中）/ err 红（连接失败）/ off 灰（未连接）
      const connState = connected
        ? ((sbusy || busy || authBusy || bstate.running || schedBusy || rstate.busy) ? "s-busy" : "s-ok")
        : (error ? "s-err" : "s-off");


      function Ico(name, size) {
        const s = size || 15;
        const P = {
          cloudBackup: [
            "M7 14.6a3.7 3.7 0 0 1-.4-7.36A5.2 5.2 0 0 1 16.6 6.7 3.4 3.4 0 0 1 16.9 14.6",
            "M12 11.8v7.4M9.7 16.9 12 19.2 14.3 16.9",
          ],
          cloudDown: [
            "M7 15.1a3.6 3.6 0 0 1-.4-7.15A5.05 5.05 0 0 1 16.3 7.2 3.3 3.3 0 0 1 16.6 15.1",
            "M12 12.2v6.6M9.8 16.6 12 18.8 14.2 16.6",
          ],
          cloudUp: [
            "M7 15.1a3.6 3.6 0 0 1-.4-7.15A5.05 5.05 0 0 1 16.3 7.2 3.3 3.3 0 0 1 16.6 15.1",
            "M12 18.8v-6.6M9.8 14.4 12 12.2l2.2 2.2",
          ],
          chevDown: "M6 9.5 12 15.5 18 9.5",
          chevRight: "M9.5 6 15.5 12 9.5 18",
          trash: "M4.5 7.5h15M9.5 7.5V5.2h5v2.3M7 7.5l.8 12h8.4L17 7.5M10.6 11v5.6M13.4 11v5.6",
          refresh: "M19.6 12a7.6 7.6 0 1 1-2.5-5.6M19.9 4.9v5.2h-5.2",
          docSearch: "M13.6 3.6H7.2A1.9 1.9 0 0 0 5.3 5.5v13A1.9 1.9 0 0 0 7.2 20.4h4.1M13.6 3.6 18.9 8.9v3.4M13.6 3.6v5.3h5.3M15.7 20.9a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8ZM18.4 20.2l2.3 2.3",
          folder: "M3.7 7.7A1.9 1.9 0 0 1 5.6 5.8h3.2l1.7 1.9h7.9a1.9 1.9 0 0 1 1.9 1.9v6.4a1.9 1.9 0 0 1-1.9 1.9H5.6a1.9 1.9 0 0 1-1.9-1.9V7.7Z",
          check: "M20 6.4 9.6 17 4.6 12",
          warn: "M12 3.8 21.2 19.9H2.8L12 3.8ZM12 9.6v4.7M12 17.3h.01",
          close: "M5.9 5.9 18.1 18.1M18.1 5.9 5.9 18.1",
          info: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M12 11.2v5.2", "M12 7.6h.01"],
        };
        if (name === "dots") {
          return react_jsx_runtime.jsxs("svg", { width: s, height: s, viewBox: "0 0 24 24", className: "dshcb-ico", "aria-hidden": "true",
            children: [
              react_jsx_runtime.jsx("circle", { cx: 12, cy: 5.4, r: 1.7, fill: "currentColor" }),
              react_jsx_runtime.jsx("circle", { cx: 12, cy: 12, r: 1.7, fill: "currentColor" }),
              react_jsx_runtime.jsx("circle", { cx: 12, cy: 18.6, r: 1.7, fill: "currentColor" }),
            ] });
        }
        const d = P[name] || "";
        const kids = Array.isArray(d)
          ? d.map(function (x, i) { return react_jsx_runtime.jsx("path", { d: x }, i); })
          : react_jsx_runtime.jsx("path", { d: d });
        return react_jsx_runtime.jsx("svg", {
          width: s, height: s, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
          strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round",
          className: "dshcb-ico", "aria-hidden": "true", children: kids,
        });
      }

      function Seg(props) {
        const items = props.items || [];
        const value = props.value;
        const onPick = props.onPick;
        const disabled = !!props.disabled;
        const box = react.useRef(null);
        const last = react.useRef(null);              // 上次量到的几何，避免重复 setState
        const [geo, setGeo] = react.useState(null);   // { left, width }：当前选项的位置与宽度
        const [canAnim, setCanAnim] = react.useState(false);   // 只有“用户真的切换选项”才滑动；布局重测不动画（否则悬停时会闪）
        // value 短暂不在 items 里（配置还没回来 / 下载期间刷新）时沿用上次位置，避免滑块跳回第一个位置“闪”
        const found = items.findIndex(function (it) { return it.value === value; });
        const lastIdx = react.useRef(0);
        if (found >= 0) lastIdx.current = found;
        const idx = found >= 0 ? found : lastIdx.current;
        const prevValue = react.useRef(value);
        react.useEffect(function () {
          if (prevValue.current !== value) { prevValue.current = value; setCanAnim(true); }
        }, [value]);
        // 几何测量：值没变就不 setState（避免每一帧重渲染）；容器或选项尺寸变化时也重新贴合
        const measure = function (animate) {
          const el = box.current;
          if (!el) return;
          const node = el.querySelectorAll("button")[idx];
          if (!node) return;
          const next = { left: node.offsetLeft, width: node.offsetWidth };
          const prev = last.current;
          if (prev && prev.left === next.left && prev.width === next.width) return;
          last.current = next;
          setCanAnim(!!animate);
          setGeo(next);
        };
        const measureRef = react.useRef(measure);
        measureRef.current = measure;
        const seen = react.useRef(false);
        react.useEffect(function () {
          const first = !seen.current;                                  // 首次定位直接落位，不滑动
          seen.current = true;
          const run = function () { measureRef.current(!first); };       // 选项变了 → 滑动过去
          const relayout = function () { measureRef.current(false); };   // 只是布局重排 → 直接贴合，不动画（悬停时不会闪）
          run();
          window.addEventListener("resize", relayout);
          let ro = null;
          if (typeof ResizeObserver === "function" && box.current) {
            ro = new ResizeObserver(relayout);
            ro.observe(box.current);
            const btns = box.current.querySelectorAll("button");
            for (let i = 0; i < btns.length; i += 1) ro.observe(btns[i]);
          }
          return function () {
            window.removeEventListener("resize", relayout);
            if (ro) ro.disconnect();
          };
        }, [idx, items.length, disabled]);
        return react_jsx_runtime.jsxs("div", {
          className: "dshcb-seg" + (disabled ? " dis" : "") + (props.small ? " sm" : ""), ref: box,
          children: [
            geo ? react_jsx_runtime.jsx("span", {
              className: "dshcb-segthumb" + (canAnim ? "" : " notrans"),
              style: { transform: "translateX(" + geo.left + "px)", width: geo.width + "px" },
            }, "thumb") : null,
          ].concat(items.map(function (it) {
            const on = it.value === value;
            return react_jsx_runtime.jsx("button", {
              type: "button", className: "dshcb-segi" + (on ? " on" : ""),
              disabled: disabled, onClick: function () { if (!disabled) onPick(it.value); },
              children: it.label,
            }, String(it.value));
          })),
        });
      }

      // 悬停提示走模块级小 store（见 TipLayer）：悬停只重渲染浮层，不牵动整卡与分段控件
      function tipProps(text) {
        const str = shortTip(text);
        if (!str) return {};
        return {
          onMouseEnter: function (e) { tipPush(str, e.clientX, e.clientY, true); },
          onMouseMove: function (e) { tipPush(str, e.clientX, e.clientY, false); },
          onMouseDown: function () { tipStore.set(null); },
          onMouseLeave: function () { tipStore.set(null); },
        };
      }
      function tool(label, icon, fn, on, disabled, warn) {
        return react_jsx_runtime.jsxs("button", {
          type: "button", className: "dshcb-tool" + (on ? " on" : "") + (warn ? " warn" : ""),
          disabled: !!disabled || !!rstate.busy || !!sbusy, onClick: fn,
          children: [Ico(icon, 15), react_jsx_runtime.jsx("span", { children: label })],
        });
      }

      function menuItem(label, fn, danger, busy) {
        return react_jsx_runtime.jsx("button", {
          type: "button", className: "dshcb-mi" + (danger ? " danger" : ""),
          disabled: !!busy || !!authBusy, onClick: fn, children: busy ? t("busy") : label,
        });
      }

      // 还原提示与「还原记录」共用同一套字段：时间 · 快照 ID · 写入 · 跳过 · 装回插件 · 跳过插件
      // 记录里的插件段既可能是名单数组（真还原写入），也可能是计数（早先记录/兜底），两种都要能显示
      const plCount = function (v) { return Array.isArray(v) ? v.length : (Number.isFinite(v) ? v : 0); };
      const lrRowText = function (lr) {
        const h = lr || {};
        const pl = h.plugins || null;
        const bits = [fmtStamp(h.at), h.stamp || "-", t("lrWritten") + " " + (h.restored || 0), t("lrSkipped") + " " + (h.skipped || 0)];
        if ((h.failed || 0) > 0) bits.push(t("lrFailed") + " " + h.failed);
        if (pl) {
          bits.push(t("lrPluginsOk") + " " + plCount(pl.installed));
          bits.push(t("lrPlSkip").replace("{n}", String(plCount(pl.skipped))));
          if (plCount(pl.skippedBlob) > 0) bits.push(t("lrPlBlob").replace("{b}", String(plCount(pl.skippedBlob))));
          if (plCount(pl.failed) > 0) bits.push(t("lrPluginsFail") + " " + plCount(pl.failed));
        }
        return bits.join(" · ");
      };
      const showLrNote = function (lr, keepOpen) {
        if (!lr) return;
        setLrNote(lr);
        if (lrTimer.current) clearTimeout(lrTimer.current);
        // 这次还原还没重启 DSH：把这一行留在原位（重启后 needsRestart 自然变回 false），别让它先自己溜走
        if (keepOpen) { lrTimer.current = null; return; }
        lrTimer.current = setTimeout(function () { setLrNote(null); }, 30 * 1000);
      };
      const doHistory = async function () {
        if (histOpen) { setHistOpen(false); return; }
        try {
          const r = await call("/restore/history");
          setRhist((r && r.items) || []);
        } catch (e) { setRhist([]); }
        setHistOpen(true);
      };

      const bk = (status && status.backup) || {};
      const needsRestart = bk.needsRestart === true;
      const rsTotal = (rsProg && Number(rsProg.total)) || 0;
      const rsDone = (rsProg && Number(rsProg.done)) || 0;
      // 还原请求返回前不能显示 100%：收尾阶段（登记表合并 / 落盘）不产生步进，
      // 显示满格会让「正在还原」看上去卡住不动
      const rsPct = rsTotal > 0 ? Math.max(1, Math.min(99, Math.round((rsDone / rsTotal) * 100))) : 0;
      const rsCancelling = !!(rsProg && rsProg.cancelled);
      const last = bk.last || null;
      const bkcfg = bk.config || {};
      const sch = (status && status.schedule) || {};
      const schedDraftOn = !!schedDraft && schedDraft.enabled !== undefined ? !!schedDraft.enabled : null;
      const schedOn = schedDraftOn === null ? (bkcfg.enabled !== false) : schedDraftOn;
      const syncDraftOn = !!schedDraft && schedDraft.autoUpload !== undefined ? !!schedDraft.autoUpload : null;
      const syncOn = syncDraftOn === null ? (bkcfg.autoUpload !== false) : syncDraftOn;
      const sideDraftOn = !!schedDraft && schedDraft.sidebarEntry !== undefined ? !!schedDraft.sidebarEntry : null;
      const sideOn = sideDraftOn === null ? (bkcfg.sidebarEntry !== false) : sideDraftOn;
      const schedMinSrv = Number(sch.intervalMinutes || bkcfg.intervalMinutes || 60);
      // 有乐观值时优先显示它，切 tab 立即生效（否则要等后端 tick）
      const srvNextAt = sch.nextAt || null;
      const schedNextAt = (schedNextDraft && srvNextAt === schedNextDraft.base) ? new Date(schedNextDraft.at).toISOString() : srvNextAt;
      const schedMin = (schedDraft && schedDraft.intervalMinutes !== undefined)
        ? Number(schedDraft.intervalMinutes) : schedMinSrv;
      const intervalOptions = [60, 360, 1440];
      const curInterval = intervalOptions.indexOf(schedMin) >= 0 ? schedMin : 60;
      const acctName = account.user_name || account.nick_name || account.user_id || "—";
      const snapList = (snaps && (snaps.merged || snaps.local)) || [];
      const lastText = last
        ? (fmtStamp(last.at) + " · " + (last.files || 0) + " " + t("backupFiles") + " / " + fmtSize(last.bytes)
           + (last.upload
             ? (last.upload.ok === true ? " · " + t("backupUploaded")
                : last.upload.ok === false ? " · " + t("backupUploadFail")
                : " · " + t("backupUploadSkipped"))
             : ""))
        : t("never");
      const sumLine = t("rowConnect") + " " + (connected ? t("connected") : t("notConnected"))
        + (connected ? " · " + t("rowAccount") + " " + acctName : "");

      const qrPanel = qr ? react_jsx_runtime.jsxs("div", {
        className: "dshcb-qrbox",
        children: [
          react_jsx_runtime.jsx("div", { className: "dshcb-qrhead", children: t("qrTitle") }),
          react_jsx_runtime.jsx("img", { className: "dshcb-qr" + (qrBig ? " big" : ""), src: qr.qr, alt: "QR", width: qrBig ? 320 : 208, height: qrBig ? 320 : 208, title: qrBig ? "\u70b9\u4e00\u4e0b\u6062\u590d\u5927\u5c0f" : "\u70b9\u4e00\u4e0b\u653e\u5927", onClick: function () { setQrBig(!qrBig); } }),
          react_jsx_runtime.jsx("div", { className: "dshcb-qrstate" + (qrState === "scanned" || qrState === "connecting" ? " ok" : ""),
            children: qrState === "scanned" ? t("qrScanned")
              : qrState === "connecting" ? (t("qrConnecting") + (qr && qr.attempt ? " \u00b7 " + t("qrTry") + " " + qr.attempt + "/12" : ""))
              : t("qrNew") }),
          react_jsx_runtime.jsx("div", { className: "dshcb-qrhint", children: t("qrExpireIn") + " " + left + " " + t("seconds") }),
          react_jsx_runtime.jsx("div", { className: "dshcb-qrrow", children: [
            react_jsx_runtime.jsx("button", { type: "button", className: "dshcb-linkbtn", onClick: function () { setQrBig(!qrBig); }, children: qrBig ? t("qrZoomOut") : t("qrZoom") }),
            react_jsx_runtime.jsx("button", { type: "button", className: "dshcb-linkbtn", onClick: openLoginInBrowser, title: loginPageUrl(), children: t("openBrowserLogin") }),
            react_jsx_runtime.jsx("button", { type: "button", className: "dshcb-linkbtn", onClick: function () { const u = loginPageUrl(); if (!u) return; const c = copyText(u); showTip(c ? t("linkCopied") : (t("linkCopyManual") + u), c ? "ok" : "err"); }, children: t("copyLink") }),
          ] }),

          watch ? react_jsx_runtime.jsxs("div", { className: "dshcb-watch", children: watch.timeout ? [
            react_jsx_runtime.jsx("span", { children: t("watchTimeout") }),
            react_jsx_runtime.jsx("button", { type: "button", className: "dshcb-linkbtn", onClick: function () { setWatch(null); }, children: t("watchDismiss") }),
          ] : [
            react_jsx_runtime.jsx("span", { className: "dshcb-spin" }),
            react_jsx_runtime.jsx("span", { children: t("watchWait") }),
            react_jsx_runtime.jsx("button", { type: "button", className: "dshcb-linkbtn", onClick: function () { stopWatch(); }, children: t("watchCancel") }),
          ] }) : null,

          react_jsx_runtime.jsx("div", { className: "dshcb-qrhint", children: t("qrNote") }),
        ],
      }) : null;
      const headPanel = react_jsx_runtime.jsxs("div", { className: "dshcb-head", children: [
        react_jsx_runtime.jsxs("div", { className: "dshcb-headL", children: [
          Ico("cloudBackup", 22),
          react_jsx_runtime.jsx("span", { className: "dshcb-h1", children: t("title") }),
          react_jsx_runtime.jsx("span", { className: "dshcb-ver", children: status && status.version ? ("v" + status.version) : t("phaseLoading") }),
        ] }),
        react_jsx_runtime.jsxs("div", { className: "dshcb-headR", children: [
          react_jsx_runtime.jsxs("span", { className: "dshcb-state " + connState, children: [
            react_jsx_runtime.jsx("i", { className: "dshcb-dot" }),
            connected ? t("connected") : t("notConnected"),
          ] }),
          react_jsx_runtime.jsxs("div", { className: "dshcb-morewrap", children: [
            react_jsx_runtime.jsxs("button", { type: "button", className: "dshcb-more",
              onClick: function () { setMenu(!menu); }, children: [t("more"), Ico("dots", 14)] }),
            menu ? react_jsx_runtime.jsxs("div", { className: "dshcb-menu", children: [
              // 顺序按效果图：断开连接 / 刷新状态 / 验证连接
              connected ? menuItem(t("disconnect"), function () { setMenu(false); doDisconnect(); }, false, authBusy === "disconnect") : null,
              menuItem(t("refresh"), function () { setMenu(false); refresh(); }),
              !connected ? menuItem(t("importLocal"), function () { setMenu(false); doImportLocal(); }, false, authBusy === "import") : null,
              connected ? menuItem(t("verify"), function () { setMenu(false); doVerify(); }, false, authBusy === "verify") : null,
              menuItem(t("openLogs"), function () { setMenu(false); doOpenLogs(); }),
            ] }) : null,
          ] }),
        ] }),
      ] });

      // ② 授权信息（可折叠表格）
      const renewText = !connected ? "—" : t("renewOn");

      const authRows = [
        [t("rowConnect"), connected ? t("connected") : t("notConnected"), connected ? "" : "warn"],
        [t("rowAccount"), acctName, ""],
        [t("rowDrive"), (auth && auth.drive_id) || "—", ""],
        [t("rowFolder"), (status && status.folder && status.folder.name) || (status && status.appFolder) || "—", ""],
        [t("rowRefresh"), renewText, ""],
        [t("rowLastBackup"), bstate.running ? t("backupRunning") : lastText,
          last && last.upload && last.upload.ok === false ? "warn" : ""],
        [t("verified"), (status && status.lastVerifiedAt) || t("never"), ""],
        [t("rowHost"), (function () {
          const h = (status && status.backup && status.backup.host) || null;
          if (!h) return "—";
          return h.shape === "desktop" ? t("hostDesktop")
            : h.shape === "web" ? t("hostWeb") : t("hostGeneric");
        })(), ""],
        [t("rowStateDir"), (status && status.stateDir) || "—", ""],
        [t("rowCrypto"), (status && status.secretBackend) || "—", ""],
      ];
      const authPanel = react_jsx_runtime.jsxs("div", { className: "dshcb-sec", children: [
        react_jsx_runtime.jsxs("button", { type: "button", className: "dshcb-sech",
          "aria-expanded": infoOpen ? "true" : "false",
          onClick: function () { setInfoOpen(!infoOpen); },
          children: [
            react_jsx_runtime.jsx("span", { className: "dshcb-sechT", children: t("secAuth") }),
            infoOpen ? null : react_jsx_runtime.jsx("span", { className: "dshcb-sechS", children: sumLine }),
            react_jsx_runtime.jsx("span", { className: "dshcb-sechIco", children: Ico(infoOpen ? "chevDown" : "chevRight", 16) }),
          ] }),
        infoOpen ? react_jsx_runtime.jsx("div", { className: "dshcb-table", children: authRows.map(function (r, i) {
          return react_jsx_runtime.jsxs("div", { className: "dshcb-tr", children: [
            react_jsx_runtime.jsx("span", { className: "dshcb-tk", children: r[0] }),
            react_jsx_runtime.jsx("span", { className: "dshcb-tv" + (r[2] ? " dshcb-" + r[2] : ""), children: r[1] }),
          ] }, "tr-" + i);
        }) }) : null,
      ] });

      const syncPanel = connected ? react_jsx_runtime.jsxs("div", { className: "dshcb-sec", children: [
        react_jsx_runtime.jsxs("div", { className: "dshcb-sech", children: [
          react_jsx_runtime.jsx("span", { className: "dshcb-sechT", children: t("syncTitle") }),
          react_jsx_runtime.jsxs("div", { className: "dshcb-sechR", children: [
            react_jsx_runtime.jsx(Seg, {
              items: [{ label: t("syncOff"), value: "off" }, { label: t("syncOn"), value: "on" }],
              value: syncOn ? "on" : "off",
              onPick: function (v) { saveSched({ autoUpload: v === "on" }); },
              disabled: !!schedBusy, small: true,
            }),
          ] }),
        ] }),
        react_jsx_runtime.jsx("div", { className: "dshcb-line", children: [
          react_jsx_runtime.jsx("span", { className: "dshcb-lineText", children: syncOn ? t("syncOnLine") : t("syncOffLine") }),
        ] }),
      ] }) : null;

      // 未连接时不显示入口设置：这一行的意义是「连上之后想在哪儿看到它」
      const sidePanel = !connected ? null : react_jsx_runtime.jsxs("div", { className: "dshcb-sec", children: [
        react_jsx_runtime.jsxs("div", { className: "dshcb-sech", children: [
          react_jsx_runtime.jsx("span", { className: "dshcb-sechT", children: t("sideEntry") }),
          react_jsx_runtime.jsxs("div", { className: "dshcb-sechR", children: [
            react_jsx_runtime.jsx(Seg, {
              items: [{ label: t("syncOff"), value: "off" }, { label: t("syncOn"), value: "on" }],
              value: sideOn ? "on" : "off",
              onPick: function (v) { const on = v === "on"; setSideEntryOn(on); saveSched({ sidebarEntry: on }); },
              disabled: !!schedBusy, small: true,
            }),
          ] }),
        ] }),
        react_jsx_runtime.jsx("div", { className: "dshcb-line", children: [
          react_jsx_runtime.jsx("span", { className: "dshcb-lineText", children: sideOn ? t("sideEntryOn") : t("sideEntryOff") }),
        ] }),
      ] });

      const schedPanel = connected ? react_jsx_runtime.jsxs("div", { className: "dshcb-sec", children: [
        react_jsx_runtime.jsxs("div", { className: "dshcb-sech", children: [
          react_jsx_runtime.jsx("span", { className: "dshcb-sechT", children: t("schedTitle") }),
          react_jsx_runtime.jsxs("div", { className: "dshcb-sechR", children: [
            react_jsx_runtime.jsx(Seg, {
              items: intervalOptions.map(function (m) { return { label: (m / 60) + t("schedHours"), value: m }; }),
              value: curInterval, onPick: function (m) { saveSched({ intervalMinutes: Number(m), enabled: true }); },
              disabled: !schedOn,
            }),
            react_jsx_runtime.jsx(Seg, {
              items: [{ label: t("schedOffShort"), value: "off" }, { label: t("schedOnShort"), value: "on" }],
              value: schedOn ? "on" : "off", onPick: function (v) { saveSched({ enabled: v === "on" }); },
            }),
          ] }),
        ] }),
        react_jsx_runtime.jsxs("div", { className: "dshcb-line", children: [
          react_jsx_runtime.jsx("span", { className: "dshcb-lineText", children: schedOn
            ? (t("schedOnLine") + t("schedNextLine") + "：" + (schedNextAt ? fmtStamp(schedNextAt) : t("schedPending"))
               + (sch.running ? " · " + t("backupRunning") : ""))
            : t("schedOffHint") }),
          react_jsx_runtime.jsx("button", {
            type: "button", className: "dshcb-btn d2", disabled: !!busy || !!bstate.running, onClick: doBackup,
            children: busy ? t("busy") : bstate.running ? t("backupRunning") : t("backupNow") }),
        ] }),
      ] }) : null;

      // ④ 最近备份：工具条 + 快照列表 + 还原操作

      // 消息层：所有「需要用户知道的状况」都由状态派生、只在这一处渲染，不落库、不重复提示
      // 云端首次读取失败常常发生在登录 / 续期刚起步的那几秒（面板挂载后本身还会自动重试），
      // 失败要持续住 CLOUD_GRACE_MS 才提示，避免登录/续期起步阶段的瞬时读取失败误报
      const cloudFailing = !!(snaps && snaps.cloudOk === false);
      const [cloudGraceDone, setCloudGraceDone] = react.useState(false);
      const [laneHidden, setLaneHidden] = react.useState({});
      react.useEffect(function () {
        if (!cloudFailing) { if (cloudGraceDone) setCloudGraceDone(false); return; }
        if (cloudGraceDone) return;
        const tm = setTimeout(function () { setCloudGraceDone(true); }, CLOUD_GRACE_MS);
        return function () { clearTimeout(tm); };
      }, [cloudFailing, cloudGraceDone]);
      const rsBusyCard = (rstate.busy === "run" ? react_jsx_runtime.jsxs("div", { className: "dshcb-rsCard", children: [
          react_jsx_runtime.jsx("span", { className: "dshcb-rsTxt", children: rsCancelling ? t("rsStopping") : t("rsBusyText") }),
          react_jsx_runtime.jsx("span", { className: rsTotal > 0 ? "dshcb-rsBar" : "dshcb-rsBar dshcb-rsBar--indet", children:
            react_jsx_runtime.jsx("i", { style: rsTotal > 0 ? { width: rsPct + "%" } : null }) }),
          react_jsx_runtime.jsx("button", { type: "button", className: "dshcb-btn ghost", disabled: rsCancelling,
            onClick: doCancelRestore, children: rsCancelling ? t("rsStopping") : t("rsCancel") }),
        ] }) : null);
      const rsDoneCard = ((needsRestart && lrNote) ? react_jsx_runtime.jsxs("div", { className: "dshcb-rsCard", children: [
          react_jsx_runtime.jsxs("span", { className: "dshcb-rsTxt", children: [
            t("rsDoneText").replace("{s}", String(lrNote.stamp || rpick || "")),
            t("rsDoneSep"),
            react_jsx_runtime.jsx("span", { className: "dshcb-rsNeed", children: t("rsNeedApply") }),
          ] }),
          react_jsx_runtime.jsx("span", { className: "dshcb-rsGap" }),
          react_jsx_runtime.jsx("button", { type: "button", className: "dshcb-btn d2", disabled: rstate.busy === "restart",
            onClick: doRestartHost, children: rstate.busy === "restart" ? t("restarting") : t("restartNow") }),
        ] }) : null);
      const laneMsgs = [];
      if (cloudFailing && cloudGraceDone) {
        const kind = (snaps.cloud && snaps.cloud.errorKind) || "network";
        const cached = !!(snaps.cloud && snaps.cloud.cached);
        // pending：登录 / 续期还没就绪（凭据里暂时没有令牌），这不是故障状态，等自动重试即可，不打扰用户
        const spec = (kind === "pending")
          ? null
          : ((kind === "auth")
            ? { lv: "blocker", tk: "cloudAuthTitle", dk: "cloudAuthHint", act: t("cloudRelogin"), on: doRelogin }
            : ((kind === "config")
              ? { lv: "blocker", tk: "cloudConfigTitle", dk: "cloudConfigHint", act: t("cloudRelogin"), on: doRelogin }
              : { lv: "warn", tk: "cloudDownTitle", dk: "cloudDownHint", act: t("cloudDownRetry"), on: function () { doRefreshSnaps(); } }));
        if (spec) laneMsgs.push({ key: "cloud", level: spec.lv, title: t(spec.tk),
          detail: t(spec.dk),
          extra: cached ? t("cloudCachedTag") : "", act: spec.act, onAct: spec.on });
      }
      if (prune.note) laneMsgs.push({ key: "prune", level: "info", title: prune.note, onClose: function () { setPrune({ plan: null, note: "" }); } });
      if (lrNote && !needsRestart) laneMsgs.push({ key: "lr", level: ((lrNote.failed || 0) > 0 || lrNote.ok === false) ? "warn" : "info",
        title: t("lrTitle") + " " + lrRowText(lrNote) + (lrNote.firstError ? "（" + lrNote.firstError + "）" : ""),
        restart: needsRestart, onClose: function () { setLrNote(null); } });
      const laneKeyOf = function (m, i) { return m.key + "-" + i + ":" + String(m.title || ""); };
      // 下载进度也是一张卡片：和还原卡片同处「最近备份」与列表之间
      const pullCard = (pullInfo ? react_jsx_runtime.jsxs("div", { className: "dshcb-rsCard dshcb-pullRow", children: [
        react_jsx_runtime.jsx("span", { className: "dshcb-pullTxt", children:
        // 主百分比 = 本次要下载的块完成度（与“还剩几块”始终自洽）；字节数与快照完整度作为补充信息
        t("pullProg") + " "
        + (pullInfo.total > 0 ? pullInfo.done + " / " + pullInfo.total + " " + t("pullBlobs")
          + " (" + Math.round((pullInfo.done / pullInfo.total) * 100) + "%)" : "…")
        + (pullInfo.needBytes > 0 ? " · " + fmtSize(pullInfo.bytes) + " / "
          + fmtSize(pullInfo.needBytes) : "")
        + (pullInfo.all > 0 ? " · " + t("pullWhole") + " " + Math.min((pullInfo.present || 0) + (pullInfo.done || 0), pullInfo.all) + " / " + pullInfo.all : "")
        + (pullInfo.scope > 0 ? " · " + t("pullScopeBlocks").replace("{s}", String(pullInfo.scope)).replace("{r}", String(pullInfo.ready || 0)) : "") }),
        pullInfo.paused
          ? react_jsx_runtime.jsx("span", { className: "dshcb-badge muted", children: t("pullPausedTag") })
          : null,
        pullInfo.paused
          ? react_jsx_runtime.jsx("button", { type: "button", className: "dshcb-btn ghost",
              onClick: function () { doPull(pullInfo.stamp || rpick); }, children: t("pullResume") })
          : react_jsx_runtime.jsx("button", { type: "button", className: "dshcb-btn ghost",
              onClick: doPausePull, children: t("pullPause") }),
      ] }) : null);

      const laneItems = laneMsgs.map(function (m, i) { return { m: m, k: laneKeyOf(m, i) }; });
      const laneAutoSig = laneItems.filter(function (x) { return !x.m.act && !x.m.restart; }).map(function (x) { return x.k; }).join("|");
      react.useEffect(function () {
        setLaneHidden({});
        if (!laneAutoSig) return;
        const tm = setTimeout(function () {
          const next = {};
          laneAutoSig.split("|").forEach(function (k) { next[k] = true; });
          setLaneHidden(next);
        }, LANE_TTL_MS);
        return function () { clearTimeout(tm); };
      }, [laneAutoSig]);
      const laneShown = laneItems.filter(function (x) { return !laneHidden[x.k]; });
      const lane = (laneShown.length || pullCard || rsBusyCard || rsDoneCard) ? react_jsx_runtime.jsx("div", { className: "dshcb-lane", children: laneShown.map(function (x) {
        const m = x.m;
        const mk = x.k;
        return react_jsx_runtime.jsxs("div", { className: "dshcb-msg dshcb-msg--" + m.level, key: mk, children: [
          react_jsx_runtime.jsxs("span", { className: "dshcb-msgMain", children: [
            react_jsx_runtime.jsx("span", { className: "dshcb-msgT", children: m.title }),
            m.detail ? react_jsx_runtime.jsx("span", { className: "dshcb-msgD", children: m.detail }) : null,
            m.extra ? react_jsx_runtime.jsx("span", { className: "dshcb-msgD", children: m.extra }) : null,
          ] }),
          react_jsx_runtime.jsxs("span", { className: "dshcb-msgAct", children: [
            m.restart ? react_jsx_runtime.jsx("span", { className: "dshcb-needRestart", children: "· " + t("rsRestartChip") }) : null,
            m.restart ? react_jsx_runtime.jsx("button", { type: "button", className: "dshcb-btn d2", disabled: rstate.busy === "restart",
              onClick: doRestartHost, children: rstate.busy === "restart" ? t("restarting") : t("restartNow") }) : null,
            m.act ? react_jsx_runtime.jsx("button", { type: "button", className: "dshcb-btn d2", disabled: !!viewBusy, onClick: m.onAct, children: m.act }) : null,
            m.onClose ? react_jsx_runtime.jsx("button", { type: "button", className: "dshcb-msgClose", title: t("lrHideNote"), onClick: m.onClose, children: "✕" }) : null,
          ] }),
        ] }, mk);
      }).concat([pullCard, rsBusyCard, rsDoneCard]) }) : null;

      const renderSnapRow = function (x) {
        const on = rpick === x.stamp;
        const exp = rexpand === x.stamp;   // 目录树展开态（与「选中」分离：收起不清空还原目标）
        const human = (x.created_at ? fmtStamp(x.created_at) : x.stamp);
        // 云端视图的行：只知道云端有；副标题标明「本地也有 / 仅云端」
        const meta = x.broken ? t("restoreNoManifest")
          : (joinNum(t("restoreFiles"), x.files || 0) + " · " + joinNum(t("sizeWord"), fmtSize(x.bytes))
              + (x.missingBlobs ? " · " + x.missingBlobs + " " + t("restoreMiss") : ""));
        const badge = x.state === "uploaded"
          ? react_jsx_runtime.jsx("span", { className: "dshcb-badge", children: t("stateUploaded") })
          : (x.state === "unknown"
            ? react_jsx_runtime.jsx("span", { className: "dshcb-badge muted", children: t("stateUnknown") })
            : (x.state === "nosync"
            ? react_jsx_runtime.jsx("span", { className: "dshcb-badge muted", children: t("stateNoSync") })
            : (x.state === "failed"
              ? react_jsx_runtime.jsx("span", { className: "dshcb-badge err", ...tipProps(x.uploadError ? String(x.uploadError) : t("stateFailed")), children: t("stateFailed") })
              : react_jsx_runtime.jsx("span", { className: "dshcb-badge warn", children: t("statePending") }))));
        return react_jsx_runtime.jsxs("div", {
          key: x.stamp, className: "dshcb-item" + ((batch ? bsel.indexOf(x.stamp) >= 0 : on) ? " on" : "") + (exp && !batch ? " open" : "") + (batch ? " dshcb-batch" : ""),
          onClick: function () {
            if (batch) { toggleBsel(x.stamp); return; }
            if (rexpand === x.stamp) { setRexpand(null); return; }   // 再点同一行 = 收起列表
            setRexpand(x.stamp);
            if (rpick !== x.stamp) setRpick(x.stamp);
            // 本地有缓存就读本地；只有“云端有、本地缓存已清”的行才去云端取目录树
            doLoadTree(x.stamp, x.hasCache === false && x.inCloud === true);
          },
          children: [
            react_jsx_runtime.jsxs("span", { className: "dshcb-rowMain", children: [
            react_jsx_runtime.jsx("span", {
              className: "dshcb-radio" + ((batch ? bsel.indexOf(x.stamp) >= 0 : on) ? " on" : ""),
              onClick: function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); if (batch) { toggleBsel(x.stamp); return; } setRpick(x.stamp); },
              children: (batch ? bsel.indexOf(x.stamp) >= 0 : on) ? Ico("check", 12) : null }),
            react_jsx_runtime.jsx("span", { className: "dshcb-fico", children: Ico("folder", 22) }),
            react_jsx_runtime.jsxs("span", { className: "dshcb-itxt", children: [
              react_jsx_runtime.jsxs("span", { className: "dshcb-ititle", children: [
                react_jsx_runtime.jsxs("span", { className: "dshcb-itname", children: [human + " ",
                  react_jsx_runtime.jsx("span", { className: "dshcb-itag", children: t("snapWord") })] }),
                badge,
              ] }),
              react_jsx_runtime.jsxs("span", { className: "dshcb-isub", children: ["ID:" + x.stamp, "\u00A0\u00A0\u00A0", meta] }),
            ] }),
            react_jsx_runtime.jsx(TipLayer, {}, "rowtip"),
            batch ? null : react_jsx_runtime.jsxs("span", { className: "dshcb-iacts", children: [
              // 「下载」只在“云端有、本地没缓存”时才有意义（本地已有缓存时它只是重复下载）
              (x.state === "uploaded" && x.hasCache === false) || (pullInfo && pullInfo.stamp === x.stamp) ? react_jsx_runtime.jsxs("button", { type: "button", className: "dshcb-tool",
                disabled: !!rstate.busy || !!sbusy || !!(pullInfo && pullInfo.stamp === x.stamp),
                ...tipProps(t("pullItem")),
                onClick: function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); setRpick(x.stamp); doPull(x.stamp); },
                children: [Ico("cloudDown", 15), react_jsx_runtime.jsx("span", { children:
                  (pullInfo && pullInfo.stamp === x.stamp) ? t("restorePulling")
                    : (rstate.busy === "pull" && rpick === x.stamp ? t("busy") : t("pullItem")) })] }) : null,
              // 本地已有副本、但云端枚举不可用的行：同样给行内「上传」入口（就在「删除」旁边）
              // 失败过的叫「重传」（原因进 title），其余叫「上传」
              (x.state === "pending" || x.state === "failed" || x.state === "unknown") ? react_jsx_runtime.jsxs("button", { type: "button", className: "dshcb-tool" + (x.state === "failed" ? " warn" : ""),
                ...tipProps(x.uploadError ? String(x.uploadError) : (x.state === "failed" ? t("retryUpload") : t("uploadBtn"))),
                disabled: !!rstate.busy || !!sbusy,
                onClick: function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); setRpick(x.stamp); doUpload(x.stamp); },
                children: [Ico("cloudUp", 15), react_jsx_runtime.jsx("span", { children: sbusy === "upload" && rpick === x.stamp ? t("busy") : (x.state === "failed" ? t("retryUpload") : t("uploadBtn")) })] }) : null,
              react_jsx_runtime.jsxs("button", { type: "button", className: "dshcb-tool",
                disabled: !!rstate.busy || !!sbusy,
                ...tipProps(t("delBackupLead")),
                onClick: function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); setRpick(x.stamp); doDelete(x.stamp); },
                children: [Ico("trash", 15), react_jsx_runtime.jsx("span", { children: sbusy === "del" && rpick === x.stamp ? t("busy") : t("delBackupBtn") })] }),
            ] }),
            react_jsx_runtime.jsx("span", { className: "dshcb-ichev" + (exp ? " open" : ""), children: Ico(exp ? "chevDown" : "chevRight", 16) }),
            ] }),
            (exp && tree.stamp === x.stamp && tree.error) ? react_jsx_runtime.jsx("div", { className: "dshcb-tree dshcb-treeLoad dshcb-errLine", children: t("restoreLoadFail") + tree.error }) : null,
            (exp && tree.stamp === x.stamp && tree.loading) ? react_jsx_runtime.jsx("div", { className: "dshcb-tree dshcb-treeLoad", children: [
              react_jsx_runtime.jsx("span", { className: "dshcb-skelbar", style: { width: "42%" } }),
              react_jsx_runtime.jsx("span", { className: "dshcb-skelbar dshcb-skelbar2", style: { width: "84%" } }),
            ] }) : null,
            (exp && tree.stamp === x.stamp && tree.nodes.length) ? react_jsx_runtime.jsx("div", { className: "dshcb-tree", children: [treeHead(x.stamp, tree.nodes)].concat(tree.nodes.map(function (n) {
              const sub = [dirRaw(n.name), dirNote(n.name)].filter(Boolean).join(" — ");
              const onSel = !!(pickSel && pickSel.stamp === x.stamp && pickSel.on && pickSel.on[n.name]);
              return react_jsx_runtime.jsxs("div", { className: "dshcb-tn" + (onSel ? " on" : ""),
                onClick: function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); togglePick(x.stamp, n.name); }, children: [
                react_jsx_runtime.jsx("span", { className: "dshcb-radio" + (onSel ? " on" : ""),
                  children: onSel ? Ico("check", 12) : null }),
                react_jsx_runtime.jsxs("span", { className: "dshcb-tnBody", children: [
                  react_jsx_runtime.jsx("div", { className: "dshcb-tnName", children: dirLabel(n.name) }),
                  sub ? react_jsx_runtime.jsx("div", { className: "dshcb-tnSub", children: sub }) : null,
                ] }),
                react_jsx_runtime.jsx("span", { className: "dshcb-tnMeta",
                  children: (n.files || 0) + " " + t("restoreFiles") + " · " + fmtSize(n.bytes) }),
              ] }, n.name);
            })) }) : null,
          ],
        });
      };

      // 单一列表：备份 = 云端的一份快照（真源）；本地只是缓存，不单独成列表。
      const rows = (snaps && snaps.items) || [];
      const totals = (snaps && snaps.totals) || {};
      const emptyRow = function (text, key) {
        return react_jsx_runtime.jsx("div", { className: "dshcb-grpEmpty", children: text }, "empty-" + key);
      };
      // 骨架屏占位行：短条 + 长条，流光扫过；只在“真的在等数据”时出现
      const skelRows = function (n, keyPrefix) {
        const out = [];
        for (let si = 0; si < (n || 2); si++) {
          const k = (keyPrefix || "skel") + si;
          out.push(react_jsx_runtime.jsx("div", { className: "dshcb-item dshcb-skelrow", key: k, children: [
            react_jsx_runtime.jsx("span", { className: "dshcb-radio" }),
            react_jsx_runtime.jsx("span", { className: "dshcb-skelico" }),
            react_jsx_runtime.jsx("span", { className: "dshcb-itxt", children: [
              react_jsx_runtime.jsx("span", { className: "dshcb-skelbar", style: { width: "46%" } }),
              react_jsx_runtime.jsx("span", { className: "dshcb-skelbar dshcb-skelbar2", style: { width: "72%" } }),
            ] }),
          ] }, k));
        }
        return out;
      };
      const snapItems = [];
      if (viewBusy) snapItems.push(react_jsx_runtime.jsxs("div", { className: "dshcb-listHint", children: [react_jsx_runtime.jsx("span", { className: "dshcb-spin" }, "spin-view"), t("viewBusy")] }, "view-busy"));
      const coldList = !rows.length && !(snaps && (snaps.items || []).length);
      const loadingList = coldList && sbusy === "list";
      if (loadingList) snapItems.push.apply(snapItems, skelRows(3, "skel"));
      if (coldList && !loadingList) {
        // 云端读不到 ≠ 没有备份：只有云端可用时才敢说“暂无备份”
        const cloudDownNoData = !!(snaps && snaps.cloudOk === false);
        snapItems.push(emptyRow(cloudDownNoData ? t("listUnavailable") : t("emptyList"), cloudDownNoData ? "warn" : "none"));
      }
      rows.forEach(function (x) { snapItems.push(renderSnapRow(x)); });
      const cloudDown = !!(snaps && snaps.cloudOk === false);
      const summary = cloudDown
        ? t("listSummaryNosync").replace("{n}", String((rows || []).length))
        : (t("listSummary").replace("{n}", String(totals.backups || 0))
            + ((totals.pending || 0) ? t("listSummaryPending").replace("{k}", String(totals.pending)) : "")
            + ((totals.failed || 0) ? t("listSummaryFailed").replace("{m}", String(totals.failed)) : ""));

      const recentPanel = connected ? react_jsx_runtime.jsxs("div", { className: "dshcb-sec", children: [
        react_jsx_runtime.jsxs("div", { className: "dshcb-sech", children: [
          react_jsx_runtime.jsxs("span", { className: "dshcb-sechT", children: [
            t("secRecent"),
react_jsx_runtime.jsxs("span", { className: "dshcb-tipHost", tabIndex: 0, children: [
              react_jsx_runtime.jsx("span", { className: "dshcb-infoIco", children: Ico("info", 13) }),
              react_jsx_runtime.jsx("span", { className: "dshcb-tip", role: "tooltip", children: t("recentInfoTip") }),
            ] }),
            react_jsx_runtime.jsx("span", { className: "dshcb-sechMeta", children: summary }),
          ] }),
          react_jsx_runtime.jsxs("div", { className: "dshcb-sechR dshcb-tools", children: batch ? [
            react_jsx_runtime.jsx("span", { className: "dshcb-tool dshcb-batchSum", children: bsel.length
              ? t("batchCount").replace("{n}", String(bsel.length)).replace("{mb}", fmtSize(batchBytes()))
              : t("batchNone") }),
            tool(sbusy === "bdel" ? (batchAt || t("busy")) : t("batchDeleteBtn"), "trash", doBatchDelete, false, !!sbusy || !bsel.length, bsel.length > 0),
            tool(t("batchCancel"), "close", doBatchOff, false, sbusy === "bdel"),
          ] : [
            tool(t("batchOp"), "check", doBatchOn, false, !!sbusy || !connected),
            tool(t("cacheCleanBtn"), "trash", doClearCache, false, !!sbusy || !connected),
            tool(t("snapRefresh"), "refresh", doRefreshSnaps, false, !!sbusy),
            tool(t("restorePull"), "cloudDown", function () { doPull(); }, false, !!rstate.busy || !rpick),
          ] }),
        ] }),
        lane,
        !snaps ? (slowList ? react_jsx_runtime.jsx("div", { className: "dshcb-list dshcb-listSkel", children: skelRows(2, "skl") }) : null)
          : (false ? react_jsx_runtime.jsx("div", { className: "dshcb-list dshcb-listSkel", children: [
              react_jsx_runtime.jsx("div", { className: "dshcb-skel", key: "s1" }),
              react_jsx_runtime.jsx("div", { className: "dshcb-skel", key: "s2" }),
            ] })
            : (!snapItems.length ? react_jsx_runtime.jsx("div", { className: "dshcb-lineText", style: { marginTop: 12 }, children: t("restoreNone") })
              : react_jsx_runtime.jsx("div", { className: "dshcb-list", children: snapItems }))),
        react_jsx_runtime.jsxs("div", { className: "dshcb-picked", children: [
          t("selId"), rpick
            ? react_jsx_runtime.jsx("span", { className: "dshcb-pickedId", children: rpick })
            : ((!snaps || loadingList)
              ? react_jsx_runtime.jsx("span", { className: "dshcb-pickedId dshcb-pickedWait", children:
                  react_jsx_runtime.jsx("span", { className: "dshcb-skelbar dshcb-pickedBar" }) })
              : react_jsx_runtime.jsx("span", { className: "dshcb-pickedId dshcb-pickedWait", children: t("selIdNone") })),
          rpick && plugCountOf(rpick) > 0 ? react_jsx_runtime.jsxs("span", { className: "dshcb-tipHost", tabIndex: 0, children: [
            react_jsx_runtime.jsx("span", { className: "dshcb-infoIco", children: Ico("info", 13) }),
            react_jsx_runtime.jsx("span", { className: "dshcb-tip", role: "tooltip", children: String(plugText(rpick) || "") + plugNoteText(rpick) }),
          ] }) : null,
        ] }),
        react_jsx_runtime.jsxs("div", { className: "dshcb-rbar", children: [
          react_jsx_runtime.jsx("input", { className: "dshcb-input", value: rtarget,
            placeholder: (status && status.restore && status.restore.dshHome) || t("restoreTargetHint"),
            onChange: function (e) { setRtarget(e.target.value); } }),
          react_jsx_runtime.jsx("button", { type: "button", className: "dshcb-btn", disabled: !!rstate.busy || !rpick, onClick: function () { doPreview(); },
            children: rstate.busy === "preview" ? t("busy") : t("restorePreview") }),
          react_jsx_runtime.jsx("button", { type: "button", className: "dshcb-btn d2", disabled: !!rstate.busy || !rpick, onClick: function () { doRestore(); },
            children: rstate.busy === "run" ? t("restoreRunning") : t("restoreRun") }),
        ] }),
        rpick && plugCountOf(rpick) > 0 ? react_jsx_runtime.jsxs("div", { className: "dshcb-plugRow", children: [
          react_jsx_runtime.jsxs("label", { className: "dshcb-plugChk", children: [
            react_jsx_runtime.jsx("input", { type: "checkbox", checked: withPlugins === true, onChange: function (e) { setWithPlugins(e.target.checked); } }),
            react_jsx_runtime.jsx("span", { children: t("restoreWithPlugins") }),
          ] }),
          react_jsx_runtime.jsx("span", { className: "dshcb-or", children: t("plugOr") }),
          react_jsx_runtime.jsx("button", { type: "button", className: "dshcb-link", onClick: doPluginPrompt, ...tipProps(t("pluginPromptTip")), children: t("pluginPrompt") }),
        ] }) : null,
        react_jsx_runtime.jsxs("div", { className: "dshcb-foot", children: [
          react_jsx_runtime.jsx("input", { type: "checkbox", checked: rconfirm, onChange: function (e) { setRconfirm(e.target.checked); } }),
          react_jsx_runtime.jsx("span", { children: t("restoreConfirm") }),
          react_jsx_runtime.jsxs("div", { className: "dshcb-footBtns", children: [
            react_jsx_runtime.jsx("button", { type: "button", className: "dshcb-link", onClick: doHistory,
              children: histOpen ? t("lrHistHide") : t("lrHist") }),
            react_jsx_runtime.jsx("button", { type: "button", className: "dshcb-link", disabled: !!rstate.busy || !rpick, onClick: doVerifyRestore,
              children: rstate.busy === "verify" ? t("busy") : t("restoreVerify") }),
          ] }),
        ] }),
        (histOpen && rhist) ? react_jsx_runtime.jsxs("div", { className: "dshcb-modalroot", onClick: function () { setHistOpen(false); }, children: [
          react_jsx_runtime.jsx("div", { className: "dshcb-mask" }),
          react_jsx_runtime.jsxs("div", { className: "dshcb-dialog dshcb-dlgHist", onClick: function (e) { e.stopPropagation(); }, children: [
            react_jsx_runtime.jsxs("div", { className: "dshcb-dlgHead", children: [
              react_jsx_runtime.jsx("h3", { className: "dshcb-dlgTitle", children: t("lrHist") }),
              react_jsx_runtime.jsx("button", { type: "button", className: "dshcb-dlgClose", title: t("lrHistHide"),
                onClick: function () { setHistOpen(false); }, children: "✕" }),
            ] }),
            react_jsx_runtime.jsx("div", { className: "dshcb-dlgContent", children: react_jsx_runtime.jsx("ul", { className: "dshcb-dlgList dshcb-histList", children: rhist.length
              ? rhist.map(function (h, i) {
                  const pl = h.plugins || null;
                  // 这之后 DSH 还没重启过：本次还原的改动尚未生效，就地标出来
                  return react_jsx_runtime.jsx("li", { key: String(h.at || "") + "-" + i,
                    title: [h.targetRoot || "", h.firstError || "", plFailTip(pl)].filter(Boolean).join(String.fromCharCode(10)) || undefined,
                    children: lrRowText(h) });
                })
              : react_jsx_runtime.jsx("li", { className: "dshcb-histEmptyLi", children: t("lrHistEmpty") }) }) }),
          ] }),
        ] }) : null,

      ] }) : null;

      function buildDialog(spec) {
        return react_jsx_runtime.jsxs("div", {
          className: "dshcb-modalroot", role: "presentation", children: [
            react_jsx_runtime.jsx("div", {
              className: "dshcb-mask", "aria-hidden": "true",
              onClick: function () { answerDlg(false); },
            }),
            react_jsx_runtime.jsxs("div", {
              className: "dshcb-dialog", role: "dialog", "aria-modal": "true", "aria-label": spec.title || "",
              children: [
                react_jsx_runtime.jsxs("div", { className: "dshcb-dlgContent", children: [
                  react_jsx_runtime.jsxs("div", { className: "dshcb-dlgHead", children: [
                    react_jsx_runtime.jsx("h2", { className: "dshcb-dlgTitle", children: spec.title }),
                    react_jsx_runtime.jsx("button", {
                      type: "button", className: "dshcb-dlgClose", "aria-label": t("dlgCloseAria"),
                      onClick: function () { answerDlg(false); }, children: Ico("close", 14),
                    }),
                  ] }),
                  spec.lead ? react_jsx_runtime.jsx("p", { className: "dshcb-dlgLead", children: spec.lead }) : null,
                  (spec.summary || (spec.lines && spec.lines.length) || spec.skip || spec.text) ? react_jsx_runtime.jsxs("div", {
                    className: "dshcb-dlgBody", children: [
                      spec.summary ? react_jsx_runtime.jsxs("div", { className: "dshcb-dlgWarn", children: [
                        react_jsx_runtime.jsx("span", { className: "dshcb-dlgWarnIco", children: Ico("warn", 18) }),
                        react_jsx_runtime.jsx("p", { children: spec.summary }),
                      ] }) : null,
                      (spec.lines && spec.lines.length) ? react_jsx_runtime.jsx("ul", {
                        className: "dshcb-dlgList",
                        children: spec.lines.map(function (ln) { return react_jsx_runtime.jsx("li", { children: ln }, ln); }),
                      }) : null,
                      spec.skip ? react_jsx_runtime.jsx("p", { className: "dshcb-dlgSkip", children: spec.skip }) : null,
                      spec.text ? react_jsx_runtime.jsx("pre", { className: "dshcb-dlgPre", children: spec.text }) : null,
                    ],
                  }) : null,
                ] }),
                react_jsx_runtime.jsxs("div", { className: "dshcb-dlgFoot", children: [
                  react_jsx_runtime.jsx("button", {
                    type: "button", className: "dshcb-dbtn outline",
                    onClick: function () { answerDlg(false); }, children: t("pruneCancel"),
                  }),
                  react_jsx_runtime.jsx("button", {
                    type: "button", className: "dshcb-dbtn primary",
                    onClick: function () { answerDlg(true); }, children: spec.confirm || t("dlgDelete"),
                  }),
                ] }),
              ],
            }),
          ],
        });
      }

      // 侧栏入口开关：面板里切换后立刻生效，配置加载后也会同步一次
      // 只在配置已知时同步入口：未知态（status 还没回来）不动，否则会先挂上再撤掉
      const sideKnown = sideDraftOn !== null || bkcfg.sidebarEntry !== undefined;
      react.useEffect(function () { if (sideKnown) setSideEntryOn(sideOn); }, [sideKnown, sideOn]);

      const errPanel = tip ? react_jsx_runtime.jsx("div", {
        className: "dshcb-toast" + (tip.kind === "err" ? " err" : tip.kind === "ok" ? " ok" : ""),
        onMouseEnter: function () { if (tipHold) tipHold(true); },
        onMouseLeave: function () { if (tipHold) tipHold(false); },
        key: tip.id, children: tip.text }) : null;

      // 确认弹窗：用 createPortal 挂到 body（与宿主 Modal 同法），点遮罩/关闭/Esc 均为取消
      const dlgNode = dlg
        ? ((react_dom && react_dom.createPortal && typeof document !== "undefined")
            ? react_dom.createPortal(buildDialog(dlg), document.body)
            : buildDialog(dlg))
        : null;

      return react_jsx_runtime.jsxs("div", {
        className: "dshcb-card" + ((!status || !!authBusy) ? " dshcb-loading" : ""),
        children: [
          headPanel,
          react_jsx_runtime.jsx("p", { className: "dshcb-sub", children: t("subtitle") }),
          errPanel,
          authPanel,
          syncPanel,
          sidePanel,
          schedPanel,
          recentPanel,
          qrPanel,
          !connected ? react_jsx_runtime.jsxs("div", { className: "dshcb-sec", children: [
            react_jsx_runtime.jsxs("div", { className: "dshcb-actions", children: [
              react_jsx_runtime.jsx("button", { type: "button", className: "dshcb-btn d2", disabled: !!busy || !!authBusy, onClick: startQr,
                children: authBusy === "qr" ? t("busy") : (qrState === "expired" || qrState === "failed") ? t("qrRegen") : t("connect") }),
              react_jsx_runtime.jsx("button", { type: "button", className: "dshcb-btn", disabled: !!busy || !!authBusy, onClick: doImportLocal,
                children: authBusy === "import" ? t("busy") : t("importLocal") }),
            ] }),
            react_jsx_runtime.jsx("p", { className: "dshcb-lineText", style: { marginTop: 10 }, children: t("importHint") }),
          ] }) : null,
          dlgNode,
        ],
      });
    }

    // 宿主 0.2.2 起将图标包进装饰性 span，并在 settings.section.icon 槽位有注册时渲染插件图标（svg 带
    // data-dshcb-slot="1"）。此函数只服务没有该槽位的旧宿主：一旦发现槽位渲染的 svg 就返回 true，调用方退役。
    function patchSettingsNavIcon() {
      if (typeof document === "undefined") return false;
      let dialogs;
      try { dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]'); }
      catch (e) { return false; }
      let slotRendered = false;
      for (let d = 0; d < dialogs.length; d++) {
        if (dialogs[d].querySelector('svg[data-dshcb-slot="1"]')) { slotRendered = true; continue; }
        const cells = dialogs[d].querySelectorAll("nav button");
        for (let i = 0; i < cells.length; i++) {
          const b = cells[i];
          // 图标可能被宿主的装饰性 span（navIcon，aria-hidden）包住，也可能直接是 button 首个子节点。
          const first = b.firstElementChild;
          const svg = first && first.tagName && first.tagName.toLowerCase() === "svg"
            ? first
            : first && first.firstElementChild && first.firstElementChild.tagName
              && first.firstElementChild.tagName.toLowerCase() === "svg"
              ? first.firstElementChild
              : null;
          if (!svg) continue;
          const labelNode = b.lastElementChild;
          const txt = ((labelNode && labelNode.textContent) || b.textContent || "").trim();
          if (txt !== t("nav")) continue;                                     // 只认自己那一行
          // 尺寸：宿主 navIcon 是 16px，这里要比它再大 2px；每次都重写，防止 React 重渲染改回 16。
          svg.setAttribute("width", "18");
          svg.setAttribute("height", "18");
          if (svg.getAttribute("data-dshcb-nav") === "1") continue;           // 已经画过，只补尺寸
          svg.setAttribute("data-dshcb-nav", "1");
          svg.setAttribute("viewBox", "0 0 24 24");
          svg.setAttribute("fill", "none");
          svg.setAttribute("stroke", "currentColor");
          svg.setAttribute("stroke-width", "1.7");
          svg.setAttribute("stroke-linecap", "round");
          svg.setAttribute("stroke-linejoin", "round");
          svg.innerHTML = "";
          for (let k = 0; k < CLOUD_ICON_PATHS.length; k++) {
            const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
            p.setAttribute("d", CLOUD_ICON_PATHS[k]);
            svg.appendChild(p);
          }
        }
      }
      return slotRendered;
    }

    // 设置侧栏图标的 DOM 兜底调度：宿主渲染完再执行，一旦槽位图标出现就停止监听。
    function settingsNavIconEffect() {
      if (typeof document === "undefined" || typeof MutationObserver === "undefined") return function () {};
      let pending = 0;
      let obs = null;
      const schedule = function () {
        if (pending) return;
        pending = setTimeout(function () {
          pending = 0;
          let done = false;
          try { done = patchSettingsNavIcon(); } catch (e) { done = false; }
          if (done && obs) { obs.disconnect(); obs = null; }
        }, 60);
      };
      try {
        obs = new MutationObserver(schedule);
        obs.observe(document.body, { childList: true, subtree: true });
        schedule();
      } catch (e) {
        console.warn("[dsh-cloud-backup] 左栏图标修补未启用:", e);
      }
      return function () {
        if (pending) clearTimeout(pending);
        if (obs) obs.disconnect();
      };
    }

    // 左侧面板入口 + 面板本体
    // 面板列表槽里的注册值只负责画图标，行本身的按钮/文案/提示/点击切面板都由宿主完成；
    // 面板内容注册在 main 槽、key = PANEL_ID，点行时宿主切过去，不再借用设置弹窗。
    const PANEL_ID = "cloud-backup";
    const CLOUD_ICON_PATHS = [
      "M7.2 15.2a4 4 0 0 1 .5-7.96A5.6 5.6 0 0 1 18.1 9.1a3.35 3.35 0 0 1-.7 6.1",
      "M12 11.6v7.6",
      "M9.4 16.6 12 19.2l2.6-2.6",
    ];
    // null = 还没读到配置（先不挂入口，读到再决定，避免「先出现又消失」）；true/false = 已知
    let panelRowWanted = null;
    let panelRowDispose = null;
    let slotApi = null;

    function setSideEntryOn(v) {
      panelRowWanted = v !== false;
      applyPanelRow();
    }

    function applyPanelRow() {
      try { if (panelRowDispose) { panelRowDispose(); panelRowDispose = null; } }
      catch (error) { panelRowDispose = null; }
      if (panelRowWanted !== true || !slotApi) return;
      try {
        panelRowDispose = slotApi.register(
          { name: "sidebar.panellist", id: PANEL_ID, order: 0.5, label: function () { return t("nav"); }, locale: NS },
          PanelRowGlyph,
        );
      } catch (error) {
        panelRowDispose = null;
        console.warn("[dsh-cloud-backup] 注册侧栏入口失败:", error);
      }
    }

    // 尺寸由宿主给（展开 16 / 收起 18），描边口径与宿主图标保持一致
    function PanelRowGlyph(props) {
      const size = (props && props.size) || 18;
      return react_jsx_runtime.jsx("svg", {
        width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
        strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true",
        children: CLOUD_ICON_PATHS.map(function (d, i) { return react_jsx_runtime.jsx("path", { d: d }, i); }),
      });
    }

    // 设置侧栏图标：宿主 SettingsPanel 对每一行调用 renderSlot("settings.section.icon",
    // {size, active}, {only: 行的 id, fallback: 默认齿轮})。注册 id 与 settings.section 的
    // id 相同，宿主才会用本组件替换默认齿轮；id 不一致则永不渲染。
    function SettingsNavGlyph(props) {
      const size = props && typeof props.size === "number" ? props.size : 16;
      const active = !!(props && props.active);
      return react_jsx_runtime.jsx("svg", {
        xmlns: "http://www.w3.org/2000/svg",
        width: size, height: size, viewBox: "0 0 24 24", fill: "none",
        stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round",
        "aria-hidden": "true", focusable: "false", "data-dshcb-slot": "1",
        "data-state": active ? "active" : void 0,
        children: CLOUD_ICON_PATHS.map(function (d, i) { return react_jsx_runtime.jsx("path", { d: d }, i); }),
      });
    }

    // 主面板页：把卡片原样铺在宿主工作区里，页面自己负责留白与滚动
    function CloudBackupPage() {
      return react_jsx_runtime.jsx("div", { className: "dshcb-page", children: react_jsx_runtime.jsx(CloudBackupCard, {}) });
    }

    const inject = ["slots", "locale"];

    function apply(ctx) {
      ctx.effect(function () {
        const locale = ctx.locale;
        if (locale && typeof locale.register === "function") locale.register(NS, DICT);
        if (locale && typeof locale.bind === "function") {
          try { t = locale.bind(NS); }
          catch (error) { console.warn("[dsh-cloud-backup] locale.bind 失败，使用内置中文文案:", error); }
        }
        return function () {};
      }, "cloud-backup: locale dictionary");

      ctx.effect(settingsNavIconEffect, "cloud-backup: settings nav icon");

      slotApi = ctx.slots;
      // 设置侧栏图标：走宿主槽位，不依赖设置弹窗的 DOM 结构。
      try {
        ctx.slots.inject("settings.section.icon", function () {
          return ctx.slots.register(
            { name: "settings.section.icon", id: "cloud-backup", order: 45, label: function () { return t("nav"); }, locale: NS },
            SettingsNavGlyph,
          );
        });
      } catch (error) {
        console.error("[dsh-cloud-backup] 注册 settings.section.icon 失败:", error);
      }

      try {
        ctx.slots.inject("settings.section", function () {
          return ctx.slots.register(
            { name: "settings.section", id: "cloud-backup", order: 45, label: function () { return t("nav"); }, locale: NS },
            CloudBackupCard,
          );
        });
      } catch (error) {
        console.error("[dsh-cloud-backup] 挂载 settings.section 失败:", error);
      }

      // 侧栏列表入口（开关关闭时注销该行；面板本体不受影响）
      try {
        ctx.slots.inject("sidebar.panellist", function () {
          applyPanelRow();
          return function () { panelRowDispose = null; };
        });
      } catch (error) {
        console.error("[dsh-cloud-backup] 挂载 sidebar.panellist 失败:", error);
      }

      // 入口的初始状态来自配置：读到之前不挂，读到后按 sidebarEntry 决定（读不到按默认开启）
      call("/status").then(function (r) {
        const cfg = (r && r.backup && r.backup.config) || {};
        setSideEntryOn(cfg.sidebarEntry !== false);
      }).catch(function () { if (panelRowWanted === null) setSideEntryOn(true); });

      // 面板本体：宿主按 key 取 main 槽的内容
      try {
        ctx.slots.inject("main", function () {
          return ctx.slots.register(
            { name: "main", key: PANEL_ID, locale: NS, inject: function () { return {}; } },
            CloudBackupPage,
          );
        });
      } catch (error) {
        console.error("[dsh-cloud-backup] 挂载 main 面板失败:", error);
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
