/* Run: node test_tracker.js — Plan 2 (provider parsing + snapshot orchestration). */
var E = require('./engine.js');
var DP = require('./dataProvider.js');
var SNAP = require('./snapshot.js');

var pass = 0, fail = 0;
function eq(actual, expected, msg) {
  var a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) { pass++; } else { fail++; console.error('FAIL: ' + msg + '\n  expected ' + b + '\n  got      ' + a); }
}
function approx(actual, expected, tol, msg) {
  if (typeof actual === 'number' && Math.abs(actual - expected) <= tol) { pass++; }
  else { fail++; console.error('FAIL: ' + msg + '\n  expected ~' + expected + ' got ' + actual); }
}
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('FAIL: ' + msg); } }

var CFG = {
  accountBalance: 1000000, riskPct: 0.05,
  atrStopMult: 1, atrEmergencyMult: 3, dteRollTrigger: 7,
  timeRollMinDelta: 0.60, timeRollMinDTE: 30, timeRollDeltaTarget: 0.70,
  rollUpDeltaBand: [0.65, 0.85], rollUpDeltaTarget: 0.75,
  liquidityMinOI: 500, liquidityMaxSpreadPct: 0.10,
  timing: { lastHourStartET: '15:00', marketCloseET: '16:00' },
  providers: { optionsGreeks: 'tradier', equityPriceAtr: 'fmp', spyEma: 'fmp' }
};

function campaign(over) {
  var base = {
    id: 'AAPL-1', ticker: 'AAPL', status: 'open', contracts: 10,
    entryStockPrice: 210.50, atrAtEntry: 4.10, rollUpStepsTaken: 0,
    legs: [{ strike: 205, expiration: '2026-08-21', deltaAtEntry: 0.72, entryMark: 9.40,
             exitMark: null, exitReason: null, realizedPnl: null, openedOn: '2026-06-19', closedOn: null }]
  };
  return Object.assign(base, over || {});
}

// Stub provider: rising SPY (regime false), configurable stock price / mark / candidates.
function stubProvider(opts) {
  opts = opts || {};
  var spy = []; for (var i = 0; i < 25; i++) spy.push({ c: 100 + i });
  return {
    getDailyBars: function () { return Promise.resolve(spy); },
    getStockQuote: function () { return Promise.resolve({ price: opts.price }); },
    getOptionQuote: function () { return Promise.resolve({ mark: opts.mark }); },
    getOptionCandidates: function () { return Promise.resolve(opts.candidates || []); },
    getStockPriceAt: function () { return Promise.resolve({ price: opts.price }); },
    getOptionChain: function () { return Promise.resolve(opts.candidates || []); }
  };
}

function stubHttp(routes) {
  return function (url) {
    var keys = Object.keys(routes);
    for (var i = 0; i < keys.length; i++) { if (url.indexOf(keys[i]) >= 0) return Promise.resolve(routes[keys[i]]); }
    return Promise.reject(new Error('no stub route for ' + url));
  };
}

