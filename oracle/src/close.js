/// Official Daily Close: freezes the official settlement levels for a day.
/// Mirrors FSPI's benchmark practice — intraday pushes are indicative; the
/// close is the one authoritative print, sha256-hashed so any settlement
/// dispute can be re-verified from the match trail + levels.
import { createHash } from "node:crypto";
import { eligibleMatches, applyMatch, newState, levelsForState } from "./compute.js";

export function hashLevels(levels) {
  const obj = {};
  for (const [id, v] of levels) obj[id] = v.level2dp;
  return createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

/// Compute the official close for `day` (YYYY-MM-DD): levels from all
/// eligible completed matches with startDate <= end of `day`, within the
/// season tracking window (SEASON_START).
export function buildClose(rawMatches, ranks, day, seasonStart) {
  const norm = day.includes("-") ? day : `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
  const end = `${norm}T23:59:59Z`;
  const start = seasonStart
    ? `${seasonStart.slice(0, 4)}-${seasonStart.slice(4, 6)}-${seasonStart.slice(6, 8)}`
    : null;
  const elig = eligibleMatches(rawMatches)
    .filter((m) => (m.startDate || "") <= end && (!start || (m.startDate || "") >= `${start}T00:00:00Z`))
    .sort((a, b) => (a.startDate || "").localeCompare(b.startDate || "") || String(a.compId).localeCompare(String(b.compId)));
  const st = newState();
  const lookup = (tour, id) => ranks?.[tour]?.get?.(id) ?? null;
  for (const m of elig) applyMatch(st, m, lookup);
  const levels = levelsForState(st);
  return {
    day: norm,
    matches: elig.length,
    players: Object.fromEntries([...levels.entries()].map(([id, v]) => [id, v.level2dp])),
    hash: hashLevels(levels),
  };
}
