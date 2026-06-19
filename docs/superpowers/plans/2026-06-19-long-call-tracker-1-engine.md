# Long-Call Tracker — Plan 1: Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `engine.js` — the pure, dependency-free math/rules core (ATR, position sizing, contract selection, the exit-rule evaluator with last-hour timing gates, roll/close accounting, and the R-based scorecard) — fully covered by `test.js`.

**Architecture:** One file of pure functions with no I/O, dual-exported for Node (`module.exports`) and browser (`window.Engine`) so the same code runs in `test.js`, the future `snapshot.js` Action, and the future browser `app.js`. Strict TDD: every function gets a failing test in `test.js` first, then the minimal implementation. Data (chains, prices, current time-in-ET, SPY regime flag) is always passed *in*; the engine never fetches.

**Tech Stack:** Vanilla JavaScript (CommonJS export + browser-global fallback), Node 18+ (`node test.js`), zero npm dependencies. Mirrors the `~/position-sizer` pure-math + `node test.js` pattern.

**Reference:** Design spec at `docs/superpowers/specs/2026-06-19-long-call-tracker-design.md` (§7 contract selection, §8 sizing, §9 exit engine, §11 scorecard).

---

## File Structure

- `engine.js` — **Create.** All pure functions. Single IIFE that builds an API object and exports it to both Node and browser. Responsibility: strategy math + rules only.
- `test.js` — **Create.** Minimal no-dependency assertion harness + all engine tests. Run with `node test.js`.
- `config.json` — **Create.** Default configuration object (the §5 spec defaults) consumed by the engine functions.

### `engine.js` public API (locked here for Plans 2–3)

```
computeATR(bars, period)                  -> number            // Wilder ATR(14); bars oldest->newest [{h,l,c}]
atrLevels(entry, atr, cfg)                -> {stop, emergency}
liquidityOK(contract, minOI, maxSpreadPct)-> boolean
sizePosition({budget, delta, atr, entryMark}) -> {contracts, lossPerContract, premium, riskBudget}
isLastHour(etMinutes, cfg)                -> boolean           // etMinutes = ET hour*60+min, supplied by caller
pickEntryContract(chain, opts)            -> contract | null
pickRollContract(candidates, opts)        -> contract | null
evaluateExits(campaign, ctx, cfg)         -> {type:'none'|'close'|'roll', reason?, contract?, newStep?, flag?}
applyAction(campaign, action, ctx)        -> {campaign, events}
computeCampaignPnl(campaign, currentMark) -> number
scorecard(campaigns)                      -> {trades, winRate, profitFactor, expectancyR, sortino, sharpe, maxDrawdown, avgWin, avgLoss, payoffRatio, avgRolls, largestWin, largestLoss, totalPnl, exitReasonBreakdown}
```

---

## Task 1: Scaffold engine, config, and the test harness

**Files:**
- Create: `engine.js`
- Create: `test.js`
- Create: `config.json`

- [ ] **Step 1: Create the empty engine API shell**

Create `engine.js`:

```js
/* Long-Call Tracker — pure strategy engine. No I/O. */
(function (factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.Engine = api;
})(function () {
  'use strict';

  // --- functions are added by later tasks ---

  return {};
});
```

- [ ] **Step 2: Create the test harness**

Create `test.js`:

```js
/* Run: node test.js */
var E = require('./engine.js');
var pass = 0, fail = 0;

function eq(actual, expected, msg) {
  var a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) { pass++; }
  else { fail++; console.error('FAIL: ' + msg + '\n  expected ' + b + '\n  got      ' + a); }
}
function approx(actual, expected, tol, msg) {
  if (typeof actual === 'number' && Math.abs(actual - expected) <= tol) { pass++; }
  else { fail++; console.error('FAIL: ' + msg + '\n  expected ~' + expected + ' got ' + actual); }
}
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('FAIL: ' + msg); } }

// --- test blocks are added by later tasks ---

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
```

- [ ] **Step 3: Create the default config**

