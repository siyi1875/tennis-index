# FSPI Tennis Index — Chiliz Spicy Testnet MVP

A tradable performance index for ATP/WTA tennis players, modeled on the FSPI league-index
methodology (futuresports.com). Every player in the ATP top-100 and WTA top-100 has a
per-player ERC-20 token whose price tracks the player's season performance level. Levels
are computed off-chain from official results (ESPN data) and pushed on-chain by an
oracle; the core contract acts as the performance counterparty so that holder wealth
tracks the index.

This is a **testnet demo** (Chiliz Spicy, chain 88882). Tokens are not real assets.

## Architecture

```
ESPN public API ──> oracle (node) ──> TennisIndex core (registry + level feed)
   rankings            │                    │
   daily scoreboards   │                    │ clones PlayerToken per player
                       └── season state     │
                           (levels 2dp)     v
                                     PlayerToken x N  <── buy/sell (NAV = level)
                                            ^
                                            └── funded/swept by core on level moves
app/  (static UI: lists players, MetaMask buy/sell)
```

- **Contracts** (`contracts/`, Solidity 0.8.28, OpenZeppelin):
  - `TennisIndex.sol` — AccessControl (ADMIN/ORACLE/PAUSER) + Pausable. `addPlayer(s)`
    deploys an EIP-1167 clone per player. Oracle-only `updateLevel(s)` with a ±25%
    (`maxDeltaBps`) cap and a 30-minute `minUpdateInterval` per player. Admin-only
    `calibrateLevel` (bypasses caps; used for backfill). `seasonReset` returns all
    levels to the 7,500.00 base on Jan 1. `topUp()` funds the counterparty pool.
    `fundingRequirement(id)` view shows the CHZ needed to bring a token reserve to target.
  - `PlayerToken.sol` — ERC-20 clone. NAV = `reserve / supply` once supply exists;
    before that it is the level-implied target read from the core (`tokenLevel`).
    `buy` mints at NAV, `sell` burns and pays from the reserve. Fees (≤ 5%) route to
    the core. One packed storage slot holds `core | buyFee | sellFee | symbol(8ch)`.
  - Levels use 2 decimals: `750_000 == 7,500.00`; minimum level `100.00`.

- **Oracle** (`oracle/`): fetches ATP/WTA rankings (150 deep, weekly) and daily
  scoreboards from `site.api.espn.com`, classifies tournaments/rounds, applies the
  expectation-relative (zero-sum, surprise-weighted) scoring with integer centi-point
  math, and pushes only *changed* levels. Runs in three modes: `backfill` (season build, disk-cached), `register`
  (deploy tokens + seed levels), `watch` (continuous: fetch → compute → push, every
  15 min, with automatic faucet top-up when the gas balance runs low).

- **UI** (`app/`): single-page app served by `app/server.js` (port 8080). Market view with
  sortable levels, deltas, sparklines; per-player detail with the retraceable level chart
  and match trail; wallet connect CTA in the header. The **profile page** shows CHZ
  balance, holdings with live NAV, invested/realized amounts and **net PnL** — reconstructed
  from the tokens' on-chain `Bought`/`Sold` events (server-side `/api/portfolio` endpoint,
  batched `balanceOf` over all registered tokens + log queries within the RPC's 250k-block
  window). Trading goes through MetaMask on Spicy. Full methodology is documented at
  **`/docs`** (`app/docs.html`): scoring tables, worked example, NAV math,
  trading mechanics, the Official Daily Close, the audit record, and architecture.

## Scoring (methodology)

Base level **7,500.00** for every player at season start. Every match is a zero-sum
transfer sized by **surprise**. Pre-match ratings give an expected win probability:

```
p = 1 / (1 + 10^((rating_opponent - rating_you) / 400))
winner points = 200 x (1 - p_winner) x tier x round
loser points  = -winner points
rating update = rating + 24 x (result - p)
```

A favourite's expected win moves the level only a little; an upset moves it a lot.
The winner gains exactly what the loser gives, so a match mints nothing. Set/game
margin stats (±4 per set, ±0.2 per net game, ±2 per bagel) are round-scaled and
zero-sum. Milestones (title +200, runner-up +100, SF +50, QF +25) are the only new
points; each is multiplied by the tier and by the surprise of the decisive match,
then by a 0.25 season scale to keep net inflation near zero.

Ratings start from the ranking snapshot (`2,200 - 200 x log10(rank)`; unranked 1,500)
and move only through results. Tier multipliers: GS ×1.5, Tour Finals ×1.25, 1000 ×1.0,
500 ×0.7, 250 ×0.5, unknown ×0.4. Round multipliers: F ×1.0, SF ×0.85, QF ×0.7,
R16 ×0.55, R32 ×0.4, R64 ×0.3, R96/R128 ×0.25, RR ×0.5.

