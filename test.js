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

// computeATR
(function () {
  var bars = [
    { h: 10, l: 9, c: 9.5 },
    { h: 11, l: 9.5, c: 10.5 },
    { h: 12, l: 10, c: 11.5 },
    { h: 11.5, l: 10.5, c: 11 }
  ];
  approx(E.computeATR(bars, 2), 1.375, 1e-9, 'computeATR wilder period 2');
  ok(isNaN(E.computeATR([{ h: 1, l: 0, c: 0.5 }], 14)), 'computeATR NaN when too few bars');
})();

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

// liquidityOK
(function () {
  ok(E.liquidityOK({ oi: 600, bid: 9.3, ask: 9.5 }, 500, 0.10) === true, 'liquidityOK pass tight spread');
  ok(E.liquidityOK({ oi: 100, bid: 9.3, ask: 9.5 }, 500, 0.10) === false, 'liquidityOK fail low OI');
  ok(E.liquidityOK({ oi: 600, bid: 8, ask: 10 }, 500, 0.10) === false, 'liquidityOK fail wide spread');
  ok(E.liquidityOK({ oi: 600, bid: 0, ask: 9.5 }, 500, 0.10) === false, 'liquidityOK fail no bid');
  ok(E.liquidityOK(null, 500, 0.10) === false, 'liquidityOK fail null contract');
})();

// sizePosition
(function () {
  var r = E.sizePosition({ budget: 50000, delta: 0.72, atr: 4.10, entryMark: 9.40 });
  approx(r.lossPerContract, 295.2, 1e-6, 'sizePosition loss per contract = delta*atr*100');
  eq(r.contracts, 169, 'sizePosition contracts = floor(50000/295.2)');
  approx(r.premium, 158860, 1e-6, 'sizePosition premium = mark*100*contracts');
  eq(r.riskBudget, 50000, 'sizePosition echoes risk budget');
  eq(E.sizePosition({ budget: 100, delta: 0.9, atr: 5, entryMark: 1 }).contracts, 1, 'sizePosition floors to min 1 contract');
})();

// isLastHour
(function () {
  var cfg = { timing: { lastHourStartET: '15:00', marketCloseET: '16:00' } };
  ok(E.isLastHour(15 * 60, cfg) === true, 'isLastHour true at 15:00');
  ok(E.isLastHour(15 * 60 + 59, cfg) === true, 'isLastHour true at 15:59');
  ok(E.isLastHour(16 * 60, cfg) === false, 'isLastHour false at 16:00');
  ok(E.isLastHour(14 * 60 + 59, cfg) === false, 'isLastHour false at 14:59');
  ok(E.isLastHour(15 * 60) === true, 'isLastHour uses 15:00-16:00 defaults');
})();

// pickEntryContract
(function () {
  var chain = [
    { strike: 200, delta: 0.85, oi: 600, bid: 13.0, ask: 13.2 },
    { strike: 205, delta: 0.72, oi: 600, bid: 9.3, ask: 9.5 },
    { strike: 210, delta: 0.60, oi: 600, bid: 6.0, ask: 6.2 },
    { strike: 207, delta: 0.68, oi: 100, bid: 7.0, ask: 7.2 }
  ];
  var c = E.pickEntryContract(chain, { targetDelta: 0.70, minOI: 500, maxSpreadPct: 0.10 });
  eq(c.strike, 205, 'pickEntryContract picks closest delta to 0.70 among liquid');
  ok(E.pickEntryContract([], { targetDelta: 0.7, minOI: 500, maxSpreadPct: 0.1 }) === null, 'pickEntryContract null on empty chain');
})();

