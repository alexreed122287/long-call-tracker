# Long-Call Paper-Trading Tracker — Design Spec

**Date:** 2026-06-19
**Repo:** `long-call-tracker` (new, public, GitHub Pages)
**Status:** Draft for user review

## 1. Purpose

A dashboard where I key in tickers I *would* buy long calls on, on the day I'd
buy them, and the tool tracks each idea's **theoretical** performance forward —
applying my exact exit/roll rules automatically in the background — so I can see,
with a live scorecard, how effective the strategy is as if I were trading real
money. No real orders are ever placed.

## 2. Goals / Non-Goals

**Goals**
- Enter a theoretical long-call trade from a ticker + date/time + chosen delta & DTE.
- Size each trade with my risk-budget model (a % of a configurable paper account).
- Track every open trade automatically against my exit rules (stop, emergency,
  time-roll, winner roll-up, SPY regime), including while I'm not looking.
- Maintain a live scorecard: win rate, profit factor, Sortino, and the other
  metrics that matter for an options strategy.

**Non-Goals**
- No real order placement, no broker integration for execution.
- No tick-by-tick monitoring (Hybrid model = approximate intraday; see §10).
- No historical *option*-quote backfill for backdated entries (see §10).

## 3. Architecture (Hybrid)

A static dashboard for interaction **plus** a scheduled GitHub Action that does
the background tracking and commits results to the repo, so progress fills in
while I'm away.

```
 Browser (GitHub Pages static site)                GitHub Action (cron, market hours)
 ----------------------------------                ------------------------------------
  index.html + app.js                               node snapshot.js
   - add/edit theoretical trades          (A)        - reads positions.json (open campaigns)
   - writes positions.json via GitHub API <───PAT──> - fetches live marks + SPY EMAs
   - live-evaluates rules while open                 - evaluates rules (engine.js)
   - reads positions.json + history.json             - rolls/closes as rules fire
   - renders positions + scorecard                   - writes positions.json + history.json
                                                      - commits to repo
            \________________  shared  ________________/
                            engine.js (pure math)
                   tradier-proxy (greeks/marks) + FMP /stable (price, ATR, SPY)
```

**Positions sync — decision (A), PAT-backed.** The static page writes
`positions.json` directly to the repo through the GitHub API using a
fine-grained Personal Access Token pasted once and stored in `localStorage`
(never committed). Adding a trade in the UI commits it, so the Action sees it on
its next run. `localStorage` also holds a local cache so the dashboard works
instantly before any sync. This matches the existing GitHub-hosted-feed pattern
(Sentiment Panel).

**Conflict handling.** The Action is the authoritative *tracker* (it owns
roll/close state transitions). The dashboard owns *user intent* (new trades,
manual closes, config). Both write `positions.json`; last-write-wins is
acceptable for a single-user tool. The dashboard re-reads after the Action's
commit. The Action runs on a fixed cron so writes rarely overlap.

## 4. Stack & Repo Layout

Mirrors `position-sizer` so the math is shared, not rewritten.

```
long-call-tracker/
  index.html              # dashboard shell + styling (vanilla, no framework)
  app.js                  # browser logic: entry forms, GitHub API sync, rendering
  engine.js               # PURE math/rules, require-able in Node AND browser
  snapshot.js             # Node entry point for the Action (uses engine.js)
  test.js                 # node test.js — unit tests for engine.js
  config.json             # paper-account balance, risk %, thresholds
  positions.json          # campaigns (committed; written by UI + Action)
  history.json            # append-only events + daily equity snapshots
  .github/workflows/snapshot.yml
  README.md
```

- **`engine.js`** exports pure functions (no I/O): `computeATR`, `atrLevels`,
  `pickEntryContract`, `pickRollContract`, `evaluateExits`, `sizePosition`,
  `scorecard`. Both the browser and Node import the same file.
