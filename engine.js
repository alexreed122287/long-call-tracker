/* Long-Call Tracker — pure strategy engine. No I/O. */
(function (factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.Engine = api;
})(function () {
  'use strict';

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

  function atrLevels(entry, atr, cfg) {
    var sm = (cfg && cfg.atrStopMult) || 1;
    var em = (cfg && cfg.atrEmergencyMult) || 3;
    return { stop: entry - sm * atr, emergency: entry - em * atr };
  }

  function liquidityOK(c, minOI, maxSpreadPct) {
    if (!c) return false;
    if ((c.oi || 0) < minOI) return false;
    var bid = c.bid || 0, ask = c.ask || 0;
    if (bid <= 0 || ask <= 0) return false;
    var mid = (bid + ask) / 2;
    if (mid <= 0) return false;
    return ((ask - bid) / mid) <= maxSpreadPct;
  }

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

  function parseHM(s) { var p = (s || '').split(':'); return (+p[0]) * 60 + (+p[1] || 0); }
  function isLastHour(etMinutes, cfg) {
    var t = (cfg && cfg.timing) || {};
    var start = parseHM(t.lastHourStartET || '15:00');
    var close = parseHM(t.marketCloseET || '16:00');
    return etMinutes >= start && etMinutes < close;
  }

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

  function computeEMA(values, period) {
    if (!values || values.length < period) return [];
    var k = 2 / (period + 1), out = [], seed = 0, i;
    for (i = 0; i < period; i++) seed += values[i];
    seed = seed / period;
    for (i = 0; i < values.length; i++) {
      if (i < period - 1) out.push(null);
      else if (i === period - 1) out.push(seed);
      else out.push(values[i] * k + out[i - 1] * (1 - k));
    }
    return out;
  }

  function regimeBearishCross(closes, fast, slow) {
    fast = fast || 10; slow = slow || 20;
    if (!closes || closes.length < 2) return false;
    var ef = computeEMA(closes, fast), es = computeEMA(closes, slow);
    var n = closes.length;
    var f1 = ef[n - 1], s1 = es[n - 1], f0 = ef[n - 2], s0 = es[n - 2];
    if (f1 == null || s1 == null || f0 == null || s0 == null) return false;
    return f0 >= s0 && f1 < s1;
  }

  function occSymbol(ticker, expISO, type, strike) {
    var p = expISO.split('-');
    var yy = p[0].slice(2), mm = p[1], dd = p[2];
    var ks = ('00000000' + Math.round(strike * 1000)).slice(-8);
    return ('' + ticker).toUpperCase() + yy + mm + dd + (type === 'P' ? 'P' : 'C') + ks;
  }

  function dteBetween(todayISO, expISO) {
    var a = Date.parse(todayISO + 'T00:00:00Z');
    var b = Date.parse(expISO + 'T00:00:00Z');
    return Math.round((b - a) / 86400000);
  }

  function windowStrikes(chain, refPrice, itm, otm) {
    // For calls: ITM = strike <= underlying, OTM = strike > underlying.
    // Returns up to itm strikes just below/at spot + otm strikes just above, sorted.
    itm = (itm == null) ? 15 : itm;
    otm = (otm == null) ? 15 : otm;
    var sorted = (chain || []).slice().sort(function (a, b) { return a.strike - b.strike; });
    if (refPrice == null || !isFinite(refPrice)) return sorted.slice(0, itm + otm);
    var below = [], above = [], i;
    for (i = 0; i < sorted.length; i++) { if (sorted[i].strike <= refPrice) below.push(sorted[i]); else above.push(sorted[i]); }
    return below.slice(Math.max(0, below.length - itm)).concat(above.slice(0, otm));
  }

  function isMonthlyExpiration(dateISO) {
    // Standard equity monthly = 3rd Friday of the month (Friday, day-of-month 15-21).
    var d = new Date(Date.parse(dateISO + 'T00:00:00Z'));
    var dom = +dateISO.slice(8, 10);
    return d.getUTCDay() === 5 && dom >= 15 && dom <= 21;
  }

  function pickDefaultExpiration(expirations, todayISO) {
    var future = (expirations || []).filter(function (d) { return dteBetween(todayISO, d) > 0; }).slice().sort();
    var monthly = future.filter(function (d) { return isMonthlyExpiration(d); }), i;
    for (i = 0; i < monthly.length; i++) { if (dteBetween(todayISO, monthly[i]) > 7) return monthly[i]; }
    if (monthly.length) return monthly[0];
    for (i = 0; i < future.length; i++) { if (dteBetween(todayISO, future[i]) > 7) return future[i]; }
    return future[0] || null;
  }

  function parseTickerList(text) {
    var raw = ('' + (text || '')).toUpperCase().split(/[^A-Z0-9.\-]+/);
    var seen = {}, out = [], i;
    for (i = 0; i < raw.length; i++) {
      var t = raw[i];
      if (t && /^[A-Z][A-Z0-9.\-]*$/.test(t) && !seen[t]) { seen[t] = 1; out.push(t); }
    }
    return out;
  }

  return {
    computeATR: computeATR,
    atrLevels: atrLevels,
    liquidityOK: liquidityOK,
    sizePosition: sizePosition,
    isLastHour: isLastHour,
    pickEntryContract: pickEntryContract,
    pickRollContract: pickRollContract,
    evaluateExits: evaluateExits,
    applyAction: applyAction,
    computeCampaignPnl: computeCampaignPnl,
    scorecard: scorecard,
    computeEMA: computeEMA,
    regimeBearishCross: regimeBearishCross,
    occSymbol: occSymbol,
    dteBetween: dteBetween,
    parseTickerList: parseTickerList,
    isMonthlyExpiration: isMonthlyExpiration,
    pickDefaultExpiration: pickDefaultExpiration,
    windowStrikes: windowStrikes
  };
});