// pickRollContract
(function () {
  var cands = [
    { strike: 215, expiration: '2026-08-21', dte: 35, delta: 0.72, oi: 800, bid: 8.0, ask: 8.2 },
    { strike: 220, expiration: '2026-08-21', dte: 35, delta: 0.66, oi: 800, bid: 6.0, ask: 6.2 },
    { strike: 215, expiration: '2026-09-18', dte: 63, delta: 0.78, oi: 800, bid: 9.0, ask: 9.2 },
    { strike: 230, expiration: '2026-08-21', dte: 35, delta: 0.50, oi: 800, bid: 3.0, ask: 3.2 }
  ];
  var up = E.pickRollContract(cands, { mode: 'up', deltaBand: [0.65, 0.85], deltaTarget: 0.75, afterDTE: 20, minOI: 500, maxSpreadPct: 0.10 });
  eq([up.expiration, up.strike], ['2026-08-21', 215], 'roll up: nearest further expiration, delta closest to 0.75 in band');

  var time = E.pickRollContract(cands, { mode: 'time', minDelta: 0.60, minDTE: 30, deltaTarget: 0.70, afterDTE: 7, minOI: 500, maxSpreadPct: 0.10 });
  eq([time.expiration, time.strike], ['2026-08-21', 215], 'roll time: nearest exp >=30 DTE, delta closest to 0.70 among >=0.60');

  var none = E.pickRollContract([{ strike: 215, expiration: '2026-08-21', dte: 35, delta: 0.40, oi: 800, bid: 8, ask: 8.2 }],
    { mode: 'time', minDelta: 0.60, minDTE: 30, deltaTarget: 0.70, afterDTE: 7, minOI: 500, maxSpreadPct: 0.10 });
  ok(none === null, 'roll returns null when nothing qualifies');
})();

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
  var rollCands = [{ strike: 215, expiration: '2026-08-21', dte: 70, delta: 0.74, oi: 800, bid: 8, ask: 8.1 }];
  var noon = 12 * 60, last = 15 * 60 + 30;

  eq(E.evaluateExits(camp, { stockPrice: 197, etMinutes: noon, spyRegimeCross: false, currentDTE: 40, rollCandidates: [] }, cfg),
     { type: 'close', reason: 'emergency' }, 'emergency closes intraday at <= -3 ATR');

  eq(E.evaluateExits(camp, { stockPrice: 205, etMinutes: noon, spyRegimeCross: false, currentDTE: 40, rollCandidates: [] }, cfg),
     { type: 'none' }, 'stop suppressed outside last hour');

  eq(E.evaluateExits(camp, { stockPrice: 205, etMinutes: last, spyRegimeCross: false, currentDTE: 40, rollCandidates: [] }, cfg),
     { type: 'close', reason: 'stop' }, 'stop closes in last hour at <= -1 ATR');

  eq(E.evaluateExits(camp, { stockPrice: 211, etMinutes: noon, spyRegimeCross: true, currentDTE: 40, rollCandidates: [] }, cfg),
     { type: 'none' }, 'regime suppressed outside last hour');

  eq(E.evaluateExits(camp, { stockPrice: 211, etMinutes: last, spyRegimeCross: true, currentDTE: 40, rollCandidates: [] }, cfg),
     { type: 'close', reason: 'regime' }, 'regime closes all in last hour');

  var tr = E.evaluateExits(camp, { stockPrice: 211, etMinutes: last, spyRegimeCross: false, currentDTE: 5, rollCandidates: rollCands }, cfg);
  eq([tr.type, tr.reason, tr.contract.strike], ['roll', 'dte_roll', 215], 'time-roll rolls at <=7 DTE when liquid');

  eq(E.evaluateExits(camp, { stockPrice: 211, etMinutes: last, spyRegimeCross: false, currentDTE: 5, rollCandidates: [] }, cfg),
     { type: 'close', reason: 'dte_close' }, 'time-roll closes when illiquid');

  var ru = E.evaluateExits(camp, { stockPrice: 214.7, etMinutes: last, spyRegimeCross: false, currentDTE: 40, rollCandidates: rollCands }, cfg);
  eq([ru.type, ru.reason, ru.newStep, ru.contract.strike], ['roll', 'roll_up', 1, 215], 'winner roll-up at +1 ATR');

  eq(E.evaluateExits(camp, { stockPrice: 214.7, etMinutes: noon, spyRegimeCross: false, currentDTE: 40, rollCandidates: rollCands }, cfg),
     { type: 'none' }, 'winner roll-up suppressed outside last hour');

  eq(E.evaluateExits(camp, { stockPrice: 211, etMinutes: last, spyRegimeCross: false, currentDTE: 40, rollCandidates: rollCands }, cfg),
     { type: 'none' }, 'no exit when nothing triggers');
})();

