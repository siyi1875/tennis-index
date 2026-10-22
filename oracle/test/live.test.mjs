// Live-match halt planning tests (node --test)
import test from "node:test";
import assert from "node:assert/strict";
import { haltPlan, unscoredPlayers, haltActions } from "../src/live.js";

const NOW = Date.parse("2026-10-23T10:00:00Z");
const S = (ms) => Math.floor(ms / 1000);
const H = 3_600_000;

function m(o = {}) {
  return {
    compId: "atp:e1:c1", tour: "atp", eventId: "e1", eventName: "Swiss Indoors Basel",
    round: "Quarterfinal", completed: false, status: "STATUS_SCHEDULED", timeValid: true,
    startDate: "2026-10-23T12:00Z",
    players: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
    ...o,
  };
}
const player = (o) => ({ espnId: "a", chainId: 1, haltFrom: 0, level: 750000, target: 750000, ...o });

test("plan: halts both players 15 min before the scheduled start", () => {
  const plan = haltPlan([m()], NOW);
  assert.equal(plan.get("a"), Date.parse("2026-10-23T11:45:00Z"));
  assert.equal(plan.get("b"), Date.parse("2026-10-23T11:45:00Z"));
});

test("plan: a live match halts now; the earliest match wins", () => {
  const plan = haltPlan([m({ status: "STATUS_IN_PROGRESS", startDate: "2026-10-23T09:00Z" }), m({ compId: "x", startDate: "2026-10-24T12:00Z" })], NOW);
  assert.equal(plan.get("a"), NOW);
});

test("plan: skips completed, cancelled, qualifying, excluded and far-off matches", () => {
  const plan = haltPlan([
    m({ completed: true, status: "STATUS_FINAL" }),
    m({ status: "STATUS_CANCELED" }),
    m({ round: "Qualifying 1st Round" }),
    m({ eventName: "Davis Cup Finals" }),
    m({ startDate: "2026-10-26T12:00Z" }), // beyond the 36h horizon
  ], NOW);
  assert.equal(plan.size, 0);
});

test("unscored: a completed match not yet applied keeps its players unpriced", () => {
  const done = m({ completed: true, status: "STATUS_FINAL", round: "Round 1" });
  assert.deepEqual([...unscoredPlayers([done], new Set(), "2026-07-01")], ["a", "b"]);
  assert.equal(unscoredPlayers([done], new Set(["atp:e1:c1"]), "2026-07-01").size, 0);
  assert.equal(unscoredPlayers([{ ...done, round: "Qualifying Final" }], new Set(), "2026-07-01").size, 0);
});

test("actions: schedule an upcoming match", () => {
  const plan = haltPlan([m()], NOW);
  const r = haltActions([player()], plan, new Set(), NOW);
  assert.deepEqual(r, { schedule: [{ chainId: 1, from: S(Date.parse("2026-10-23T11:45:00Z")) }], resume: [] });
});

test("actions: keep a live halt; nothing to re-send for an already scheduled halt", () => {
  const live = haltActions([player({ haltFrom: S(NOW) - 600 })], haltPlan([m({ status: "STATUS_IN_PROGRESS" })], NOW), new Set(), NOW);
  assert.deepEqual(live, { schedule: [], resume: [] });
  const due = S(Date.parse("2026-10-23T11:45:00Z"));
  const sched = haltActions([player({ haltFrom: due })], haltPlan([m()], NOW), new Set(), NOW);
  assert.deepEqual(sched, { schedule: [], resume: [] });
});

test("actions: release a finished, priced match; then schedule the next one", () => {
  const next = m({ compId: "c2", startDate: "2026-10-24T12:00Z" });
  const r = haltActions([player({ haltFrom: S(NOW) - 3600 })], haltPlan([next], NOW), new Set(), NOW);
  assert.deepEqual(r.resume, [1]);
  assert.equal(r.schedule[0].from, S(Date.parse("2026-10-24T11:45:00Z")));
});

test("actions: never release while the result is unscored or not pushed", () => {
  const halted = player({ haltFrom: S(NOW) - 3600 });
  assert.deepEqual(haltActions([halted], new Map(), new Set(["a"]), NOW), { schedule: [], resume: [] });
  assert.deepEqual(haltActions([{ ...halted, target: 760000 }], new Map(), new Set(), NOW), { schedule: [], resume: [] });
});

test("actions: an unpushed result on an open token halts it immediately", () => {
  const r = haltActions([player({ target: 760000 })], new Map(), new Set(), NOW);
  assert.deepEqual(r, { schedule: [{ chainId: 1, from: S(NOW) }], resume: [] });
});

test("actions: a cancelled match cancels its scheduled halt", () => {
  const r = haltActions([player({ haltFrom: S(NOW) + 3600 })], new Map(), new Set(), NOW);
  assert.deepEqual(r, { schedule: [], resume: [1] });
});