Create `config.json`:

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
  "timeRollMinDTE": 30,
  "timeRollDeltaTarget": 0.70,
  "liquidityMinOI": 500,
  "liquidityMaxSpreadPct": 0.10,
  "timing": { "lastHourStartET": "15:00", "marketCloseET": "16:00" },
  "providers": { "optionsGreeks": "tradier", "equityPriceAtr": "fmp", "spyEma": "fmp" }
}
```

- [ ] **Step 4: Run the harness to confirm the toolchain works**

Run: `node test.js`
Expected: prints `0 passed, 0 failed` and exits 0.

- [ ] **Step 5: Commit**

```bash
git add engine.js test.js config.json
git commit -m "scaffold engine, config defaults, and test harness"
```

---

## Task 2: `computeATR` — Wilder ATR(14)

**Files:**
- Modify: `engine.js` (add `computeATR`, export it)
- Modify: `test.js` (add test block)

- [ ] **Step 1: Write the failing test**

In `test.js`, insert before the `console.log(...)` summary line:

```js
// computeATR
(function () {
  var bars = [
    { h: 10, l: 9, c: 9.5 },
    { h: 11, l: 9.5, c: 10.5 },
    { h: 12, l: 10, c: 11.5 },
    { h: 11.5, l: 10.5, c: 11 }
  ];
  // TRs: 1.5, 2, 1 ; period 2 -> seed (1.5+2)/2=1.75 ; then (1.75*1+1)/2=1.375
  approx(E.computeATR(bars, 2), 1.375, 1e-9, 'computeATR wilder period 2');
  ok(isNaN(E.computeATR([{ h: 1, l: 0, c: 0.5 }], 14)), 'computeATR NaN when too few bars');
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test.js`
Expected: FAIL — `E.computeATR is not a function` (harness throws / non-zero exit).

- [ ] **Step 3: Write minimal implementation**

In `engine.js`, add inside the factory (above `return`):

```js
function computeATR(bars, period) {
  period = period || 14;
  if (!bars || bars.length < period + 1) return NaN;
  var trs = [], i;
  for (i = 1; i < bars.length; i++) {
    var h = bars[i].h, l = bars[i].l, pc = bars[i - 1].c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (trs.length < period) return NaN;
  var atr = 0, j;
  for (j = 0; j < period; j++) atr += trs[j];
  atr = atr / period;
  for (var k = period; k < trs.length; k++) atr = (atr * (period - 1) + trs[k]) / period;
  return atr;
}
```

Change the `return {};` line to:

```js
  return { computeATR: computeATR };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test.js`
Expected: `2 passed, 0 failed`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add engine.js test.js
git commit -m "add computeATR (Wilder ATR)"
```

---

## Task 3: `atrLevels` — stop & emergency price levels

**Files:**
- Modify: `engine.js`
- Modify: `test.js`

- [ ] **Step 1: Write the failing test**

Insert before the summary line in `test.js`:

```js
// atrLevels
(function () {
  var cfg = { atrStopMult: 1.0, atrEmergencyMult: 3.0 };
  var lv = E.atrLevels(210.50, 4.10, cfg);
  approx(lv.stop, 206.40, 1e-9, 'atrLevels stop = entry - 1 ATR');
  approx(lv.emergency, 198.20, 1e-9, 'atrLevels emergency = entry - 3 ATR');
  var d = E.atrLevels(100, 2);
  approx(d.stop, 98, 1e-9, 'atrLevels default stop mult 1');
  approx(d.emergency, 94, 1e-9, 'atrLevels default emergency mult 3');
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test.js`
Expected: FAIL — `E.atrLevels is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add in `engine.js`:

```js
function atrLevels(entry, atr, cfg) {
  var sm = (cfg && cfg.atrStopMult) || 1;
  var em = (cfg && cfg.atrEmergencyMult) || 3;
  return { stop: entry - sm * atr, emergency: entry - em * atr };
}
```

Add `atrLevels: atrLevels` to the returned object.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test.js`
Expected: `6 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add engine.js test.js
git commit -m "add atrLevels (stop and emergency levels)"
```

---

## Task 4: `liquidityOK` — OI + spread gate

**Files:**
- Modify: `engine.js`
- Modify: `test.js`

- [ ] **Step 1: Write the failing test**

Insert before the summary line:

```js
// liquidityOK
(function () {
  ok(E.liquidityOK({ oi: 600, bid: 9.3, ask: 9.5 }, 500, 0.10) === true, 'liquidityOK pass tight spread');
  ok(E.liquidityOK({ oi: 100, bid: 9.3, ask: 9.5 }, 500, 0.10) === false, 'liquidityOK fail low OI');
  ok(E.liquidityOK({ oi: 600, bid: 8, ask: 10 }, 500, 0.10) === false, 'liquidityOK fail wide spread');
  ok(E.liquidityOK({ oi: 600, bid: 0, ask: 9.5 }, 500, 0.10) === false, 'liquidityOK fail no bid');
  ok(E.liquidityOK(null, 500, 0.10) === false, 'liquidityOK fail null contract');
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test.js`
Expected: FAIL — `E.liquidityOK is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add in `engine.js`:

```js
function liquidityOK(c, minOI, maxSpreadPct) {
  if (!c) return false;
  if ((c.oi || 0) < minOI) return false;
  var bid = c.bid || 0, ask = c.ask || 0;
  if (bid <= 0 || ask <= 0) return false;
  var mid = (bid + ask) / 2;
  if (mid <= 0) return false;
  return ((ask - bid) / mid) <= maxSpreadPct;
}
```

Add `liquidityOK: liquidityOK` to the returned object.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test.js`
Expected: `11 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add engine.js test.js
git commit -m "add liquidityOK (OI and spread gate)"
```

---

## Task 5: `sizePosition` — risk-budget sizing

Implements spec §8: contracts sized so the estimated loss at the −1 ATR stop equals the risk budget. `lossPerContract = delta * atr * 100`.

**Files:**
- Modify: `engine.js`
- Modify: `test.js`

- [ ] **Step 1: Write the failing test**

Insert before the summary line:

```js
// sizePosition
(function () {
  var r = E.sizePosition({ budget: 50000, delta: 0.72, atr: 4.10, entryMark: 9.40 });
  approx(r.lossPerContract, 295.2, 1e-6, 'sizePosition loss per contract = delta*atr*100');
  eq(r.contracts, 169, 'sizePosition contracts = floor(50000/295.2)');
  approx(r.premium, 158860, 1e-6, 'sizePosition premium = mark*100*contracts');
  eq(r.riskBudget, 50000, 'sizePosition echoes risk budget');
  eq(E.sizePosition({ budget: 100, delta: 0.9, atr: 5, entryMark: 1 }).contracts, 1, 'sizePosition floors to min 1 contract');
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test.js`
Expected: FAIL — `E.sizePosition is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add in `engine.js`:

```js
function sizePosition(p) {
  var lossPerContract = p.delta * p.atr * 100;
  var contracts = Math.max(1, Math.floor(p.budget / lossPerContract));
  return {
    contracts: contracts,
    lossPerContract: lossPerContract,
    premium: (p.entryMark || 0) * 100 * contracts,
    riskBudget: p.budget
  };
}
```

Add `sizePosition: sizePosition` to the returned object.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test.js`
Expected: `16 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add engine.js test.js
git commit -m "add sizePosition (risk-budget delta-adjusted sizing)"
```

---

## Task 6: `isLastHour` — ET last-hour timing gate

`etMinutes` = ET hour*60 + minute, computed by the caller (snapshot/app convert local/UTC to ET).

**Files:**
- Modify: `engine.js`
- Modify: `test.js`

- [ ] **Step 1: Write the failing test**

Insert before the summary line:

```js
// isLastHour
(function () {
  var cfg = { timing: { lastHourStartET: '15:00', marketCloseET: '16:00' } };
  ok(E.isLastHour(15 * 60, cfg) === true, 'isLastHour true at 15:00');
  ok(E.isLastHour(15 * 60 + 59, cfg) === true, 'isLastHour true at 15:59');
  ok(E.isLastHour(16 * 60, cfg) === false, 'isLastHour false at 16:00');
  ok(E.isLastHour(14 * 60 + 59, cfg) === false, 'isLastHour false at 14:59');
  ok(E.isLastHour(15 * 60) === true, 'isLastHour uses 15:00-16:00 defaults');
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test.js`
Expected: FAIL — `E.isLastHour is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add in `engine.js`:

```js
function parseHM(s) { var p = (s || '').split(':'); return (+p[0]) * 60 + (+p[1] || 0); }
function isLastHour(etMinutes, cfg) {
  var t = (cfg && cfg.timing) || {};
  var start = parseHM(t.lastHourStartET || '15:00');
  var close = parseHM(t.marketCloseET || '16:00');
  return etMinutes >= start && etMinutes < close;
}
```

Add `isLastHour: isLastHour` to the returned object. (`parseHM` stays private — not exported.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node test.js`
Expected: `21 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add engine.js test.js
git commit -m "add isLastHour (ET last-hour timing gate)"
```

---

## Task 7: `pickEntryContract` — closest-delta liquid contract

**Files:**
- Modify: `engine.js`
- Modify: `test.js`

- [ ] **Step 1: Write the failing test**

Insert before the summary line:

```js
// pickEntryContract
(function () {
  var chain = [
    { strike: 200, delta: 0.85, oi: 600, bid: 13.0, ask: 13.2 },
    { strike: 205, delta: 0.72, oi: 600, bid: 9.3, ask: 9.5 },
    { strike: 210, delta: 0.60, oi: 600, bid: 6.0, ask: 6.2 },
    { strike: 207, delta: 0.68, oi: 100, bid: 7.0, ask: 7.2 }  // illiquid, ignored
  ];
  var c = E.pickEntryContract(chain, { targetDelta: 0.70, minOI: 500, maxSpreadPct: 0.10 });
  eq(c.strike, 205, 'pickEntryContract picks closest delta to 0.70 among liquid');
  ok(E.pickEntryContract([], { targetDelta: 0.7, minOI: 500, maxSpreadPct: 0.1 }) === null, 'pickEntryContract null on empty chain');
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test.js`
Expected: FAIL — `E.pickEntryContract is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add in `engine.js`:

```js
function pickEntryContract(chain, opts) {
  var best = null, bestDiff = Infinity, i;
  for (i = 0; i < (chain || []).length; i++) {
    var c = chain[i];
    if (!liquidityOK(c, opts.minOI, opts.maxSpreadPct)) continue;
    if (c.delta == null || isNaN(c.delta)) continue;
    var diff = Math.abs(c.delta - opts.targetDelta);
    if (diff < bestDiff) { bestDiff = diff; best = c; }
  }
  return best;
}
```

Add `pickEntryContract: pickEntryContract` to the returned object.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test.js`
Expected: `23 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add engine.js test.js
git commit -m "add pickEntryContract (closest-delta liquid pick)"
```

---

## Task 8: `pickRollContract` — winner (`up`) and time (`time`) roll targets

Spec §7. `up`: delta in `deltaBand`, closest to `deltaTarget`, nearest expiration that is further out than the current leg. `time`: delta ≥ `minDelta`, dte ≥ `minDTE`, nearest qualifying expiration. Both require `dte > afterDTE` (must roll further out) and liquidity.

**Files:**
- Modify: `engine.js`
- Modify: `test.js`

- [ ] **Step 1: Write the failing test**

Insert before the summary line:

```js
// pickRollContract
(function () {
  var cands = [
    { strike: 215, expiration: '2026-08-21', dte: 35, delta: 0.74, oi: 800, bid: 8.0, ask: 8.2 },
    { strike: 220, expiration: '2026-08-21', dte: 35, delta: 0.66, oi: 800, bid: 6.0, ask: 6.2 },
    { strike: 215, expiration: '2026-09-18', dte: 63, delta: 0.78, oi: 800, bid: 9.0, ask: 9.2 },
    { strike: 230, expiration: '2026-08-21', dte: 35, delta: 0.50, oi: 800, bid: 3.0, ask: 3.2 } // out of band
  ];
  var up = E.pickRollContract(cands, { mode: 'up', deltaBand: [0.65, 0.85], deltaTarget: 0.75, afterDTE: 20, minOI: 500, maxSpreadPct: 0.10 });
  eq([up.expiration, up.strike], ['2026-08-21', 215], 'roll up: nearest further expiration, delta closest to 0.75 in band');

  var time = E.pickRollContract(cands, { mode: 'time', minDelta: 0.60, minDTE: 30, deltaTarget: 0.70, afterDTE: 7, minOI: 500, maxSpreadPct: 0.10 });
  eq([time.expiration, time.strike], ['2026-08-21', 215], 'roll time: nearest exp >=30 DTE, delta closest to 0.70 among >=0.60');

  var none = E.pickRollContract([{ strike: 215, expiration: '2026-08-21', dte: 35, delta: 0.40, oi: 800, bid: 8, ask: 8.2 }],
    { mode: 'time', minDelta: 0.60, minDTE: 30, deltaTarget: 0.70, afterDTE: 7, minOI: 500, maxSpreadPct: 0.10 });
  ok(none === null, 'roll returns null when nothing qualifies');
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test.js`
Expected: FAIL — `E.pickRollContract is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add in `engine.js`:

```js
function pickRollContract(candidates, opts) {
  var pool = [], i;
  for (i = 0; i < (candidates || []).length; i++) {
    var c = candidates[i];
    if (!liquidityOK(c, opts.minOI, opts.maxSpreadPct)) continue;
    if (c.delta == null || isNaN(c.delta)) continue;
    if (opts.afterDTE != null && c.dte <= opts.afterDTE) continue;
    if (opts.mode === 'up') {
      if (c.delta < opts.deltaBand[0] || c.delta > opts.deltaBand[1]) continue;
    } else {
      if (c.delta < opts.minDelta) continue;
      if (c.dte < opts.minDTE) continue;
    }
    pool.push(c);
  }
  if (!pool.length) return null;
  pool.sort(function (a, b) {
    if (a.dte !== b.dte) return a.dte - b.dte;
    return Math.abs(a.delta - opts.deltaTarget) - Math.abs(b.delta - opts.deltaTarget);
  });
  return pool[0];
}
```

Add `pickRollContract: pickRollContract` to the returned object.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test.js`
Expected: `26 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add engine.js test.js
git commit -m "add pickRollContract (winner and time roll targets)"
```

---

## Task 9: `evaluateExits` — the precedence + timing-gated decision

Spec §9. Returns a decision only; `applyAction` (Task 10) mutates state. Precedence: regime (last hour) → emergency (intraday) → stop (last hour) → time-roll (last hour) → winner roll-up (last hour). Outside the last hour only emergency can fire.

**Files:**
- Modify: `engine.js`
- Modify: `test.js`

- [ ] **Step 1: Write the failing test**

Insert before the summary line:

```js
// evaluateExits
(function () {
  var cfg = {
    atrStopMult: 1, atrEmergencyMult: 3, dteRollTrigger: 7,
    timeRollMinDelta: 0.60, timeRollMinDTE: 30, timeRollDeltaTarget: 0.70,
    rollUpDeltaBand: [0.65, 0.85], rollUpDeltaTarget: 0.75,
    liquidityMinOI: 500, liquidityMaxSpreadPct: 0.10,
    timing: { lastHourStartET: '15:00', marketCloseET: '16:00' }
  };
  var camp = { entryStockPrice: 210.50, atrAtEntry: 4.10, rollUpStepsTaken: 0 };
  var rollCands = [{ strike: 215, expiration: '2026-08-21', dte: 35, delta: 0.74, oi: 800, bid: 8, ask: 8.1 }];
  var noon = 12 * 60, last = 15 * 60 + 30;

  // emergency fires intraday (any time)
  eq(E.evaluateExits(camp, { stockPrice: 197, etMinutes: noon, spyRegimeCross: false, currentDTE: 40, rollCandidates: [] }, cfg),
     { type: 'close', reason: 'emergency' }, 'emergency closes intraday at <= -3 ATR');

  // stop suppressed outside last hour (dip-and-recover protection)
  eq(E.evaluateExits(camp, { stockPrice: 205, etMinutes: noon, spyRegimeCross: false, currentDTE: 40, rollCandidates: [] }, cfg),
     { type: 'none' }, 'stop suppressed outside last hour');

  // stop fires in last hour
  eq(E.evaluateExits(camp, { stockPrice: 205, etMinutes: last, spyRegimeCross: false, currentDTE: 40, rollCandidates: [] }, cfg),
     { type: 'close', reason: 'stop' }, 'stop closes in last hour at <= -1 ATR');

  // regime suppressed outside last hour
  eq(E.evaluateExits(camp, { stockPrice: 211, etMinutes: noon, spyRegimeCross: true, currentDTE: 40, rollCandidates: [] }, cfg),
     { type: 'none' }, 'regime suppressed outside last hour');

  // regime closes in last hour, before emergency precedence
  eq(E.evaluateExits(camp, { stockPrice: 211, etMinutes: last, spyRegimeCross: true, currentDTE: 40, rollCandidates: [] }, cfg),
     { type: 'close', reason: 'regime' }, 'regime closes all in last hour');

  // time-roll in last hour with a liquid candidate
  var tr = E.evaluateExits(camp, { stockPrice: 211, etMinutes: last, spyRegimeCross: false, currentDTE: 5, rollCandidates: rollCands }, cfg);
  eq([tr.type, tr.reason, tr.contract.strike], ['roll', 'dte_roll', 215], 'time-roll rolls at <=7 DTE when liquid');

  // time-roll closes when no liquid candidate
  eq(E.evaluateExits(camp, { stockPrice: 211, etMinutes: last, spyRegimeCross: false, currentDTE: 5, rollCandidates: [] }, cfg),
     { type: 'close', reason: 'dte_close' }, 'time-roll closes when illiquid');

  // winner roll-up at +1 ATR step in last hour
  var ru = E.evaluateExits(camp, { stockPrice: 214.7, etMinutes: last, spyRegimeCross: false, currentDTE: 40, rollCandidates: rollCands }, cfg);
  eq([ru.type, ru.reason, ru.newStep, ru.contract.strike], ['roll', 'roll_up', 1, 215], 'winner roll-up at +1 ATR');

  // winner roll-up suppressed outside last hour
  eq(E.evaluateExits(camp, { stockPrice: 214.7, etMinutes: noon, spyRegimeCross: false, currentDTE: 40, rollCandidates: rollCands }, cfg),
     { type: 'none' }, 'winner roll-up suppressed outside last hour');

  // nothing triggers
  eq(E.evaluateExits(camp, { stockPrice: 211, etMinutes: last, spyRegimeCross: false, currentDTE: 40, rollCandidates: rollCands }, cfg),
     { type: 'none' }, 'no exit when nothing triggers');
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test.js`
Expected: FAIL — `E.evaluateExits is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add in `engine.js`:

```js
function evaluateExits(campaign, ctx, cfg) {
  var lv = atrLevels(campaign.entryStockPrice, campaign.atrAtEntry, cfg);
  var last = isLastHour(ctx.etMinutes, cfg);

  // Rule 1: regime (last hour only; precedence above emergency)
  if (last && ctx.spyRegimeCross) return { type: 'close', reason: 'regime' };

  // Rule 2: emergency (intraday, any time)
  if (ctx.stockPrice <= lv.emergency) return { type: 'close', reason: 'emergency' };

  if (last) {
    // Rule 3: stop
    if (ctx.stockPrice <= lv.stop) return { type: 'close', reason: 'stop' };

    // Rule 4: time-roll
    if (ctx.currentDTE <= cfg.dteRollTrigger) {
      var rollT = pickRollContract(ctx.rollCandidates, {
        mode: 'time',
        minDelta: cfg.timeRollMinDelta,
        minDTE: cfg.timeRollMinDTE || 30,
        deltaTarget: cfg.timeRollDeltaTarget || 0.70,
        afterDTE: ctx.currentDTE,
        minOI: cfg.liquidityMinOI,
        maxSpreadPct: cfg.liquidityMaxSpreadPct
      });
      if (rollT) return { type: 'roll', reason: 'dte_roll', contract: rollT };
      return { type: 'close', reason: 'dte_close' };
    }

    // Rule 5: winner roll-up at each new +1 ATR step
    var k = (campaign.rollUpStepsTaken || 0) + 1;
    if (ctx.stockPrice >= campaign.entryStockPrice + k * campaign.atrAtEntry) {
      var rollU = pickRollContract(ctx.rollCandidates, {
        mode: 'up',
        deltaBand: cfg.rollUpDeltaBand,
        deltaTarget: cfg.rollUpDeltaTarget,
        afterDTE: ctx.currentDTE,
        minOI: cfg.liquidityMinOI,
        maxSpreadPct: cfg.liquidityMaxSpreadPct
      });
      if (rollU) return { type: 'roll', reason: 'roll_up', contract: rollU, newStep: k };
      return { type: 'none', flag: 'roll_skipped_illiquid' };
    }
  }
  return { type: 'none' };
}
```

Add `evaluateExits: evaluateExits` to the returned object.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test.js`
Expected: `36 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add engine.js test.js
git commit -m "add evaluateExits (precedence + last-hour timing gates)"
```

---

## Task 10: `applyAction` + `computeCampaignPnl` — roll/close accounting

Applies a decision to a campaign without mutating the input (deep-cloned). A roll closes the open leg at the current mark (realizing its P&L) and opens the new leg; a close finalizes the campaign. `computeCampaignPnl` sums realized legs plus the open leg's unrealized.

**Files:**
- Modify: `engine.js`
- Modify: `test.js`

- [ ] **Step 1: Write the failing test**

Insert before the summary line:

```js
// computeCampaignPnl + applyAction
(function () {
  var base = {
    id: 'AAPL-1', ticker: 'AAPL', status: 'open', contracts: 10,
    entryStockPrice: 210.50, atrAtEntry: 4.10, rollUpStepsTaken: 0,
    legs: [{ strike: 205, expiration: '2026-07-18', deltaAtEntry: 0.72, entryMark: 9.40,
             exitMark: null, exitReason: null, realizedPnl: null, openedOn: '2026-06-19', closedOn: null }]
  };

  // open campaign unrealized: (11.40 - 9.40) * 100 * 10 = 2000
  approx(E.computeCampaignPnl(base, 11.40), 2000, 1e-6, 'computeCampaignPnl open uses current mark');

  // close
  var closed = E.applyAction(base, { type: 'close', reason: 'stop' }, { currentMark: 7.40, today: '2026-07-02' });
  eq(closed.campaign.status, 'closed', 'applyAction close sets status');
  eq(closed.campaign.exitReason, 'stop', 'applyAction close sets exitReason');
  approx(closed.campaign.netPnl, -2000, 1e-6, 'applyAction close netPnl = (7.40-9.40)*100*10');
  approx(closed.campaign.legs[0].realizedPnl, -2000, 1e-6, 'applyAction close realizes leg');
  eq(base.status, 'open', 'applyAction does not mutate input campaign');

  // roll_up: realize old leg at 12.40 -> (12.40-9.40)*100*10 = 3000; open new leg; step -> 1
  var rolled = E.applyAction(base, {
    type: 'roll', reason: 'roll_up', newStep: 1,
    contract: { strike: 215, expiration: '2026-08-21', delta: 0.74, mark: 8.00 }
  }, { currentMark: 12.40, today: '2026-06-26' });
  approx(rolled.campaign.legs[0].realizedPnl, 3000, 1e-6, 'roll realizes closed leg');
  eq(rolled.campaign.legs.length, 2, 'roll opens a new leg');
  eq(rolled.campaign.legs[1].entryMark, 8.00, 'roll new leg uses contract mark');
  eq(rolled.campaign.rollUpStepsTaken, 1, 'roll_up increments step');
  eq(rolled.campaign.status, 'open', 'roll keeps campaign open');
  // after roll, total with new leg at 9.00: realized 3000 + (9.00-8.00)*100*10 = 4000
  approx(E.computeCampaignPnl(rolled.campaign, 9.00), 4000, 1e-6, 'computeCampaignPnl sums realized + open leg');
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test.js`
Expected: FAIL — `E.computeCampaignPnl is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add in `engine.js`:

```js
function computeCampaignPnl(camp, currentMark) {
  var realized = 0, i;
  for (i = 0; i < camp.legs.length; i++) {
    if (camp.legs[i].realizedPnl != null) realized += camp.legs[i].realizedPnl;
  }
  if (camp.status === 'open' && currentMark != null) {
    var open = camp.legs[camp.legs.length - 1];
    realized += (currentMark - open.entryMark) * 100 * camp.contracts;
  }
  return realized;
}

function applyAction(campaign, action, ctx) {
  var camp = JSON.parse(JSON.stringify(campaign));
  var events = [];
  var openLeg = camp.legs[camp.legs.length - 1];

  if (action.type === 'close') {
    openLeg.exitMark = ctx.currentMark;
    openLeg.exitReason = action.reason;
    openLeg.closedOn = ctx.today;
    openLeg.realizedPnl = (ctx.currentMark - openLeg.entryMark) * 100 * camp.contracts;
    camp.status = 'closed';
    camp.exitReason = action.reason;
    camp.netPnl = computeCampaignPnl(camp, null);
    events.push({ campaign: camp.id, type: 'close', detail: action.reason, ts: ctx.today });
  } else if (action.type === 'roll') {
    openLeg.exitMark = ctx.currentMark;
    openLeg.exitReason = 'roll:' + action.reason;
    openLeg.closedOn = ctx.today;
    openLeg.realizedPnl = (ctx.currentMark - openLeg.entryMark) * 100 * camp.contracts;
    camp.legs.push({
      strike: action.contract.strike, expiration: action.contract.expiration,
      deltaAtEntry: action.contract.delta, entryMark: action.contract.mark,
      exitMark: null, exitReason: null, realizedPnl: null, openedOn: ctx.today, closedOn: null
    });
    if (action.reason === 'roll_up' && action.newStep != null) camp.rollUpStepsTaken = action.newStep;
    events.push({ campaign: camp.id, type: action.reason, detail: openLeg.strike + '->' + action.contract.strike, ts: ctx.today });
  }
  return { campaign: camp, events: events };
}
```

Add `computeCampaignPnl: computeCampaignPnl` and `applyAction: applyAction` to the returned object.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test.js`
Expected: `48 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add engine.js test.js
git commit -m "add applyAction + computeCampaignPnl (roll/close accounting)"
```

---

## Task 11: `scorecard` — R-based strategy metrics

Spec §11. Operates on **closed** campaigns (each with `netPnl`, `riskBudget`, `exitReason`, `legs`). Cumulative P&L for drawdown is taken in input order (close order). R = `netPnl / riskBudget`. Sortino uses downside deviation with MAR = 0.

**Files:**
- Modify: `engine.js`
- Modify: `test.js`

- [ ] **Step 1: Write the failing test**

Insert before the summary line:

```js
// scorecard
(function () {
  // 4 closed campaigns, riskBudget 1000 each. pnls: +2000, -1000, +500, -1500
  var camps = [
    { status: 'closed', netPnl: 2000, riskBudget: 1000, exitReason: 'roll_up_chain', legs: [{}, {}] },
    { status: 'closed', netPnl: -1000, riskBudget: 1000, exitReason: 'stop', legs: [{}] },
    { status: 'closed', netPnl: 500, riskBudget: 1000, exitReason: 'dte_close', legs: [{}] },
    { status: 'closed', netPnl: -1500, riskBudget: 1000, exitReason: 'stop', legs: [{}] }
  ];
  var s = E.scorecard(camps);
  eq(s.trades, 4, 'scorecard trade count');
  approx(s.winRate, 0.5, 1e-9, 'scorecard win rate 2/4');
  approx(s.profitFactor, 1.0, 1e-9, 'scorecard profit factor 2500/2500');
  approx(s.totalPnl, 0, 1e-9, 'scorecard total pnl');
  // R series: 2, -1, 0.5, -1.5 ; mean = 0 ; expectancyR 0
  approx(s.expectancyR, 0, 1e-9, 'scorecard expectancy R');
  // cumulative: 2000, 1000, 1500, 0 ; peak 2000 -> trough 0 => mdd 2000
  approx(s.maxDrawdown, 2000, 1e-9, 'scorecard max drawdown');
  approx(s.avgWin, 1250, 1e-9, 'scorecard avg win (2000+500)/2');
  approx(s.avgLoss, -1250, 1e-9, 'scorecard avg loss (-1000-1500)/2');
  approx(s.payoffRatio, 1.0, 1e-9, 'scorecard payoff ratio');
  approx(s.avgRolls, 0.25, 1e-9, 'scorecard avg rolls (one campaign has 2 legs)');
  eq(s.exitReasonBreakdown.stop, 2, 'scorecard exit-reason breakdown counts stops');
  // downside dev of [2,-1,0.5,-1.5] with MAR 0: negatives -1,-1.5 -> mean(0,1,0,2.25)=0.8125 -> sqrt=0.9013878
  approx(s.sortino, 0 / 0.9013878, 1e-6, 'scorecard sortino = meanR / downsideDev');
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test.js`
Expected: FAIL — `E.scorecard is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add in `engine.js`:

```js
function _mean(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : 0; }
function _std(a) {
  if (a.length < 2) return 0;
  var m = _mean(a);
  return Math.sqrt(a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / (a.length - 1));
}
function _downsideDev(a, mar) {
  var d = a.map(function (x) { var e = Math.min(0, x - mar); return e * e; });
  return Math.sqrt(_mean(d));
}
function scorecard(campaigns) {
  var closed = (campaigns || []).filter(function (c) { return c.status === 'closed'; });
  var n = closed.length;
  var pnls = closed.map(function (c) { return c.netPnl; });
  var Rs = closed.map(function (c) { return c.riskBudget ? c.netPnl / c.riskBudget : 0; });
  var wins = pnls.filter(function (x) { return x > 0; });
  var losses = pnls.filter(function (x) { return x < 0; });
  var grossWin = wins.reduce(function (s, x) { return s + x; }, 0);
  var grossLoss = Math.abs(losses.reduce(function (s, x) { return s + x; }, 0));

  var cum = 0, peak = 0, mdd = 0, i;
  for (i = 0; i < pnls.length; i++) {
    cum += pnls[i];
    if (cum > peak) peak = cum;
    if (peak - cum > mdd) mdd = peak - cum;
  }

  var reasons = {};
  closed.forEach(function (c) { reasons[c.exitReason] = (reasons[c.exitReason] || 0) + 1; });

  var dd = _downsideDev(Rs, 0), sd = _std(Rs);
  return {
    trades: n,
    winRate: n ? wins.length / n : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    expectancyR: _mean(Rs),
    sortino: dd > 0 ? _mean(Rs) / dd : 0,
    sharpe: sd > 0 ? _mean(Rs) / sd : 0,
    maxDrawdown: mdd,
    avgWin: wins.length ? _mean(wins) : 0,
    avgLoss: losses.length ? _mean(losses) : 0,
    payoffRatio: (wins.length && losses.length) ? _mean(wins) / Math.abs(_mean(losses)) : 0,
    avgRolls: n ? _mean(closed.map(function (c) { return c.legs.length - 1; })) : 0,
    largestWin: wins.length ? Math.max.apply(null, wins) : 0,
    largestLoss: losses.length ? Math.min.apply(null, losses) : 0,
    totalPnl: pnls.reduce(function (s, x) { return s + x; }, 0),
    exitReasonBreakdown: reasons
  };
}
```

Add `scorecard: scorecard` to the returned object. (`_mean`, `_std`, `_downsideDev` stay private.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node test.js`
Expected: `60 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add engine.js test.js
git commit -m "add scorecard (R-based strategy metrics)"
```

---

## Task 12: README for the engine

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write the README**

Create `README.md`:

```markdown
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
```

- [ ] **Step 2: Verify tests still pass**

Run: `node test.js`
Expected: `60 passed, 0 failed`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "add README for engine (Plan 1)"
```

---

## Self-Review (completed by plan author)

**Spec coverage (Plan 1 scope = engine only):**
- §7 contract selection → Tasks 7, 8 (`pickEntryContract`, `pickRollContract`). ✓
- §8 risk-budget sizing → Task 5 (`sizePosition`). ✓
- §9 exit engine precedence + last-hour gates → Task 9 (`evaluateExits`); roll/close accounting → Task 10. ✓
- §11 scorecard metrics → Task 11 (`scorecard`). ✓
- ATR(14) as-of-entry → Task 2 (`computeATR`). ✓
- Deferred to later plans (correctly out of scope here): data adapters, snapshot CLI, GitHub Action (Plan 2); UI, GitHub PAT sync, live polling, equity-curve persistence (Plan 3). The `expiry` defensive-fallback exit reason (spec §9) is produced by the snapshot/UI layer when a leg reaches expiration, not by `evaluateExits`; noted for Plan 2.

**Placeholder scan:** No TBD/TODO; every code and test step contains complete code and exact expected output. ✓

**Type consistency:** Function names and shapes match the locked API table and are used identically across tasks — `evaluateExits` returns `{type, reason, contract, newStep, flag}`; `applyAction` consumes that exact shape and returns `{campaign, events}`; `scorecard` consumes campaigns with `{status, netPnl, riskBudget, exitReason, legs}` as produced by `applyAction`. Running test-pass counts are cumulative and consistent (2, 6, 11, 16, 21, 23, 26, 36, 48, 60). ✓