// computeCampaignPnl + applyAction
(function () {
  var base = {
    id: 'AAPL-1', ticker: 'AAPL', status: 'open', contracts: 10,
    entryStockPrice: 210.50, atrAtEntry: 4.10, rollUpStepsTaken: 0,
    legs: [{ strike: 205, expiration: '2026-07-18', deltaAtEntry: 0.72, entryMark: 9.40,
             exitMark: null, exitReason: null, realizedPnl: null, openedOn: '2026-06-19', closedOn: null }]
  };

  approx(E.computeCampaignPnl(base, 11.40), 2000, 1e-6, 'computeCampaignPnl open uses current mark');

  var closed = E.applyAction(base, { type: 'close', reason: 'stop' }, { currentMark: 7.40, today: '2026-07-02' });
  eq(closed.campaign.status, 'closed', 'applyAction close sets status');
  eq(closed.campaign.exitReason, 'stop', 'applyAction close sets exitReason');
  approx(closed.campaign.netPnl, -2000, 1e-6, 'applyAction close netPnl = (7.40-9.40)*100*10');
  approx(closed.campaign.legs[0].realizedPnl, -2000, 1e-6, 'applyAction close realizes leg');
  eq(base.status, 'open', 'applyAction does not mutate input campaign');

  var rolled = E.applyAction(base, {
    type: 'roll', reason: 'roll_up', newStep: 1,
    contract: { strike: 215, expiration: '2026-08-21', delta: 0.74, mark: 8.00 }
  }, { currentMark: 12.40, today: '2026-06-26' });
  approx(rolled.campaign.legs[0].realizedPnl, 3000, 1e-6, 'roll realizes closed leg');
  eq(rolled.campaign.legs.length, 2, 'roll opens a new leg');
  eq(rolled.campaign.legs[1].entryMark, 8.00, 'roll new leg uses contract mark');
  eq(rolled.campaign.rollUpStepsTaken, 1, 'roll_up increments step');
  eq(rolled.campaign.status, 'open', 'roll keeps campaign open');
  approx(E.computeCampaignPnl(rolled.campaign, 9.00), 4000, 1e-6, 'computeCampaignPnl sums realized + open leg');
})();

// scorecard
(function () {
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
  approx(s.expectancyR, 0, 1e-9, 'scorecard expectancy R');
  approx(s.maxDrawdown, 2000, 1e-9, 'scorecard max drawdown');
  approx(s.avgWin, 1250, 1e-9, 'scorecard avg win (2000+500)/2');
  approx(s.avgLoss, -1250, 1e-9, 'scorecard avg loss (-1000-1500)/2');
  approx(s.payoffRatio, 1.0, 1e-9, 'scorecard payoff ratio');
  approx(s.avgRolls, 0.25, 1e-9, 'scorecard avg rolls (one campaign has 2 legs)');
  eq(s.exitReasonBreakdown.stop, 2, 'scorecard exit-reason breakdown counts stops');
  approx(s.sortino, 0 / 0.9013878, 1e-6, 'scorecard sortino = meanR / downsideDev');
})();

// computeEMA / regimeBearishCross
(function () {
  var ema = E.computeEMA([1, 2, 3, 4, 3, 2], 2);
  ok(ema[0] === null, 'computeEMA seeds with nulls before period');
  approx(ema[ema.length - 1], 2.3889, 1e-3, 'computeEMA last value (period 2)');
  ok(E.regimeBearishCross([1, 2, 3, 4, 3, 2], 2, 3) === true, 'regimeBearishCross true on fresh bearish cross');
  ok(E.regimeBearishCross([1, 2, 3, 4, 5, 6], 2, 3) === false, 'regimeBearishCross false while trending up');
})();

