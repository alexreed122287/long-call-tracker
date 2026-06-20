/* Long-Call Tracker — dashboard logic. Uses window.Engine + window.DataProvider. */
(function () {
  'use strict';
  var E = window.Engine, DP = window.DataProvider;
  var liveMarks = {}, liveStocks = {};

  /* ---------- storage ---------- */
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function getJSON(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function setJSON(k, v) { lsSet(k, JSON.stringify(v)); }

  var DEFAULT_CONFIG = {
    accountBalance: 1000000, riskPct: 0.05, atrStopMult: 1, atrEmergencyMult: 3, atrRollUpStep: 1,
    rollUpDeltaBand: [0.65, 0.85], rollUpDeltaTarget: 0.75, dteRollTrigger: 7,
    timeRollMinDelta: 0.60, timeRollMinDTE: 30, timeRollDeltaTarget: 0.70,
    liquidityMinOI: 500, liquidityMaxSpreadPct: 0.10,
    timing: { lastHourStartET: '15:00', marketCloseET: '16:00' },
    providers: { optionsGreeks: 'tradier', equityPriceAtr: 'fmp', spyEma: 'fmp' }
  };
  function getConfig() { return getJSON('lct_config', DEFAULT_CONFIG); }
  function setConfig(c) { setJSON('lct_config', c); }
  function getPositions() { return getJSON('lct_positions', []); }
  function setPositions(p) { setJSON('lct_positions', p); }
  function getHistory() { return getJSON('lct_history', { events: [], equity: [] }); }
  function setHistory(h) { setJSON('lct_history', h); }
  function secrets() {
    return {
      fmpKey: lsGet('lct_fmp', ''), tradierProxy: lsGet('lct_tproxy', ''),
      tradierLiveToken: lsGet('lct_tlive', ''), tradierToken: lsGet('lct_ttok', ''),
      alpacaKey: lsGet('lct_akey', ''), alpacaSecret: lsGet('lct_asec', '')
    };
  }
  function gh() { return { owner: lsGet('lct_gh_owner', ''), repo: lsGet('lct_gh_repo', ''), pat: lsGet('lct_gh_pat', ''), branch: lsGet('lct_gh_branch', 'main') }; }
  function provider() { return DP.createProvider(getConfig(), secrets()); }

  /* ---------- helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function setStatus(s) { $('status').textContent = s; }
  function fmtMoney(x) { if (x == null || isNaN(x)) return '-'; return (x < 0 ? '-$' : '$') + Math.abs(x).toLocaleString(undefined, { maximumFractionDigits: 0 }); }
  function fmt2(x) { return (x == null || isNaN(x)) ? '-' : (+x).toFixed(2); }
  function signClass(x) { return x > 0 ? 'pos' : (x < 0 ? 'neg' : ''); }
  function isoToday() { return new Date().toISOString().slice(0, 10); }
  function isoMinusDays(iso, n) { return new Date(Date.parse(iso + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10); }
  function etNow() {
    var f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    var p = {}; f.formatToParts(new Date()).forEach(function (x) { p[x.type] = x.value; });
    return { dateISO: p.year + '-' + p.month + '-' + p.day, minutes: ((+p.hour) % 24) * 60 + (+p.minute) };
  }
  function cstToEt(hhmm) { var pr = (hhmm || '08:45').split(':'); var m = (+pr[0]) * 60 + (+pr[1]) + 60; return pad(Math.floor(m / 60) % 24) + ':' + pad(m % 60); }
  function nearestExpiration(cands, targetDte) {
    var byExp = {}; cands.forEach(function (c) { if (byExp[c.expiration] == null) byExp[c.expiration] = c.dte; });
    var best = null, bd = Infinity;
    Object.keys(byExp).forEach(function (ex) { var d = Math.abs(byExp[ex] - targetDte); if (d < bd) { bd = d; best = ex; } });
    return best;
  }

  /* ---------- GitHub contents API ---------- */
  function b64encode(s) { return btoa(unescape(encodeURIComponent(s))); }
  function b64decode(s) { return decodeURIComponent(escape(atob((s || '').replace(/\n/g, '')))); }
  function ghHeaders(g) { return { 'Authorization': 'Bearer ' + g.pat, 'Accept': 'application/vnd.github+json' }; }
  async function ghGet(path) {
    var g = gh(); if (!g.owner || !g.repo || !g.pat) return null;
    var url = 'https://api.github.com/repos/' + g.owner + '/' + g.repo + '/contents/' + path + '?ref=' + (g.branch || 'main');
    var r = await fetch(url, { headers: ghHeaders(g) });
    if (r.status === 404) return { json: null, sha: null };
    if (!r.ok) throw new Error('GitHub GET ' + r.status);
    var d = await r.json();
    return { json: JSON.parse(b64decode(d.content)), sha: d.sha };
  }
  async function ghPut(path, obj, sha, msg) {
    var g = gh();
    var url = 'https://api.github.com/repos/' + g.owner + '/' + g.repo + '/contents/' + path;
    var body = { message: msg, content: b64encode(JSON.stringify(obj, null, 2) + '\n'), branch: (g.branch || 'main') };
    if (sha) body.sha = sha;
    var r = await fetch(url, { method: 'PUT', headers: ghHeaders(g), body: JSON.stringify(body) });
    if (!r.ok) throw new Error('GitHub PUT ' + r.status);
    return r.json();
  }
  async function pullFromRepo() {
    try {
      setStatus('pulling...');
      var pos = await ghGet('positions.json'); var his = await ghGet('history.json');
      if (pos && pos.json) setPositions(pos.json);
      if (his && his.json) setHistory(his.json);
      render(); setStatus('pulled from repo');
    } catch (e) { setStatus('pull failed: ' + e.message); }
  }
  async function pushState() {
    try {
      setStatus('pushing...');
      var pos = await ghGet('positions.json');
      await ghPut('positions.json', getPositions(), pos && pos.sha, 'dashboard: update positions');
      var his = await ghGet('history.json');
      await ghPut('history.json', getHistory(), his && his.sha, 'dashboard: update history');
      setStatus('pushed to repo');
    } catch (e) { setStatus('push failed: ' + e.message); }
  }

  /* ---------- add trade ---------- */
  async function addTrade() {
    var msg = $('t-msg'); msg.className = 'hint'; msg.textContent = 'fetching...';
    try {
      var cfg = getConfig(), p = provider();
      var ticker = ($('t-ticker').value || '').trim().toUpperCase();
      var date = $('t-date').value || isoToday();
      var delta = parseFloat($('t-delta').value);
      var dte = parseInt($('t-dte').value, 10);
      if (!ticker) throw new Error('ticker required');
      var etTime = cstToEt($('t-time').value);
      var stock = await p.getStockPriceAt(ticker, date, etTime);
      if (!stock || !stock.price) throw new Error('no stock price for ' + ticker + ' at ' + date);
      var bars = await p.getDailyBars(ticker, isoMinusDays(date, 40), date);
      var atr = E.computeATR(bars, 14);
      if (!isFinite(atr)) throw new Error('not enough history for ATR');
      var cands = await p.getOptionCandidates(ticker, date);
      var exp = nearestExpiration(cands, dte);
      if (!exp) throw new Error('no option expirations found');
      var chain = cands.filter(function (c) { return c.expiration === exp; });
      var contract = E.pickEntryContract(chain, { targetDelta: delta, minOI: cfg.liquidityMinOI, maxSpreadPct: cfg.liquidityMaxSpreadPct });
      if (!contract) throw new Error('no liquid contract near delta ' + delta);
      var override = parseFloat($('t-prem').value);
      var entryMark = isFinite(override) ? override : contract.mark;
      var budget = cfg.accountBalance * cfg.riskPct;
      var size = E.sizePosition({ budget: budget, delta: contract.delta, atr: atr, entryMark: entryMark });
      var camp = {
        id: ticker + '-' + date + '-' + (getPositions().length + 1),
        ticker: ticker, status: 'open', entryDate: date, entryTimeCST: $('t-time').value,
        entryStockPrice: stock.price, atrAtEntry: atr, riskBudget: budget, contracts: size.contracts,
        stopLevel: stock.price - cfg.atrStopMult * atr, emergencyLevel: stock.price - cfg.atrEmergencyMult * atr,
        rollUpStepsTaken: 0,
        legs: [{ strike: contract.strike, expiration: exp, deltaAtEntry: contract.delta, entryMark: entryMark, exitMark: null, exitReason: null, realizedPnl: null, openedOn: date, closedOn: null }],
        netPnl: null, exitReason: null
      };
      var positions = getPositions(); positions.push(camp); setPositions(positions);
      var history = getHistory(); history.events.push({ campaign: camp.id, type: 'open', detail: ticker + ' ' + contract.strike + 'C ' + exp + ' x' + size.contracts, ts: date }); setHistory(history);
      msg.className = 'hint'; msg.textContent = 'Added ' + ticker + ' ' + contract.strike + 'C ' + exp + ' x' + size.contracts + ' (ATR ' + fmt2(atr) + ', entry ' + fmt2(entryMark) + ', risk ' + fmtMoney(budget) + ')';
      $('t-ticker').value = '';
      if (gh().pat) pushState();
      render();
    } catch (e) { msg.className = 'err'; msg.textContent = e.message; }
  }

  /* ---------- live tick: evaluate + apply (open-tab tracking) ---------- */
  async function tick() {
    var cfg = getConfig(), p;
    try { p = provider(); } catch (e) { setStatus('set API keys'); return; }
    var positions = getPositions(), history = getHistory(), now = etNow(), changed = false;
    var regime = false;
    try { var spy = await p.getDailyBars('SPY', isoMinusDays(now.dateISO, 90), now.dateISO); regime = E.regimeBearishCross((spy || []).map(function (b) { return b.c; }), 10, 20); } catch (e) {}
    for (var i = 0; i < positions.length; i++) {
      var camp = positions[i];
      if (camp.status !== 'open') continue;
      var leg = camp.legs[camp.legs.length - 1];
      try {
        var occ = E.occSymbol(camp.ticker, leg.expiration, 'C', leg.strike);
        var q = await p.getOptionQuote(occ);
        var sq = await p.getStockQuote(camp.ticker);
        liveMarks[camp.id] = q.mark; liveStocks[camp.ticker] = sq.price;
        var currentDTE = E.dteBetween(now.dateISO, leg.expiration);
        var last = E.isLastHour(now.minutes, cfg), cands = [];
        if (last && (currentDTE <= cfg.dteRollTrigger || sq.price >= camp.entryStockPrice + ((camp.rollUpStepsTaken || 0) + 1) * camp.atrAtEntry)) cands = await p.getOptionCandidates(camp.ticker, now.dateISO);
        var ctx = { stockPrice: sq.price, etMinutes: now.minutes, spyRegimeCross: regime, currentDTE: currentDTE, currentMark: q.mark, today: now.dateISO, rollCandidates: cands };
        var action = E.evaluateExits(camp, ctx, cfg);
        if (action.type !== 'none') {
          var res = E.applyAction(camp, action, ctx);
          positions[i] = res.campaign;
          for (var e = 0; e < res.events.length; e++) history.events.push(res.events[e]);
          changed = true;
        }
      } catch (err) { setStatus('data error: ' + err.message); }
    }
    appendEquity(positions, history, now.dateISO);
    setPositions(positions); setHistory(history);
    if (changed && gh().pat) pushState();
    render();
    setStatus('updated ' + pad(Math.floor(now.minutes / 60)) + ':' + pad(now.minutes % 60) + ' ET');
  }

  function appendEquity(positions, history, dateISO) {
    var realized = 0, unrealized = 0;
    positions.forEach(function (c) {
      if (c.status === 'closed') realized += (c.netPnl || 0);
      else if (liveMarks[c.id] != null) unrealized += E.computeCampaignPnl(c, liveMarks[c.id]);
    });
    var equity = getConfig().accountBalance + realized + unrealized;
    history.equity = (history.equity || []).filter(function (pt) { return pt.date !== dateISO; });
    history.equity.push({ date: dateISO, realized: realized, unrealized: unrealized, equity: equity });
  }

  async function closeCampaign(id) {
    var positions = getPositions(), history = getHistory();
    for (var i = 0; i < positions.length; i++) {
      if (positions[i].id === id && positions[i].status === 'open') {
        var mark = liveMarks[id];
        if (mark == null) { try { mark = (await provider().getOptionQuote(E.occSymbol(positions[i].ticker, positions[i].legs[positions[i].legs.length - 1].expiration, 'C', positions[i].legs[positions[i].legs.length - 1].strike))).mark; } catch (e) { setStatus('need a mark to close (refresh first)'); return; } }
        var res = E.applyAction(positions[i], { type: 'close', reason: 'manual' }, { currentMark: mark, today: etNow().dateISO });
        positions[i] = res.campaign; res.events.forEach(function (ev) { history.events.push(ev); });
        setPositions(positions); setHistory(history);
        if (gh().pat) pushState();
        render();
        return;
      }
    }
  }

  /* ---------- render ---------- */
  function render() { renderPositions(); renderScorecard(); }

  function renderPositions() {
    var positions = getPositions();
    var tb = $('pos-table').querySelector('tbody');
    tb.innerHTML = '';
    $('pos-empty').style.display = positions.length ? 'none' : 'block';
    var today = etNow().dateISO;
    positions.forEach(function (c) {
      var leg = c.legs[c.legs.length - 1];
      var mark = c.status === 'open' ? liveMarks[c.id] : leg.exitMark;
      var pnl = c.status === 'closed' ? c.netPnl : (mark != null ? E.computeCampaignPnl(c, mark) : null);
      var r = (pnl != null && c.riskBudget) ? pnl / c.riskBudget : null;
      var nextUp = c.entryStockPrice + ((c.rollUpStepsTaken || 0) + 1) * c.atrAtEntry;
      var dte = E.dteBetween(today, leg.expiration);
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + c.ticker + '</td>' +
        '<td><span class="pill ' + c.status + '">' + (c.status === 'closed' ? (c.exitReason || 'closed') : 'open') + '</span></td>' +
        '<td>' + fmt2(c.entryStockPrice) + '</td>' +
        '<td>' + fmt2(c.stopLevel) + ' / ' + fmt2(c.emergencyLevel) + '</td>' +
        '<td>' + fmt2(nextUp) + '</td>' +
        '<td>' + leg.strike + 'C / ' + leg.expiration + ' / ' + fmt2(leg.deltaAtEntry) + ' / ' + dte + 'd</td>' +
        '<td>' + c.contracts + '</td>' +
        '<td>' + (mark != null ? fmt2(mark) : '-') + '</td>' +
        '<td class="' + signClass(pnl) + '">' + (pnl != null ? fmtMoney(pnl) : '-') + '</td>' +
        '<td class="' + signClass(r) + '">' + (r != null ? (r > 0 ? '+' : '') + r.toFixed(2) + 'R' : '-') + '</td>' +
        '<td>' + (c.legs.length - 1) + '</td>' +
        '<td>' + (c.status === 'open' ? '<button class="danger" data-close="' + c.id + '">Close</button>' : '') + '</td>';
      tb.appendChild(tr);
    });
    Array.prototype.forEach.call(tb.querySelectorAll('[data-close]'), function (b) {
      b.onclick = function () { closeCampaign(b.getAttribute('data-close')); };
    });
  }

  function renderScorecard() {
    var s = E.scorecard(getPositions());
    var grid = $('sc-grid');
    var metrics = [
      ['Trades', s.trades], ['Win rate', (s.winRate * 100).toFixed(1) + '%'],
      ['Profit factor', isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞'],
      ['Expectancy', s.expectancyR.toFixed(2) + 'R'], ['Sortino', s.sortino.toFixed(2)],
      ['Sharpe', s.sharpe.toFixed(2)], ['Max drawdown', fmtMoney(s.maxDrawdown)],
      ['Payoff ratio', s.payoffRatio.toFixed(2)], ['Avg win', fmtMoney(s.avgWin)],
      ['Avg loss', fmtMoney(s.avgLoss)], ['Avg rolls', s.avgRolls.toFixed(2)],
      ['Total P&L', fmtMoney(s.totalPnl)]
    ];
    grid.innerHTML = metrics.map(function (m) {
      var cls = (m[0] === 'Total P&L') ? signClass(s.totalPnl) : '';
      return '<div class="metric"><div class="v ' + cls + '">' + m[1] + '</div><div class="k">' + m[0] + '</div></div>';
    }).join('');
    var br = s.exitReasonBreakdown || {};
    var parts = Object.keys(br).map(function (k) { return k + ': ' + br[k]; });
    $('sc-breakdown').textContent = parts.length ? ('Exit reasons — ' + parts.join(', ')) : 'No closed campaigns yet.';
    renderEquity();
  }

  function renderEquity() {
    var eq = (getHistory().equity || []);
    var box = $('equity');
    if (eq.length < 2) { box.innerHTML = '<div class="hint">Equity curve appears once there are at least two daily snapshots.</div>'; return; }
    var vals = eq.map(function (p) { return p.equity; });
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals), W = 720, H = 140, pad = 8;
    var span = (max - min) || 1;
    var pts = vals.map(function (v, i) {
      var x = pad + i * (W - 2 * pad) / (vals.length - 1);
      var y = H - pad - (v - min) / span * (H - 2 * pad);
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    var up = vals[vals.length - 1] >= vals[0];
    box.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H + '">' +
      '<polyline fill="none" stroke="' + (up ? 'var(--green)' : 'var(--red)') + '" stroke-width="2" points="' + pts + '"/></svg>' +
      '<div class="hint">' + eq[0].date + ' → ' + eq[eq.length - 1].date + ' &middot; ' + fmtMoney(vals[0]) + ' → ' + fmtMoney(vals[vals.length - 1]) + '</div>';
  }

  /* ---------- settings ---------- */
  function loadSettings() {
    var c = getConfig();
    $('s-bal').value = c.accountBalance; $('s-risk').value = c.riskPct;
    $('s-oi').value = c.liquidityMinOI; $('s-spread').value = c.liquidityMaxSpreadPct;
    $('s-p-opt').value = c.providers.optionsGreeks; $('s-p-eq').value = c.providers.equityPriceAtr; $('s-p-spy').value = c.providers.spyEma;
    $('s-fmp').value = lsGet('lct_fmp', ''); $('s-tproxy').value = lsGet('lct_tproxy', '');
    $('s-tlive').value = lsGet('lct_tlive', ''); $('s-ttok').value = lsGet('lct_ttok', '');
    $('s-akey').value = lsGet('lct_akey', ''); $('s-asec').value = lsGet('lct_asec', '');
    $('s-gh-owner').value = lsGet('lct_gh_owner', ''); $('s-gh-repo').value = lsGet('lct_gh_repo', '');
    $('s-gh-branch').value = lsGet('lct_gh_branch', 'main'); $('s-gh-pat').value = lsGet('lct_gh_pat', '');
  }
  function saveSettings() {
    var c = getConfig();
    c.accountBalance = parseFloat($('s-bal').value) || c.accountBalance;
    c.riskPct = parseFloat($('s-risk').value) || c.riskPct;
    c.liquidityMinOI = parseFloat($('s-oi').value) || c.liquidityMinOI;
    c.liquidityMaxSpreadPct = parseFloat($('s-spread').value) || c.liquidityMaxSpreadPct;
    c.providers = { optionsGreeks: $('s-p-opt').value, equityPriceAtr: $('s-p-eq').value, spyEma: $('s-p-spy').value };
    setConfig(c);
    lsSet('lct_fmp', $('s-fmp').value); lsSet('lct_tproxy', $('s-tproxy').value);
    lsSet('lct_tlive', $('s-tlive').value); lsSet('lct_ttok', $('s-ttok').value);
    lsSet('lct_akey', $('s-akey').value); lsSet('lct_asec', $('s-asec').value);
    lsSet('lct_gh_owner', $('s-gh-owner').value); lsSet('lct_gh_repo', $('s-gh-repo').value);
    lsSet('lct_gh_branch', $('s-gh-branch').value || 'main'); lsSet('lct_gh_pat', $('s-gh-pat').value);
    $('s-msg').textContent = 'Saved.'; setTimeout(function () { $('s-msg').textContent = ''; }, 2000);
    render();
  }

  /* ---------- tabs + init ---------- */
  function showTab(name) {
    Array.prototype.forEach.call(document.querySelectorAll('nav button'), function (b) { b.classList.toggle('active', b.getAttribute('data-tab') === name); });
    Array.prototype.forEach.call(document.querySelectorAll('main section'), function (s) { s.classList.toggle('active', s.id === name); });
  }

  function init() {
    // seed config from bundled config.json if not customized yet
    if (localStorage.getItem('lct_config') == null) {
      fetch('config.json').then(function (r) { return r.json(); }).then(function (j) { setConfig(j); loadSettings(); }).catch(function () {});
    }
    $('t-date').value = isoToday();
    Array.prototype.forEach.call(document.querySelectorAll('nav button'), function (b) { b.onclick = function () { showTab(b.getAttribute('data-tab')); }; });
    $('t-add').onclick = addTrade;
    $('refresh').onclick = tick;
    $('s-save').onclick = saveSettings;
    $('gh-pull').onclick = pullFromRepo;
    $('gh-push').onclick = pushState;
    loadSettings();
    render();
    // open-tab tracking: poll every 90s when keys are configured
    setInterval(function () { if (secrets().fmpKey || secrets().tradierLiveToken || secrets().alpacaKey) tick(); }, 90000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.LCT = { tick: tick, render: render }; // for manual/debug use
})();
