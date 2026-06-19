# Long-Call Tracker

A theoretical (paper) long-call trade tracker. Key in tickers you would buy
calls on; the tool tracks each idea forward against an ATR-based exit/roll
ruleset and reports a live R-based scorecard. No real orders are placed.

See `docs/superpowers/specs/2026-06-19-long-call-tracker-design.md` for the full
design.

## Status
- [x] Plan 1 — Engine (`engine.js`): pure math/rules, unit-tested.
- [ ] Plan 2 — Tracker (`dataProvider.js`, `snapshot.js`, GitHub Action).
- [ ] Plan 3 — Dashboard (`index.html`, `app.js`).

## Engine
`engine.js` is pure and dependency-free, exported for both Node and the browser.

Run the tests:

    node test.js

Key functions: `computeATR`, `atrLevels`, `sizePosition`, `pickEntryContract`,
`pickRollContract`, `evaluateExits`, `applyAction`, `computeCampaignPnl`,
`scorecard`. See the spec sections referenced in the plan for behavior.
