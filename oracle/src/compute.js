// Season index computation: expectation-relative (Elo-style) scoring.
// Deterministic integer math in "centi-points" (1 level point = 100 cp).
//
// Every match is a zero-sum transfer between the two players, sized by
// surprise. Pre-match ratings give an expected win probability p:
//   p = 1 / (1 + 10^((ratingOpp - ratingYou) / 400))
// The winner gains K_POINTS x (1 - p), the loser loses the same amount, so a
// favourite's expected win barely moves the level while an upset moves it a
// lot. Ratings update with the standard Elo rule (also zero-sum). Set/game
// margin stats remain round-scaled and zero-sum. Milestones are the only mint
// and are scaled by the surprise of the decisive match.
import { TIERS, ROUNDS, classifyRound, classifyTier, isExcluded, POINTS, BASE_LEVEL, MIN_LEVEL } from "./tiers.js";

const TIER_BPS = Object.fromEntries(Object.entries(TIERS).map(([k, v]) => [k, Math.round(v.mult * 10000)]));
const ROUND_BPS = Object.fromEntries(Object.entries(ROUNDS).map(([k, v]) => [k, Math.round(v.mult * 10000)]));

const SET_WIN_CP = POINTS.SET_WIN * 100;
const SET_LOSS_CP = POINTS.SET_LOSS * 100;
const GAME_DIFF_CP = POINTS.GAME_DIFF * 100;
const BAGEL_CP = POINTS.BAGEL * 100;
const MILESTONE_CP = Object.fromEntries(Object.entries(POINTS.MILESTONE).map(([k, v]) => [k, v * 100]));
export { TIER_BPS, ROUND_BPS, MILESTONE_CP };

export const ELO_START = 1500;
const ELO_DIVISOR = 400;
const kRating = () => Number(process.env.ELO_K_RATING || 24);
const kPoints = () => Number(process.env.ELO_K_POINTS || 200);
const milestoneScale = () => Number(process.env.ELO_MILESTONE_SCALE || 0.25);

const ROUND_ORDER = { RR: 0, R128: 1, R96: 1, R64: 2, R32: 3, R16: 4, QF: 5, SF: 6, F: 7 };

/// Expected win probability for A given the two ratings.
export function expectedScore(ratingA, ratingB) {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / ELO_DIVISOR));
}

/// Cold-start rating from the ranking snapshot: 400 pts ~= 10x odds.
/// Rank 1 ~= 2200, rank 10 ~= 2000, rank 100 ~= 1800, unranked = 1500.
export function ratingFromRank(rank) {
  if (!Number.isFinite(rank) || rank <= 0) return ELO_START;
  return 2200 - 200 * Math.log10(rank);
}

export function ratingOf(state, id) {
  return state.ratings.get(id) ?? ELO_START;
}

/// Filter + normalize the raw match stream into scoring-eligible matches.
/// ESPN labels early rounds "Round 1..4" without draw-size context; we resolve
/// them per event using the event's named rounds (QF/SF/F) as anchors:
/// deepest "Round N" -> R16, then R32, R64, and R128 vs R96 by match count.
/// `labels` ({ "tour|eventId": { label: matchCount } }, from the scoreboards
/// incl. scheduled and TBD matches) gives the full draw structure from day 1,
/// so early rounds score as soon as they finish instead of waiting days for a
/// completed QF: until then their results were public but unpriced.
export function eligibleMatches(rawMatches, labels = {}) {
  const resolver = resolveEventRounds(rawMatches, labels);
  return rawMatches.filter((m) => {
    if (!m.completed) return false;
    if (isExcluded(m.eventName)) return false;
    const r = classifyRound(m.round);
    if (r) {
      m.resolvedRound = r;
      return true;
    }
    const resolved = resolver.get(`${m.tour}|${m.eventId}|${(m.round || "").trim()}`);
    if (resolved) {
      m.resolvedRound = resolved;
      return true;
    }
    return false;
  });
}