// occSymbol / dteBetween
(function () {
  eq(E.occSymbol('AAPL', '2026-07-18', 'C', 205), 'AAPL260718C00205000', 'occSymbol builds OCC string');
  eq(E.occSymbol('spy', '2026-08-21', 'C', 540.5), 'SPY260821C00540500', 'occSymbol handles fractional strike + lowercase');
  eq(E.dteBetween('2026-06-19', '2026-07-18'), 29, 'dteBetween counts calendar days');
})();

// parseTickerList
(function () {
  eq(E.parseTickerList('aapl, msft\nnvda  aapl'), ['AAPL', 'MSFT', 'NVDA'], 'parseTickerList splits, uppercases, dedupes');
  eq(E.parseTickerList('BRK.B, spy; qqq|tsla'), ['BRK.B', 'SPY', 'QQQ', 'TSLA'], 'parseTickerList handles mixed separators and dotted symbols');
  eq(E.parseTickerList(''), [], 'parseTickerList empty input');
})();

// nextCampaignId — must stay unique across delete + re-add (the delete bug)
(function () {
  var pos = [];
  function add(t, d) { var id = E.nextCampaignId(pos, t, d); pos.push({ id: id, ticker: t, entryDate: d }); return id; }
  eq(add('AAPL', '2026-06-19'), 'AAPL-2026-06-19-1', 'nextCampaignId first id = -1');
  eq(add('AAPL', '2026-06-19'), 'AAPL-2026-06-19-2', 'nextCampaignId increments per ticker+date');
  eq(add('MSFT', '2026-06-19'), 'MSFT-2026-06-19-1', 'nextCampaignId numbers each ticker separately');
  // delete the first AAPL, then add another: the OLD length-based scheme would
  // have reused "-2" (length 2 + ... ) and collided; the new one must not.
  pos = pos.filter(function (c) { return c.id !== 'AAPL-2026-06-19-1'; });
  var reAdded = E.nextCampaignId(pos, 'AAPL', '2026-06-19');
  eq(reAdded, 'AAPL-2026-06-19-3', 'nextCampaignId does not reuse a live suffix after a delete');
  ok(pos.every(function (c) { return c.id !== reAdded; }), 're-added id collides with no live campaign');
})();

// dedupeCampaignIds — repairs legacy data that already has duplicate/blank ids
(function () {
  var dirty = [
    { id: 'AAPL-2026-06-19-2', ticker: 'AAPL', entryDate: '2026-06-19', tag: 'A' },
    { id: 'AAPL-2026-06-19-2', ticker: 'AAPL', entryDate: '2026-06-19', tag: 'B' },
    { id: '', ticker: 'TSLA', entryDate: '2026-06-19', tag: 'C' }
  ];
  var clean = E.dedupeCampaignIds(dirty);
  eq(clean.length, 3, 'dedupe preserves campaign count');
  eq(clean[0].id, 'AAPL-2026-06-19-2', 'dedupe keeps the first occurrence id');
  ok(clean[1].id !== clean[0].id, 'dedupe reassigns the colliding duplicate');
  ok(!!clean[2].id, 'dedupe assigns an id to a blank one');
  var ids = clean.map(function (c) { return c.id; });
  ok(ids.length === 3 && ids[0] !== ids[1] && ids[1] !== ids[2] && ids[0] !== ids[2], 'dedupe yields all-unique ids');
  eq(clean.map(function (c) { return c.tag; }), ['A', 'B', 'C'], 'dedupe preserves campaigns and order');
  eq(dirty[1].id, 'AAPL-2026-06-19-2', 'dedupe does not mutate the input');
})();

// prevCloseFromBars — intraday history includes today's partial bar
(function () {
  var bars = [
    { date: '2026-07-15', o: 1, h: 1, l: 1, c: 101 },
    { date: '2026-07-16', o: 1, h: 1, l: 1, c: 102 },
    { date: '2026-07-17', o: 1, h: 1, l: 1, c: 103 }   // today, in-progress
  ];
  eq(E.prevCloseFromBars(bars, '2026-07-17'), 102, 'prevCloseFromBars skips today partial bar');
  eq(E.prevCloseFromBars(bars, '2026-07-18'), 103, 'prevCloseFromBars uses last bar when all are past');
  eq(E.prevCloseFromBars([], '2026-07-17'), null, 'prevCloseFromBars null on empty');
  eq(E.prevCloseFromBars([{ date: '2026-07-17', c: 103 }], '2026-07-17'), null, 'prevCloseFromBars null when only today exists');
})();

