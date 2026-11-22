/** 宿主识别：只问「哪个 profile、有没有 Electron 能力」；识别失败退化为 generic，只影响显示。 */
import fs from "node:fs";
import path from "node:path";

export function shapeOfProfile(dshHome, profile) {
  if (!profile) return "generic";
  if (profile === "desktop") return "desktop";
  try {
    const file = path.join(dshHome, "profiles", profile, "package.json");
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    const bundles = (j && j.dsh && j.dsh.profile && j.dsh.profile.bundles) || [];
    return bundles.indexOf("@deepseek-ai/dsh-web-app") >= 0 ? "web" : "generic";
  } catch {
    return "generic";
  }
}

export function profileFromArgv(argv, dshHome, env = {}) {
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i += 1) {
    const a = String(list[i]);
    if (a === "--profile" && list[i + 1]) return String(list[i + 1]);
    if (a.indexOf("--profile=") === 0) return a.slice("--profile=".length);
  }
  if (env && env.DSH_PROFILE) return String(env.DSH_PROFILE);
  const home = String(dshHome || "").replace(/\\/g, "/").replace(/\/+$/, "");
  for (const raw of list) {
    const s = String(raw).replace(/\\/g, "/");
    if (home && s.indexOf(home + "/profiles/") === 0) {
      const name = s.slice((home + "/profiles/").length).split("/")[0];
      if (name) return name;
    }
    const m = /\/profiles\/([^/]+)\/?$/.exec(s);
    if (m) return m[1];
  }
  return null;
}

export function detectHost({ dshHome = "", argv = [], env = {}, versions = {} } = {}) {
  const profile = profileFromArgv(argv, dshHome, env) || null;
  const electron = !!versions.electron || !!env.ELECTRON_RUN_AS_NODE;
  return { profile: profile || null, shape: shapeOfProfile(dshHome, profile), electron: electron, node: versions.node || "" };
}

export function sameHost(a, b) {
  if (!a || !b) return true;
  return String(a.profile || "") === String(b.profile || "") && String(a.shape || "") === String(b.shape || "");
}
