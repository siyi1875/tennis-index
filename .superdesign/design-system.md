# Courtline — Design System ("paper")

## Product context

**What it is:** per-player tennis performance tokens on Chiliz Spicy (88882). Each
ranked player is a token whose level (index) is computed by an expectation-relative
(zero-sum, surprise-weighted) methodology; tokens mint/burn at NAV against a 1:1 CHZ
reserve.
The project's thesis is *benchmark-first*: the Official Daily Close is the licensed
artifact; the token is the real spot leg.

**Target users:** crypto-native tennis fans and small traders who want exposure to a
player's season performance; future: derivatives venues that settle against the
benchmark.

**Core journeys:** scan the board (market view) → open a player (level, chart,
retraceable match trail, NAV, order card) → buy/sell with a wallet → check
portfolio & PnL (fills read from chain) → read the methodology (/docs).

**JTBD:** "Let me see who is heating up and back my conviction in minutes, with
numbers I can trust to the exact match."

## Key pages

1. **Market view** (default, `/`): inline stat ticker (players, tokens, days,
   match trail, core reserve, funded ratio, open claim), ATP/WTA tabs, search,
   sortable index table (rank, player, level, Δ1d, Δ7d, trend sparkline, NAV,
   token pill), order-card detail panel (opens beside the table on selection).
2. **Docs** (`/docs`): editorial methodology page — sticky TOC sidebar, numbered
   sections, constant tables, worked example, formulas, glossary.
3. **Profile & PnL**: connect hero when signed out; portfolio strip (CHZ balance,
   open value, invested, realized, net PnL), holdings table, on-chain fill history.
4. **Connect modal**: EIP-6963 detected wallets + install list.

## Branding & styling — paper theme

Reference: exchange.papertrade.xyz warm paper look. Two modes, same tokens:

- **Light (default)** `--paper #f4ecd8` page / `--raised #faf6ed` surfaces /
  `--sunk #ede3cf` wells & hovers / `--well #f7f1e1` inset panels.
- **Night (espresso)** `--paper #1a1410` / `--raised #231c15` / `--sunk #130e09` /
  `--well #1e1711` — dark brown in the same warm hue family as the paper theme,
  never navy/grey. Ink warms to cream `#f2e8d3` / tan `#b4a58b` / faded `#877a63`.
  Semantics warm up too: up = sage `#90cb9c`, down = terracotta `#d98d77`,
  gold `#e5c46a`, chartreuse stays `#d3e04f`. Toggle: header icon button,
  persists to `localStorage.fspi_theme`, mirrored into `<meta name="theme-color">`.

- **Type:** Inter only for UI (400–700), JetBrains Mono for all numerics,
  addresses, hashes, symbols, and the `.kicker` (mono, uppercase, +1.2px).
  No display font. Scale: page body 14px, tables 13px, notes 12–12.5px,
  detail name 20px, NAV big 26px mono, section h2 (docs) 22px/-0.015em.
- **Color tokens:**
  - ink `--ink #262019`, secondary `--ink-2 #6f6454`, faint `--ink-3 #9a8f7c`
  - semantic `--up #2d5f3a` (muted forest green), `--down #a83a3a` (brick red),
    soft tints for tag backgrounds; night: `--up #7bd8a8`, `--down #f28da0`
  - brand `--tennis #cdd63f` (chartreuse, header ball mark + toasts +
    milestone tags only), `--gold #a67c1b` / `--gold-soft` (GS tags, close badge,
    season banner), night `--gold #e5c46a`
  - chart `--chart` = up color, `--chart-fill` 10% alpha (SVG area fill)
- **Borders:** hairlines `--line`, strong `--line-strong` (hover). No heavy slabs.
  1px solid everywhere; dividers inside panels use the grid-gap trick
  (1px background gap) for stat strips.
- **Radii:** 6/8/10/14 (input 8, panel 14, pills/buttons full 999).
- **Header:** 56px sticky, blurred `color-mix` paper, hairline bottom. Left:
  ball mark (pure CSS circle with clipped arcs, chartreuse) + "Courtline".
  Right: Docs navlink, theme toggle, portfolio button, wallet chip, Connect CTA
  (green, pill).
- **Density:** editorial spacing on docs (max 720px column, 44px section rhythm),
  terminal-grade tables on market. No zebra; hover = sunk tint.

## Motion

- 150–200ms ease-out on hover/focus; toasts slide up 8px; skeleton shimmer.
- Sparklines/charts are static SVG; no chart animation.
- `prefers-reduced-motion: reduce` disables transforms.

## Specific requirements

- Single self-contained `app/index.html` + `app/docs.html` + `app/server.js`
  (`/docs` route). No build step, no framework.
- All numerics right-aligned, monospace, tabular-nums; hashes truncated 6+4.
- Order card: segmented Buy/Sell side toggle (one input + one button that switch
  semantics), fee note (1% per side → core reserve), 2% slippage guard, wallet +
  holdings reference rows.
- Empty and loading states are explicit ("Loading index…" — no blank areas).
- Season-end warning banner (≤21 days) and Official Close badge are persistent
  header fixtures.
- No emojis; icons via inline SVG only.

## Preserved element contract (do not break)

IDs: `stats search tbody emptyMsg grid marketTools tabAtp tabWta rowCount detail
profileView pfPanel walletChip chipAddr chipBal chainDot pfBtn connectBtn
connectModal walletList installList toasts seasonBadge tokStats tokMsg holdBal
walletAddr walletBal chainBadge themeBtn orderAmt orderBtn sideBuy sideSell
navBig navSub tokenPanel seasonBanner`. (`sinceDate`/`amtChz`/`amtTok` removed —
the sub lede is static text and the order card uses one unified input.)
JS classes used by generated markup: `stat k v acc down up`, `num`, `row sel rk nm
sym lv delta spark tok tok-pill`, `tag gs win loss mil`, `ev d m l1 l2 cp lvafter`,
`oref feenote conn toksym tokaddr navbig navsub side-toggle btn btnrow msg err ok`,
`wrow sub arrow ph wsec`, `toast ok err`, `modal modal-card modal-head x`, `hero`,
`empty`, `ghost cta chip dot addr bal`, `navlink`, `icon-btn`, tabs/side `on`.

## Docs page conventions

- Same token system; `.page` grid 220px TOC + content; sticky TOC with
  IntersectionObserver active state.
- `.doc .kicker` mono green; `h2` numbered "N · Title"; constant tables class `c`.
- Formulas in `.formula` blocks (mono); worked example reproduces the engine's
  exact integer math; `.note` gold callouts for caveats.
