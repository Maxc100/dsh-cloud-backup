// lib/engine/rotation.js —— GFS 保留策略（近 N / 日 / 周 / 月 四层）

export const ROTATION_DEFAULTS = { recentKeep: 24, dailyKeep: 7, weeklyKeep: 4, monthlyKeep: 6 };

function parts(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(String(stamp));
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6] };
}
export function dayKey(stamp) { const p = parts(stamp); return p ? p.y + "-" + p.mo + "-" + p.d : String(stamp); }
export function monthKey(stamp) { const p = parts(stamp); return p ? p.y + "-" + p.mo : String(stamp); }
export function weekKey(stamp) {
  const p = parts(stamp);
  if (!p) return String(stamp);
  const dt = new Date(Date.UTC(p.y, p.mo - 1, p.d));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((dt - yearStart) / 86400000 + 1) / 7);
  return dt.getUTCFullYear() + "-W" + String(week).padStart(2, "0");
}

/** @returns {{keep: Set<string>, tiers: {recent: string[], daily: string[], weekly: string[], monthly: string[]}}} */
export function selectKeep(stamps, opts = {}) {
  const o = { ...ROTATION_DEFAULTS, ...opts };
  const desc = [...stamps].sort().reverse();
  const recent = desc.slice(0, Math.max(0, o.recentKeep));
  const keep = new Set(recent);
  const tiers = { recent, daily: [], weekly: [], monthly: [] };
  let pool = desc.slice(recent.length);
  const take = (keyFn, limit, bucket) => {
    const seen = new Set();
    const remain = [];
    for (const s of pool) {
      const k = keyFn(s);
      if (bucket.length < limit && !seen.has(k)) { seen.add(k); bucket.push(s); keep.add(s); }
      else remain.push(s);
    }
    pool = remain;
  };
  take(dayKey, o.dailyKeep, tiers.daily);
  take(weekKey, o.weeklyKeep, tiers.weekly);
  take(monthKey, o.monthlyKeep, tiers.monthly);
  return { keep, tiers };
}

export function pruneList(stamps, opts = {}) {
  const { keep } = selectKeep(stamps, opts);
  return [...stamps].filter((s) => !keep.has(s)).sort().reverse();
}
