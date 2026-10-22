// Season index engine tests (node --test)
import test from "node:test";
import assert from "node:assert/strict";
import {
  eligibleMatches, applyMatch, levelsForState, newState,
  expectedScore, ratingFromRank, milestoneCpForPlayer, ELO_START,
} from "../src/compute.js";
import { BASE_LEVEL, MIN_LEVEL } from "../src/tiers.js";

const mkRanks = (map) => (tour, id) => map.get(id) ?? null;

function mkMatch(overrides = {}) {
  return {
    compId: "m1", tour: "atp", eventId: "e1", eventName: "Rolex Shanghai Masters",
    round: "Final", completed: true, startDate: "2026-10-13T00:00Z",
    players: [
      { id: "a", name: "Jannik Sinner", winner: true, lines: [{ value: 6, winner: true }, { value: 6, winner: true }] },
      { id: "d", name: "Novak Djokovic", winner: false, lines: [{ value: 0, winner: false }, { value: 0, winner: false }] },
    ],
    ...overrides,
  };
}

test("expected score: 0.5 at equal ratings, complementary across opponents", () => {
  assert.equal(expectedScore(1500, 1500), 0.5);
  assert.ok(Math.abs(expectedScore(1900, 1500) - 0.909) < 0.001);
  assert.ok(Math.abs(expectedScore(1500, 1900) + expectedScore(1900, 1500) - 1) < 1e-12);
});

test("ranking bootstrap: #1 starts near 2,200, #100 near 1,800, unranked 1,500", () => {
  assert.equal(ratingFromRank(null), ELO_START);
  assert.ok(Math.abs(ratingFromRank(1) - 2200) < 1e-9);
  assert.ok(Math.abs(ratingFromRank(100) - 1800) < 1e-9);
  assert.ok(ratingFromRank(1) > ratingFromRank(10));
});

test("match application is idempotent by compId", () => {
  const st = newState();
  assert.ok(applyMatch(st, mkMatch(), mkRanks(new Map())));
  assert.equal(applyMatch(st, mkMatch(), mkRanks(new Map())), false);
  assert.equal(st.matchIds.size, 1);
});

test("level points are a zero-sum transfer between the two players", () => {
  const st = newState();
  applyMatch(st, mkMatch(), mkRanks(new Map()));
  const a = st.players.get("a"), d = st.players.get("d");
  assert.equal(a.levelCp + d.levelCp, 0);
  assert.ok(a.levelCp > 0);
  assert.ok(d.levelCp < 0);
  // equal ratings: p=0.5, 6-0 6-0 with a title
  assert.equal(levelsForState(st).get("a").cp, 13940);
  assert.equal(levelsForState(st).get("d").cp, -10190);
});

test("rating updates are zero-sum", () => {
  const st = newState();
  st.ratings.set("a", 1900);
  st.ratings.set("d", 1500);
  applyMatch(st, mkMatch(), mkRanks(new Map()));
  assert.ok(Math.abs(st.ratings.get("a") + st.ratings.get("d") - 3400) < 1e-9);
});

test("an underdog win pays much more than a favourite win", () => {
  const score = (ra, rd) => {
    const st = newState();
    st.ratings.set("a", ra);
    st.ratings.set("d", rd);
    applyMatch(st, mkMatch(), mkRanks(new Map()));
    return st.players.get("a").levelCp;
  };
  const underdog = score(1500, 1900);
  const favourite = score(1900, 1500);
  assert.ok(underdog > favourite * 5, `underdog ${underdog} vs favourite ${favourite}`);
});

test("milestones scale with the surprise of the decisive match", () => {
  const milestone = (ra, rd) => {
    const st = newState();
    st.ratings.set("a", ra);
    st.ratings.set("d", rd);
    applyMatch(st, mkMatch(), mkRanks(new Map()));
    return milestoneCpForPlayer(st.players.get("a"));
  };
  const underdog = milestone(1500, 1900);
  const favourite = milestone(1900, 1500);
  assert.ok(underdog > favourite * 5, `underdog ${underdog} vs favourite ${favourite}`);
  assert.ok(underdog > 0);
});

