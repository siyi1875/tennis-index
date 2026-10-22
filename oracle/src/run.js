#!/usr/bin/env node
// Tennis Index oracle CLI
// Usage: node src/run.js <command>
//   backfill            fetch full 2026 season scoreboards (cached on disk)
//   compute             rebuild state from cached matches + rankings (+ history)
//   report              print top movers / levels summary
//   register            create on-chain player tokens + calibrate levels (admin)
//   push                push changed levels on-chain (oracle)
//   rebase              admin: calibrate all levels to computed values (no clamp)
//   watch               loop: fetch new results, compute, push (default 15 min)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchDay, fetchRankings, parseScoreboard, fmtDate, dateRange } from "./espn.js";
import { eligibleMatches, applyMatch, levelsForState, newState } from "./compute.js";
import { buildHistory } from "./history.js";
import { buildClose } from "./close.js";
import { saveJson, loadJson, serializeState } from "./state.js";
import { seededLookup } from "./seeds.js";
import { getWallet, getCore, TX_OVERRIDES, RPC_URL, DEPLOYMENTS_FILE, saveDeployments } from "./chain.js";
import { ethers } from "ethers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEASON = process.env.SEASON || "2026";
const SEASON_START = process.env.SEASON_START || "20260701"; // tracking starts mid-year; SEASON_START=20260101 for full season
const FEE_BPS = Number(process.env.FEE_BPS || 100); // venue fee on buy+sell (`fees` command only; new tokens use the core's on-chain default)
const CLOSE_HOUR_UTC = Number(process.env.CLOSE_HOUR_UTC || 9);
const TOURS = ["atp", "wta"];

const MATCHES_FILE = `matches-${SEASON}.json`;
const SEEDS_FILE = `seeds-${SEASON}.json`;

async function main() {
  const cmd = process.argv[2] || "help";
  const commands = { backfill, compute, report, register, push, rebase, close, fees, watch, deployinfo, help };
  if (commands[cmd]) await commands[cmd](process.argv[3]);
  else commands.help();
}

async function backfill() {
  const today = fmtDate(new Date());
  const matches = loadJson(MATCHES_FILE, { byId: {} });
  const seen = new Set(Object.keys(matches.byId));
  let added = 0;
  for (const tour of TOURS) {
    for (const d of dateRange(SEASON_START, today)) {
      if (new Date().getTime() % 1 === 0) process.stdout.write(`\r${tour} ${d}   `);
      const payload = await fetchDay(tour, d, { useCache: d !== today });
      const parsed = parseScoreboard(tour, payload);
      for (const m of parsed) {
        if (seen.has(m.compId)) continue;
        if (!m.completed) continue;
        matches.byId[m.compId] = m;
        seen.add(m.compId);
        added++;
      }
      saveJson(MATCHES_FILE, matches); // checkpoint per day (crash-safe)
      await new Promise((r) => setTimeout(r, 350)); // be polite to ESPN
    }
  }
  console.log(`\nbackfill complete: +${added} new matches, total ${Object.keys(matches.byId).length}`);
}

async function loadRankings() {
  const ranks = {};
  for (const tour of TOURS) {
    const r = await fetchRankings(tour);
    ranks[tour] = new Map(r.ranks.map((x) => [x.id, x.rank]));
    console.log(`${tour}: ${r.ranks.length} ranked, updated ${r.updatedAt}, #1 ${r.ranks[0].name} (${r.ranks[0].points} pts)`);
  }
  return ranks;
}

/// Rank lookup with frozen seeds (see seeds.js): players already seen keep
/// their first-sight rank; new players are seeded from the live ranking and
/// persisted by persist().
async function frozenLookup() {
  const seeds = loadJson(SEEDS_FILE, { atp: {}, wta: {} });
  const s = seededLookup(await loadRankings(), seeds);
  const persist = () => {
    if (!s.added()) return;
    saveJson(SEEDS_FILE, seeds);
    console.log(`seeds: +${s.added()} players frozen at first-sight rank`);
  };
  return { lookup: s.lookup, persist };
}

