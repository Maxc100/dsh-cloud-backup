
import fs from "node:fs";
import { statePath, writeFileAtomic } from "./paths.js";

export function loadState() {
  try {
    if (!fs.existsSync(statePath())) return {};
    const s = JSON.parse(fs.readFileSync(statePath(), "utf8"));
    return s && typeof s === "object" ? s : {};
  } catch { return {}; }
}

export function saveState(patch) {
  const next = { ...loadState(), ...patch, updated_at: new Date().toISOString() };
  writeFileAtomic(statePath(), JSON.stringify(next, null, 2));
  return next;
}
