// Tournament tier + round classification (FSPI-style weighting).
// Tier multiplier mirrors FSPI's "Seasonal Adjustment Factor" concept:
// bigger stages carry more weight.
export const TIERS = {
  GS: { label: "Grand Slam", mult: 1.5 },
  YEC: { label: "Tour Finals", mult: 1.25 },
  M1000: { label: "Masters 1000 / WTA 1000", mult: 1.0 },
  P500: { label: "ATP 500 / WTA 500", mult: 0.7 },
  P250: { label: "ATP 250 / WTA 250", mult: 0.5 },
  DFLT: { label: "Unclassified (conservative)", mult: 0.4 },
  EXCL: { label: "Excluded (team/exhibition/lower tour)", mult: 0 },
};

export const ROUNDS = {
  F: { label: "Final", mult: 1.0 },
  SF: { label: "Semifinal", mult: 0.85 },
  QF: { label: "Quarterfinal", mult: 0.7 },
  R16: { label: "Round of 16", mult: 0.55 },
  R32: { label: "Round of 32", mult: 0.4 },
  R64: { label: "Round of 64", mult: 0.3 },
  R96: { label: "Round of 96", mult: 0.25 },
  R128: { label: "Round of 128", mult: 0.25 },
  RR: { label: "Round Robin", mult: 0.5 },
};

const GRAND_SLAMS = [
  "Australian Open",
  "Roland Garros",
  "French Open",
  "Wimbledon",
  "US Open",
  "U.S. Open",
];

const FINALS = ["ATP Finals", "WTA Finals", "Nitto ATP Finals", "WTA Finals Riyadh"];

// ATP Masters 1000 hosts
const M1000_ATP = [
  "Indian Wells", "BNP Paribas Open", "Miami", "Miami Open", "Monte Carlo", "Monte-Carlo",
  "Madrid", "Mutua Madrid Open", "Rome", "Internazionali BNL d'Italia", "Canada", "Cincinnati",
  "Shanghai", "Rolex Shanghai Masters", "Paris", "Rolex Paris Masters",
];
// WTA 1000 hosts (2026 season: Doha/Dubai split, plus mandatory 1000s)
const M1000_WTA = [
  "Doha", "Qatar TotalEnergies Open", "Qatar Total Energies Open", "Dubai", "Duty Free Tennis Championships",
  "Indian Wells", "BNP Paribas Open", "Miami", "Miami Open", "Madrid", "Mutua Madrid Open",
  "Rome", "Internazionali BNL d'Italia", "Canada", "National Bank Open", "Cincinnati",
  "Cincinnati Open", "Wuhan", "Wuhan Open", "Beijing", "China Open",
];
// 500 hosts (curated; unknown hosts fall back to DFLT 0.4)
const P500_ATP = [
  "Rotterdam", "ABN AMRO Open", "Doha", "Dubai", "Dubai Duty Free Tennis Championships",
  "Acapulco", "Abierto Mexicano", "Rio de Janeiro", "Rio Open", "Marseille",
  "Open 13", "Barcelona", "Barcelona Open", "Munich", "BMW Open",
  "Estoril", "Millennium Estoril Open", "Washington", "Mubadala Citi DC Open",
  "Tokyo", "Japan Open", "Basel", "Swiss Indoors",
  "Vienna", "Erste Bank Open", "Halle", "Terra Wortmann Open", "Queen's", "cinch Championships",
  "Stuttgart", "Boss Open", "Hamburg", "Hamburg Open",
];
const P500_WTA = [
  "Charleston", "Credit One Charleston Open",
  "Stuttgart", "Porsche Grand Prix", "Eastbourne", "Bad Homburg",
  "Berlin", "ecotrans Ladies Open", "Guadalajara", "Zhengzhou", "Tokyo", "Pan Pacific Open", "Ningbo",
];

// Team events / exhibitions / lower circuits to exclude (not tour-level
// individual events: FSPI indexes the main tours only)
const EXCLUDED = [
  "United Cup", "Davis Cup", "Billie Jean King Cup", "Laver Cup", "Hopman Cup",
  "ATP Cup", "Next Gen ATP Finals", "Challenger", "ITF", "UTS", "Exhibition",
  "World Tennis League", "World Team Cup",
];

function containsAny(name, list) {
  const n = name.toLowerCase();
  return list.some((x) => n.includes(x.toLowerCase()));
}

export function isExcluded(eventName) {
  return containsAny(eventName, EXCLUDED);
}

/// Classify a tournament (by name + tour) into a tier key.
export function classifyTier(eventName, tour) {
  if (isExcluded(eventName)) return "EXCL";
  if (containsAny(eventName, GRAND_SLAMS)) return "GS";
  if (containsAny(eventName, FINALS)) return "YEC";
  const pool = tour === "atp" ? M1000_ATP : M1000_WTA;
  const p500 = tour === "atp" ? P500_ATP : P500_WTA;
  if (containsAny(eventName, pool)) return "M1000";
  if (containsAny(eventName, p500)) return "P500";
  if (/masters/i.test(eventName)) return "M1000";
  if (/wta\s*1000/i.test(eventName)) return "M1000";
  if (/atp\s*500|wta\s*500/i.test(eventName)) return "P500";
  if (/atp\s*250|wta\s*250/i.test(eventName)) return "P250";
  return "DFLT";
}

/// Normalize a round display name into a ROUNDS key (null => skip match).
export function classifyRound(roundName) {
  const r = (roundName || "").toLowerCase();
  if (r.includes("qualifying") || r.includes("qualification")) return null;
  if (r.includes("round robin") || r.includes("round-robin") || r.includes("robin")) return "RR";
  if (r.includes("final")) {
    if (r.includes("semifinal") || r.includes("semi-final") || r.includes("semi final")) return "SF";
    if (r.includes("quarterfinal") || r.includes("quarter-final") || r.includes("quarter final")) return "QF";
    return "F";
  }
  if (r.includes("semifinal") || r.includes("semi-final") || r.includes("semi final")) return "SF";
  if (r.includes("quarterfinal") || r.includes("quarter-final") || r.includes("quarter final")) return "QF";
  const m = r.match(/round of (\d+)/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n <= 16) return "R16";
    if (n <= 32) return "R32";
    if (n <= 64) return "R64";
    if (n <= 96) return "R96";
    return "R128";
  }
  if (r.includes("1st round") || r.includes("first round")) return "R64"; // ambiguous; conservative default refined by draw size
  if (r.includes("2nd round") || r.includes("second round")) return "R32";
  if (r.includes("3rd round") || r.includes("third round")) return "R16";
  if (r.includes("4th round")) return "R16";
  return null; // unknown round => skip (only official recognized rounds count)
}

/// Expectation-relative tier/round weights (tennis adaptation of FSPI).
/// All points are integers (2dp scale = points * 100 applied in compute).
export const POINTS = {
  WIN: 50,
  LOSS: -30,
  SET_WIN: 4,
  SET_LOSS: -4,
  GAME_DIFF: 0.2, // per net game
  BAGEL: 2, // extra for a 6-0 set
  OPP_BONUS: [
    { maxRank: 10, pts: 40 },
    { maxRank: 25, pts: 25 },
    { maxRank: 50, pts: 15 },
    { maxRank: 100, pts: 8 },
    { maxRank: 150, pts: 3 },
    { maxRank: Infinity, pts: 0 },
  ],
  MILESTONE: { TITLE: 200, FINAL: 100, SF: 50, QF: 25 }, // x tier mult, once per event
};

export const BASE_LEVEL = 7500.0;
export const MIN_LEVEL = 100.0;
