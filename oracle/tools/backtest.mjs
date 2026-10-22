// Season backtest: replay the match stream through the published scoring
// engine and report drift, reserve cost and platform economics.
//
//   node tools/backtest.mjs                 # live season (Jul 1 -> today)
//   node tools/backtest.mjs --season-start 2026-01-01
//
// Reads oracle/state/matches-2026.json + cached rankings. Prints:
//   - parity vs the published levels
//   - level drift distribution and the fat tail
//   - reserve cost per 1,000 CHZ of outstanding supply
//   - 10 CHZ hold P&L for the biggest movers
//   - fee revenue scenarios and break-even turnover
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { eligibleMatches, newState, applyMatch, levelsForState, milestoneCpForPlayer } from "../src/compute.js";
import { seededLookup } from "../src/seeds.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};

const BASE_CP = 750000;
const SEASON_START = arg("season-start", "2026-07-01");
const CHZ_USD = Number(arg("chz-usd", 0.014));

function loadRanks() {
  const out = {};
  for (const tour of ["atp", "wta"]) {
    const f = path.join(ROOT, "cache", `rankings-${tour}.json`);
    if (!fs.existsSync(f)) continue;
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    const r = j.rankings?.[0];
    if (r) out[tour] = new Map(r.ranks.map((e) => [String(e.athlete?.id ?? ""), e.current]));
  }
  return out;
}

const fmt = (n, d = 1) => (n >= 0 ? "+" : "") + n.toFixed(d);

function distribution(deltas) {
  const v = [...deltas].sort((a, b) => a - b);
  const n = v.length;
  const mean = v.reduce((s, x) => s + x, 0) / n;
  const median = n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / n);
  const q = (p) => v[Math.min(n - 1, Math.max(0, Math.floor(p * (n - 1))))];
  return { n, mean, median, sd, p5: q(0.05), p95: q(0.95), min: v[0], max: v[n - 1], above: v.filter((x) => x > 0).length, below: v.filter((x) => x < 0).length };
}

function payoutPer1000(ids, deltas) {
  const mean = ids.reduce((s, id) => s + (deltas.get(id) ?? 0), 0) / ids.length;
  return (1000 * mean) / 7500;
}

function holdPnl(level, spend = 10, feeBps = 100) {
  const tokens = (spend * (1 - feeBps / 10000)) / 1.0;
  const proceeds = tokens * (level / 7500) * (1 - feeBps / 10000);
  return { tokens, proceeds, profit: proceeds - spend, ret: (proceeds / spend - 1) * 100 };
}

console.log(`\n=== FSPI Tennis Index — season backtest ===`);
console.log(`window: ${SEASON_START} .. latest cached match\n`);

const matchesJson = JSON.parse(fs.readFileSync(path.join(ROOT, "state", "matches-2026.json"), "utf8"));
const rawAll = Object.values(matchesJson.byId);
const eligible = eligibleMatches(rawAll, matchesJson.labels)
  .filter((m) => m.startDate && m.startDate >= SEASON_START)
  .sort((a, b) => a.startDate.localeCompare(b.startDate) || String(a.compId).localeCompare(String(b.compId)));

console.log(`eligible matches: ${eligible.length}`);
console.log(`date range: ${eligible[0]?.startDate} .. ${eligible[eligible.length - 1]?.startDate}\n`);

const ranks = loadRanks();
// same frozen seeds as the oracle (read-only: the backtest never writes them)
const seedsFile = path.join(ROOT, "state", `seeds-${SEASON_START.slice(0, 4)}.json`);
const seeds = fs.existsSync(seedsFile) ? JSON.parse(fs.readFileSync(seedsFile, "utf8")) : { atp: {}, wta: {} };
const { lookup } = seededLookup(ranks, seeds);
const state = newState();
for (const m of eligible) applyMatch(state, m, lookup);
const levels = levelsForState(state);

