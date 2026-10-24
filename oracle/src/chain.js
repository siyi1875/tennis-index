// On-chain bindings: TennisIndex core + PlayerToken via ethers v6.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";
import { ethers } from "ethers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const RPC_URL = process.env.SPICY_RPC_URL || "https://spicy-rpc.chiliz.com";
/// Read lazily so read-only commands (compute, report, close) run without a key.
export function loadPrivateKey() {
  return process.env.ORACLE_PRIVATE_KEY || fs.readFileSync(path.join(__dirname, "..", "..", "contracts", ".deploy", "env"), "utf8").match(/DEPLOYER_PRIVATE_KEY=(\S+)/)[1];
}

export const DEPLOYMENTS_FILE = path.join(__dirname, "..", "state", "deployments.json");
export const STATE_FILE = path.join(__dirname, "..", "state", "season-2026.json");

export function loadDeployments() {
  if (!fs.existsSync(DEPLOYMENTS_FILE)) throw new Error(`deployments file missing: ${DEPLOYMENTS_FILE}`);
  return JSON.parse(fs.readFileSync(DEPLOYMENTS_FILE, "utf8"));
}

export function saveDeployments(d) {
  fs.mkdirSync(path.dirname(DEPLOYMENTS_FILE), { recursive: true });
  fs.writeFileSync(DEPLOYMENTS_FILE, JSON.stringify(d, null, 2));
}

export const CORE_ABI = [
  "function playerCount() view returns (uint256)",
  "function player(uint256 id) view returns (tuple(address token, uint8 tour, uint128 level, uint64 lastUpdate))",
  "function playersRange(uint256 fromId, uint256 toId) view returns (tuple(address token, uint8 tour, uint128 level, uint64 lastUpdate)[])",
  "function tokenLevel(address token) view returns (uint128)",
  "function levelOf(uint256 id) view returns (uint128)",
  "function addPlayer(string symbol, uint8 tour, uint128 initialLevel) returns (uint256)",
  "function addPlayers(string[] symbols, uint8[] tours, uint128[] initialLevels) returns (uint256)",
  "function updateLevel(uint256 id, uint128 newLevel)",
  "function updateLevels(uint256[] ids, uint128[] levels)",
  "function calibrateLevel(uint256 id, uint128 newLevel)",
  "function setPlayerFees(uint256 id, uint16 buyBps, uint16 sellBps)",
  "function setDefaultFees(uint16 buyBps, uint16 sellBps)",
  "function defaultBuyFeeBps() view returns (uint16)",
  "function defaultSellFeeBps() view returns (uint16)",
  "function treasury() view returns (address)",
  "function treasuryShareBps() view returns (uint16)",
  "function treasuryBalance() view returns (uint256)",
  "function poolBalance() view returns (uint256)",
  "function withdrawTreasury(uint256 amount)",
  "function setTreasury(address treasury, uint16 shareBps)",
  "function seasonReset(uint256[] ids)",
  "function scheduleHalts(uint256[] ids, uint64[] froms)",
  "function resume(uint256[] ids)",
  "function heartbeat()",
  "function haltFrom(address token) view returns (uint64)",
  "function haltFromRange(uint256 fromId, uint256 toId) view returns (uint64[])",
  "function halted(address token) view returns (bool)",
  "function lastHeartbeat() view returns (uint64)",
  "function heartbeatMaxAge() view returns (uint64)",
  "function tradeStatus(address token) view returns (uint8)",
  "function targetNavOf(address token) view returns (uint256)",
  "function navScaleOf(address token) view returns (uint256)",
  "function topUp() payable",
  "function pause()",
  "function unpause()",
  "function paused() view returns (bool)",
  "function maxDeltaBps() view returns (uint16)",
  "function minUpdateInterval() view returns (uint64)",
  "function fundingRequirement(uint256 id) view returns (uint256)",
  "function ORACLE_ROLE() view returns (bytes32)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function grantRole(bytes32 role, address account)",
  "event LevelUpdated(uint256 indexed id, uint128 oldLevel, uint128 newLevel, uint256 fundingWad, uint256 sweepWad)",
  "event PlayerAdded(uint256 indexed id, address indexed token, string symbol, uint8 tour, uint128 level)",
];

export const TOKEN_ABI = [
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function navWad() view returns (uint256)",
  "function reserveWad() view returns (uint256)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function buy(address to, uint256 minTokensOut) payable returns (uint256)",
  "function sell(uint256 tokenIn, address to, uint256 minChzOut) returns (uint256)",
  "function epoch() view returns (uint32)",
  "function pendingChz() view returns (uint256)",
  "function orders(uint32 epoch, address who) view returns (uint256 paid, uint256 buyChz, uint256 sellTokens)",
  "function claim(uint32 epoch, address who) returns (uint256 tokensOut, uint256 chzOut)",
];

// Connect over IPv4: on networks without working IPv6 the RPC's AAAA records stall
// Node's connections (curl falls back, Node often does not). Wait up to a minute.
const rpcAgent = new https.Agent({ keepAlive: true, family: 4 });
export function rpcRequest(url = RPC_URL) {
  const req = new ethers.FetchRequest(url);
  req.timeout = 60_000;
  if (url.startsWith("https:")) req.getUrlFunc = ethers.FetchRequest.createGetUrlFunc({ agent: rpcAgent });
  return req;
}

export function getWallet(pk = loadPrivateKey()) {
  return new ethers.Wallet(pk, new ethers.JsonRpcProvider(rpcRequest(), 88882, { staticNetwork: true }));
}

export function getCore(wallet) {
  const d = loadDeployments();
  return new ethers.Contract(d.core, CORE_ABI, wallet);
}

// Spicy base fee is fixed at 2500 gwei; a small tip is enough for inclusion.
export const TX_OVERRIDES = {
  type: 2,
  maxFeePerGas: ethers.parseUnits("2800", "gwei"),
  maxPriorityFeePerGas: ethers.parseUnits("200", "gwei"),
};
