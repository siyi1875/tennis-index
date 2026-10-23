#!/usr/bin/env node
// Business-model scenario check: Monte Carlo of the venue's P&L and pool
// solvency over a multi-year horizon, driven by the real 2026 level history.
//
// Market: daily level moves of the registered players (state/history-2026.json),
// resampled in whole weeks (tournament weeks stay intact, same week for every
// player, so cross-player structure is kept) into N synthetic futures, with a
// 6-week off-season per year (no matches, low volume). Price = level x scale,
// and the season reset carries prices over, so a level return is a price return.
//
// Holders: the book (B, USD at market value, held constant: inflows/outflows
// keep it there) is allocated by a behaviour and rebalanced weekly. The core is
// the counterparty: holder gains are paid from the pool, losses are swept to it.
//
// Venue: fees (1% per side) on all traded notional, 50% to the treasury and 50%
// to the pool. Costs: oracle gas per player-match (halt + post-match push, plus
// queue settlement when orders queued) from the real match counts, and a fixed
// monthly opex. Economic profit = fees - holder gains - gas - opex; the pool
// running dry (balance < 0) means tokens float below their level price.
//
//   node tools/scenarios.mjs [--paths 400] [--months 24] [--json out.json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const PATHS = Number(arg("paths", 400));
const MONTHS = Number(arg("months", 24));
const JSON_OUT = arg("json", null);
const SEED = Number(arg("seed", 7));

// ------------------------------ assumptions ------------------------------
export const A = {
  feeBps: 100, // per side
  treasuryShare: 0.5,
  chzUsd: Number(arg("chz-usd", 0.014)), // repo's backtest assumption; gas only
  gasPriceGwei: 2700, // Spicy: 2,500 base + tip
  gasPerPlayerMatch: 47_000 + 60_000, // scheduleHalts slot + updateLevel in a batch
  gasQueueSettle: 130_000, // when a batch has orders
  queuedShare: 0.3, // share of player-matches with queued orders
  offSeasonDays: 42, // per 365: no level moves
  offSeasonVolume: 0.3, // volume multiple during the off-season
  rebalanceDays: 7,
};

// --------------------------------- data ----------------------------------
const hist = JSON.parse(fs.readFileSync(path.join(ROOT, "state", "history-2026.json"), "utf8"));
const reg = JSON.parse(fs.readFileSync(path.join(ROOT, "state", "registry.json"), "utf8")).byId;
const seeds = JSON.parse(fs.readFileSync(path.join(ROOT, "state", "seeds-2026.json"), "utf8"));
const ids = Object.keys(reg);
const P = ids.length;
const D = hist.days.length;
const lv = ids.map((id) => hist.days.map((d) => d.lv[id] ?? 750000));
// daily returns r[t][i], t = 1..D-1
const R = [];
for (let t = 1; t < D; t++) R.push(Float64Array.from(ids.map((_, i) => lv[i][t] / lv[i][t - 1] - 1)));
const T = R.length;
// registered player-matches per day (gas)
const dayIdx = new Map(hist.days.map((d, k) => [d.d, k]));
const matchesPerDay = new Float64Array(D);
for (const id of ids) for (const row of hist.players[id]?.rows ?? []) if (row.t === "match" && dayIdx.has(row.d)) matchesPerDay[dayIdx.get(row.d)]++;
const avgPlayerMatches = matchesPerDay.reduce((s, x) => s + x, 0) / D;
const rank = ids.map((id) => seeds[reg[id].tour]?.[id] ?? 999);