- **Data:** `tradier-proxy` (`https://tradier-proxy.alexander-s-reed.workers.dev`,
  `X-Live-Token`) for option greeks/delta and live marks; **FMP `/stable`** for
  stock price, ATR(14), and SPY daily history. Keys: browser uses my
  `localStorage` keys (`rrjcar_tradier_proxy_live_token`, `rrjcar_fmp`); the
  Action uses repo **secrets** of the same values.

## 5. Data Model

### `config.json`
```json
{
  "accountBalance": 1000000,
  "riskPct": 0.05,
  "atrStopMult": 1.0,
  "atrEmergencyMult": 3.0,
  "atrRollUpStep": 1.0,
  "rollUpDeltaBand": [0.65, 0.85],
  "rollUpDeltaTarget": 0.75,
  "dteRollTrigger": 7,
  "timeRollMinDelta": 0.60,
  "liquidityMinOI": 500,
  "liquidityMaxSpreadPct": 0.10,
  "timing": {
    "lastHourStartET": "15:00",
    "marketCloseET": "16:00"
  },
  "providers": {
    "optionsGreeks": "tradier",
    "equityPriceAtr": "fmp",
    "spyEma": "fmp"
  }
}
```

**`providers` — pluggable data sources.** Each data need is satisfied through an
adapter (§10a) and can be pointed at `tradier`, `alpaca`, or `fmp`:
- `optionsGreeks` — option chains with greeks (delta) + live option marks.
- `equityPriceAtr` — stock price at a moment + daily bars for ATR(14).
- `spyEma` — SPY daily closes for the 10/20 EMA.

Defaults: **Tradier** for options (only provider that reliably returns greeks +
marks together; already wired via the proxy), **FMP** for equity price/ATR and
SPY (proven ATR-as-of-date logic from position-sizer). Alpaca is selectable for
equities/SPY (free, reliable bars); Tradier can also serve all three if you want
a single key. Switching a provider only swaps the adapter — no rule changes.

### `positions.json` — array of **campaigns**
A *campaign* = one ticker idea and the chain of contract *legs* it rolls through.
The campaign is the unit the scorecard counts as one "trade."

```json
{
  "id": "AAPL-2026-06-19-1",
  "ticker": "AAPL",
  "status": "open",                 // open | closed
  "entryDate": "2026-06-19",
  "entryTimeCST": "09:45",
  "entryStockPrice": 210.50,        // FMP at that moment; editable override
  "atrAtEntry": 4.10,               // ATR(14) as of entry date (FIXED for life)
  "riskBudget": 50000.00,           // = riskPct * accountBalance at entry (5% of 1,000,000)
  "contracts": 169,                 // floor(50000 / (0.72 delta * 4.10 ATR * 100))
  "stopLevel": 206.40,              // entry - 1*ATR  (price anchored at entry)
  "emergencyLevel": 198.20,         // entry - 3*ATR
  "rollUpStepsTaken": 0,            // k: number of +1 ATR roll-ups done
  "legs": [
    {
      "strike": 205, "expiration": "2026-07-18",
      "deltaAtEntry": 0.72, "entryMark": 9.40,
      "exitMark": null, "exitReason": null, "realizedPnl": null,
      "openedOn": "2026-06-19", "closedOn": null
    }
  ],
  "netPnl": null,                   // set when campaign closes
  "exitReason": null                // stop | emergency | regime | dte_close | expiry
}
```

### `history.json`
```json
{
  "events": [
    {"ts":"2026-06-19T14:45Z","campaign":"AAPL-...","type":"open","detail":"..."},
    {"ts":"2026-06-25T15:00Z","campaign":"AAPL-...","type":"roll_up","detail":"205->215, +1 ATR step 1"},
    {"ts":"2026-07-02T16:00Z","campaign":"AAPL-...","type":"close","detail":"stop"}
  ],
  "equity": [
    {"date":"2026-06-19","realized":0,"unrealized":120,"equity":1000120}
  ]
}
```

