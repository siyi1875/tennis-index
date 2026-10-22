// Minimal static + data server for the FSPI Tennis Index demo UI.
// Read-only on-chain reads for the portfolio view live here (browser does trades).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.dirname(fileURLToPath(import.meta.url));
const stateDir = path.join(root, "..", "oracle", "state");
const port = Number(process.env.PORT || 8080);
const require = createRequire(path.join(root, "..", "oracle", "package.json"));
const { ethers, JsonRpcProvider } = require("ethers");

const RPC = process.env.RPC_URL || "https://spicy-rpc.chiliz.com";
const provider = new JsonRpcProvider(RPC, 88882, { staticNetwork: true });

const API = {
  "/api/registry": "registry.json",
  "/api/levels": "levels-2026.json",
  "/api/history": "history-2026.json",
  "/api/pushlog": "pushlog-2026.json",
  "/api/close": "close-2026.json",
};

const SEL = {
  balanceOf: ethers.id("balanceOf(address)").slice(0, 10),
  navWad: ethers.id("navWad()").slice(0, 10),
};
const BOUGHT_TOPIC = ethers.id("Bought(address,address,uint256,uint256,uint256)");
const SOLD_TOPIC = ethers.id("Sold(address,address,uint256,uint256,uint256)");

const registryCache = { at: 0, byId: null };
function loadRegistry() {
  if (Date.now() - registryCache.at < 10_000 && registryCache.byId) return registryCache.byId;
  try {
    registryCache.byId = JSON.parse(fs.readFileSync(path.join(stateDir, "registry.json"), "utf8")).byId ?? {};
  } catch { registryCache.byId = {}; }
  registryCache.at = Date.now();
  return registryCache.byId;
}

const portfolioCache = new Map(); // address -> { at, data }
const blockTsCache = new Map(); // number -> ts
const LOG_WINDOW = 200_000; // Spicy RPC caps getLogs at 250k blocks
let latestBlock = 0, latestBlockAt = 0;
async function logFromBlock() {
  if (Date.now() - latestBlockAt > 60_000 || !latestBlock) {
    latestBlock = await provider.getBlockNumber().catch(() => 0);
    latestBlockAt = Date.now();
  }
  return Math.max(0, latestBlock - LOG_WINDOW);
}
async function blockTs(n) {
  if (blockTsCache.has(n)) return blockTsCache.get(n);
  const b = await provider.getBlock(n);
  const ts = b ? b.timestamp : 0;
  blockTsCache.set(n, ts);
  return ts;
}

const call = (to, data) => provider.call({ to, data });

async function buildPortfolio(addr) {
  const registry = loadRegistry();
  const tokens = Object.entries(registry).map(([id, r]) => ({ espnId: id, ...r })).filter((r) => r.token);
  // 1. which tokens does the user hold?
  const holds = [];
  const CHUNK = 25;
  for (let i = 0; i < tokens.length; i += CHUNK) {
    const chunk = tokens.slice(i, i + CHUNK);
    const datas = chunk.map((t) => ({ to: t.token, data: SEL.balanceOf + addr.slice(2).toLowerCase().padStart(64, "0") }));
    const outs = await Promise.all(datas.map((d) => call(d.to, d.data).catch(() => "0x")));
    outs.forEach((o, k) => {
      try {
        const bal = BigInt(o);
        if (bal > 0n) holds.push({ ...chunk[k], balance: bal });
      } catch {}
    });
  }
  // 2. fills for held tokens -> cost basis + realized
  const padTopic = "0x" + addr.slice(2).toLowerCase().padStart(64, "0");
  const tsBlocks = new Set();
  const fills = [];
  const fromBlock = await logFromBlock();
  await Promise.all(holds.map(async (h) => {
    for (const [topic, kind] of [[BOUGHT_TOPIC, "buy"], [SOLD_TOPIC, "sell"]]) {
      let logs = [];
      try {
        logs = await provider.getLogs({ address: h.token, fromBlock, topics: [topic, padTopic] });
      } catch { logs = []; }
      for (const log of logs) {
        const d = log.data.slice(2);
        const words = [BigInt("0x" + d.slice(0, 64)), BigInt("0x" + d.slice(64, 128)), BigInt("0x" + d.slice(128, 192))];
        if (kind === "buy") fills.push({ kind, token: h.token, symbol: h.symbol, name: h.name, chz: words[0], tokens: words[1], nav: words[2], tx: log.transactionHash, block: log.blockNumber });
        else fills.push({ kind, token: h.token, symbol: h.symbol, name: h.name, chz: words[1], tokens: words[0], nav: words[2], tx: log.transactionHash, block: log.blockNumber });
        tsBlocks.add(log.blockNumber);
      }
    }
  }));
  // 3. NAVs for held tokens
  await Promise.all(holds.map(async (h) => {
    try { h.nav = BigInt(await call(h.token, SEL.navWad)); } catch { h.nav = 0n; }
  }));
  const holdings = holds.map((h) => {
    const my = fills.filter((f) => f.token === h.token);
    const invested = my.filter((f) => f.kind === "buy").reduce((s, f) => s + f.chz, 0n);
    const realized = my.filter((f) => f.kind === "sell").reduce((s, f) => s + f.chz, 0n);
    const value = (h.balance * h.nav) / 10n ** 18n;
    return {
      espnId: h.espnId, symbol: h.symbol, name: h.name, token: h.token,
      balance: h.balance.toString(), nav: h.nav.toString(),
      value: value.toString(), invested: invested.toString(), realized: realized.toString(),
      pnl: (value + realized - invested).toString(),
    };
  });
  const totalValue = holdings.reduce((s, h) => s + BigInt(h.value), 0n);
  const totalInvested = holdings.reduce((s, h) => s + BigInt(h.invested), 0n);
  const totalRealized = holdings.reduce((s, h) => s + BigInt(h.realized), 0n);
  const chz = await provider.getBalance(addr).catch(() => 0n);
  const tsMap = new Map();
  for (const n of tsBlocks) { const t = await blockTs(n).catch(() => null); if (t) tsMap.set(n, t); }
  const fillsOut = fills
    .map((f) => ({ ...f, chz: f.chz.toString(), tokens: f.tokens.toString(), nav: f.nav.toString(), ts: tsMap.get(f.block) ?? null }))
    .sort((a, b) => b.block - a.block)
    .slice(0, 60);
  return {
    address: addr,
    chz: chz.toString(),
    holdings,
    fills: fillsOut,
    totals: {
      value: totalValue.toString(), invested: totalInvested.toString(), realized: totalRealized.toString(),
      pnl: (totalValue + totalRealized - totalInvested).toString(),
    },
  };
}