// ------------------------------- behaviours ------------------------------
// weights(history of returns up to the rebalance day) -> Float64Array summing to 1
const topK = (score, k) => {
  const order = [...score.keys()].sort((a, b) => score[b] - score[a]).slice(0, k);
  const w = new Float64Array(P);
  for (const i of order) w[i] = 1 / k;
  return w;
};
const trailing = (path, t, n) => {
  const s = new Float64Array(P);
  for (let k = Math.max(0, t - n); k < t; k++) for (let i = 0; i < P; i++) s[i] += path[k][i];
  return s;
};
export const BEHAVIOURS = {
  broad: { label: "Broad: equal weight, all players", w: () => new Float64Array(P).fill(1 / P) },
  stars: { label: "Fans of stars: top-20 by ranking", w: () => topK(rank.map((r) => -r), 20) },
  momentum: { label: "Chasers: top-20 by last 14 days", w: (p, t) => topK(trailing(p, t, 14), 20) },
  contrarian: { label: "Bargain hunters: bottom-20 by last 14 days", w: (p, t) => topK(trailing(p, t, 14).map((x) => -x), 20) },
  mixed: { label: "Mixed: 40% stars, 30% chasers, 30% broad", mix: { stars: 0.4, momentum: 0.3, broad: 0.3 } },
};

// --------------------------------- rng -----------------------------------
let s0 = SEED >>> 0;
const rnd = () => ((s0 = (s0 * 1664525 + 1013904223) >>> 0) / 4294967296);

/// One synthetic future: daily return rows (shared references into R; the
/// off-season uses a zero row), plus the off-season flag per day.
function synthPath(days) {
  const zero = new Float64Array(P);
  const out = [], off = [];
  while (out.length < days) {
    const dayOfYear = out.length % 365;
    if (dayOfYear >= 365 - A.offSeasonDays) { out.push(zero); off.push(1); continue; }
    const start = Math.floor(rnd() * (T - 7));
    for (let k = 0; k < 7 && out.length < days && out.length % 365 < 365 - A.offSeasonDays; k++) { out.push(R[start + k]); off.push(0); }
  }
  return { rows: out, off };
}

/// Per behaviour, per day: holder return on the book (g) and rebalance
/// turnover as a fraction of the book (u). Scale-free, so every volume/size
/// scenario reuses the same paths.
function behaviourSeries(rows) {
  const days = rows.length;
  const base = {};
  for (const key of ["broad", "stars", "momentum", "contrarian"]) {
    const g = new Float64Array(days), u = new Float64Array(days);
    let w = null;
    for (let t = 0; t < days; t++) {
      if (t % A.rebalanceDays === 0) {
        const nw = BEHAVIOURS[key].w(rows, t);
        if (w) { let d = 0; for (let i = 0; i < P; i++) d += Math.abs(nw[i] - w[i]); u[t] = d; } // buys + sells notional
        w = nw;
      }
      let x = 0; const r = rows[t];
      for (let i = 0; i < P; i++) if (w[i]) x += w[i] * r[i];
      g[t] = x;
    }
    base[key] = { g, u };
  }
  const m = BEHAVIOURS.mixed.mix;
  const g = new Float64Array(days), u = new Float64Array(days);
  for (let t = 0; t < days; t++) for (const [k, f] of Object.entries(m)) { g[t] += f * base[k].g[t]; u[t] += f * base[k].u[t]; }
  base.mixed = { g, u };
  return base;
}

/// Old design's latency leak: an arbitrageur with capital `share` x book buys
/// each day's best mover after the result is public and before the push,
/// whenever the move beats the 2% round trip.
function leakSeries(rows, off) {
  const days = rows.length, x = new Float64Array(days);
  for (let t = 0; t < days; t++) {
    if (off[t]) continue;
    let best = 0; for (const r of rows[t]) if (r > best) best = r;
    x[t] = Math.max(0, best - 0.02);
  }
  return x;
}