test("tier multipliers scale the surprise base and milestone", () => {
  const st = newState();
  applyMatch(st, mkMatch({ compId: "m-gs", eventName: "Wimbledon", eventId: "e2" }), mkRanks(new Map()));
  // base 100.00 x 1.5 = 150.00 ; stats 14.40 ; title 200 x 1.5 x 0.5 x 0.25 = 37.50
  assert.equal(levelsForState(st).get("a").cp, 20190);
});

test("unknown-tier events use the conservative 0.4 multiplier", () => {
  const st = newState();
  applyMatch(st, mkMatch({ compId: "m8", eventName: "Some Random Open 2026" }), mkRanks(new Map()));
  // base 100 x 0.4 = 40.00 ; stats 14.40 ; title 200 x 0.4 x 0.5 x 0.25 = 10.00
  assert.equal(levelsForState(st).get("a").cp, 6440);
});

test("excluded events and qualifying rounds are rejected by applyMatch itself", () => {
  const st = newState();
  assert.equal(applyMatch(st, mkMatch({ compId: "m5", eventName: "Davis Cup" }), mkRanks(new Map())), false);
  assert.equal(applyMatch(st, mkMatch({ compId: "m6", round: "Qualification Round of 16" }), mkRanks(new Map())), false);
  assert.equal(applyMatch(st, mkMatch({ compId: "m7", eventName: "M15 Some ITF Future" }), mkRanks(new Map())), false);
});

test("levels clamp to minimum", () => {
  const st = newState();
  st.players.set("z", { id: "z", name: "Min Man", tour: "atp", levelCp: -10_000_000, events: new Map() });
  const levels = levelsForState(st);
  assert.equal(levels.get("z").level2dp, Math.round(MIN_LEVEL * 100));
});

test("seed ratings come from the ranking snapshot on first sight", () => {
  const st = newState();
  applyMatch(st, mkMatch(), mkRanks(new Map([["a", 1], ["d", 100]])));
  assert.ok(st.ratings.get("a") > st.ratings.get("d"));
  // #1 is a heavy favourite, so the same win is worth less than the #100's win
  const st2 = newState();
  applyMatch(st2, mkMatch({ compId: "m2" }), mkRanks(new Map([["a", 100], ["d", 1]])));
  assert.ok(st.players.get("a").levelCp < st2.players.get("a").levelCp);
});

function mkRounds(label) {
  return (round, n = 1, completed = true) => ({
    compId: `c-${round}-${n}`, tour: "atp", eventId: "ev", eventName: "Some Open 250",
    round, completed, startDate: "x",
    players: [
      { id: "a", name: "A A", winner: true, lines: [] },
      { id: "b", name: "B B", winner: false, lines: [] },
    ],
  });
}

test("Round-N labels resolve via draw structure (32-draw: R1=R32, R2=R16)", () => {
  const raw = [];
  const mk = mkRounds();
  for (let i = 0; i < 16; i++) raw.push(mk("Round 1", i));
  for (let i = 0; i < 8; i++) raw.push(mk("Round 2", i));
  for (let i = 0; i < 4; i++) raw.push(mk("Quarterfinals", i));
  raw.push(mk("Semifinals", 0), mk("Final", 0));
  const elig = eligibleMatches(raw);
  const byRound = {};
  for (const m of elig) byRound[m.resolvedRound] = (byRound[m.resolvedRound] || 0) + 1;
  assert.deepEqual(byRound, { R32: 16, R16: 8, QF: 4, SF: 1, F: 1 });
});

test("128-draw GS: Round1->R128 (64 matches), Round4->R16", () => {
  const raw = [];
  const mk = mkRounds();
  for (let i = 0; i < 64; i++) raw.push(mk("Round 1", i));
  for (let i = 0; i < 32; i++) raw.push(mk("Round 2", i));
  for (let i = 0; i < 16; i++) raw.push(mk("Round 3", i));
  for (let i = 0; i < 8; i++) raw.push(mk("Round 4", i));
  for (let i = 0; i < 4; i++) raw.push(mk("Quarterfinals", i));
  raw.push(mk("Semifinals", 0), mk("Final", 0));
  const elig = eligibleMatches(raw);
  const byRound = {};
  for (const m of elig) byRound[m.resolvedRound] = (byRound[m.resolvedRound] || 0) + 1;
  assert.deepEqual(byRound, { R128: 64, R64: 32, R32: 16, R16: 8, QF: 4, SF: 1, F: 1 });
});