async function buildState() {
  const matchesData = loadJson(MATCHES_FILE, { byId: {} });
  const raw = Object.values(matchesData.byId);
  const start = SEASON_START.length === 8 ? `${SEASON_START.slice(0, 4)}-${SEASON_START.slice(4, 6)}-${SEASON_START.slice(6, 8)}` : SEASON_START;
  const elig = eligibleMatches(raw)
    .filter((m) => (m.startDate || "").slice(0, 10) >= start)
    .sort((a, b) => (a.startDate || "").localeCompare(b.startDate || "") || String(a.compId).localeCompare(String(b.compId)));
  console.log(`matches: ${raw.length} raw, ${elig.length} eligible since ${start} (singles, main draw, completed)`);
  const { lookup, persist } = await frozenLookup();
  const st = newState();
  let applied = 0;
  for (const m of elig) if (applyMatch(st, m, lookup)) applied++;
  persist();
  console.log(`applied ${applied} matches to state (${st.matchIds.size} total, ${st.players.size} players)`);
  saveJson(`state-${SEASON}.json`, serializeState(st));
  return st;
}

async function compute() {
  const matchesData = loadJson(MATCHES_FILE, { byId: {} });
  const raw = Object.values(matchesData.byId);
  const start = SEASON_START.length === 8 ? `${SEASON_START.slice(0, 4)}-${SEASON_START.slice(4, 6)}-${SEASON_START.slice(6, 8)}` : SEASON_START;
  const elig = eligibleMatches(raw)
    .filter((m) => (m.startDate || "").slice(0, 10) >= start)
    .sort((a, b) => (a.startDate || "").localeCompare(b.startDate || "") || String(a.compId).localeCompare(String(b.compId)));
  console.log(`matches: ${raw.length} raw, ${elig.length} eligible since ${start} (singles, main draw, completed)`);
  const { lookup, persist } = await frozenLookup();
  const state = newState();
  let applied = 0;
  for (const m of elig) if (applyMatch(state, m, lookup)) applied++;
  persist();
  console.log(`applied ${applied} matches to state (${state.matchIds.size} total, ${state.players.size} players)`);
  saveJson(`state-${SEASON}.json`, serializeState(state));
  const levels = levelsForState(state);
  saveJson(`levels-${SEASON}.json`, {
    computedAt: new Date().toISOString(),
    seasonStart: start,
    players: Object.fromEntries([...levels.entries()].map(([id, v]) => [id, v])),
  });
  // retraceable record: daily snapshots + per-player match attribution
  const { out: history } = buildHistory(elig, lookup);
  saveJson(`history-${SEASON}.json`, history);
  console.log(`history: ${history.players ? Object.keys(history.players).length : 0} players, ${history.days.length} daily snapshots`);
  await reportFrom(levels);
}

async function reportFrom(levels) {
  const rows = [...levels.entries()].map(([id, v]) => ({ id, ...v }));
  for (const tour of ["atp", "wta"]) {
    const tourRows = rows.filter((r) => r.tour === tour).sort((a, b) => b.level2dp - a.level2dp);
    console.log(`\n=== ${tour.toUpperCase()} top 10 ===`);
    for (const r of tourRows.slice(0, 10)) console.log(`  ${r.levelFloat.toFixed(2).padStart(8)}  ${r.name}`);
    console.log(`  (${tourRows.length} players ranked by index)`);
  }
}

async function report() {
  const levels = new Map(Object.entries(loadJson(`levels-${SEASON}.json`, { players: {} }).players).map(([k, v]) => [k, v]));
  await reportFrom(levels);
}

function symbolFor(name, tour, used) {
  const parts = name.split(/\s+/).filter(Boolean);
  const last = parts.length > 1 ? parts[parts.length - 1] : name;
  let base = (last.replace(/[^A-Za-z]/g, "").slice(0, 3) || "PLY").toUpperCase();
  const prefix = tour === "atp" ? "ATP" : "WTA";
  let sym = `${prefix}-${base}`;
  if (!used.has(sym)) {
    used.add(sym);
    return sym;
  }
  // disambiguate within 8 chars: "ATP-SIN2" ... "ATP-SI99"
  for (let n = 2; n <= 99; n++) {
    const suffix = String(n);
    const keep = 5 - prefix.length - 1 - suffix.length; // chars of base available
    sym = `${prefix}-${base.slice(0, Math.max(1, keep))}${suffix}`;
    if (!used.has(sym)) {
      used.add(sym);
      return sym;
    }
  }
  throw new Error(`no symbol available for ${name}`);
}