Team events (United Cup, Davis/BJK Cup, Laver Cup, Next Gen Finals) and
Challenger/ITF/exhibitions are excluded. Qualifying rounds are excluded. Early rounds
("Round 1..4") are resolved per event from draw structure, anchored on named QF/SF/F
rounds; a 4th-deep round maps to R128 vs R96 by match count (≥40 → 128-draw).

## Economics

- **NAV** is reserve-backed by construction: buys mint `net / NAV` and add exactly the
  paid CHZ to the reserve; sells pay `tokens × NAV` from the reserve. Solvency is
  structural: the reserve can always cover full redemption.
- The **core is the counterparty**: on a level rise it funds each token's reserve up to
  `supply × newLevel / 750000` (capped at its balance — graceful degradation if the pool
  is short, NAV floats below target but stays fully backed); on a fall the token sweeps
  the surplus back to the core.
- Trading fees accrue to the core pool. The pool is seeded via `topUp()` and refilled by
  daily faucet claims.

## Deployment (Spicy testnet, 88882)

| Contract | Address |
|---|---|
| TennisIndex core | `0xb4b1839683ec021599cf38057005709e42e42da2` |
| PlayerToken implementation | `0x8fe41d434f719e38a55eb4b45498b2fbcfbbb15b` |
| Admin / Oracle / Treasury keyholder | `0x6720Cab7fBC755d51F92187146aF0dD9ca3E8d17` |

202 players registered (top-100 ATP + top-100 WTA by current ESPN ranking, plus the two
strongest non-ranked by season level). **Tracking window: Jul 1 → today** (`SEASON_START`
env, default `20260701`; set `SEASON_START=20260101` for the full season). Levels were
rebuilt from the mid-year baseline of 7,500.00 and calibrated on-chain in one admin pass.
Current leaders by index (surprise, not world ranking): Davidovich Fokina 7,937.75 (ATP), Zheng Qinwen 8,106.87 (WTA).

Every player's level is **retraceable**: `oracle/state/history-2026.json` holds a daily
level snapshot for the whole window plus, per player, a chronological trail where each
match row (event, tier, round, opponent, result, score, expectation, surprise, cp, running level) and each
milestone row is recorded; `pushlog-2026.json` records every on-chain push. A replay
assertion guarantees the trail sums exactly to the computed level (0/677 mismatches).

Gas on Spicy: base fee is fixed at 2500 gwei; a small priority tip (~100–200 gwei) is
enough. Registration cost ≈ 141k gas ≈ 0.35 CHZ per player (batched `addPlayers`, 20/tx);
one `calibrateLevel` ≈ 60k gas ≈ 0.15 CHZ.

## Operating

```bash
cd oracle
npm i
node src/run.js backfill     # rebuild season match stream (cached)
node src/run.js compute      # rebuild state + levels + history
node src/run.js register     # deploy tokens for new players (admin)
node src/run.js push         # push changed levels (oracle)
node src/run.js rebase       # admin: calibrate all levels to computed values
node src/run.js fees         # admin: set 1%/1% fees on supplied tokens
node src/run.js close [day]  # publish Official Daily Close (default: yesterday)
node tools/backtest.mjs      # season drift, reserve cost and platform economics
env WATCH_INTERVAL_MIN=15 node src/run.js watch   # continuous oracle (push, close, fees)
cd ../app && node server.js  # UI on :8080
```

### Repository setup

Dependency trees, build artifacts, caches and the deployer key are not committed.

```bash
cd contracts
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts OpenZeppelin/openzeppelin-contracts-upgradeable --no-commit
cp .deploy/env.example .deploy/env   # fill in the testnet deployer address/key
forge test

cd ../oracle && npm ci
cd ../app && node server.js          # http://localhost:8080
```

`contracts/.deploy/env` is gitignored. Only the oracle writer, registration and demo
scripts need it; the UI and read-only API work without a key. Never use a mainnet key.

Tests: `cd contracts && forge test` — 32 tests (17 token economics, 12 registry/oracle,
1 invariant suite: reserve covers full redemption, NAV ≤ target, NAV near target when
funded, holder wealth == reserve, core/token level consistency; runs=20, depth=200).
Oracle: `cd oracle && node --test test/*.mjs` — 16 tests.

## Self-review findings (fixed during the build)

1. **Set-loss sign bug** — `SET_LOSS_CP` is signed; subtracting it re-added losses.
   Loser stats were double-credited (+8 per lost set). Fixed to signed addition; caught
   by the compute test suite before any on-chain push.