test("96-draw: Round1 with 32 matches -> R96", () => {
  const raw = [];
  const mk = mkRounds();
  for (let i = 0; i < 32; i++) raw.push(mk("Round 1", i));
  for (let i = 0; i < 16; i++) raw.push(mk("Round 2", i));
  for (let i = 0; i < 8; i++) raw.push(mk("Round 3", i));
  for (let i = 0; i < 8; i++) raw.push(mk("Round 4", i));
  for (let i = 0; i < 4; i++) raw.push(mk("Quarterfinals", i));
  raw.push(mk("Semifinals", 0), mk("Final", 0));
  const elig = eligibleMatches(raw);
  const byRound = {};
  for (const m of elig) byRound[m.resolvedRound] = (byRound[m.resolvedRound] || 0) + 1;
  assert.deepEqual(byRound, { R96: 32, R64: 16, R32: 8, R16: 8, QF: 4, SF: 1, F: 1 });
});

test("Round-N without named anchor is skipped", () => {
  const raw = [];
  const mk = mkRounds();
  for (let i = 0; i < 8; i++) raw.push(mk("Round 1", i));
  raw.push(mk("Round 2", 0));
  const elig = eligibleMatches(raw);
  assert.equal(elig.length, 0);
});

test("frozen seeds: a ranking update does not move levels of matches already played", async () => {
  const { seededLookup } = await import("../src/seeds.js");
  const seeds = { atp: {}, wta: {} };
  const week1 = { atp: new Map([["a", 1], ["d", 100]]) };
  const week2 = { atp: new Map([["a", 50], ["d", 2]]) }; // rankings flip
  const run = (live) => {
    const st = newState();
    applyMatch(st, mkMatch(), seededLookup(live, seeds).lookup);
    return levelsForState(st);
  };
  const before = run(week1);
  const after = run(week2);
  assert.equal(after.get("a").level2dp, before.get("a").level2dp);
  assert.equal(after.get("d").level2dp, before.get("d").level2dp);
  assert.deepEqual(seeds.atp, { a: 1, d: 100 });
});

test("frozen seeds: a new player is seeded from the live ranking, unranked stays null", async () => {
  const { seededLookup } = await import("../src/seeds.js");
  const seeds = { atp: { a: 1 } };
  const s = seededLookup({ atp: new Map([["a", 40], ["n", 7]]) }, seeds);
  assert.equal(s.lookup("atp", "a"), 1);
  assert.equal(s.lookup("atp", "n"), 7);
  assert.equal(s.lookup("atp", "x"), null);
  assert.equal(s.added(), 2);
  // once seeded as unranked, a later live rank does not re-seed
  assert.equal(seededLookup({ atp: new Map([["x", 3]]) }, seeds).lookup("atp", "x"), null);
});

test("board round labels resolve early rounds before any QF is completed", () => {
  const r1 = { ...mkRounds("x")("Round 1", 1), eventId: "ev2" };
  // only Round 1 has finished: no completed anchor yet
  assert.equal(eligibleMatches([r1]).length, 0);
  // the board already lists Round 2, QF, SF and F (scheduled / TBD): 32-draw
  const labels = { "atp|ev2": { "Round 1": 16, "Round 2": 8, Quarterfinal: 4, Semifinal: 2, Final: 1 } };
  const elig = eligibleMatches([r1], labels);
  assert.equal(elig.length, 1);
  assert.equal(elig[0].resolvedRound, "R32");
});

test("board labels never change a completed event's resolution", () => {
  const mk = mkRounds("x");
  const raw = [mk("Round 1", 1), mk("Round 2", 2), mk("Quarterfinal", 3), mk("Semifinal", 4), mk("Final", 5)];
  const before = eligibleMatches(raw.map((m) => ({ ...m }))).map((m) => m.resolvedRound);
  const labels = { "atp|ev": { "Round 1": 16, "Round 2": 8, Quarterfinal: 4, Semifinal: 2, Final: 1 } };
  const after = eligibleMatches(raw.map((m) => ({ ...m })), labels).map((m) => m.resolvedRound);
  assert.deepEqual(after, before);
});