// ------------------------------- scenario --------------------------------
/// Run one parameter set over precomputed paths. Returns per-path monthly
/// series and summary stats.
export function runScenario(pathsData, sc) {
  const days = MONTHS * 30;
  const fee = A.feeBps / 10_000;
  const gasUsdPerPlayerMatch = ((A.gasPerPlayerMatch + A.queuedShare * A.gasQueueSettle) * A.gasPriceGwei * 1e-9) * A.chzUsd;
  const results = [];
  for (const pd of pathsData) {
    const { g, u } = pd.series[sc.behaviour];
    let pool = sc.poolSeed, treasury = 0, econ = -sc.poolSeed * 0, cumFees = 0, cumHolder = 0, cumCost = 0;
    let dryDay = null, monthly = [];
    for (let t = 0; t < days; t++) {
      const book = sc.bookEnd ? sc.book + (sc.bookEnd - sc.book) * Math.min(1, t / days) : sc.book; // ramp
      const vol = book * ((sc.turnover / 30) * (pd.off[t] ? A.offSeasonVolume : 1) + u[t] * (sc.rebalanceShare ?? 0));
      let fees = vol * fee;
      let holder = book * g[t]; // + = pool pays
      if (sc.leak) holder += book * sc.leakShare * pd.leak[t];
      const gas = pd.off[t] ? 0 : avgPlayerMatches * gasUsdPerPlayerMatch;
      const opex = sc.opexMonthly / 30;
      pool += fees * (1 - A.treasuryShare) - holder;
      treasury += fees * A.treasuryShare - gas - opex;
      cumFees += fees; cumHolder += holder; cumCost += gas + opex;
      if (pool < 0 && dryDay === null) dryDay = t;
      if ((t + 1) % 30 === 0) monthly.push({ fees: cumFees, holder: cumHolder, cost: cumCost, pool, treasury });
    }
    const cum = monthly.map((m) => m.fees - m.holder - m.cost);
    const pay = cum.findIndex((v, m) => v > 0 && cum.slice(m).every((x) => x > 0));
    results.push({ dryDay, monthly, econ: cumFees - cumHolder - cumCost, payback: pay < 0 ? null : pay + 1 });
  }
  // summaries
  const q = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };
  const econ = results.map((r) => r.econ);
  const dry = results.map((r) => r.dryDay);
  const dryFrac = dry.filter((d) => d !== null).length / results.length;
  const dryMonths = dry.filter((d) => d !== null).map((d) => d / 30);
  // first month where cumulative economic P&L turns and stays positive (median path)
  const monthEcon = Array.from({ length: MONTHS }, (_, m) => q(results.map((r) => r.monthly[m].fees - r.monthly[m].holder - r.monthly[m].cost), 0.5));
  const monthEconP10 = Array.from({ length: MONTHS }, (_, m) => q(results.map((r) => r.monthly[m].fees - r.monthly[m].holder - r.monthly[m].cost), 0.1));
  const monthPoolP10 = Array.from({ length: MONTHS }, (_, m) => q(results.map((r) => r.monthly[m].pool), 0.1));
  const breakEven = monthEcon.findIndex((v, m) => v > 0 && monthEcon.slice(m).every((x) => x > 0));
  return {
    econMedian: q(econ, 0.5), econP10: q(econ, 0.1), econP90: q(econ, 0.9),
    probProfit: econ.filter((x) => x > 0).length / econ.length,
    feesMedian: q(results.map((r) => r.monthly.at(-1).fees), 0.5),
    holderMedian: q(results.map((r) => r.monthly.at(-1).holder), 0.5),
    holderP90: q(results.map((r) => r.monthly.at(-1).holder), 0.9),
    costMedian: q(results.map((r) => r.monthly.at(-1).cost), 0.5),
    poolDryProb: dryFrac, poolDryMedianMonth: dryMonths.length ? q(dryMonths, 0.5) : null,
    breakEvenMonth: breakEven < 0 ? null : breakEven + 1,
    paybackShare: results.filter((r) => r.payback !== null).length / results.length,
    paybackMedian: (() => { const p = results.map((r) => r.payback ?? Infinity); const v = q(p, 0.5); return v === Infinity ? null : v; })(),
    monthEcon, monthEconP10, monthPoolP10,
  };
}

export function buildPaths(n = PATHS) {
  const days = MONTHS * 30;
  const out = [];
  for (let k = 0; k < n; k++) {
    const { rows, off } = synthPath(days);
    out.push({ series: behaviourSeries(rows), off, leak: leakSeries(rows, off) });
  }
  return out;
}