function resolveEventRounds(rawMatches, labels = {}) {
  const groups = new Map();
  for (const m of rawMatches) {
    if (!m.completed) continue;
    if (isExcluded(m.eventName)) continue;
    const lbl = (m.round || "").trim();
    if (/qualif/i.test(lbl)) continue;
    const key = `${m.tour}|${m.eventId}`;
    let g = groups.get(key);
    if (!g) {
      g = new Map();
      groups.set(key, g);
    }
    g.set(lbl, (g.get(lbl) || 0) + 1);
  }
  for (const [key, g] of groups) {
    for (const [lbl, n] of Object.entries(labels[key] ?? {})) {
      if (/qualif/i.test(lbl)) continue;
      g.set(lbl, Math.max(g.get(lbl) || 0, n));
    }
  }
  const resolved = new Map();
  for (const [key, g] of groups) {
    const roundLabels = [...g.keys()].filter((l) => /^Round (\d+)$/i.test(l));
    if (roundLabels.length === 0) continue;
    const hasAnchor = [...g.keys()].some((l) => ["QF", "SF", "F"].includes(classifyRound(l)));
    if (!hasAnchor) continue;
    const sorted = roundLabels.sort((x, y) => Number(y.match(/\d+/)[0]) - Number(x.match(/\d+/)[0]));
    const seq = ["R16", "R32", "R64"];
    for (let i = 0; i < sorted.length; i++) {
      let r;
      if (i < 3) r = seq[i];
      else r = g.get(sorted[i]) >= 40 ? "R128" : "R96";
      resolved.set(`${key}|${sorted[i]}`, r);
    }
  }
  return resolved;
}

/// state: { players: Map<id, {id,name,tour,levelCp,events}>,
///          matchIds: Set, matches: [], ratings: Map<id, rating> }
export function newState() {
  return { players: new Map(), matchIds: new Set(), matches: [], ratings: new Map() };
}

export function ensurePlayer(state, espnId, name, tour) {
  let p = state.players.get(espnId);
  if (!p) {
    p = { id: espnId, name, tour, levelCp: 0, events: new Map() };
    state.players.set(espnId, p);
  }
  if (name && p.name !== name) p.name = name;
  return p;
}

function ratingFor(state, id, tour, rankLookup) {
  let r = state.ratings.get(id);
  if (r === undefined) {
    const rank = rankLookup?.(tour, id) ?? null;
    r = ratingFromRank(rank);
    state.ratings.set(id, r);
  }
  return r;
}

