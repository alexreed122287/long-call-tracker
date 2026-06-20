# Long-Call Tracker — Plan 3: Dashboard Implementation Plan

> Built straight through in-session per user request. Browser-verified (preview: console clean + rendered state) since the UI is DOM glue over the already-tested engine.

**Goal:** The static dashboard — key in trades, see each campaign tracked against the rules with live marks, and read the R-based scorecard. PAT-backed GitHub sync so the background Action shares state.

**Architecture:** `index.html` (shell, dark theme, three tabs, no icon glyphs) loads `engine.js` + `dataProvider.js` + `app.js` as plain scripts (globals `Engine`, `DataProvider`). `app.js` keeps state in `localStorage` (positions, history, config, keys, GitHub PAT), reads/writes `positions.json`/`history.json` via the GitHub contents API, fetches live data through the provider, and reuses the engine for all math. While open, a poll loop runs the same evaluate→apply logic as `snapshot.js` (open-tab tracking within the hybrid model).

**Tech Stack:** Vanilla JS + the existing globals. No framework, no deps.

---

## File Structure
- `index.html` — **Create.** Shell + `<style>` + three tab sections (Positions, Scorecard, Settings) + script tags.
- `app.js` — **Create.** All browser logic: storage, GitHub sync, provider wiring, add-trade, render, poll tick, scorecard + equity sparkline.

## Tasks
### Task 1: `index.html`
- [ ] Dark theme, header, tab buttons, three `<section>`s, Positions add-trade form + table, Scorecard metrics grid + equity SVG, Settings form (account/risk/thresholds, provider selection, API keys/tokens, GitHub owner/repo/PAT). Load `engine.js`, `dataProvider.js`, `app.js`.

### Task 2: `app.js` — storage + settings
- [ ] localStorage helpers; default config seeded from `./config.json`; load/save settings fields; provider built from config + secrets.

### Task 3: `app.js` — GitHub sync
- [ ] `ghGet(path)`/`ghPut(path,obj,sha,msg)` via contents API (base64, unicode-safe); `pullFromRepo()` and `pushState()` (positions + history); status messages.

### Task 4: `app.js` — add trade
- [ ] On submit: `getStockPriceAt` (entry fill, CST→ET +1h), `getDailyBars`→`computeATR`(14), `getOptionCandidates`→nearest expiration to DTE→`pickEntryContract`, `sizePosition`, build campaign, persist, optional push. Optional entry-premium override. Errors surfaced (e.g. missing keys).

### Task 5: `app.js` — render + tick + scorecard
- [ ] Positions table (entry, ATR levels, leg, qty, live mark, unrealized $/R, rolls, action); manual Close. `refresh()` fetches live marks/prices. `tick()` runs evaluate→apply per open campaign while the tab is open and persists. Scorecard via `Engine.scorecard` + equity sparkline from `history.equity` + exit-reason breakdown.

## Self-Review
- Spec §12 UI (three tabs, no glyphs) ✓; §11 scorecard ✓; §3 PAT sync ✓; open-tab tracking reuses §9 engine logic ✓. DOM glue verified in-browser rather than unit-tested; engine math already covered by Plans 1–2. ✓

## Addendum (chain picker)
Add-trade was changed from keyed delta/DTE to an **option-chain picker**: Load chain
→ pick expiration (all expirations, lazy-loaded via new `getExpirations`) → click a
call strike (table shows strike/Δ/bid/ask/mark/OI/spread; 0.65–0.85 band highlighted,
illiquid rows dimmed) → sizing preview → Add. New provider method `getExpirations`
(Tradier/Alpaca; FMP throws) with `parseTradierExpirations` (+4 tracker tests, now 27).
Browser-verified end-to-end with a stubbed provider. Spec §6/§12 updated.
