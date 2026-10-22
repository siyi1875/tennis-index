// Live-match halts: decide, from ESPN scoreboards, which players to halt and
// when (the order of play, posted on-chain ahead of time), and which halts
// can be lifted. Pure functions; run.js does the I/O.
//
// Safety rule: a player is released only when nothing about them is still
// unpriced: no match live or about to start, no completed match the scoring
// has not applied yet (e.g. an early round waiting for its draw anchor), and
// the on-chain level equals the computed level.
import { classifyRound, isExcluded } from "./tiers.js";

export const HALT_BUFFER_MIN = Number(process.env.HALT_BUFFER_MIN || 15); // halt this long before the scheduled start
export const HALT_HORIZON_H = Number(process.env.HALT_HORIZON_H || 36); // post halts this far ahead

const NO_PLAY = new Set(["STATUS_CANCELED", "STATUS_POSTPONED", "STATUS_ABANDONED", "STATUS_FORFEIT"]);

/// Does this match move levels at all? Qualifying, team events, Challengers
/// etc. are excluded from scoring, so they need no halt.
export function scoringRelevant(m) {
  if (isExcluded(m.eventName)) return false;
  if (/qualif/i.test(m.round || "")) return false;
  return true;
}

/// Halt start (ms) per ESPN player id for every scoring-relevant match that is
/// live or starts within the horizon. Earliest match wins. A match without a
/// confirmed time (timeValid false: ESPN's placeholder, early in the day) is
/// halted from that placeholder, which is conservative.
export function haltPlan(matches, nowMs, { bufferMin = HALT_BUFFER_MIN, horizonH = HALT_HORIZON_H } = {}) {
  const plan = new Map();
  for (const m of matches) {
    if (m.completed || NO_PLAY.has(m.status) || !scoringRelevant(m)) continue;
    const start = Date.parse(m.startDate || "");
    if (!Number.isFinite(start)) continue;
    let at = m.status === "STATUS_IN_PROGRESS" ? nowMs : start - bufferMin * 60_000;
    if (at > nowMs + horizonH * 3_600_000) continue;
    if (at < nowMs) at = nowMs; // already due: halt now
    for (const p of m.players) {
      const cur = plan.get(p.id);
      if (cur === undefined || at < cur) plan.set(p.id, at);
    }
  }
  return plan;
}

/// Players with a completed, scoring-relevant match the season state has not
/// applied yet. Their result is public but not in the price: keep them halted.
export function unscoredPlayers(matches, appliedCompIds, seasonStartIso) {
  const out = new Set();
  for (const m of matches) {
    if (!m.completed || !scoringRelevant(m)) continue;
    if (seasonStartIso && (m.startDate || "") < seasonStartIso) continue;
    if (appliedCompIds.has(m.compId)) continue;
    // a named round that classifyRound rejects never scores: not pending
    if (m.round && !/^Round \d+$/i.test(m.round.trim()) && !classifyRound(m.round)) continue;
    for (const p of m.players) out.add(p.id);
  }
  return out;
}

/// Decide on-chain actions for registered players.
///   players: [{ espnId, chainId, haltFrom (s, 0 = none), level, target }]
///   target: the level the oracle will push (computed, after the ±25% clamp)
/// Returns { schedule: [{chainId, from}], resume: [chainId] }. Resumes come
/// first on-chain, so a player released from an old halt can be re-scheduled
/// for their next match in the same loop.
export function haltActions(players, plan, unscored, nowMs) {
  const nowS = Math.floor(nowMs / 1000);
  const schedule = [];
  const resume = [];
  for (const p of players) {
    const wantMs = plan.get(p.espnId);
    let want = wantMs === undefined ? null : Math.floor(wantMs / 1000);
    // A result that is public but not on-chain yet (unscored, or computed
    // but not pushed): halt now, whatever the schedule says.
    const priced = !unscored.has(p.espnId) && p.target === p.level;
    if (!priced) want = want === null ? nowS : Math.min(want, nowS);
    const active = p.haltFrom !== 0 && p.haltFrom <= nowS;
    let cur = p.haltFrom;
    if (cur !== 0) {
      // active: keep while a match is live/due; scheduled: keep while one is upcoming
      const keep = want !== null && (!active || want <= nowS);
      if (!keep) {
        resume.push(p.chainId);
        cur = 0;
      }
    }
    if (want !== null && (cur === 0 || want < cur)) schedule.push({ chainId: p.chainId, from: want });
  }
  return { schedule, resume };
}
