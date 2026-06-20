# Long-Call Tracker

A theoretical (paper) long-call trade tracker. Key in tickers you would buy
calls on; the tool tracks each idea forward against an ATR-based exit/roll
ruleset and reports a live R-based scorecard. No real orders are placed.

See `docs/superpowers/specs/2026-06-19-long-call-tracker-design.md` for the full
design.

## Status
- [x] Plan 1 — Engine (`engine.js`): pure math/rules, unit-tested.
- [x] Plan 2 — Tracker (`dataProvider.js`, `snapshot.js`, `.github/workflows/snapshot.yml`).
- [x] Plan 3 — Dashboard (`index.html`, `app.js`): entry form, positions table, scorecard, GitHub PAT sync.

## Dashboard
Open `index.html` (served statically, or via GitHub Pages). Set your API keys and
GitHub PAT in the Settings tab (stored in this browser only). Tabs:
**Watchlist · Positions · Scorecard · Settings**.
- **Watchlist** — stage daily candidates by name/symbol search or bulk paste;
  Refresh shows last price, daily %, ATR, and the suggested 0.65-0.85 call; Chain
  expands the full option chain inline; Buy jumps straight into the chain picker.
- **Positions** — pick a contract off the option chain; tracked against the rules
  with live marks and manual close.
- **Scorecard** — win rate, profit factor, Sortino, Sharpe, drawdown, expectancy
  (R) and the equity curve.

While the tab is open it polls and applies the exit rules itself; the GitHub
Action does the same while you're away.

**Tradier credentials:** in Settings, pick the environment (Production
`api.tradier.com` or Sandbox `sandbox.tradier.com`), enter your account ID + API
key (or a proxy URL + live token), and hit **Test connection** to verify. An
HTTP 401 means a bad/empty token or a sandbox key used against production — flip
the environment toggle or recheck the key.

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