(async function () {
  /* ---- dataProvider parsing via createProvider + stubbed httpJson ---- */
  (function () {
    var fmpDaily = [
      { date: '2026-06-03', open: 3, high: 4, low: 2, close: 3.5 },
      { date: '2026-06-01', open: 1, high: 2, low: 0.5, close: 1.5 },
      { date: '2026-06-02', open: 2, high: 3, low: 1.5, close: 2.5 }
    ];
    eq(DP.parseFmpDaily(fmpDaily).map(function (r) { return r.date; }),
       ['2026-06-01', '2026-06-02', '2026-06-03'], 'parseFmpDaily sorts oldest->newest');

    var chain = { options: { option: [
      { strike: 205, bid: 9.3, ask: 9.5, greeks: { delta: 0.72 }, open_interest: 600, option_type: 'call', expiration_date: '2026-07-18' },
      { strike: 205, bid: 1.0, ask: 1.1, greeks: { delta: -0.28 }, open_interest: 600, option_type: 'put', expiration_date: '2026-07-18' }
    ] } };
    var parsedChain = DP.parseTradierChain(chain);
    eq(parsedChain.length, 1, 'parseTradierChain keeps calls only');
    approx(parsedChain[0].delta, 0.72, 1e-9, 'parseTradierChain reads greek delta');
    approx(parsedChain[0].mark, 9.4, 1e-9, 'parseTradierChain mark = mid');

    var quote = { quotes: { quote: { bid: 9.3, ask: 9.5, last: 9.35, greeks: { delta: 0.72 }, open_interest: 600 } } };
    approx(DP.parseTradierQuote(quote).mark, 9.4, 1e-9, 'parseTradierQuote mark = mid');

    eq(DP.parseTradierExpirations({ expirations: { date: ['2026-07-18', '2026-08-21'] } }), ['2026-07-18', '2026-08-21'], 'parseTradierExpirations returns date list');
    eq(DP.parseTradierExpirations({ expirations: { date: '2026-07-18' } }), ['2026-07-18'], 'parseTradierExpirations wraps single date');

    eq(DP.parseFmpSearch([{ symbol: 'AAPL', name: 'Apple Inc.' }, { symbol: '', name: 'bad' }]), [{ symbol: 'AAPL', name: 'Apple Inc.' }], 'parseFmpSearch maps and drops empties');
    eq(DP.parseTradierSearch({ securities: { security: [{ symbol: 'AAPL', description: 'Apple Inc' }] } }), [{ symbol: 'AAPL', name: 'Apple Inc' }], 'parseTradierSearch maps securities');
  })();

  // createProvider dispatch + URL: Tradier chain through stubbed httpJson
  await (async function () {
    var seen = { url: '' };
    var http = function (url, headers) {
      seen.url = url; seen.headers = headers;
      return Promise.resolve({ options: { option: [
        { strike: 215, bid: 8.0, ask: 8.2, greeks: { delta: 0.70 }, open_interest: 800, option_type: 'call', expiration_date: '2026-07-18' }
      ] } });
    };
    var p = DP.createProvider(CFG, { tradierProxy: 'https://proxy.example', tradierLiveToken: 'tok' }, http);
    var chain = await p.getOptionChain('AAPL', '2026-07-18');
    ok(seen.url.indexOf('/v1/markets/options/chains') >= 0, 'createProvider builds tradier chain URL');
    ok(seen.headers['X-Live-Token'] === 'tok', 'createProvider uses proxy X-Live-Token header');
    eq(chain[0].strike, 215, 'createProvider returns parsed chain');
  })();

  // createProvider getExpirations dispatch
  await (async function () {
    var seen = {};
    var http = function (url) { seen.url = url; return Promise.resolve({ expirations: { date: ['2026-07-18', '2026-08-21', '2026-09-18'] } }); };
    var p = DP.createProvider(CFG, { tradierProxy: 'https://proxy.example', tradierLiveToken: 'tok' }, http);
    var exps = await p.getExpirations('AAPL');
    ok(seen.url.indexOf('/v1/markets/options/expirations') >= 0, 'createProvider builds expirations URL');
    eq(exps.length, 3, 'createProvider returns expiration list');
  })();

  // createProvider searchSymbols dispatch (FMP)
  await (async function () {
    var seen = {};
    var http = function (url) { seen.url = url; return Promise.resolve([{ symbol: 'AAPL', name: 'Apple Inc.' }]); };
    var p = DP.createProvider({ providers: { equityPriceAtr: 'fmp', optionsGreeks: 'tradier', spyEma: 'fmp' } }, { fmpKey: 'k' }, http);
    var res = await p.searchSymbols('apple');
    ok(seen.url.indexOf('search-symbol') >= 0, 'createProvider builds FMP search URL');
    eq(res[0].symbol, 'AAPL', 'searchSymbols returns parsed matches');
  })();

  /* ---- snapshot.runSnapshot orchestration via stub provider ---- */

  // A. emergency close (intraday)
  await (async function () {
    var out = await SNAP.runSnapshot({
      cfg: CFG, positions: [campaign()], history: { events: [], equity: [] },
      provider: stubProvider({ price: 197, mark: 5.00 }),
      nowET: { minutes: 12 * 60, dateISO: '2026-06-19' }
    });
    eq(out.positions[0].status, 'closed', 'runSnapshot emergency-closes campaign');
    eq(out.positions[0].exitReason, 'emergency', 'runSnapshot tags emergency');
    approx(out.positions[0].netPnl, -4400, 1e-6, 'runSnapshot books netPnl (5.00-9.40)*100*10');
    ok(out.history.events.some(function (e) { return e.type === 'close'; }), 'runSnapshot logs close event');
    eq(out.history.equity.length, 1, 'runSnapshot appends one equity point');
    eq(out.history.equity[0].date, '2026-06-19', 'equity point dated today');
  })();

  // B. winner roll-up (last hour)
  await (async function () {
    var cands = [{ strike: 215, expiration: '2026-12-18', dte: 182, delta: 0.74, oi: 800, bid: 8, ask: 8.1 }];
    var out = await SNAP.runSnapshot({
      cfg: CFG, positions: [campaign()], history: { events: [], equity: [] },
      provider: stubProvider({ price: 214.7, mark: 12.40, candidates: cands }),
      nowET: { minutes: 15 * 60 + 30, dateISO: '2026-06-19' }
    });
    eq(out.positions[0].status, 'open', 'runSnapshot keeps campaign open on roll');
    eq(out.positions[0].legs.length, 2, 'runSnapshot appends rolled leg');
    eq(out.positions[0].rollUpStepsTaken, 1, 'runSnapshot increments roll step');
    ok(out.history.events.some(function (e) { return e.type === 'roll_up'; }), 'runSnapshot logs roll_up event');
  })();

  // C. no trigger (midday, healthy)
  await (async function () {
    var out = await SNAP.runSnapshot({
      cfg: CFG, positions: [campaign()], history: { events: [], equity: [] },
      provider: stubProvider({ price: 211, mark: 9.50 }),
      nowET: { minutes: 12 * 60, dateISO: '2026-06-19' }
    });
    eq(out.positions[0].status, 'open', 'runSnapshot leaves healthy campaign open');
    eq(out.history.events.length, 0, 'runSnapshot records no exit events when nothing triggers');
    approx(out.history.equity[0].unrealized, 100, 1e-6, 'equity unrealized = (9.50-9.40)*100*10');
  })();

  // D. closed campaign feeds the scorecard
  await (async function () {
    var out = await SNAP.runSnapshot({
      cfg: CFG, positions: [campaign()], history: { events: [], equity: [] },
      provider: stubProvider({ price: 197, mark: 5.00 }),
      nowET: { minutes: 12 * 60, dateISO: '2026-06-19' }
    });
    var s = E.scorecard(out.positions);
    eq(s.trades, 1, 'scorecard counts the closed campaign');
    eq(s.exitReasonBreakdown.emergency, 1, 'scorecard breakdown includes emergency');
  })();

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
