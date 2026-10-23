/// Retraceable record: replays eligible matches chronologically and produces
/// (1) a per-player, per-match attribution trail (cp gained, running level),
/// (2) milestone rows (title/final/SF/QF), and (3) a daily level snapshot for
/// every player seen so far. The replay must reproduce levelsForState exactly:
/// sum(attribution cp) + milestones == final level cp (asserted at the end).
import { applyMatch, levelsForState, milestoneCpForEvent, newState } from "./compute.js";
import { BASE_LEVEL, MIN_LEVEL } from "./tiers.js";

export function buildHistory(elig, rankLookup) {
  const sorted = [...elig].sort(
    (x, y) => (x.startDate || "").localeCompare(y.startDate || "") || x.compId.localeCompare(y.compId)
  );

  const st = newState();
  const events = new Map(); // espnId -> { name, tour, rows: [] }
  const cpSum = new Map(); // espnId -> running cp (matches + milestones)
  const emitted = new Set(); // `${id}|${eventId}` milestone rows already emitted
  const evLastDate = new Map(); // eventId -> last match date seen for the event
  const evNames = new Map(); // eventId -> display name
  const days = [];
  let curDay = null;

  // same rule as levelsForState: base + points, floored at the 100.00 minimum
  // (not at the base: that hid every player's losses in the daily record)
  const levelOf = (id) => Math.max(Math.round(MIN_LEVEL * 100), Math.round(BASE_LEVEL * 100) + (cpSum.get(id) || 0));
  const pushRow = (id, row) => {
    let e = events.get(id);
    if (!e) { e = { name: null, tour: null, rows: [] }; events.set(id, e); }
    e.rows.push(row);
  };

  const emitMilestone = (id, eventId, ev, key, date) => {
    const k = `${id}|${eventId}`;
    if (emitted.has(k)) return;
    const cp = milestoneCpForEvent(ev, key);
    emitted.add(k);
    const dec = key === "TITLE" || key === "FINAL" ? "F" : key === "SF" ? "QF" : "R16";
    const p = ev.pByRound?.get(dec) ?? 0.5;
    cpSum.set(id, (cpSum.get(id) || 0) + cp);
    pushRow(id, {
      t: "milestone", d: date, e: eventId, n: evNames.get(eventId) ?? null, tier: ev.tier,
      r: key === "TITLE" ? "F" : key, w: key === "TITLE", cp,
      p: Math.round(p * 10000) / 10000, x: Math.round((1 - p) * 10000) / 10000, lv: levelOf(id),
    });
  };

  const scoreOf = (m, idx) => {
    const lines = idx === 0 ? m.players[0].lines : m.players[1].lines;
    const other = idx === 0 ? m.players[1].lines : m.players[0].lines;
    if (!lines || lines.length === 0 || lines.length !== other.length) return null;
    return lines.map((l, i) => `${l.value ?? 0}-${other[i].value ?? 0}`).join(" ");
  };

  const endDay = (day) => {
    if (!curDay) return;
    const lv = {};
    for (const [id] of st.players) lv[id] = levelOf(id);
    days.push({ d: curDay, lv });
  };

  for (const m of sorted) {
    const day = (m.startDate || "").slice(0, 10);
    if (!day) continue;
    if (day !== curDay) { endDay(curDay); curDay = day; }

    const r = applyMatch(st, m, rankLookup);
    if (!r) continue;
    evLastDate.set(m.eventId, day);
    evNames.set(m.eventId, m.eventName);

    const sides = [
      { who: m.players[0], cp: r.aCp, opp: m.players[1], exp: r.pA },
      { who: m.players[1], cp: r.bCp, opp: m.players[0], exp: r.pB },
    ];
    for (const { who, cp, opp, exp } of sides) {
      let e = events.get(who.id);
      if (!e) { e = { name: null, tour: null, rows: [] }; events.set(who.id, e); }
      e.name = who.name; e.tour = m.tour;
      cpSum.set(who.id, (cpSum.get(who.id) || 0) + cp);
      pushRow(who.id, {
        t: "match", d: day, e: m.eventId, n: m.eventName, tier: r.tier, r: r.round,
        res: who.winner ? "W" : "L", opp: opp.name, oppId: opp.id, sc: scoreOf(m, who === m.players[0] ? 0 : 1),
        cp, p: Math.round(exp * 10000) / 10000,
        x: Math.round(Math.abs((who.winner ? 1 : 0) - exp) * 10000) / 10000, lv: levelOf(who.id),
      });

      const pl = st.players.get(who.id);
      const ev = pl.events.get(m.eventId);
      // milestone attribution: exact final-bestRound semantics
      if (r.round === "F") emitMilestone(who.id, m.eventId, ev, who.winner ? "TITLE" : "FINAL", day);
      else if ((r.round === "SF" || r.round === "QF") && !who.winner) emitMilestone(who.id, m.eventId, ev, r.round, day);
    }
  }
  endDay(curDay);

  // resolve pending milestones (reached QF/SF but no deeper match recorded):
  // emit on the event's last recorded date so totals match levelsForState exactly
  for (const [id, pl] of st.players) {
    for (const [eventId, ev] of pl.events) {
      if (ev.bestRound !== "QF" && ev.bestRound !== "SF") continue;
      const k = `${id}|${eventId}`;
      if (emitted.has(k)) continue;
      const date = evLastDate.get(eventId) || "9999-12-31";
      emitMilestone(id, eventId, ev, ev.bestRound, date);
    }
  }

  // consistency: replayed cp must equal levelsForState cp for every player
  const levels = levelsForState(st);
  let mismatches = 0;
  for (const [id, v] of levels) {
    if (v.cp !== (cpSum.get(id) || 0)) {
      mismatches++;
      if (mismatches <= 5) console.error(`history mismatch ${id}: replay ${cpSum.get(id) || 0} vs final ${v.cp}`);
    }
  }
  if (mismatches) console.error(`history: ${mismatches} players with cp mismatch`);
  // the daily record must end on the computed levels themselves, not just the same points
  let levelMismatches = 0;
  const lastDay = days.at(-1)?.lv ?? {};
  for (const [id, v] of levels) if (lastDay[id] !== undefined && lastDay[id] !== v.level2dp) levelMismatches++;
  if (levelMismatches) console.error(`history: ${levelMismatches} players whose last daily level differs from the computed level`);

  const out = {
    generatedAt: new Date().toISOString(),
    seasonStart: sorted.length ? (sorted[0].startDate || "").slice(0, 10) : null,
    days: days.map((d) => ({ d: d.d, lv: d.lv })),
    players: Object.fromEntries(
      [...events.entries()].map(([id, e]) => [id, { name: e.name, tour: e.tour, rows: e.rows }])
    ),
  };
  return { out, levels };
}