// parity with the published levels (same window only)
const liveFile = path.join(ROOT, "state", "levels-2026.json");
if (fs.existsSync(liveFile)) {
  const live = JSON.parse(fs.readFileSync(liveFile, "utf8"));
  if ((live.seasonStart ?? "") === SEASON_START) {
    let n = 0, sumAbs = 0, big = 0;
    for (const [id, v] of levels) {
      const lv = live.players?.[id]?.levelFloat;
      if (lv == null) continue;
      n++; sumAbs += Math.abs(lv - v.levelFloat);
      if (Math.abs(lv - v.levelFloat) > 0.01) big++;
    }
    console.log(`parity vs published levels: ${n} matched, mean |diff| ${(sumAbs / n).toFixed(4)} pts, >0.01 pts: ${big}\n`);
  }
}

const deltas = new Map();
for (const [id, v] of levels) deltas.set(id, (v.level2dp - BASE_CP) / 100);
const byLevel = [...levels.entries()].sort((a, b) => b[1].levelFloat - a[1].levelFloat);
const top10 = byLevel.slice(0, 10);
const top50 = byLevel.slice(0, 50);
const allIds = [...levels.keys()];

let matchCp = 0, milestoneCp = 0;
for (const [, p] of state.players) { matchCp += p.levelCp; milestoneCp += milestoneCpForPlayer(p); }
console.log(`--- Drift (points off 7,500) ---`);
const d = distribution(deltas.values());
console.log(`players ${d.n} · mean ${fmt(d.mean, 2)} · median ${fmt(d.median, 2)} · sd ${d.sd.toFixed(1)} · p5/p95 ${fmt(d.p5, 0)}/${fmt(d.p95, 0)} · up/down ${d.above}/${d.below}`);
console.log(`decomposition: match transfers ${fmt(matchCp / 100, 1)} pts (zero-sum) · milestones ${fmt(milestoneCp / 100, 1)} pts (the only mint)\n`);

console.log(`--- Top 10 by level ---`);
for (const [id, v] of top10) console.log(`${(v.name || id).padEnd(24)} ${v.levelFloat.toFixed(1).padStart(8)}  ${fmt(deltas.get(id), 1).padStart(8)}`);
const top10sum = top10.reduce((s, [id]) => s + deltas.get(id), 0);
console.log(`top-10 sum: ${fmt(top10sum, 0)} pts (${fmt((top10sum / 10 / 7500) * 100, 1)}% NAV)\n`);

console.log(`--- Reserve cost per 1,000 CHZ of outstanding supply ---`);
const pools = [["top 10", top10.map(([id]) => id)], ["top 50", top50.map(([id]) => id)], ["all players", allIds]];
const starIds = [];
for (const tour of ["atp", "wta"]) {
  for (const [id] of [...(ranks[tour] ?? new Map()).entries()].sort((a, b) => a[1] - b[1]).slice(0, 5)) {
    if (levels.has(id)) starIds.push(id);
  }
}
pools.push(["star basket", starIds]);
const costs = {};
for (const [name, ids] of pools) {
  const chz = payoutPer1000(ids, deltas);
  costs[name] = chz;
  console.log(`${name.padEnd(12)} ${fmt(chz, 2).padStart(9)} CHZ  ${fmt((chz / 1000) * 100, 2).padStart(7)}% of book over the window`);
}

const days = Math.max(1, (Date.now() - new Date(eligible[0].startDate).getTime()) / 86400000);
const ann = (pct) => ((1 + pct / 100) ** (365 / days) - 1) * 100;
const annTop = ann((costs["top 10"] / 1000) * 100);
const annTop50 = ann((costs["top 50"] / 1000) * 100);
const annStars = ann((costs["star basket"] / 1000) * 100);
const annAll = ann((costs["all players"] / 1000) * 100);
console.log(`\nwindow: ${days.toFixed(0)} days`);
console.log(`annualized reserve cost: top-10 index ${fmt(annTop, 0)}%/yr · top-50 ${fmt(annTop50, 0)}%/yr · star basket ${fmt(annStars, 1)}%/yr · broad ${fmt(annAll, 1)}%/yr`);
console.log(`break-even turnover (1%/side): top-10 ${(annTop / 12).toFixed(2)}× book/month · star basket ${(annStars / 12).toFixed(2)}× · broad ${(annAll / 12).toFixed(2)}×\n`);