## 6. Entry Workflow

1. Key in **ticker**, **entry date**, **entry time (CST)**; click **Load chain**.
2. Tool fetches the **stock price at that moment** (FMP 5-min intraday, CST→ET),
   **ATR(14) as of the entry date** (FMP daily), and the **expiration list**
   (`getExpirations`).
3. Pick an expiration → the **call chain** loads (strike, delta, bid/ask/mark, OI,
   spread). Strikes in the **0.65–0.85 band are highlighted** and **illiquid** ones
   (OI<500 or spread>10%) are dimmed/flagged. You **click the strike** you want —
   no keying delta/DTE.
4. Tool **sizes** the position (§8), previews contracts/premium/risk, and offers an
   **editable entry-premium override** (defaults to the contract mark, for backdated
   fills). **Add & track** writes the campaign to `positions.json`.

## 7. Contract Selection (`pickEntryContract`, `pickRollContract`)

- **Entry:** the nearest expiration to the chosen DTE; among its strikes, the one
  whose delta is closest to my chosen delta. Must meet liquidity (OI ≥ 500,
  spread ≤ 10%); if not, step to the adjacent strike/expiration.
- **Winner roll-up target:** one expiration cycle **further out** than the current
  leg; pick the strike with delta closest to **0.75**, constrained to
  **[0.65, 0.85]**, meeting liquidity. If none qualify there, try the next
  expiration out; if still none, hold current leg and flag `roll_skipped_illiquid`.
- **Time-roll target:** nearest expiration **≥ 30 DTE**; pick the strike with
  delta ≥ **0.60** (closest to ~0.70) meeting liquidity. If none, close at 7 DTE.

## 8. Position Sizing (`sizePosition`) — risk-budget model

Reuses the `position-sizer` math. **The 5% is what you lose if the trade reaches
its planned exit (−1 ATR), NOT the cash you put up for the contracts.** You're
risking 5% because −1 ATR is the planned stop.

- **Risk budget** `B = riskPct * accountBalance` — the dollars you intend to lose
  at the planned stop. Default 5% of $1,000,000 = **$50,000**.
- **Planned exit distance** = entry stock price down to `entry − 1*ATR` (the stop).
- **Estimated loss per contract at that stop** = `delta * (1*ATR) * 100` — the
  option's delta-approximated drop when the stock falls 1 ATR. This is the
  "distance from entry to 1 ATR below," expressed in option dollars.
- **Contracts** = `floor( B / (delta * (1*ATR) * 100) )`, min 1 — sized so the
  total estimated loss at the −1 ATR stop equals `B`. The `delta` term is what
  makes "loss at the stop = 5%" true; dropping it would under-risk the position.
- **Premium / capital deployed** = `entryMark * 100 * contracts` — reported for
  reference only; **not** the risk figure. (Your true *max* loss is the full
  premium, but the strategy plans to exit at −1 ATR long before that.)
- **R unit:** `R = B`. Trade return in R = `campaignNetPnl / B`, so a clean −1 ATR
  stop ≈ −1R. The loss estimate ignores gamma/theta/IV; a gap straight through the
  stop (or the −3 ATR emergency) can lose more than `B` — that tail is real and is
  reported in the scorecard, not hidden.

## 9. Exit Engine (`evaluateExits`)

Runs on every snapshot (Action) and live while the tab is open. All price levels
are **anchored at entry** using the **entry-date ATR** (fixed for the campaign's
life — consistent with "ATR as of the purchase date").

**Timing gates.** Only the **emergency** rule acts intraday at any time. Every
other rule (stop, time-roll, winner roll-up, regime) is evaluated **only during
the last hour of regular trading, 15:00–16:00 ET (14:00–15:00 CT)**. So a −1 ATR
intraday dip that recovers before the last hour does **not** stop you out — the
stop only sells if price is still below the level during that window. Each rule
below is tagged `[intraday]` or `[last hour]`.