async function onchainPlayers() {
  const core = getCore(getWallet());
  const count = Number(await core.playerCount());
  const players = [];
  if (count > 0) {
    const arr = await core.playersRange(0, count);
    arr.forEach((p, i) => players.push({ id: i, token: p.token, tour: Number(p.tour), level: Number(p.level), lastUpdate: Number(p.lastUpdate) }));
  }
  return { core, count, players };
}

async function register() {
  const st = await buildState();
  const levels = levelsForState(st);
  // Universe: top-100 of each tour by current ESPN ranking + anyone else with
  // a strong season level (>= 7,900.00). Extras are added only while budget
  // allows (we keep a safety reserve for the oracle watch loop).
  const ranks = await loadRankings();
  const rows = [...levels.entries()].map(([id, v]) => ({ id, ...v }));
  const coreIds = new Set();
  const extrasByTour = { atp: [], wta: [] };
  for (const tour of TOURS) {
    const top100 = [...ranks[tour].entries()].sort((a, b) => a[1] - b[1]).slice(0, 100).map(([id]) => id);
    top100.forEach((id) => coreIds.add(id));
    extrasByTour[tour] = rows
      .filter((r) => r.tour === tour && !coreIds.has(r.id) && r.level2dp >= 790_000)
      .sort((a, b) => b.level2dp - a.level2dp)
      .slice(0, 40)
      .map((r) => r.id);
  }
  const ordered = [...coreIds, ...extrasByTour.atp, ...extrasByTour.wta].filter((id) => levels.has(id));

  const { count, players } = await onchainPlayers();
  const registry = loadJson("registry.json", { byId: {} });
  const used = new Set();
  // rebuild the used-symbol set from on-chain token symbols
  {
    const wallet = getWallet();
    const ethersMod = await import("ethers");
    for (const p of players) {
      const tok = new ethersMod.Contract(p.token, ["function symbol() view returns (string)"], wallet);
      used.add(await tok.symbol());
    }
  }
  const toAdd = ordered.filter((id) => !registry.byId[id]);
  console.log(`universe: ${ordered.length}, registered: ${Object.keys(registry.byId).length}, to add: ${toAdd.length}`);

  const SAFETY = ethers.parseEther("4"); // keep this much for the oracle
  const CHUNK = 20;
  for (let i = 0; i < toAdd.length; i += CHUNK) {
    const chunk = toAdd.slice(i, i + CHUNK);
    const wallet = getWallet();
    const coreW = getCore(wallet);
    const bal = await wallet.provider.getBalance(await wallet.getAddress());
    if (bal < SAFETY + ethers.parseEther("0.4") * BigInt(chunk.length)) {
      console.log(`budget stop: balance ${ethers.formatEther(bal)} CHZ, need ~${(0.4 * chunk.length + Number(ethers.formatEther(SAFETY))).toFixed(1)}`);
      break;
    }
    const symbols = [], tours = [], lvls = [];
    for (const id of chunk) {
      const v = levels.get(id);
      const sym = symbolFor(v.name, v.tour, used);
      symbols.push(sym);
      tours.push(v.tour === "atp" ? 1 : 2);
      lvls.push(v.level2dp);
    }
    try {
      const tx = await coreW.addPlayers(symbols, tours, lvls, TX_OVERRIDES);
      const rc = await tx.wait();
      const evs = rc.logs
        .map((l) => { try { return coreW.interface.parseLog(l); } catch { return null; } })
        .filter((x) => x?.name === "PlayerAdded");
      chunk.forEach((id, k) => {
        const v = levels.get(id);
        const ev = evs.find((e) => e?.args?.symbol === symbols[k]);
        const onChainId = Number(ev?.args?.id ?? (count + i + k));
        registry.byId[id] = { onChainId, name: v.name, symbol: symbols[k], tour: v.tour, level: v.level2dp, tx: rc.hash };
      });
      saveJson("registry.json", registry);
      console.log(`batch ${Math.floor(i / CHUNK)}: +${evs.length} players (tx ${rc.hash.slice(0, 12)}…, gas ${rc.gasUsed}, ~${(Number(rc.gasUsed) * 2.7e-6).toFixed(2)} CHZ)`);
    } catch (e) {
      console.error(`batch failed: ${(e.shortMessage || e.message || "").slice(0, 200)}`);
      if (/insufficient funds/i.test(e.message ?? "")) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  console.log(`registration done: registry size ${Object.keys(registry.byId).length}`);
}

async function push() {
  const st = await buildState();
  const levels = levelsForState(st);
  const { core, players } = await onchainPlayers();
  const registry = loadJson("registry.json", { byId: {} });
  const byChainId = new Map(players.map((p) => [p.id, p]));
  const updates = [];
  const now = Math.floor(Date.now() / 1000);
  const MIN_INTERVAL = 30 * 60; // keep in sync with TennisIndex.minUpdateInterval
  let deferred = 0;
  for (const [espnId, reg] of Object.entries(registry.byId)) {
    const p = byChainId.get(reg.onChainId);
    const lv = levels.get(espnId);
    if (!p || !lv) continue;
    if (lv.level2dp === p.level) continue;
    if (p.lastUpdate && now < p.lastUpdate + MIN_INTERVAL) { deferred++; continue; }
    updates.push({ id: p.id, level: lv.level2dp, name: reg.name, old: p.level, delta: (lv.level2dp - p.level) / 100 });
  }
  console.log(`push: ${updates.length} level changes pending${deferred ? `, ${deferred} deferred (<30m since last update)` : ""}`);
  updates.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  for (const u of updates.slice(0, 15)) console.log(`  ${u.name}: ${(u.old / 100).toFixed(2)} -> ${(u.level / 100).toFixed(2)} (${u.delta > 0 ? "+" : ""}${u.delta.toFixed(2)})`);
  if (updates.length === 0) return;
  // cap |delta| at maxDeltaBps by clamping (oracle-side) to avoid DeltaTooBig
  const cap = 2500; // 25%
  const ids = [], lvls = [];
  for (const u of updates) {
    let target = u.level;
    const maxAbs = Math.floor((u.old * cap) / 10000);
    if (target > u.old + maxAbs) target = u.old + maxAbs;
    if (target < u.old - maxAbs) target = u.old - maxAbs;
    ids.push(u.id);
    lvls.push(target);
  }
  const CHUNK_MAX = 40;
  const GAS_PER_MOVER = 60000n; // measured ~57.5k gas per level in a batched updateLevels
  const FEE_PER_GAS = ethers.parseUnits("2.7", "gwei"); // 2500 base + ~200 tip
  const MIN_GAS_BALANCE = ethers.parseEther("1");
  let i = 0;
  while (i < ids.length) {
    const wallet = getWallet();
    const coreW = getCore(wallet);
    const bal = await wallet.provider.getBalance(await wallet.getAddress());
    if (bal < MIN_GAS_BALANCE) {
      console.log(`push aborted: balance ${ethers.formatEther(bal)} CHZ too low for gas`);
      break;
    }
    const affordable = Number((bal - MIN_GAS_BALANCE) / (GAS_PER_MOVER * FEE_PER_GAS));
    const n = Math.max(1, Math.min(CHUNK_MAX, affordable));
    const size = Math.min(n, ids.length - i);
    try {
      const tx = await coreW.updateLevels(ids.slice(i, i + size), lvls.slice(i, i + size), TX_OVERRIDES);
      const rc = await tx.wait();
      console.log(`pushed ${size} levels (tx ${rc.hash.slice(0, 12)}…, gas ${rc.gasUsed})`);
      const log = loadJson(`pushlog-${SEASON}.json`, []);
      log.push({ ts: new Date().toISOString(), tx: rc.hash, n: size, ids: ids.slice(i, i + size), levels: lvls.slice(i, i + size) });
      saveJson(`pushlog-${SEASON}.json`, log);
    } catch (e) {
      console.error(`push chunk failed: ${(e.shortMessage || e.message || "").slice(0, 200)}`);
      throw e;
    }
    i += size;
    await new Promise((r) => setTimeout(r, 4000));
  }
}

const FAUCET_MIN_BALANCE = Number(process.env.FAUCET_MIN_BALANCE || 4);
const FAUCET_CLAIMS_PER_DAY = Number(process.env.FAUCET_CLAIMS_PER_DAY || 4);
let faucetClaimsToday = 0;
let faucetDay = new Date().toISOString().slice(0, 10);

async function maybeClaimFaucet() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== faucetDay) {
    faucetDay = today;
    faucetClaimsToday = 0;
  }
  const wallet = getWallet();
  const bal = await wallet.provider.getBalance(await wallet.getAddress());
  if (bal > ethers.parseEther(String(FAUCET_MIN_BALANCE))) return;
  if (faucetClaimsToday >= FAUCET_CLAIMS_PER_DAY) return;
  faucetClaimsToday++;
  const priv = `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  const fw = new ethers.Wallet(priv, wallet.provider);
  const addr = await fw.getAddress();
  const { spawnSync } = await import("node:child_process");
  const bot = path.join(__dirname, "..", "faucetbot", "claim2.cjs");
  const res = spawnSync("node", [bot, addr], { timeout: 120_000, encoding: "utf8" });
  const ok = /Tokens sent successfully/.test(res.stdout ?? "");
  console.log(`faucet claim #${faucetClaimsToday} for ${addr}: ${ok ? "OK" : "FAILED"}`);
  if (!ok) return;
  await new Promise((r) => setTimeout(r, 12_000));
  const fresh = await wallet.provider.getBalance(addr);
  if (fresh > ethers.parseEther("0.05")) {
    const sweep = fresh - 42000n * ethers.parseUnits("2700", "gwei");
    const fee = { type: 2, maxFeePerGas: ethers.parseUnits("2700", "gwei"), maxPriorityFeePerGas: ethers.parseUnits("200", "gwei") };
    const stx = await fw.sendTransaction({ to: await wallet.getAddress(), value: sweep, ...fee });
    await stx.wait();
    console.log(`faucet swept ${ethers.formatEther(sweep)} CHZ to deployer`);
  }
}

