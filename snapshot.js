/* Long-Call Tracker — background snapshot runner for the GitHub Action.
 * runSnapshot() is deterministic given its inputs (provider injected) and is
 * unit-tested with a stub provider. main() wires real files + env + clock. */
'use strict';
var E = require('./engine.js');
var DP = require('./dataProvider.js');

function isoMinusDays(iso, n) {
  return new Date(Date.parse(iso + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10);
}

function fetchRollCandidates(provider, ticker, todayISO) {
  return provider.getOptionCandidates(ticker, todayISO);
}

function runSnapshot(state) {
  var cfg = state.cfg;
  var positions = state.positions || [];
  var history = state.history || { events: [], equity: [] };
  var provider = state.provider;
  var nowET = state.nowET; // {minutes, dateISO}
  if (!history.events) history.events = [];
  if (!history.equity) history.equity = [];
  var logs = [];

  var spyFrom = isoMinusDays(nowET.dateISO, 90);

  return provider.getDailyBars('SPY', spyFrom, nowET.dateISO).then(function (spyBars) {
    var regimeCross = E.regimeBearishCross((spyBars || []).map(function (b) { return b.c; }), 10, 20);

    var updated = [];
    var marks = {};
    var lastHour = E.isLastHour(nowET.minutes, cfg);

    // Process campaigns sequentially so the (stubbed or live) provider calls are ordered.
    var chain = Promise.resolve();
    positions.forEach(function (camp) {
      chain = chain.then(function () {
        if (camp.status !== 'open') { updated.push(camp); return; }
        var leg = camp.legs[camp.legs.length - 1];
        var occ = E.occSymbol(camp.ticker, leg.expiration, 'C', leg.strike);
        return provider.getOptionQuote(occ).then(function (q) {
          return provider.getStockQuote(camp.ticker).then(function (sq) {
            var ctxBase = {
              stockPrice: sq.price,
              etMinutes: nowET.minutes,
              spyRegimeCross: regimeCross,
              currentDTE: E.dteBetween(nowET.dateISO, leg.expiration),
              currentMark: q.mark,
              today: nowET.dateISO,
              rollCandidates: []
            };
            marks[camp.id] = q.mark;
            var needCandidates = lastHour &&
              (ctxBase.currentDTE <= cfg.dteRollTrigger ||
                ctxBase.stockPrice >= camp.entryStockPrice + ((camp.rollUpStepsTaken || 0) + 1) * camp.atrAtEntry);
            var candP = needCandidates ? fetchRollCandidates(provider, camp.ticker, nowET.dateISO) : Promise.resolve([]);
            return candP.then(function (cands) {
              ctxBase.rollCandidates = cands || [];
              var action = E.evaluateExits(camp, ctxBase, cfg);
              if (action.type === 'none') { updated.push(camp); return; }
              var res = E.applyAction(camp, action, ctxBase);
              updated.push(res.campaign);
              for (var i = 0; i < res.events.length; i++) history.events.push(res.events[i]);
              if (res.campaign.status === 'closed') delete marks[res.campaign.id];
              logs.push(camp.ticker + ': ' + action.type + (action.reason ? (' ' + action.reason) : ''));
            });
          });
        });
      });
    });

    return chain.then(function () {
      var realized = 0, unrealized = 0;
      updated.forEach(function (c) {
        if (c.status === 'closed') realized += (c.netPnl || 0);
        else if (marks[c.id] != null) unrealized += E.computeCampaignPnl(c, marks[c.id]);
      });
      var equity = (cfg.accountBalance || 0) + realized + unrealized;
      history.equity = history.equity.filter(function (p) { return p.date !== nowET.dateISO; });
      history.equity.push({ date: nowET.dateISO, realized: realized, unrealized: unrealized, equity: equity });
      return { positions: updated, history: history, regimeCross: regimeCross, logs: logs };
    });
  });
}

function etNow() {
  var fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  var parts = {};
  fmt.formatToParts(new Date()).forEach(function (p) { parts[p.type] = p.value; });
  return { dateISO: parts.year + '-' + parts.month + '-' + parts.day, minutes: ((+parts.hour) % 24) * 60 + (+parts.minute) };
}

function main() {
  var fs = require('fs');
  function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fb; } }
  var cfg = readJson('./config.json', {});
  var positions = readJson('./positions.json', []);
  var history = readJson('./history.json', { events: [], equity: [] });
  var secrets = {
    fmpKey: process.env.FMP_KEY,
    tradierProxy: process.env.TRADIER_PROXY,
    tradierLiveToken: process.env.TRADIER_LIVE_TOKEN,
    tradierToken: process.env.TRADIER_TOKEN,
    tradierEnv: process.env.TRADIER_ENV,
    alpacaKey: process.env.ALPACA_KEY,
    alpacaSecret: process.env.ALPACA_SECRET
  };
  var provider = DP.createProvider(cfg, secrets);
  runSnapshot({ cfg: cfg, positions: positions, history: history, provider: provider, nowET: etNow() })
    .then(function (out) {
      fs.writeFileSync('./positions.json', JSON.stringify(out.positions, null, 2) + '\n');
      fs.writeFileSync('./history.json', JSON.stringify(out.history, null, 2) + '\n');
      console.log('snapshot ' + out.logs.length + ' action(s); regimeBearishCross=' + out.regimeCross);
      out.logs.forEach(function (l) { console.log('  ' + l); });
    })
    .catch(function (e) { console.error('snapshot failed: ' + (e && e.message)); process.exit(1); });
}

module.exports = { runSnapshot: runSnapshot, fetchRollCandidates: fetchRollCandidates, isoMinusDays: isoMinusDays, etNow: etNow };

if (require.main === module) main();