console.log(`--- 10 CHZ hold from season start (1% in, 1% out) ---`);
const movers = [...deltas.entries()].sort((a, b) => b[1] - a[1]);
const shown = [...movers.slice(0, 5), ...movers.slice(-5)];
console.log("player                    exit level    exit value      P&L      return");
for (const [id, delta] of shown) {
  const v = levels.get(id);
  const p = holdPnl(v.levelFloat);
  console.log(`${(v.name || id).padEnd(24)} ${v.levelFloat.toFixed(1).padStart(9)} ${p.proceeds.toFixed(4).padStart(12)} CHZ ${fmt(p.profit, 4).padStart(10)} ${fmt(p.ret, 2).padStart(9)}%`);
}

console.log(`\n--- Fee revenue (1% per side; volume counts both sides) ---`);
console.log("scenario         traders  avg CHZ/mo   monthly volume   fee/mo    fee/yr");
for (const [name, traders, avg] of [["pilot", 100, 200], ["growth", 1000, 500], ["scale", 5000, 1000]]) {
  const vol = traders * avg, feeMo = vol * 0.01;
  console.log(`${name.padEnd(15)} ${String(traders).padStart(7)} ${String(avg).padStart(10)} ${vol.toLocaleString().padStart(16)} ${feeMo.toLocaleString(undefined, { maximumFractionDigits: 0 }).padStart(9)} ${(feeMo * 12).toLocaleString(undefined, { maximumFractionDigits: 0 }).padStart(9)}`);
}

const BOOK_CHZ = 36_000_000;
const BOOK_USD = BOOK_CHZ * CHZ_USD;
const TURNOVER_MO = 2;
const annualVol = BOOK_CHZ * TURNOVER_MO * 12;
const feeChz = annualVol * 0.01;
console.log(`\n--- Platform P&L on a reference book ---`);
console.log(`book: ${(BOOK_CHZ / 1e6).toFixed(0)}M CHZ (~$${Math.round(BOOK_USD / 1000)}k at $${CHZ_USD}/CHZ), turnover ${TURNOVER_MO}×/month`);
console.log(`annual volume: ${(annualVol / 1e6).toFixed(0)}M CHZ (~$${Math.round((annualVol * CHZ_USD) / 1000)}k)`);
console.log(`fee revenue (1%/side): ${(feeChz / 1e6).toFixed(2)}M CHZ (~$${Math.round((feeChz * CHZ_USD) / 1000)}k)`);
console.log(`reserve cost: star basket ${fmt(annStars, 1)}% (~$${Math.round((BOOK_USD * annStars) / 100 / 1000)}k) · top-10 index ${fmt(annTop, 0)}% (~$${Math.round((BOOK_USD * annTop) / 100 / 1000)}k) · broad ${fmt(annAll, 1)}% (~$${Math.round((BOOK_USD * annAll) / 100 / 1000)}k)`);
console.log(`net before infra: star basket ~$${Math.round((feeChz * CHZ_USD - (BOOK_USD * annStars) / 100) / 1000)}k · broad ~$${Math.round((feeChz * CHZ_USD - (BOOK_USD * annAll) / 100) / 1000)}k`);
console.log(`\nbreak-even: ${(annStars / 12).toFixed(2)}× book/month (star basket) or ${(annAll / 12).toFixed(2)}× (broad) covers the reserve; fees at 2×/month are 24% of book/year.`);