/// One-off admin rebase: set every registered player's on-chain level to the
/// currently computed level, bypassing the ±25% push clamp (calibrateLevel).
/// Used when the tracking window changes (e.g. season restart at mid-year).
async function rebase() {
  const st = await buildState();
  const levels = levelsForState(st);
  const { core, count, players } = await onchainPlayers();
  const registry = loadJson("registry.json", { byId: {} });
  const byChainId = new Map(players.map((p) => [p.id, p]));
  const jobs = [];
  for (const [espnId, reg] of Object.entries(registry.byId)) {
    const p = byChainId.get(reg.onChainId);
    const lv = levels.get(espnId);
    if (!p || !lv) continue;
    if (lv.level2dp !== p.level) jobs.push({ id: p.id, level: lv.level2dp, name: reg.name, old: p.level });
  }
  console.log(`rebase: ${jobs.length}/${count} players need calibrate`);
  // broadcast concurrently with sequential nonces (don't wait per tx)
  const wallet = getWallet();
  const coreW = getCore(wallet);
  let nonce = await wallet.getNonce("pending");
  const promises = [];
  let sent = 0;
  for (const j of jobs) {
    try {
      const tx = await coreW.calibrateLevel(j.id, j.level, { ...TX_OVERRIDES, nonce });
      nonce++;
      sent++;
      promises.push(
        tx.wait().then(() => {}).catch((e) => console.error(`calibrate tx failed #${j.id} ${j.name}: ${(e.shortMessage || e.message || "").slice(0, 100)}`))
      );
    } catch (e) {
      console.error(`calibrate send failed #${j.id} ${j.name}: ${(e.shortMessage || e.message || "").slice(0, 120)}`);
    }
    if (sent % 25 === 0) await new Promise((r) => setTimeout(r, 400));
  }
  await Promise.allSettled(promises);
  console.log(`rebase done: ${sent} txs sent`);
}

