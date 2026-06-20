# Long-Call Tracker — Plan 2: Tracker Implementation Plan

> **For agentic workers:** built straight through in-session per user request. TDD where logic is pure/orchestration; live HTTP paths are implemented but verified by stubbed-`httpJson` unit tests (no live keys in CI for tests).

**Goal:** The background tracker — a pluggable data-provider layer, a `snapshot.js` evaluation core that runs every campaign through the engine and persists state, and a two-tier GitHub Action that runs it on a market-hours cron.

**Architecture:** `dataProvider.js` exposes one interface backed by Tradier / Alpaca / FMP, selected by `config.providers`; HTTP is injectable so parsing is unit-tested without network. `snapshot.js` has a pure-ish `runSnapshot({cfg, positions, history, provider, nowET})` core (engine-driven, deterministic given inputs) plus a thin `main()` that reads files, builds the provider from env secrets, computes ET-now, and writes `positions.json` + `history.json`. The Action commits the updated JSON back to the repo.

**Tech Stack:** Vanilla JS (dual Node/browser export), Node 18+ global `fetch`, GitHub Actions cron. Zero npm deps.

---

## File Structure

- `engine.js` — **Modify.** Add pure helpers used by the tracker: `computeEMA`, `regimeBearishCross`, `occSymbol`, `dteBetween`.
- `dataProvider.js` — **Create.** `createProvider(cfg, secrets, httpJson)` → interface; per-provider backends; exported pure parse functions.
- `snapshot.js` — **Create.** `runSnapshot(...)` core + helpers (`fetchRollCandidates`, `equityPoint`) + `main()`.
- `test.js` — **Modify.** Add tests for the 4 new engine helpers.
- `test_tracker.js` — **Create.** Async harness; tests provider parsing (stubbed `httpJson`) and `runSnapshot` (stub provider).
- `positions.json` — **Create.** Seed `[]`.
- `history.json` — **Create.** Seed `{"events":[],"equity":[]}`.
- `.github/workflows/snapshot.yml` — **Create.** Two-tier cron; runs `node snapshot.js`; commits changes.

### Adapter interface (extends spec §10a by `getStockQuote` + `getOptionCandidates`)

```
getDailyBars(sym, fromISO, toISO)      -> [{date,o,h,l,c}]  oldest->newest   // ATR, SPY EMA
getStockQuote(sym)                     -> {price}                            // live underlying
getStockPriceAt(sym, dateISO, etHHMM)  -> {price}                            // entry-moment fill
getOptionChain(sym, expiration)        -> [{strike,bid,ask,mark,delta,oi,expiration,type:'call'}]
getOptionQuote(occSymbol)              -> {mark,delta,bid,ask,oi}            // current leg
getOptionCandidates(sym, todayISO)     -> [{strike,expiration,dte,delta,bid,ask,mark,oi}]  // rolls
```

---

## Tasks

### Task 1: Engine helpers (`computeEMA`, `regimeBearishCross`, `occSymbol`, `dteBetween`)
- [ ] Add the four functions to `engine.js` and export them.
- [ ] Add tests to `test.js`:
  - `computeEMA([1,2,3,4,3,2],2)` last value ≈ 2.3889 (k=2/3, SMA seed).
  - `regimeBearishCross([1,2,3,4,3,2],2,3) === true`; `([1,2,3,4,5,6],2,3) === false`.
  - `occSymbol('AAPL','2026-07-18','C',205) === 'AAPL260718C00205000'`.
  - `dteBetween('2026-06-19','2026-07-18') === 29`.
- [ ] `node test.js` stays green.

### Task 2: `dataProvider.js`
- [ ] Implement `defaultHttpJson(url, headers)` (fetch + ok-check).
- [ ] Pure parsers (exported): `parseFmpDaily`, `parseFmpIntradayAt`, `parseTradierChain`, `parseTradierQuote`, `parseAlpacaBars`.
- [ ] `createProvider(cfg, secrets, httpJson)` dispatching each interface method to the configured backend; Tradier via proxy (`X-Live-Token`) or direct (`Authorization`), Alpaca via `APCA-*` headers, FMP via `apikey` query. FMP option methods throw a clear "use tradier/alpaca for options" error.
- [ ] Tests in `test_tracker.js` with stubbed `httpJson`: FMP daily parse + URL, Tradier chain parse (greeks→delta, calls only), Tradier quote parse.

### Task 3: `snapshot.js`
- [ ] `runSnapshot({cfg, positions, history, provider, nowET})`:
  - fetch SPY daily bars → `regimeBearishCross` over closes.
  - per OPEN campaign: build OCC for current leg, `getOptionQuote` (mark), `getStockQuote` (price), compute `currentDTE`; if `isLastHour`, `fetchRollCandidates`; build `ctx`; `evaluateExits` → if not `none`, `applyAction`, push events, log.
  - append one `equity` point for `nowET.dateISO` (realized closed + open unrealized via `computeCampaignPnl`), replacing any same-date point.
  - return `{positions, history, regimeCross, logs}`.
- [ ] `fetchRollCandidates(provider, ticker, todayISO, cfg)` → `getOptionCandidates`.
- [ ] `main()`: read `config.json`/`positions.json`/`history.json`; build provider from `process.env` (`FMP_KEY`, `TRADIER_LIVE_TOKEN`, `TRADIER_PROXY`, `ALPACA_KEY`, `ALPACA_SECRET`); compute `nowET` (Intl ET); `runSnapshot`; write files; print logs.
- [ ] Tests in `test_tracker.js` with a stub provider object: emergency-close persists + books netPnl; roll_up appends a leg + records event; `none` leaves campaign open; closed campaigns produce a scorecard via `engine.scorecard`.

### Task 4: Seeds + workflow
- [ ] Create `positions.json` = `[]`, `history.json` = `{"events":[],"equity":[]}`.
- [ ] Create `.github/workflows/snapshot.yml`: cron `*/30 13-20 * * 1-5` (intraday emergency) + `*/5 19-20 * * 1-5` (dense last-hour ET ~15:00-16:00 = 19:00-20:00 UTC during DST); `node snapshot.js`; commit `positions.json history.json` if changed. Secrets referenced, not committed.
- [ ] `node test.js && node test_tracker.js` both green. Commit.

---

## Self-Review
- Spec §3 background tracker → snapshot.js + Action. §9 rules → engine (Plan 1) invoked by runSnapshot. §10 providers → dataProvider.js. ✓
- Live HTTP cannot be CI-tested without keys; parsing + dispatch + orchestration are unit-tested with stubs; noted honestly. ✓
- Interface grew by `getStockQuote` + `getOptionCandidates` vs spec §10a — spec updated to match. ✓