2. **Milestone tier not persisted** — per-event records lacked the tier, so milestone
   tier-scaling read undefined. Tier now stored per player-event.
3. **compId collision risk** — ESPN competition ids are not globally unique; compId is
   now `tour:eventId:compId`. (The backfill was restarted after the change to avoid
   mixed-id double scoring.)
4. **Buy dilution bug (critical)** — `buy()` priced mints against
   `address(this).balance`, which already includes the incoming `msg.value`. With
   supply > 0, a buyer could receive up to half the tokens they paid for (verified
   on-chain: 1 CHZ bought 0.3433 instead of 0.6866 tokens). Fixed by pricing against
   `balance - msg.value`; verified on-chain that NAV stays pinned across buys/sells.
5. **Stale deployment pointer** — the first post-redesign registration hit the old core
   with new calldata and burned ~16 CHZ in revert gas; `deployments.json` is now the
   single source of truth.
6. **Gas redesign** — original contracts cost 337k gas/player (~0.9 CHZ); packing token
   storage into one slot, dropping the treasury and per-token level storage, and batching
   registrations cut it to 141k (~0.35 CHZ), making a 202-player launch affordable.
7. **Stranded funds recovered** — the superseded cores hold no withdraw path, but their
   pools were recovered through the mechanism itself: an admin `calibrateLevel` raise
   funds the token from the core, then the held tokens are sold back. ~25 CHZ was
   extracted across three cycles; the deprecated core is now `pause()`d with ~2 CHZ
   left (further cycles cost more gas than they return).

## Known limitations (MVP scope)

- Opponent-rank bonus uses the *current* ranking snapshot applied retroactively across
  the season (ESPN only exposes current ranks); the oracle refreshes it daily.
- Early-round resolution depends on an event having at least one named round (QF/SF/F)
  before its early matches count; live events score with a small lag.
- The watch loop only fetches yesterday+today; a longer outage needs a backfill re-run.
- Season backfill seeds levels retroactively at launch ("calibration"), then updates are
  capped at ±25% per push by the on-chain guard.
- The counterparty pool is a single hot wallet's faucet income; it degrades gracefully
  (NAV floats below target) rather than breaking solvency when underfunded.

## Business model

The design follows the futuresports/FSPI model of an **index administrator** — the venue
does not take a position; it defines methodology, publishes the record, and earns fees.

**Revenue: trading fees.** Every buy and sell pays `FEE_BPS` (currently 1%/1%), routed
on-chain to the core. The core clears zero-sum transfers between players and funds the
small milestone mint; fees monetize activity and grow the reserve buffer. NAV is
invariant to fees on both sides (fees are taken from the transfer, not from the reserve).

**Reserve health.** `node src/run.js report` and `/api/stats` track:
- `totalTarget` — Σ supply × level / 7,500,000 across supplied tokens (the full claim)
- `totalReserve` — Σ reserve balances actually held
- `fundedRatio` — reserve ÷ target (100% = every holder can exit at full NAV)
- `outstandingNeed` — the gap the pool must cover

Reserve economics (live season, Jul 1 → Oct 18 measured): match points are zero-sum
(+1.1 cp net); milestones mint +1,981 cp over the window — about 0.04% of the book.
A broad book therefore costs ~0.1%/yr to keep funded. A star-concentrated book is the
stress case: the top-ranked basket costs ~5.7%/yr and the top-10 by index ~18%/yr.
At 1%/side, break-even turnover is ~0.48× book/month for the star basket (0.01× for a
broad book); 2×/month produces fee revenue of 24% of book/year. The core is a
clearinghouse for transfers plus a small milestone mint, not a subsidy for match
outcomes.

**Benchmark-ification (the FSPI/CME path).** Intraday pushes are indicative; once a
day at 09:00 UTC the oracle publishes the **Official Daily Close** — settlement levels
computed from all eligible completed matches through the prior day, hash-pinned
(sha256 of the level table) in `oracle/state/close-2026.json` and served at `/api/close`.
This is the artifact a derivatives venue would license: settlement-by-construction,
no reserve requirement, no annual-reset cost. The per-player tokens provide the real
spot leg that makes basis arbitrage against such futures possible.

**Season reset.** Levels reset to 7,500.00 on Jan 1; `seasonReset` sweeps surplus
reserve above base level back to the core. The UI shows a banner 21 days before
year-end so holders can exit before the reset.

**Known gap:** a single-signer oracle is a trust assumption; a production version
needs multi-sig or zk-attested score feeds, and fee routing to a treasury multisig.

