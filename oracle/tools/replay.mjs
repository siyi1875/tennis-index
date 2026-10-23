#!/usr/bin/env node
// Historical replay: run the venue's books over a real stretch of results, day
// by day in the order they happened (no resampling), and split the result into
// trading profit (fees - holder gains) and running costs.
//
//   node tools/replay.mjs [--history state/history-2026.json] [--universe registry|all|top]
//
// A full past year (scored as one continuous run, outside the live state):
//   SEASON=last12 SEASON_START=<yyyymmdd a year ago> node src/run.js backfill
//   SEASON=last12 SEASON_START=<same> node src/run.js compute
//   node tools/replay.mjs --history state/history-last12.json
// (run in a scratch worktree: it writes matches/state/history-last12 files)
//
// Universe:
//   registry  the players tokenized today (state/registry.json). Chosen by
//             today's ranking, so over a past window it favours players who did
//             well in it: a cost to the house, i.e. conservative.
//   top       top-100 per tour by level on the window's first day + 30 days
//             (a point-in-time pick that does not look ahead past day 30).
//   all       every tracked player.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const histFile = arg("history", path.join(ROOT, "state", "history-2026.json"));
const universe = arg("universe", "registry");
const hist = JSON.parse(fs.readFileSync(histFile, "utf8"));
// the record only has days with matches: fill calendar days, carrying levels forward
{
  const byDay = new Map(hist.days.map((d) => [d.d, d]));
  const cal = [];
  for (let t = Date.parse(hist.days[0].d + "T00:00:00Z"); t <= Date.parse(hist.days.at(-1).d + "T00:00:00Z"); t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10);
    cal.push(byDay.get(d) ?? { d, lv: cal.at(-1).lv });
  }
  hist.days = cal;
}
const reg = JSON.parse(fs.readFileSync(path.join(ROOT, "state", "registry.json"), "utf8")).byId;
const D = hist.days.length;

// ---------------------------- universe ----------------------------
let ids;
if (universe === "all") ids = Object.keys(hist.days.at(-1).lv);
else if (universe === "top") {
  const d30 = hist.days[Math.min(30, D - 1)].lv;
  ids = [];
  for (const tour of ["atp", "wta"]) {
    const ps = Object.keys(d30).filter((id) => hist.players[id]?.tour === tour).sort((a, b) => d30[b] - d30[a]);
    ids.push(...ps.slice(0, 100));
  }
} else ids = Object.keys(reg).filter((id) => hist.players[id] || hist.days.at(-1).lv[id]);
const P = ids.length;
const lv = ids.map((id) => hist.days.map((d) => d.lv[id] ?? 750000));
// tokens trade from the start of the window, so a player first seen later
// starts at base: their first move is real
const ret = (i, t) => lv[i][t] / lv[i][t - 1] - 1;

// matches per day in the universe (for gas and the quiet-day volume)
const dayIdx = new Map(hist.days.map((d, k) => [d.d, k]));
const matches = new Float64Array(D);
for (const id of ids) for (const r of hist.players[id]?.rows ?? []) if (r.t === "match" && dayIdx.has(r.d)) matches[dayIdx.get(r.d)]++;

// ---------------------------- behaviours ----------------------------
// popularity proxy: highest level on day 30 (a fan favours whoever is doing
// well and well known), fixed for the run; chasers/bargain hunters use the
// trailing 14 days, rebalanced weekly
const d30 = hist.days[Math.min(30, D - 1)].lv;
const order = (score) => [...score.keys()].sort((a, b) => score[b] - score[a]);
const top = (score, k) => { const w = new Float64Array(P); for (const i of order(score).slice(0, k)) w[i] = 1 / k; return w; };
const starsW = top(ids.map((id) => d30[id] ?? 0), 20);
const broadW = new Float64Array(P).fill(1 / P);
function holderReturns() {
  const g = { broad: [], stars: [], chase: [], bargain: [] };
  let wc = broadW, wb = broadW;
  for (let t = 1; t < D; t++) {
    if ((t - 1) % 7 === 0 && t > 14) {
      const tr = ids.map((_, i) => lv[i][t - 1] / lv[i][t - 15] - 1);
      wc = top(tr, 20); wb = top(tr.map((x) => -x), 20);
    }
    let a = 0, s = 0, c = 0, b = 0;
    for (let i = 0; i < P; i++) { const x = ret(i, t); if (!x) continue; a += broadW[i] * x; s += starsW[i] * x; c += wc[i] * x; b += wb[i] * x; }
    g.broad.push(a); g.stars.push(s); g.chase.push(c); g.bargain.push(b);
  }
  return g;
}
const G = holderReturns();
const MIX = { mixed: { stars: 0.4, chase: 0.3, broad: 0.3 }, broad: { broad: 1 }, stars: { stars: 1 }, chase: { chase: 1 }, bargain: { bargain: 1 } };
const series = (mix) => G.broad.map((_, t) => Object.entries(mix).reduce((s, [k, f]) => s + f * G[k][t], 0));