const statsCache = { at: 0, data: null };
async function buildStats() {
  const registry = loadRegistry();
  const dep = JSON.parse(fs.readFileSync(path.join(stateDir, "deployments.json"), "utf8"));
  const core = dep.core;
  const coreBalance = await provider.getBalance(core).catch(() => 0n);
  const tokens = Object.values(registry).filter((r) => r.token);
  const supplySel = SEL.balanceOf; // reuse pattern below
  // read supply per token (batched), then reserve + level for supplied ones
  const supplied = [];
  const CHUNK = 25;
  for (let i = 0; i < tokens.length; i += CHUNK) {
    const chunk = tokens.slice(i, i + CHUNK);
    const outs = await Promise.all(chunk.map((t) =>
      provider.call({ to: t.token, data: "0x18160ddd" }).catch(() => "0x")
    ));
    outs.forEach((o, k) => {
      try { const s = BigInt(o); if (s > 0n) supplied.push({ ...chunk[k], supply: s }); } catch {}
    });
  }
  await Promise.all(supplied.map(async (t) => {
    try { t.reserve = BigInt(await provider.call({ to: t.token, data: "0xe9669822" })); } catch { t.reserve = 0n; }
    try {
      const data = "0x" + ethers.id("tokenLevel(address)").slice(2, 10) + t.token.slice(2).toLowerCase().padStart(64, "0");
      t.level = Number(BigInt(await provider.call({ to: core, data })));
    } catch { t.level = 750000; }
  }));
  let totalTarget = 0n, totalReserve = 0n;
  for (const t of supplied) {
    const target = (t.supply * BigInt(t.level) * 100n) / 750000n; // 100 CHZ per token at 7,500.00 (PlayerToken.targetReserve)
    totalTarget += target;
    totalReserve += t.reserve;
  }
  return {
    updatedAt: new Date().toISOString(),
    coreBalance: coreBalance.toString(),
    suppliedTokens: supplied.length,
    totalTarget: totalTarget.toString(),
    totalReserve: totalReserve.toString(),
    outstandingNeed: (totalTarget > totalReserve ? totalTarget - totalReserve : 0n).toString(),
    fundedRatio: totalTarget > 0n ? Number(totalReserve * 10000n / totalTarget) / 10000 : 1,
    feeBps: 100,
  };
}

http.createServer(async (req, res) => {
  const p = req.url.split("?")[0];
  const q = new URL(req.url, "http://x");
  const api = API[p];
  if (api) {
    const file = path.join(stateDir, api);
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ byId: {}, players: {}, days: [] })); }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(data);
    });
    return;
  }
  if (p === "/api/stats") {
    if (statsCache.data && Date.now() - statsCache.at < 60_000) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify(statsCache.data));
    }
    try {
      const data = await buildStats();
      statsCache.at = Date.now();
      statsCache.data = data;
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: (e.message ?? "failed").slice(0, 200) }));
    }
    return;
  }
  if (p === "/api/portfolio") {
    const addr = (q.searchParams.get("address") || "").trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) { res.writeHead(400); return res.end(JSON.stringify({ error: "bad address" })); }
    const key = addr.toLowerCase();
    const cached = portfolioCache.get(key);
    if (cached && Date.now() - cached.at < 30_000) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify(cached.data));
    }
    try {
      const data = await buildPortfolio(addr);
      portfolioCache.set(key, { at: Date.now(), data });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: (e.message ?? "failed").slice(0, 200) }));
    }
    return;
  }
  let fp = p === "/" ? "/index.html" : p === "/docs" ? "/docs.html" : p;
  const file = path.join(root, path.normalize(fp));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    const ext = path.extname(file);
    const mime = { ".html": "text/html", ".json": "application/json", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" }[ext] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": mime });
    res.end(data);
  });
}).listen(port, () => console.log(`FSPI Tennis UI: http://localhost:${port}`));
