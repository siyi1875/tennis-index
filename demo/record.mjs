/// Demo walkthrough recorder: drives the real UI end-to-end with a local-signer
/// wallet shim (EIP-6963 "Demo Wallet"), so every transaction is a real signed
/// Spicy testnet transaction — only the wallet chrome is simulated.
/// Produces demo/walkthrough.webm + demo/steps/*.png.
import { chromium } from "/Users/siyi.chen/.local/lib/chiliz/0.1.46/node_modules/playwright/index.mjs";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = "/Users/siyi.chen/tennis-index-chiliz";
const ETH_SRC = readFileSync(`${ROOT}/oracle/node_modules/ethers/dist/ethers.min.js`, "utf8");
const PK = readFileSync(`${ROOT}/contracts/.deploy/env`, "utf8")
  .split("\n").find((l) => l.startsWith("DEPLOYER_PRIVATE_KEY=")).split("=")[1].trim();
const RPC = "https://spicy-rpc.chiliz.com";
const CHAIN = "0x15b32";
const OUT = `${ROOT}/demo`;
mkdirSync(`${OUT}/steps`, { recursive: true });

const shim = `
(self.__ETH_SRC__ = ${JSON.stringify(ETH_SRC)}),
new Promise((resolve) => {
  let ready = null;
  const prov = {
    request: async ({ method, params = [] }) => {
      const w = await ready;
      if (method === "eth_chainId") return ${JSON.stringify(CHAIN)};
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [await w.getAddress()];
      if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
      if (method === "personal_sign") return await w.signMessage(w.ethers.toUtf8Bytes(params[0]));
      if (method === "eth_sendTransaction") {
        const [t] = params;
        const tx = await w.sendTransaction({
          to: t.to, value: t.value ? BigInt(t.value) : 0n, data: t.data ?? "0x",
        });
        return tx.hash;
      }
      throw new Error("Demo wallet: unsupported " + method);
    },
    on: () => {}, removeListener: () => {},
  };
  const info = {
    uuid: "demo-local-signer-0000-0000",
    name: "Demo Wallet (local signer)",
    icon: "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="14" fill="%2312e29a"/><text x="32" y="42" font-size="30" text-anchor="middle" fill="%23071a10" font-family="monospace">D</text></svg>'),
    rdns: "demo.fspi.local",
  };
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider: prov }) }));
  window.addEventListener("eip6963:requestProvider", announce);
  const loop = async () => { for (let i = 0; i < 16; i++) { announce(); await new Promise((r) => setTimeout(r, 250)); } };
  loop();
  (async () => {
    const blob = new Blob([self.__ETH_SRC__], { type: "text/javascript" });
    const ethers = await import(URL.createObjectURL(blob));
    const w = new ethers.Wallet(${JSON.stringify(PK)}, new ethers.JsonRpcProvider(${JSON.stringify(RPC)}, undefined, { staticNetwork: true }));
    w.ethers = ethers;
    ready = w;
    resolve();
  })();
})`;

const step = async (p, name) => { await p.waitForTimeout(700); await p.screenshot({ path: `${OUT}/steps/${String(n).padStart(2, "0")}-${name}.png` }); n++; };
let n = 1;

const browser = await chromium.launch({ channel: "chrome" });
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, recordVideo: { dir: "/tmp/demo-video", size: { width: 1360, height: 900 } } });
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(String(e).slice(0, 100)));
p.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 100)); });

await p.addInitScript(shim);
await p.goto("http://localhost:8080", { waitUntil: "networkidle" });
await p.waitForTimeout(1500);
await step(p, "market");

// connect
await p.click("#connectBtn");
await p.waitForTimeout(600);
await p.waitForTimeout(600);
await step(p, "connect-modal");
try {
  await p.getByText("Demo Wallet (local signer)").click();
} catch (e) {
  console.log("MODAL HTML:", (await p.locator("#walletList").innerHTML()).slice(0, 400));
  console.log("ERRS:", errs);
  throw e;
}
await p.waitForTimeout(1800);
await step(p, "connected");

// open ATP-SIN
await p.fill("#search", "Sinner");
await p.waitForTimeout(700);
await step(p, "search");
await p.locator("#tbody tr").first().click();
await p.waitForTimeout(1200);
await step(p, "token-panel");

// buy 0.5 CHZ
await p.fill("#orderAmt", "0.5");
await p.waitForTimeout(400);
await step(p, "buy-quote");
await p.locator("#orderBtn").click();
await p.waitForTimeout(9000); // wait for the real tx
const buyMsg = await p.locator("#tokMsg").innerText();
console.log("BUY:", buyMsg);
await step(p, "buy-sent");

// sell 0.25 tokens (flip the side toggle first)
await p.locator("#sideSell").click();
await p.fill("#orderAmt", "0.25");
await p.waitForTimeout(300);
await p.locator("#orderBtn").click();
await p.waitForTimeout(9000);
const sellMsg = await p.locator("#tokMsg").innerText();
console.log("SELL:", sellMsg);
await step(p, "sell-sent");

// profile
await p.click("#pfBtn");
try { await p.waitForSelector("#pfPanel table", { timeout: 30000 }); } catch {}
await p.waitForTimeout(600);
await step(p, "profile");

await ctx.close();
await browser.close();
const vid = readdirSync("/tmp/demo-video").find((f) => f.endsWith(".webm"));
if (vid) { writeFileSync(`${OUT}/walkthrough.webm`, readFileSync(`/tmp/demo-video/${vid}`)); console.log("VIDEO:", `${OUT}/walkthrough.webm`); }
console.log("PAGE ERRORS:", errs.length ? errs : "none");