/// Re-price fees on existing tokens to FEE_BPS/FEE_BPS. New tokens already
/// start with the core's default fees (set on-chain at creation), so this is
/// only for deliberate changes; it no longer runs in watch.
async function fees() {
  const wallet = getWallet();
  const coreW = getCore(wallet);
  const { players } = await onchainPlayers();
  const jobs = [];
  for (const p of players) {
    const tok = new ethers.Contract(p.token, ["function buyFeeBps() view returns (uint16)", "function sellFeeBps() view returns (uint16)"], wallet);
    const [buyFee, sellFee] = await Promise.all([tok.buyFeeBps(), tok.sellFeeBps()]);
    if (Number(buyFee) !== FEE_BPS || Number(sellFee) !== FEE_BPS) jobs.push({ id: p.id, token: p.token });
  }
  console.log(`fees: ${jobs.length} tokens need ${FEE_BPS}/${FEE_BPS} bps`);
  for (const j of jobs) {
    const tx = await coreW.setPlayerFees(j.id, FEE_BPS, FEE_BPS, TX_OVERRIDES);
    await tx.wait();
    console.log(`fees set: player #${j.id} -> ${FEE_BPS}/${FEE_BPS} bps`);
  }
  console.log("fees done");
}

/// Publish the Official Daily Close for `day` (default: yesterday).
/// Levels from all completed matches with startDate <= end of day, hashed.
async function close(day) {
  const target = day || fmtDate(new Date(Date.now() - 26 * 3600 * 1000));
  const norm = target.includes("-") ? target : `${target.slice(0, 4)}-${target.slice(4, 6)}-${target.slice(6, 8)}`;
  const matchesData = loadJson(MATCHES_FILE, { byId: {} });
  const { lookup, persist } = await frozenLookup();
  const c = buildClose(Object.values(matchesData.byId), lookup, norm, SEASON_START);
  persist();
  const file = loadJson(`close-${SEASON}.json`, { history: [], latest: null });
  file.history = [...(file.history ?? [])].sort((a, b) => a.day.localeCompare(b.day));
  const maxDay = file.history[file.history.length - 1]?.day;
  const existing = file.history.find((h) => h.day === norm);
  if (existing) {
    if (norm === maxDay && file.latest?.day !== norm) {
      file.latest = { ...existing, players: c.players };
      saveJson(`close-${SEASON}.json`, file);
    }
    console.log(`close for ${norm} already published (hash ${existing.hash.slice(0, 12)}…)`);
    return;
  }
  const entry = { day: c.day, publishedAt: new Date().toISOString(), matches: c.matches, hash: c.hash };
  file.history.push(entry);
  file.history.sort((a, b) => a.day.localeCompare(b.day));
  if (norm === file.history[file.history.length - 1].day) {
    file.latest = { ...entry, players: c.players };
  }
  saveJson(`close-${SEASON}.json`, file);
  console.log(`official close ${target}: ${c.matches} matches, ${Object.keys(c.players).length} players, sha256 ${c.hash.slice(0, 12)}…`);
}