/// Apply one match (call in chronological order). Idempotent by compId.
export function applyMatch(state, match, rankLookup) {
  if (state.matchIds.has(match.compId)) return false;
  if (isExcluded(match.eventName)) return false;
  const [a, b] = match.players;
  const tier = classifyTier(match.eventName, match.tour);
  if (tier === "EXCL") return false;
  const round = match.resolvedRound ?? classifyRound(match.round);
  if (!round || ROUND_BPS[round] === undefined) return false;

  const tour = match.tour;
  const pa = ensurePlayer(state, a.id, a.name, tour);
  const pb = ensurePlayer(state, b.id, b.name, tour);

  // expectations from PRE-match ratings
  const rA = ratingFor(state, a.id, tour, rankLookup);
  const rB = ratingFor(state, b.id, tour, rankLookup);
  const pA = expectedScore(rA, rB);
  const pB = 1 - pA;
  const sA = a.winner ? 1 : 0;
  const sB = 1 - sA;

  // standard Elo rating update (zero-sum)
  state.ratings.set(a.id, rA + kRating() * (sA - pA));
  state.ratings.set(b.id, rB + kRating() * (sB - pB));

  // level points: K_POINTS x |result - expectation|, signed by the result
  const surpriseA = Math.abs(sA - pA);
  const baseCp = Math.round(surpriseA * kPoints() * 100);
  const aSigned = sA === 1 ? baseCp : -baseCp;
  const bSigned = -aSigned;

  // margin stats (zero-sum, round-scaled)
  let statCp = { [a.id]: 0, [b.id]: 0 };
  if (a.lines.length > 0 && a.lines.length === b.lines.length) {
    let setsA = 0, setsB = 0, gamesA = 0, gamesB = 0, bagelsA = 0, bagelsB = 0;
    for (let i = 0; i < a.lines.length; i++) {
      const va = a.lines[i].value ?? 0;
      const vb = b.lines[i].value ?? 0;
      gamesA += va; gamesB += vb;
      if (a.lines[i].winner === true) { setsA++; if (va - vb >= 6 && vb === 0) bagelsA++; }
      else if (b.lines[i].winner === true) { setsB++; if (vb - va >= 6 && va === 0) bagelsB++; }
    }
    statCp[a.id] = setsA * SET_WIN_CP + setsB * SET_LOSS_CP + Math.round((gamesA - gamesB) * GAME_DIFF_CP) + bagelsA * BAGEL_CP - bagelsB * BAGEL_CP;
    statCp[b.id] = setsB * SET_WIN_CP + setsA * SET_LOSS_CP + Math.round((gamesB - gamesA) * GAME_DIFF_CP) + bagelsB * BAGEL_CP - bagelsA * BAGEL_CP;
  }

  const mulRoundTier = (cp) => Math.round((cp * ROUND_BPS[round] * TIER_BPS[tier]) / 1e8);
  const mulRound = (cp) => Math.floor((cp * ROUND_BPS[round]) / 1e4);

  const aCp = mulRoundTier(aSigned) + mulRound(statCp[a.id]);
  const bCp = mulRoundTier(bSigned) + mulRound(statCp[b.id]);
  pa.levelCp += aCp;
  pb.levelCp += bCp;

  // track deepest round and pre-match expectations for milestone surprise
  for (const [pl, pOwn] of [[pa, pA], [pb, pB]]) {
    let ev = pl.events.get(match.eventId);
    if (!ev) { ev = { bestRound: null, wonF: false, tier, pByRound: new Map() }; pl.events.set(match.eventId, ev); }
    if (ev.tier !== tier) ev.tier = tier;
    if (ev.bestRound === null || ROUND_ORDER[round] > ROUND_ORDER[ev.bestRound]) ev.bestRound = round;
    if (round === "F" && pl.id === (a.winner ? a.id : b.id)) ev.wonF = true;
    if (!ev.pByRound.has(round)) ev.pByRound.set(round, pOwn);
  }

  state.matchIds.add(match.compId);
  state.matches.push({
    compId: match.compId, tour, eventId: match.eventId, eventName: match.eventName,
    round, tier, startDate: match.startDate,
    a: { id: a.id, name: a.name, won: a.winner },
    b: { id: b.id, name: b.name, won: b.winner },
  });
  return { aCp, bCp, tier, round, pA, pB };
}

/// Round whose expectation decides the milestone surprise.
export function milestoneDecisiveRound(key) {
  if (key === "TITLE" || key === "FINAL") return "F";
  if (key === "SF") return "QF";
  if (key === "QF") return "R16";
  return null;
}

/// Milestone points for one event: base x tier x surprise x scale.
export function milestoneCpForEvent(ev, key) {
  const base = MILESTONE_CP[key];
  if (!base) return 0;
  const dec = milestoneDecisiveRound(key);
  const p = dec ? (ev.pByRound?.get(dec) ?? 0.5) : 0.5;
  const surprise = Math.max(0, 1 - p);
  return Math.floor((base * (TIER_BPS[ev.tier] ?? 4000) * surprise * milestoneScale()) / 1e4);
}

/// Milestones are applied once per event, after the final result is known.
export function milestoneCpForPlayer(player) {
  let total = 0;
  for (const [, ev] of player.events) {
    let key = null;
    if (ev.bestRound === "F") key = ev.wonF ? "TITLE" : "FINAL";
    else if (ev.bestRound === "SF") key = "SF";
    else if (ev.bestRound === "QF") key = "QF";
    if (key) total += milestoneCpForEvent(ev, key);
  }
  return total;
}

/// Final levels (2dp): BASE_LEVEL*100 + cp, clamped to MIN_LEVEL*100.
export function levelsForState(state) {
  const out = new Map();
  for (const [id, p] of state.players) {
    const cp = p.levelCp + milestoneCpForPlayer(p);
    const level2dp = Math.max(Math.round(MIN_LEVEL * 100), Math.round(BASE_LEVEL * 100) + cp);
    out.set(id, { level2dp, levelFloat: level2dp / 100, name: p.name, tour: p.tour, cp });
  }
  return out;
}
