# Long-Call Tracker

A theoretical (paper) long-call trade tracker. Key in tickers you would buy
calls on; the tool tracks each idea forward against an ATR-based exit/roll
ruleset and reports a live R-based scorecard. No real orders are placed.

See `docs/superpowers/specs/2026-06-19-long-call-tracker-design.md` for the full
design.

## Status
- [x] Plan 1 — Engine (`engine.js`): pure math/rules, unit-tested.
- [x] Plan 2 — Tracker (`dataProvider.js`, `snapshot.js`, `.github/workflows/snapshot.yml`).
- [ ] Plan 3 — Dashboard (`index.html`, `app.js`).

## Engine + tracker
`engine.js` and `dataProvider.js` are pure/dependency-free, exported for both
Node and the browser. `snapshot.js` is the GitHub Action runner.

Run the tests:

    node test.js          # engine
    node test_tracker.js  # data adapters + snapshot orchestration

## Background tracker
`.github/workflows/snapshot.yml` runs `snapshot.js` on a two-tier cron and
commits `positions.json` / `history.json`. It needs repo secrets: `FMP_KEY`,
`TRADIER_PROXY`, `TRADIER_LIVE_TOKEN` (or `TRADIER_TOKEN`), and optionally
`ALPACA_KEY` / `ALPACA_SECRET`.

Key functions: `computeATR`, `atrLevels`, `sizePosition`, `pickEntryContract`,
`pickRollContract`, `evaluateExits`, `applyAction`, `computeCampaignPnl`,
`scorecard`. See the spec sections referenced in the plan for behavior.
