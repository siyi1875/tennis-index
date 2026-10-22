// State persistence: season state, match stream, on-chain id mapping.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, "..", "state");
fs.mkdirSync(STATE_DIR, { recursive: true });

export function saveJson(name, data) {
  fs.writeFileSync(path.join(STATE_DIR, name), JSON.stringify(data));
}

export function loadJson(name, fallback = null) {
  const p = path.join(STATE_DIR, name);
  if (!fs.existsSync(p)) return fallback;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/// Serialize state (Maps -> objects)
export function serializeState(state) {
  return {
    players: Object.fromEntries(
      [...state.players.entries()].map(([id, p]) => [
        id,
        {
          id: p.id, name: p.name, tour: p.tour, levelCp: p.levelCp,
          events: [...p.events.entries()].map(([k, v]) => [k, {
            bestRound: v.bestRound, wonF: v.wonF, tier: v.tier,
            pByRound: [...(v.pByRound ?? new Map()).entries()],
          }]),
        },
      ])
    ),
    matchIds: [...state.matchIds],
    matches: state.matches,
    ratings: [...(state.ratings ?? new Map()).entries()],
  };
}

export function deserializeState(d) {
  const state = { players: new Map(), matchIds: new Set(d.matchIds), matches: d.matches, ratings: new Map(d.ratings ?? []) };
  for (const [id, p] of Object.entries(d.players)) {
    const events = new Map((p.events ?? []).map(([k, v]) => [k, { ...v, pByRound: new Map(v.pByRound ?? []) }]));
    state.players.set(id, { id: p.id, name: p.name, tour: p.tour, levelCp: p.levelCp, events });
  }
  return state;
}
