// dsh-cloud-backup / 浏览器登录页（扫码在浏览器里完成）

function esc(s) {
  return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

export function qrPageHtml(opts = {}) {
  const sessionId = String(opts.sessionId || "");
  const qr = String(opts.qr || "");
  const apiBase = String(opts.apiBase || "/api/dsh-cloud-backup");
  const ttl = Number(opts.expiresInSec) > 0 ? Number(opts.expiresInSec) : 180;
  const oauthUrl = String(opts.oauthUrl || "");
  const hasSession = !!sessionId && !!qr;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录阿里云盘 · 云盘备份</title>
<style>
  :root{
    --bg:#fff; --fg:#1b1c1e; --fg2:#6b6f76; --line:#e6e7eb; --card:#fff;
    --accent:#0c90e6; --ok:#128a3d; --warn:#b45309; --fill:#f5f6f8;
  }
  @media (prefers-color-scheme: dark){
    :root{ --bg:#141416; --fg:#f2f3f5; --fg2:#9a9ea6; --line:#2c2d31; --card:#1c1d20; --fill:#242528; }
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
    font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
    display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
  main{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);
    border-radius:16px;padding:24px;text-align:center;box-shadow:0 8px 28px rgba(0,0,0,.06)}
  h1{margin:0 0 6px;font-size:16.5px;font-weight:600}
  .sub{margin:0 0 18px;font-size:12.5px;color:var(--fg2)}
  .qrbox{display:inline-flex;align-items:center;justify-content:center;
    padding:10px;border:1px solid var(--line);border-radius:12px;background:#fff}
  .qrbox img{display:block;width:248px;height:248px;image-rendering:pixelated}
  .state{margin:16px 0 4px;font-size:13.5px;font-weight:600}
  .state.ok{color:var(--ok)}
  .state.warn{color:var(--warn)}
  .left{margin:0;font-size:12px;color:var(--fg2);font-variant-numeric:tabular-nums}
  .steps{margin:16px 0 0;padding:10px 12px;background:var(--fill);border-radius:10px;
    font-size:12px;color:var(--fg2);text-align:left}
  .alt{margin:14px 0 0;font-size:12.5px}
  a{color:var(--accent);text-decoration:none}
  a:hover{text-decoration:underline}
  .hint{margin:10px 0 0;font-size:11.5px;color:var(--fg2)}
</style>
</head>
<body>
<main>
  <h1>用手机扫码登录阿里云盘</h1>
  <p class="sub">扫码后在手机上确认，本页会自动完成登录，面板会同时变为「已连接」。</p>
  ${hasSession
    ? `<div class="qrbox"><img id="qr" src="${esc(qr)}" alt="阿里云盘登录二维码"></div>`
    : `<p class="state warn">这个页面缺少有效的二维码会话</p>
       <p class="left">请回到备份面板，点「连接阿里云盘」重新生成二维码后，再点「在浏览器里登录」。</p>`}
  <p id="state" class="state">${hasSession ? "等待扫码…" : ""}</p>
  <p id="left" class="left"></p>
  <div class="steps">
    1. 用「阿里云盘」App 扫上面的二维码<br>
    2. 手机上点确认登录<br>
    3. 本页显示「登录成功」即完成，无需再操作
  </div>
  ${oauthUrl ? `<p class="alt"><a href="${esc(oauthUrl)}" target="_blank" rel="noreferrer">或在阿里云盘官方授权页登录</a></p>` : ""}
  <p class="hint">仅用于本次登录，登录完成后可关闭本页。</p>
</main>
<script>
(function(){
  var sid = ${JSON.stringify(sessionId)};
  var api = ${JSON.stringify(apiBase)};
  var ttlMs = ${ttl * 1000};
  var stateEl = document.getElementById("state");
  var leftEl = document.getElementById("left");
  var t0 = Date.now(), stopped = !sid, nextMs = 900;

  function setState(text, cls) {
    stateEl.textContent = text;
    stateEl.className = "state" + (cls ? " " + cls : "");
  }
  function tickLeft() {
    var left = Math.max(0, Math.round((ttlMs - (Date.now() - t0)) / 1000));
    leftEl.textContent = left > 0 ? ("二维码有效期剩 " + left + " 秒") : "二维码已过期";
    if (left <= 0 && !stopped) { stopped = true; setState("二维码已过期，请回到面板重新生成", "warn"); }
  }
  tickLeft();
  setInterval(tickLeft, 1000);

  function poll() {
    if (stopped) return;
    fetch(api + "/auth/qr/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ sessionId: sid, peek: true })
    }).then(function (r) { return r.json(); }).then(function (j) {
      var st = j && j.status;
      if (st === "connected" || st === "confirmed") {
        var who = (j.account && (j.account.nick_name || j.account.user_name)) || "";
        setState("登录成功 ✔" + (who ? ("  " + who) : ""), "ok");
        leftEl.textContent = "可以关闭本页了";
        stopped = true;
        return;
      }
      if (st === "scanned") setState("已扫码，请在手机上点确认…");
      else if (st === "connecting") setState("已确认，正在获取令牌…（第 " + (j.attempt || 1) + " 次）");
      else if (st === "failed") { setState("登录失败：" + (j.reason || "未知原因"), "warn"); stopped = true; return; }
      else if (st === "expired") { setState("二维码已过期，请回到面板重新生成", "warn"); stopped = true; return; }
      else setState("等待扫码…");
      var wait = Number(j && j.nextPollMs);
      nextMs = (wait > 0 ? Math.min(Math.max(wait, 400), 4000) : 1200);
      setTimeout(poll, nextMs);
    }).catch(function () {
      setState("网络异常，正在重试…", "warn");
      setTimeout(poll, 2000);
    });
  }
  poll();
})();
</script>
</body>
</html>`;
}

/** 阿里云盘官方 OAuth 授权页（浏览器里登录的官方入口）。 */
export function oauthAuthorizeUrl(clientId, redirectUri) {
  const cid = String(clientId || "");
  const ru = String(redirectUri || "https://www.aliyundrive.com/sign/callback");
  const q = new URLSearchParams({
    client_id: cid,
    redirect_uri: ru,
    response_type: "code",
    scope: "user:base,file:all:read,file:all:write",
  });
  return "https://auth.aliyundrive.com/v2/oauth/authorize?" + q.toString();
}