Per open campaign, **first match wins**:

1. **Regime** `[last hour]` — SPY daily **10-EMA crosses below 20-EMA** (was above
   on the prior bar → fresh bearish cross) ⇒ **close all** open campaigns.
   `exitReason = regime`.
2. **Emergency** `[intraday]` — snapshot stock ≤ `entry − 3*ATR` ⇒ close (any time
   of day). `exitReason = emergency`.
3. **Stop** `[last hour]` — stock ≤ `entry − 1*ATR` **during 15:00–16:00 ET** ⇒
   close. `exitReason = stop`. *(Order 2 before 3: a −3 ATR breach is tagged
   `emergency` even intraday; a last-hour breach between −1 and −3 ATR is `stop`.)*
4. **Time-roll** `[last hour]` — current leg **DTE ≤ 7** ⇒ roll to the time-roll
   target (§7); if no liquid ≥0.60-delta contract exists, **close**.
   `exitReason = dte_close`.
5. **Winner roll-up** `[last hour]` — stock has reached a **new** `entry + k*ATR`
   threshold (k = `rollUpStepsTaken + 1`) ⇒ **roll up and out** to the winner
   target (§7), then `rollUpStepsTaken += 1`. Each additional +1 ATR step rolls
   again.

Outside the last hour, a snapshot evaluates **only** rule 2 (emergency).

**Defensive fallback — `expiry`:** under normal operation the time-roll (rule 4)
closes or rolls every leg by 7 DTE, so expiration is never reached. If the Action
misses runs and a leg slips to its expiration date, it is settled at intrinsic
value (`max(0, stock − strike) * 100 * contracts`) and closed with
`exitReason = expiry`.

### Roll mechanics & accounting
A **roll** closes the current leg at its live mark (realizing that leg's P&L into
the campaign) and opens the new leg at its live mark. The campaign stays **one
trade**. `campaignNetPnl = Σ(realized leg P&L) + (open leg unrealized)`. A
**close** closes the final leg and sets `status=closed`, `netPnl`, `exitReason`.

## 10. Data Sources & Limitations

All three data needs go through the §10a adapter and are provider-selectable in
`config.json`. Defaults:

- **Entry stock price / ATR:** FMP `/stable` (5-min intraday for the entry moment;
  daily history for ATR(14)). Same as position-sizer. (Alpaca/Tradier selectable.)
- **Option delta / live mark:** `tradier-proxy` (greeks). (Alpaca options-data
  selectable where greeks are available on the plan.)
- **SPY EMAs:** FMP SPY daily closes → 10-EMA and 20-EMA. (Alpaca/Tradier selectable.)

### 10a. Provider adapter interface

A thin `dataProvider.js` exposes one interface; each provider (`tradier`,
`alpaca`, `fmp`) implements it. `config.providers` selects which backs each call.

```
getStockPriceAt(symbol, dateET, timeET) -> { price }          // entry-moment fill
getStockQuote(symbol)                   -> { price }          // live underlying
getDailyBars(symbol, fromDate, toDate)  -> [{date,o,h,l,c}]    // ATR(14), SPY EMA
getOptionChain(symbol, expiration)      -> [{strike,bid,ask,mark,delta,oi}]  // greeks (entry)
getOptionQuote(occSymbol)               -> { mark, delta, bid, ask, oi }     // live leg mark
getOptionCandidates(symbol, todayISO)   -> [{strike,expiration,dte,delta,bid,ask,mark,oi}]  // rolls
```

Browser reads keys/tokens from `localStorage`; the Action reads the same values
from repo **secrets**. Adding a provider = adding one file implementing the four
methods; rules and UI are untouched.

**Limitations (accepted):**
- **Backdated entries:** Tradier doesn't serve cheap historical *option* quotes.
  For a trade dated today the entry premium is live; for a past date the entry
  premium is an **editable cell** (stock price & ATR still come from FMP).
