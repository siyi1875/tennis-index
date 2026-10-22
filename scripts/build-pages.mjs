import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = path.join(root, "app");
const stateDir = path.join(root, "oracle", "state");
const outDir = path.join(root, "docs");
const dataDir = path.join(outDir, "data");

const stateFiles = {
  registry: "registry.json",
  levels: "levels-2026.json",
  history: "history-2026.json",
  close: "close-2026.json",
  pushlog: "pushlog-2026.json",
};

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

for (const [name, file] of Object.entries(stateFiles)) {
  fs.copyFileSync(path.join(stateDir, file), path.join(dataDir, `${name}.json`));
}

const statsUrl = process.env.STATS_URL || "http://localhost:8080/api/stats";
const statsRes = await fetch(statsUrl);
if (!statsRes.ok) throw new Error(`stats endpoint failed: ${statsRes.status} ${statsUrl}`);
fs.writeFileSync(path.join(dataDir, "stats.json"), JSON.stringify(await statsRes.json()));

const builtAt = new Date().toISOString();
const shim = `<script>
(() => {
  const files = { registry: 1, levels: 1, history: 1, close: 1, stats: 1, pushlog: 1 };
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    try {
      const raw = typeof input === "string" ? input : input.url;
      const u = new URL(raw, location.href);
      const m = u.pathname.match(/\\/api\\/([a-z]+)/);
      if (m && files[m[1]]) return nativeFetch(new URL("./data/" + m[1] + ".json", location.href), init);
      if (m && m[1] === "portfolio") {
        return Promise.resolve(new Response(JSON.stringify({
          error: "Portfolio reads need the local API server. Run app/server.js to see live holdings and PnL."
        }), { status: 200, headers: { "content-type": "application/json" } }));
      }
    } catch {}
    return nativeFetch(input, init);
  };
})();
</script>`;

function buildHtml(src, dst) {
  let html = fs.readFileSync(path.join(appDir, src), "utf8");
  html = html
    .replaceAll('href="/docs"', 'href="./docs.html"')
    .replaceAll('href="/docs#', 'href="./docs.html#')
    .replaceAll('href="/"', 'href="./index.html"')
    .replaceAll('src="/', 'src="./');
  html = html.replace("</head>", `<meta name="fspi-build" content="${builtAt}">\n${shim}\n</head>`);
  fs.writeFileSync(path.join(outDir, dst), html);
}

buildHtml("index.html", "index.html");
buildHtml("docs.html", "docs.html");
fs.writeFileSync(path.join(outDir, ".nojekyll"), "");

console.log(`pages snapshot: ${outDir}`);
console.log(`data: ${Object.keys(stateFiles).join(", ")}, stats`);