// ---------------------------------- main ---------------------------------
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const t0 = Date.now();
  const paths = buildPaths();
  const gasMonthUsd = avgPlayerMatches * 30 * ((A.gasPerPlayerMatch + A.queuedShare * A.gasQueueSettle) * A.gasPriceGwei * 1e-9) * A.chzUsd;
  console.log(`data: ${P} registered players, ${T} daily moves (${hist.days[0].d}..${hist.days.at(-1).d}), ${avgPlayerMatches.toFixed(1)} registered player-matches/day`);
  console.log(`paths: ${PATHS} x ${MONTHS} months (weekly block bootstrap, ${A.offSeasonDays}-day off-season/yr) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`oracle gas: ~${(gasMonthUsd / A.chzUsd).toFixed(0)} CHZ/month (~$${gasMonthUsd.toFixed(0)} at $${A.chzUsd}/CHZ)\n`);

  const fmt = (x) => (x === null ? "never" : Math.abs(x) >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : Math.abs(x) >= 1e3 ? `${(x / 1e3).toFixed(0)}k` : x.toFixed(0));
  const qq = (a, x) => [...a].sort((m, n) => m - n)[Math.floor(x * a.length)];
  const fee = A.feeBps / 10_000;

  // 1. what each behaviour takes from the pool, and what users keep after fees
  console.log("1) Per year, as % of the book: holder gains the pool pays (median [10th..90th]) and the user's net after fees");
  console.log(`   ${"".padEnd(44)} ${"pool pays".padStart(22)}   user net at 0.25x / 0.5x / 1x / 2x per month`);
  const drift = {};
  for (const [key, b] of Object.entries(BEHAVIOURS)) {
    const yr = paths.map((p) => p.series[key].g.slice(0, 365).reduce((s, x) => s + x, 0));
    drift[key] = { med: qq(yr, 0.5), p90: qq(yr, 0.9) };
    const net = [0.25, 0.5, 1, 2].map((t) => `${(100 * (drift[key].med - t * 12 * fee * (1 - (A.offSeasonDays / 365) * (1 - A.offSeasonVolume)))).toFixed(0)}%`.padStart(5));
    console.log(`   ${b.label.padEnd(44)} ${`${(100 * drift[key].med).toFixed(1)}% [${(100 * qq(yr, 0.1)).toFixed(1)}..${(100 * drift[key].p90).toFixed(1)}]`.padStart(22)}   ${net.join(" /")}`);
  }

  // 2. break-even volume: fees must cover holder gains + costs
  const volFactor = 1 - (A.offSeasonDays / 365) * (1 - A.offSeasonVolume);
  console.log("\n2) Break-even trading volume (x book per month) = (holder gains + gas + opex) / 1% fee, mixed behaviour");
  console.log(`   ${"book".padEnd(8)} ${[0, 2_000, 10_000, 40_000].map((o) => `opex $${fmt(o)}/mo`.padStart(16)).join("")}     (90th-pct bad year)`);
  for (const book of [50_000, 250_000, 500_000, 1_000_000, 5_000_000]) {
    const cells = [0, 2_000, 10_000, 40_000].map((o) => {
      const t = (drift.mixed.med / 12 + (o + gasMonthUsd) / book) / (fee * volFactor);
      return `${t.toFixed(2)}x`.padStart(16);
    });
    const bad = (drift.mixed.p90 / 12 + (10_000 + gasMonthUsd) / book) / (fee * volFactor);
    console.log(`   $${fmt(book).padEnd(7)} ${cells.join("")}     ${bad.toFixed(2)}x @ $10k`);
  }

  // 3. Monte Carlo grid: total volume, behaviour picks holdings
  const turnovers = [0.25, 0.5, 1, 2, 4];
  const opexFor = { 50_000: 2_000, 500_000: 10_000, 5_000_000: 40_000 };
  const grid = [];
  for (const book of [50_000, 500_000, 5_000_000]) {
    console.log(`\n3) Book $${fmt(book)}, pool seed $${fmt(book * 0.1)}, opex $${fmt(opexFor[book])}/mo: ${MONTHS}-month profit, median (share of futures in profit)`);
    console.log(`   ${"behaviour".padEnd(12)} ${turnovers.map((t) => `${t}x/mo`.padStart(17)).join("")}`);
    for (const key of Object.keys(BEHAVIOURS)) {
      const cells = turnovers.map((turnover) => {
        const sc = { book, turnover, behaviour: key, poolSeed: book * 0.1, opexMonthly: opexFor[book] };
        const r = runScenario(paths, sc);
        grid.push({ ...sc, econMedian: r.econMedian, econP10: r.econP10, probProfit: r.probProfit, poolDryProb: r.poolDryProb });
        return `${fmt(r.econMedian)} (${Math.round(r.probProfit * 100)}%)`.padStart(17);
      });
      console.log(`   ${key.padEnd(12)} ${cells.join("")}`);
    }
  }

  // 4. growth: how long until it pays back
  console.log(`\n4) Growth case: book ramps from $50k to $X over ${MONTHS} months, mixed behaviour, opex $10k/mo, pool seed $50k`);
  console.log(`   ${"book at end".padEnd(12)} ${[0.5, 1, 2, 4].map((t) => `${t}x/mo`.padStart(24)).join("")}`);
  for (const end of [500_000, 2_000_000, 5_000_000]) {
    const cells = [0.5, 1, 2, 4].map((turnover) => {
      const r = runScenario(paths, { book: 50_000, bookEnd: end, turnover, behaviour: "mixed", poolSeed: 50_000, opexMonthly: 10_000 });
      return `${fmt(r.econMedian)}, payback ${r.paybackMedian ? `m${r.paybackMedian}` : "none"}`.padStart(24);
    });
    console.log(`   $${fmt(end).padEnd(11)} ${cells.join("")}`);
  }

  // 5. pool stress: star-heavy book, low volume
  console.log(`\n5) Pool stress: book $500k, pool seed $50k, opex $10k/mo; chance the pool runs dry in ${MONTHS} months / worst-10% pool at the end`);
  for (const key of ["stars", "mixed", "broad"]) {
    const cells = [0.25, 0.5, 1].map((turnover) => {
      const r = runScenario(paths, { book: 500_000, turnover, behaviour: key, poolSeed: 50_000, opexMonthly: 10_000 });
      return `${Math.round(r.poolDryProb * 100)}% / $${fmt(r.monthPoolP10.at(-1))}`.padStart(20);
    });
    console.log(`   ${key.padEnd(10)} at 0.25x / 0.5x / 1x: ${cells.join("")}`);
  }

  // 6. old design
  console.log(`\n6) Old design's latency leak: book $500k, mixed, 1x/mo, ${MONTHS}-month median profit by arbitrage capital`);
  const base = runScenario(paths, { book: 500_000, turnover: 1, behaviour: "mixed", poolSeed: 50_000, opexMonthly: 10_000 }).econMedian;
  for (const leakShare of [0.01, 0.05, 0.2]) {
    const r = runScenario(paths, { book: 500_000, turnover: 1, behaviour: "mixed", poolSeed: 50_000, opexMonthly: 10_000, leak: true, leakShare });
    console.log(`   ${String(leakShare * 100).padStart(3)}% of book: ${fmt(r.econMedian).padStart(6)} (cost of the leak ${fmt(base - r.econMedian)})`);
  }
  const lk = paths.map((p) => p.leak.reduce((s, x) => s + x, 0) / (MONTHS / 12));
  console.log(`   (an arbitrageur's edge per year on their capital, median: ${(100 * qq(lk, 0.5)).toFixed(0)}%)`);

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({ assumptions: A, months: MONTHS, paths: PATHS, players: P, avgPlayerMatches, gasMonthUsd, grid }, null, 1));
    console.log(`\nwrote ${JSON_OUT}`);
  }
}