- **"Rapid intraday" emergency** is best-effort: with a few snapshots/day it's
  caught at the next snapshot or while the tab is open, not tick-by-tick. Emergency
  uses the **snapshot price only** (per decision), so a spike that reverses between
  snapshots is missed.
- **Snapshot cadence (two-tier):** a light intraday cron (~every 30 min, market
  hours) evaluates **only** the emergency rule; dedicated **last-hour** runs
  (~15:05 and ~15:55 ET) evaluate rolls, the −1 ATR stop, and the regime cross.
  GitHub Action cron timing is best-effort, not to-the-second.

## 11. Scorecard (`scorecard`)

Trade unit = a **closed campaign**. `R = riskBudget` per trade.

- **Win rate** = winning campaigns ÷ closed campaigns.
- **Profit factor** = Σ(winning $) ÷ |Σ(losing $)|.
- **Expectancy (R)** = mean(trade R).
- **Sortino** = mean(trade R) ÷ downside deviation(trade R), MAR = 0 (per-trade;
  optional annualization by trades/yr, noted in UI).
- **Sharpe** = mean(trade R) ÷ stdev(trade R).
- **Max drawdown** = max peak-to-trough on the cumulative-$ equity curve (`history.equity`).
- **Payoff ratio** = avg win $ ÷ avg loss $.
- Supporting: # trades, # open, avg hold days, avg rolls/campaign, largest
  win/loss, total realized P&L, open unrealized P&L, and an **exit-reason
  breakdown** (% by stop / emergency / regime / dte_close / expiry).

## 12. Dashboard UI

Single page, position-sizer styling (no icon glyphs on labels), tabs:

- **Positions** — table of campaigns: ticker, status, entry, current stock vs
  ATR levels (−1/−3 stop & emergency, +k ATR roll ladder), current leg
  (strike/exp/delta/DTE), contracts, mark, unrealized P&L ($ and R), # rolls,
  next-trigger hint. **Add-trade via an option-chain picker** at top (load chain →
  pick expiration → click a strike, with band/liquidity highlighting). Manual
  "Close now" per row.
- **Scorecard** — the §11 metrics + an equity curve and exit-reason breakdown.
- **Settings** — paper-account balance, risk %, thresholds, **provider selection**
  (Tradier/Alpaca/FMP per data type), and the last-hour window (writes
  `config.json`); plus API keys/tokens + GitHub PAT (localStorage only).

## 13. Testing

`node test.js` unit-covers `engine.js`: ATR(14), ATR levels, sizing math,
CST→ET intraday match, entry/roll contract pick, each exit rule's trigger
boundary, the **last-hour timing gates** (emergency fires intraday; stop/rolls/
regime suppressed outside 15:00–16:00 ET; −1 ATR dip-and-recover does not stop
out), roll accounting (realized + unrealized chaining), and every scorecard
metric on a known fixture. Mirrors position-sizer's pure-math test approach.

## 14. Assumptions to confirm at spec review

1. **ATR is fixed at entry** (levels anchored to entry price + entry-date ATR),
   not trailing. (Matches position-sizer "ATR as of purchase date.")
2. **Winner roll-up extends expiration** one cycle each +1 ATR step (the "extra
   expiration out for less theta" from the original dictation), targeting ~0.75
   delta within 0.65–0.85.
3. **Last-hour window = 15:00–16:00 ET (14:00–15:00 CT).** Stop, both rolls, and
   the regime cross act only in this window; only the −3 ATR emergency acts
   intraday. The regime exit therefore closes all positions on the **last-hour
   evaluation of the day the daily cross occurs**, not the instant it forms.
4. **Sortino is per-trade in R** (not daily-return based) as the primary figure.
5. **Default providers:** Tradier (options greeks/marks) + FMP (equity price/ATR
   + SPY EMAs); Alpaca selectable per data type. Switchable any time in config.