// ------------------------------ replay ------------------------------
const GAS_USD_PER_MATCH = (107_000 + 0.3 * 130_000) * 2700e-9 * 0.014;
function replay({ book, turnover, mix = "mixed", fee = 0.01, share = 0.5, seed = 0.1, opex = 0 }) {
  const g = series(MIX[mix]);
  let fees = 0, holder = 0, gas = 0, pool = book * seed, poolMin = pool, monthly = [];
  let mFees = 0, mHolder = 0;
  for (let t = 0; t < g.length; t++) {
    const quiet = matches[t + 1] === 0; // no tokenized player played: off-season volume
    const f = book * (turnover / 30) * (quiet ? 0.3 : 1) * fee;
    const h = book * g[t];
    fees += f; holder += h; mFees += f; mHolder += h;
    gas += matches[t + 1] * GAS_USD_PER_MATCH;
    pool += f * (1 - share) - h; poolMin = Math.min(poolMin, pool);
    if ((t + 1) % 30 === 0 || t === g.length - 1) { monthly.push({ to: hist.days[t + 1].d, fees: mFees, holder: mHolder }); mFees = 0; mHolder = 0; }
  }
  const years = g.length / 365;
  const opexTotal = opex * 12 * years;
  return { fees, holder, trading: fees - holder, gas, opex: opexTotal, net: fees - holder - gas - opexTotal, pool, poolMin, years, monthly, holderPct: g.reduce((s, x) => s + x, 0) };
}

// ------------------------------ report ------------------------------
const k = (x) => (Math.abs(x) >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : Math.abs(x) >= 1e3 ? `${(x / 1e3).toFixed(1)}k` : x.toFixed(0));
const $ = (x) => (x < 0 ? "-$" : "$") + k(Math.abs(x));
console.log(`window ${hist.days[0].d} .. ${hist.days.at(-1).d} (${D} days, ${(G.broad.length / 365).toFixed(2)} yr) · universe "${universe}": ${P} players · ${matches.reduce((s, x) => s + x, 0)} player-matches · ${matches.filter((x) => x === 0).length} quiet days\n`);

console.log("1) What holders gained over the window (the house pays this), by what they hold");
for (const m of Object.keys(MIX)) {
  const g = series(MIX[m]);
  let peak = 0, cum = 0, worst = 0;
  for (const x of g) { cum += x; peak = Math.max(peak, cum); worst = Math.max(worst, cum); }
  console.log(`   ${m.padEnd(8)} ${(100 * g.reduce((s, x) => s + x, 0)).toFixed(2).padStart(6)}% of the book   (peak ${(100 * worst).toFixed(2)}%)`);
}

console.log("\n2) Trading profit = fees - holder gains (no running costs), mixed holders, 1% fee per side");
const books = [50_000, 500_000, 5_000_000];
const vols = [0.1, 0.25, 0.5, 1, 2];
console.log(`   ${"book".padEnd(8)} ${vols.map((v) => `${v}x/mo`.padStart(26)).join("")}`);
for (const book of books) {
  console.log(`   $${k(book).padEnd(7)} ${vols.map((turnover) => {
    const r = replay({ book, turnover });
    return `${$(r.trading)} (fees ${$(r.fees)})`.padStart(26);
  }).join("")}`);
}

console.log("\n3) Same, by what holders hold, $500k book");
console.log(`   ${"holders".padEnd(8)} ${vols.map((v) => `${v}x/mo`.padStart(12)).join("")}`);
for (const mix of Object.keys(MIX)) console.log(`   ${mix.padEnd(8)} ${vols.map((turnover) => $(replay({ book: 500_000, turnover, mix }).trading).padStart(12)).join("")}`);

console.log("\n4) Lowest volume where trading alone breaks even (fees = holder gains), mixed / stars");
for (const mix of ["mixed", "stars", "broad"]) {
  let lo = 0, hi = 5;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (replay({ book: 500_000, turnover: m, mix }).trading > 0) hi = m; else lo = m; }
  console.log(`   ${mix.padEnd(8)} ${hi.toFixed(3)}x book per month`);
}

console.log("\n5) Full P&L, $500k book, mixed, 1x/mo: where the money goes over the window");
const r = replay({ book: 500_000, turnover: 1, opex: 10_000 });
console.log(`   fees ${$(r.fees)}  - holder gains ${$(r.holder)}  = trading ${$(r.trading)}  - gas ${$(r.gas)}  - running costs ${$(r.opex)} ($10k/mo)  = ${$(r.net)}`);
console.log(`   pool: starts $50k, lowest $${k(r.poolMin)}, ends $${k(r.pool)}`);
console.log("   month by month (fees / paid to holders):");
for (const m of r.monthly) console.log(`     to ${m.to}  ${$(m.fees).padStart(8)} / ${$(m.holder).padStart(8)}`);