async function maybePublishClose() {
  const now = new Date();
  const cutoff = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), CLOSE_HOUR_UTC);
  if (now.getTime() < cutoff) return;
  const target = fmtDate(new Date(Date.now() - 26 * 3600 * 1000));
  const norm = `${target.slice(0, 4)}-${target.slice(4, 6)}-${target.slice(6, 8)}`;
  const file = loadJson(`close-${SEASON}.json`, { history: [] });
  if ((file.history ?? []).some((h) => h.day === norm)) return;
  await close(target);
}

async function watch() {
  const intervalMin = Number(process.env.WATCH_INTERVAL_MIN || 15);
  console.log(`watch mode: every ${intervalMin} min`);
  for (;;) {
    try {
      await incrementalFetch();
      await compute();
      await push();
      await maybePublishClose();
      await maybeClaimFaucet();
    } catch (e) {
      console.error(`watch iteration failed: ${e.message?.slice(0, 300)}`);
    }
    await new Promise((r) => setTimeout(r, intervalMin * 60_000));
  }
}

async function incrementalFetch() {
  const matchesData = loadJson(MATCHES_FILE, { byId: {} });
  const seen = new Set(Object.keys(matchesData.byId));
  const yesterday = fmtDate(new Date(Date.now() - 26 * 3600 * 1000));
  const today = fmtDate(new Date());
  let added = 0;
  for (const tour of TOURS) {
    for (const d of [yesterday, today]) {
      const payload = await fetchDay(tour, d, { useCache: d === yesterday });
      for (const m of parseScoreboard(tour, payload)) {
        if (seen.has(m.compId) || !m.completed) continue;
        matchesData.byId[m.compId] = m;
        seen.add(m.compId);
        added++;
      }
    }
  }
  if (added) saveJson(MATCHES_FILE, matchesData);
  console.log(`incremental fetch: +${added} matches`);
}

async function deployinfo() {
  const d = JSON.parse(fs.readFileSync(DEPLOYMENTS_FILE, "utf8"));
  console.log(JSON.stringify(d, null, 2));
}

async function help() {
  console.log(`commands: backfill compute report register push rebase close fees watch deployinfo`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