// gapStats
(function () {
  var g = E.gapStats(105, 100, 2);
  approx(g.gapPct, 5, 1e-9, 'gapStats pct = (last-prev)/prev*100');
  approx(g.gapATR, 2.5, 1e-9, 'gapStats ATR multiple = (last-prev)/atr');
  eq(E.gapStats(105, null, 2), { gapPct: null, gapATR: null }, 'gapStats null without prevClose');
  eq(E.gapStats(105, 100, null).gapATR, null, 'gapStats null ATR multiple without atr');
  approx(E.gapStats(95, 100, 2).gapATR, -2.5, 1e-9, 'gapStats negative on gap-down');
})();

// rankPremarket — pre-market scan ranking
(function () {
  var items = [
    { ticker: 'FLAT', last: 100, prevClose: 100, atr: 2 },
    { ticker: 'BIGGAP', last: 106, prevClose: 100, atr: 4 },   // +1.5 ATR
    { ticker: 'NODATA', last: null, prevClose: null, atr: null },
    { ticker: 'SMALLGAP', last: 100.5, prevClose: 100, atr: 5 }, // +0.1 ATR
    { ticker: 'DOWN', last: 95, prevClose: 100, atr: 2 }        // -2.5 ATR
  ];
  var r = E.rankPremarket(items, 0.25);
  eq(r.map(function (x) { return x.ticker; }), ['BIGGAP', 'SMALLGAP', 'FLAT', 'DOWN', 'NODATA'],
     'rankPremarket sorts by gap ATRs desc, missing data last');
  eq(r[0].pm.buy, true, 'rankPremarket flags gap-up >= threshold as buy');
  eq(r[1].pm.buy, false, 'rankPremarket no flag below threshold');
  eq(r[3].pm.buy, false, 'rankPremarket never flags gap-downs');
  approx(r[0].pm.gapATR, 1.5, 1e-9, 'rankPremarket computes ATR multiple');
  eq(items[0].pm, undefined, 'rankPremarket does not mutate input');
  eq(E.rankPremarket([], null).length, 0, 'rankPremarket empty input');
})();

// isMonthlyExpiration / pickDefaultExpiration
(function () {
  ok(E.isMonthlyExpiration('2026-07-17') === true, 'isMonthlyExpiration true for 3rd Friday');
  ok(E.isMonthlyExpiration('2026-07-24') === false, 'isMonthlyExpiration false for 4th Friday');
  ok(E.isMonthlyExpiration('2026-07-10') === false, 'isMonthlyExpiration false for 2nd Friday');
  var exps = ['2026-06-26', '2026-07-17', '2026-07-24', '2026-08-21'];
  eq(E.pickDefaultExpiration(exps, '2026-06-19'), '2026-07-17', 'pickDefaultExpiration = nearest monthly >7 DTE');
  eq(E.pickDefaultExpiration(['2026-07-17', '2026-08-21'], '2026-07-15'), '2026-08-21', 'pickDefaultExpiration skips monthly within 7 DTE');
})();

// windowStrikes
(function () {
  var chain = [], i;
  for (i = 90; i <= 130; i++) chain.push({ strike: i });
  var w = E.windowStrikes(chain, 110.4, 15, 15);
  eq(w.length, 30, 'windowStrikes returns 30 strikes');
  eq(w[0].strike, 96, 'windowStrikes lowest = 15 strikes below spot');
  eq(w[w.length - 1].strike, 125, 'windowStrikes highest = 15 strikes above spot');
  eq(E.windowStrikes([{ strike: 100 }, { strike: 105 }, { strike: 110 }], 104, 15, 15).length, 3, 'windowStrikes returns all when fewer than the window');
  eq(E.windowStrikes(chain, null, 15, 15).length, 30, 'windowStrikes falls back to first 30 without a ref price');
})();

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
