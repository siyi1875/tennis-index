// ESPN data access layer with disk cache.
// Sources:
//  - Rankings: https://site.api.espn.com/apis/site/v2/sports/tennis/{tour}/rankings
//  - Scoreboard (per day): https://site.api.espn.com/apis/site/v2/sports/tennis/{tour}/scoreboard?dates=YYYYMMDD
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, "..", "cache");
fs.mkdirSync(CACHE_DIR, { recursive: true });

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, { cacheFile = null, retries = 3 } = {}) {
  if (cacheFile && fs.existsSync(cacheFile)) {
    try {
      return JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    } catch {
      /* refetch */
    }
  }
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const req = urllibRequest(url);
      const res = await req;
      const data = JSON.parse(res);
      if (cacheFile) fs.writeFileSync(cacheFile, JSON.stringify(data));
      return data;
    } catch (e) {
      lastErr = e;
      await sleep(1500 * (i + 1));
    }
  }
  throw lastErr;
}

function urllibRequest(url) {
  return new Promise((resolve, reject) => {
    // node 18+ has global fetch; use it but strip caching concerns
    fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(60000) })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
        return r.text();
      })
      .then((t) => resolve(t))
      .catch(reject);
  });
}

export function fmtDate(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

const RANKINGS_TTL_MS = 24 * 3600 * 1000;

async function fetchCached(url, cacheFile) {
  if (cacheFile && fs.existsSync(cacheFile)) {
    const age = Date.now() - fs.statSync(cacheFile).mtimeMs;
    if (age < RANKINGS_TTL_MS) {
      try {
        return JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      } catch {
        /* refetch */
      }
    }
  }
  return null;
}

/// Fetch the official singles rankings for a tour.
/// Returns [{ id, name, rank, prevRank, points, country }]
export async function fetchRankings(tour) {
  const cache = path.join(CACHE_DIR, `rankings-${tour}.json`);
  const url = `https://site.api.espn.com/apis/site/v2/sports/tennis/${tour}/rankings`;
  const cached = await fetchCached(url, cache);
  if (cached) return fromRankingsPayload(cached);
  const d = await fetchJson(url, {});
  fs.writeFileSync(cache, JSON.stringify(d));
  return fromRankingsPayload(d);
}

function fromRankingsPayload(d) {
  const r = d?.rankings?.[0];
  if (!r) throw new Error("no rankings payload");
  return {
    updatedAt: r.update,
    ranks: r.ranks.map((e) => ({
      id: String(e.athlete?.id ?? ""),
      name: e.athlete?.displayName ?? "",
      rank: e.current,
      prevRank: e.previous,
      points: e.points ?? 0,
      country: e.athlete?.flag?.alt ?? "",
    })),
  };
}

const cachePath = (tour, yyyymmdd) => path.join(CACHE_DIR, `sb-${tour}-${yyyymmdd}.json`);

/// Fetch the scoreboard for a given calendar day. Returns the raw payload.
export async function fetchDay(tour, yyyymmdd, { useCache = true } = {}) {
  const cache = useCache ? cachePath(tour, yyyymmdd) : null;
  return fetchJson(`https://site.api.espn.com/apis/site/v2/sports/tennis/${tour}/scoreboard?dates=${yyyymmdd}`, {
    cacheFile: cache,
  });
}

/// Normalize a scoreboard payload into match records (singles only).
export function parseScoreboard(tour, payload) {
  const out = [];
  const singlesSlug = tour === "atp" ? "mens-singles" : "womens-singles";
  for (const ev of payload?.events ?? []) {
    const eventName = ev.name || ev.shortName || "Unknown";
    const eventId = ev.id;
    for (const g of ev.groupings ?? []) {
      if (g.grouping?.slug !== singlesSlug) continue;
      for (const c of g.competitions ?? []) {
        const rd = c.round?.displayName ?? "";
        const completed = c.status?.type?.completed === true;
        const comps = c.competitors ?? [];
        if (comps.length !== 2) continue;
        // skip non-singles type slugs (defensive)
        const typeSlug = c.type?.slug ?? "";
        if (typeSlug && typeSlug !== singlesSlug) continue;
        const startDate = c.startDate ?? c.date ?? ev.date;
        const players = comps.map((x) => ({
          id: String(x.athlete?.id ?? x.id ?? ""),
          name: x.athlete?.displayName ?? "",
          winner: x.winner === true,
          lines: (x.linescores ?? []).map((l) => ({ value: l.value ?? 0, tiebreak: l.tiebreak ?? null })),
        }));
        if (players.some((p) => !p.id || !p.name)) continue;
        out.push({
          compId: `${tour}:${eventId}:${c.id ?? ""}`,
          tour,
          eventId: String(eventId ?? ""),
          eventName,
          round: rd,
          completed,
          status: c.status?.type?.name ?? "",
          timeValid: c.timeValid !== false, // false: ESPN placeholder time, not the order of play
          startDate,
          players,
        });
      }
    }
  }
  return out;
}

/// Round labels per event from a scoreboard, with match counts, including
/// scheduled and TBD-vs-TBD placeholder matches: ESPN lists the later rounds
/// from the start of an event, which gives the draw structure on day 1.
/// Returns { "tour|eventId": { label: count } } (singles, main draw).
export function roundLabels(tour, payload) {
  const out = {};
  const singlesSlug = tour === "atp" ? "mens-singles" : "womens-singles";
  for (const ev of payload?.events ?? []) {
    const key = `${tour}|${String(ev.id ?? "")}`;
    for (const g of ev.groupings ?? []) {
      if (g.grouping?.slug !== singlesSlug) continue;
      for (const c of g.competitions ?? []) {
        const lbl = (c.round?.displayName ?? "").trim();
        if (!lbl || /qualif/i.test(lbl)) continue;
        (out[key] ??= {})[lbl] = (out[key][lbl] ?? 0) + 1;
      }
    }
  }
  return out;
}

/// Merge label counts into `into` (max per label: boards overlap).
export function mergeLabels(into, add) {
  for (const [key, ls] of Object.entries(add)) {
    const t = (into[key] ??= {});
    for (const [lbl, n] of Object.entries(ls)) t[lbl] = Math.max(t[lbl] ?? 0, n);
  }
  return into;
}

/// Date iterator YYYYMMDD inclusive
export function* dateRange(startYyyymmdd, endYyyymmdd) {
  const start = new Date(`${startYyyymmdd.slice(0, 4)}-${startYyyymmdd.slice(4, 6)}-${startYyyymmdd.slice(6, 8)}T00:00:00Z`);
  const end = new Date(`${endYyyymmdd.slice(0, 4)}-${endYyyymmdd.slice(4, 6)}-${endYyyymmdd.slice(6, 8)}T00:00:00Z`);
  for (let d = start; d <= end; d = new Date(d.getTime() + 86400000)) yield fmtDate(d);
}

export { CACHE_DIR };
