/// Frozen seed ranks. A player's cold-start rating comes from their ranking
/// the first time the oracle sees them, and that rank is then fixed for the
/// season. Weekly ranking updates therefore never re-rate matches already
/// played: a level only moves when its player actually plays. (Re-seeding
/// from the live ranking on every rebuild moved levels with no match played,
/// in a way anyone could predict from the published rankings.)
///
/// seeds: { atp: { [espnId]: rank|null }, wta: { ... } } — persisted as
/// state/seeds-<SEASON>.json. null records "unranked at first sight".
export function seededLookup(liveRanks, seeds) {
  let added = 0;
  const lookup = (tour, id) => {
    const t = (seeds[tour] ??= {});
    if (Object.hasOwn(t, id)) return t[id];
    const r = liveRanks?.[tour]?.get?.(id) ?? null;
    t[id] = r;
    added++;
    return r;
  };
  return { lookup, added: () => added };
}
