# Demo walkthrough — Courtline trade flow

Recorded on an earlier deployment, before token symbols moved from `ATP-`/`WTA-` to
neutral `M-`/`W-` prefixes.

The nine step frames below are current as of 2026-10-21; every transaction shown
is a genuine signed Spicy testnet transaction from the admin wallet. The only
simulated part is the wallet chrome — a local-signer EIP-1193 shim ("Demo Wallet")
announces itself via EIP-6963 exactly like MetaMask would, so the UI code path
(connect → chain check → sendTransaction) is the real one.

`walkthrough.webm` is from an earlier build. The bundled Playwright build used
here cannot encode video, so re-record with a standard Playwright install if you
need a fresh webm; the step frames are the current record.

Re-run it any time: `node demo/record.mjs` (needs the UI on :8080, the RPC up,
and a Playwright browser). The recorder uses the system Chrome channel, so no
Playwright browser download is needed.

## Scene script

| Step | Frame | What happens |
|---|---|---|
| 1 | `steps/01-market.png` | Market view: 677 players tracked, 202 live tokens, 110 days of record, 5,537-row match trail, core reserve 15.54 CHZ, 100.0% funded, 0 open claim; Official close badge `2026-10-20 · a7141115` |
| 2 | `steps/02-connect-modal.png` | Connect Wallet → EIP-6963 modal lists detected wallets with the same flow real users get |
| 3 | `steps/03-connected.png` | Connected: chip shows address + CHZ balance, Portfolio & PnL button appears |
| 4 | `steps/04-search.png` | Search "Sinner" — filter narrows the board to one player |
| 5 | `steps/05-token-panel.png` | Token panel: level 7,795.56, season chart with Wimbledon title marker, and the **retraceable trail** — TITLE +31.85, final vs Zverev +128.43 (expected 58%), SF vs Djokovic +65.04 (expected 75%). Token box: NAV 1.0394 · supply · reserve · fees 1%/1% → core reserve |
| 6 | `steps/06-buy-quote.png` | Buy 0.5 CHZ |
| 7 | `steps/07-buy-sent.png` | Real tx `0x53fdf845…`: 0.5 CHZ → 0.4762 ATP-SIN at NAV 1.0394 (the 1% buy fee goes to the core reserve). Message confirms NAV-pinned pricing |
| 8 | `steps/08-sell-sent.png` | Real tx `0xc7a6cbb9…`: 0.25 ATP-SIN → 0.2573 CHZ at NAV 1.0394 (1% sell fee) |
| 9 | `steps/09-profile.png` | Portfolio & PnL: CHZ 8.5500, open value 1.7986, invested 2.5000, realized 1.5935, net PnL +0.8921; holdings + on-chain fills with amount, NAV at fill, and tx hash |

The profile includes fills from earlier demo sessions (the 2026-10-15 rows at
NAV 1.0899), so its cumulative PnL is not just this run's round trip. The new
round trip is the 2026-10-21 buy/sell pair at NAV 1.0394.

## Design system

The visual language follows `.superdesign/design-system.md`: warm paper by
default with an espresso night theme, Space Grotesk display / Inter UI /
JetBrains Mono numerics, hairline separators, tennis-ball chartreuse reserved
for action and positive deltas, 8px spacing rhythm, terminal-grade table density.

## Notes for presenters

- The buy/sell numbers demonstrate the reserve model: tokens mint/burn at NAV =
  reserve/supply; fees are taken from the transfer, not the reserve, so NAV is
  invariant for other holders.
- The level is an expectation-relative score, not a world ranking: Sinner's
  Wimbledon run earned +295.6 points because he was the favourite; an underdog
  upset moves the same level much more.
- The header close badge and the season-end banner (arms 21 days before Dec 31)
  frame the benchmark story: intraday is indicative, the daily close is the
  settlement print.
