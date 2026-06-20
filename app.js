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

  /* ---------- exit strategy presets ---------- */
  var EXIT_PRESETS = {
    standard: {
      atrStopMult: 1, atrEmergencyMult: 3, dteRollTrigger: 7,
      rollUpDeltaBand: [0.65, 0.85], rollUpDeltaTarget: 0.75,
      timeRollMinDelta: 0.60, timeRollMinDTE: 30, timeRollDeltaTarget: 0.70
    },
    aggressive: {
      atrStopMult: 0.75, atrEmergencyMult: 2, dteRollTrigger: 10,
      rollUpDeltaBand: [0.65, 0.85], rollUpDeltaTarget: 0.78,
      timeRollMinDelta: 0.65, timeRollMinDTE: 21, timeRollDeltaTarget: 0.75
    },
    passive: {
      atrStopMult: 1.5, atrEmergencyMult: 4, dteRollTrigger: 5,
      rollUpDeltaBand: [0.60, 0.90], rollUpDeltaTarget: 0.72,
      timeRollMinDelta: 0.55, timeRollMinDTE: 45, timeRollDeltaTarget: 0.65
    }
  };

  var EXIT_STRATEGY_RULES = {
    standard: [
      { name: 'Emergency stop', badge: '🛑', desc: 'Close immediately if stock drops below entry − 3× ATR.', trigger: 'Triggered intraday, any time. Highest priority.' },
      { name: 'Regime exit', badge: '📉', desc: 'Close if SPY 10 EMA crosses below 20 EMA (bearish regime shift).', trigger: 'Triggered in the last hour of trading only (after 3:00 PM ET).' },
      { name: 'ATR stop', badge: '⛔', desc: 'Close if stock drops below entry − 1× ATR.', trigger: 'Triggered in the last hour of trading only.' },
      { name: 'Time roll', badge: '⏱️', desc: 'Roll out to a new expiration when DTE ≤ 7 and a liquid 60+ delta / 30+ DTE contract is available.', trigger: 'Last hour only. If no liquid roll is found, position closes instead.' },
      { name: 'Winner roll-up', badge: '🎯', desc: 'Roll up the strike when stock price reaches entry + N× ATR (for the Nth step taken).', trigger: 'Last hour only. Requires a liquid contract in the 65–85 delta band.' }
    ],
    aggressive: [
      { name: 'Emergency stop', badge: '🛑', desc: 'Close if stock drops below entry − 2× ATR.', trigger: 'Intraday, any time. Tighter cushion than standard.' },
      { name: 'Regime exit', badge: '📉', desc: 'Close on SPY 10/20 EMA bearish cross.', trigger: 'Last hour only.' },
      { name: 'ATR stop', badge: '⛔', desc: 'Close if stock drops below entry − 0.75× ATR.', trigger: 'Last hour only.' },
      { name: 'Time roll', badge: '⏱️', desc: 'Roll when DTE ≤ 10. Targets 65+ delta, 21+ DTE.', trigger: 'Last hour only. Earlier roll trigger vs standard.' },
      { name: 'Winner roll-up', badge: '🎯', desc: 'Roll up on each +1 ATR step in the 65–85 delta band.', trigger: 'Last hour only.' }
    ],
    passive: [
      { name: 'Emergency stop', badge: '🛑', desc: 'Close if stock drops below entry − 4× ATR. Very wide cushion.', trigger: 'Intraday, any time.' },
      { name: 'Regime exit', badge: '📉', desc: 'Close on SPY 10/20 EMA bearish cross.', trigger: 'Last hour only.' },
      { name: 'ATR stop', badge: '⛔', desc: 'Close if stock drops below entry − 1.5× ATR.', trigger: 'Last hour only.' },
      { name: 'Time roll', badge: '⏱️', desc: 'Roll when DTE ≤ 5. Targets 55+ delta, 45+ DTE to give extra time.', trigger: 'Last hour only. Holds longer before rolling.' },
      { name: 'Winner roll-up', badge: '🎯', desc: 'Roll up on each +1 ATR step in the 60–90 delta band.', trigger: 'Last hour only.' }
    ],
    custom: [
      { name: 'Emergency stop', badge: '🛑', desc: 'Close if stock drops below entry − (ATR emergency multiplier) × ATR.', trigger: 'Intraday, any time.' },
      { name: 'Regime exit', badge: '📉', desc: 'Close on SPY 10/20 EMA bearish cross.', trigger: 'Last hour only (after 3:00 PM ET).' },
      { name: 'ATR stop', badge: '⛔', desc: 'Close if stock drops below entry − (ATR stop multiplier) × ATR.', trigger: 'Last hour only.' },
      { name: 'Time roll', badge: '⏱️', desc: 'Roll when DTE ≤ (DTE roll trigger). Targets configured min delta / DTE.', trigger: 'Last hour only.' },
      { name: 'Winner roll-up', badge: '🎯', desc: 'Roll up on each +1 ATR step within the roll-up delta band.', trigger: 'Last hour only.' }
    ]
  };

  var METRIC_TOOLTIPS = {
    'Trades': 'Total number of campaigns that have been fully closed.',
    'Win rate': 'Percentage of closed campaigns that closed with a positive net P&L.',
    'Profit factor': 'Gross wins ÷ gross losses. Above 1.0 means you made more than you lost overall. 2.0+ is strong.',
    'Expectancy': 'Average P&L per trade expressed in units of risk (R). Positive = edge. 0.30R+ is a healthy expectancy for a systematic strategy.',
    'Max drawdown': 'The largest peak-to-trough decline in cumulative P&L across closed campaigns.',
    'Payoff ratio': 'Average winning trade ÷ average losing trade. Shows if wins are larger than losses on average.',
    'Avg win': 'Average dollar profit on winning closed campaigns.',
    'Avg loss': 'Average dollar loss on losing closed campaigns.',
    'Avg rolls': 'Average number of contract rolls executed per campaign before it closed.',
    'Largest win': 'Highest single-campaign dollar profit.',
    'Largest loss': 'Largest single-campaign dollar loss.',
    'Total P&L': 'Sum of all realized P&L across every closed campaign.'
  };

  var DEFAULT_CONFIG = {
    accountBalance: 1000000, riskPct: 0.05, atrStopMult: 1, atrEmergencyMult: 3, atrRollUpStep: 1,
    rollUpDeltaBand: [0.65, 0.85], rollUpDeltaTarget: 0.75, dteRollTrigger: 7,
    timeRollMinDelta: 0.60, timeRollMinDTE: 30, timeRollDeltaTarget: 0.70,
    liquidityMinOI: 500, liquidityMaxSpreadPct: 0.10,
    exitStrategy: 'standard',
    timing: { lastHourStartET: '15:00', marketCloseET: '16:00' },
    providers: { optionsGreeks: 'tradier', equityPriceAtr: 'tradier', spyEma: 'tradier' }
  };
  function getConfig() { return Object.assign({}, DEFAULT_CONFIG, getJSON('lct_config', DEFAULT_CONFIG)); }
  function setConfig(c) { setJSON('lct_config', c); }
  function getPositions() { return getJSON('lct_positions', []); }
  function setPositions(p) { setJSON('lct_positions', p); markDirty(); }
  function getHistory() { return getJSON('lct_history', { events: [], equity: [] }); }
  function setHistory(h) { setJSON('lct_history', h); markDirty(); }
  function secrets() {
    return {
      fmpKey: lsGet('lct_fmp', ''), tradierProxy: lsGet('lct_tproxy', ''),
      tradierLiveToken: lsGet('lct_tlive', ''), tradierToken: lsGet('lct_ttok', ''),
      tradierEnv: lsGet('lct_tenv', 'prod'), tradierAccount: lsGet('lct_tacct', ''),
      alpacaKey: lsGet('lct_akey', ''), alpacaSecret: lsGet('lct_asec', '')
    };
  }
  function gh() { return { owner: lsGet('lct_gh_owner', ''), repo: lsGet('lct_gh_repo', ''), pat: lsGet('lct_gh_pat', ''), branch: lsGet('lct_gh_branch', 'main') }; }
  function provider() { return DP.createProvider(getConfig(), secrets()); }

  /* ---------- share state badge ---------- */
  var _isDirty = false;
  function markDirty() {
    _isDirty = true;
    var el = document.getElementById('share-state');
    if (el) { el.textContent = 'unsaved'; el.className = 'state-badge dirty'; }
  }
  function markSynced() {
    _isDirty = false;
    var el = document.getElementById('share-state');
    if (el) { el.textContent = 'synced'; el.className = 'state-badge synced'; }
  }
  function markLocal() {
    var el = document.getElementById('share-state');
    if (el) { el.textContent = 'local'; el.className = 'state-badge'; }
  }

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

  /* ---------- shareable URL (no API keys) ---------- */
  function buildSharePayload() {
    return {
      positions: getPositions(),
      history: getHistory(),
      config: (function () {
        var c = getConfig();
        // strip sensitive data — only share structural config
        return {
          accountBalance: c.accountBalance,
          riskPct: c.riskPct,
          atrStopMult: c.atrStopMult,
          atrEmergencyMult: c.atrEmergencyMult,
          dteRollTrigger: c.dteRollTrigger,
          rollUpDeltaBand: c.rollUpDeltaBand,
          rollUpDeltaTarget: c.rollUpDeltaTarget,
          timeRollMinDelta: c.timeRollMinDelta,
          timeRollMinDTE: c.timeRollMinDTE,
          exitStrategy: c.exitStrategy
        };
      })()
    };
  }

  function generateShareURL() {
    try {
      var payload = buildSharePayload();
      var json = JSON.stringify(payload);
      var compressed = btoa(unescape(encodeURIComponent(json)));
      var url = window.location.origin + window.location.pathname + '?share=' + compressed;
      return url;
    } catch (e) {
      return null;
    }
  }

  function importSharePayload(encoded) {
    try {
      var json = decodeURIComponent(escape(atob(encoded)));
      var payload = JSON.parse(json);
      if (payload.positions) setPositions(E.dedupeCampaignIds(payload.positions));
      if (payload.history) setHistory(payload.history);
      if (payload.config) {
        var cfg = getConfig();
        Object.assign(cfg, payload.config);
        setConfig(cfg);
        loadSettings();
      }
      render();
      return true;
    } catch (e) {
      return false;
    }
  }

  function checkURLShare() {
    var params = new URLSearchParams(window.location.search);
    var share = params.get('share');
    if (!share) return;
    var ok = importSharePayload(share);
    if (ok) {
      // remove ?share= from URL without reload
      var clean = window.location.origin + window.location.pathname;
      window.history.replaceState({}, '', clean);
      setStatus('Loaded shared data');
      markSynced();
    } else {
      setStatus('Failed to load shared data');
    }
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
      render(); setStatus('pulled from repo'); markSynced();
    } catch (e) { setStatus('pull failed: ' + e.message); }
  }
  async function pushState() {
    try {
      setStatus('pushing...');
      var pos = await ghGet('positions.json');
      await ghPut('positions.json', getPositions(), pos && pos.sha, 'dashboard: update positions');
      var his = await ghGet('history.json');
      await ghPut('history.json', getHistory(), his && his.sha, 'dashboard: update history');
      setStatus('pushed to repo'); markSynced();
    } catch (e) { setStatus('push failed: ' + e.message); }
  }

  /* ---------- add trade: option-chain picker ---------- */
  var picker = { entry: null, selected: null };

  async function loadChain() {
    var msg = $('t-msg'); msg.className = 'hint'; msg.textContent = 'loading chain...';
    $('chain-panel').style.display = 'none'; $('select-box').style.display = 'none'; picker.selected = null;
    try {
      var cfg = getConfig(), p = provider();
      var ticker = ($('t-ticker').value || '').trim().toUpperCase();
      var date = $('t-date').value || isoToday();
      if (!ticker) throw new Error('ticker required');
      var etTime = cstToEt($('t-time').value);
      var stock = await p.getStockPriceAt(ticker, date, etTime);
      if (!stock || !stock.price) throw new Error('no stock price for ' + ticker + ' at ' + date);
      var bars = await p.getDailyBars(ticker, isoMinusDays(date, 40), date);
      var atr = E.computeATR(bars, 14);
      if (!isFinite(atr)) throw new Error('not enough history for ATR');
      var exps = await p.getExpirations(ticker);
      exps = (exps || []).filter(function (d) { return E.dteBetween(date, d) > 0; });
      if (!exps.length) throw new Error('no expirations found');
      picker.entry = { ticker: ticker, date: date, price: stock.price, atr: atr };
      $('entry-readout').innerHTML = '<strong>' + ticker + '</strong> &middot; entry ' + fmt2(stock.price) +
        ' &middot; ATR(14) ' + fmt2(atr) + ' &middot; stop ' + fmt2(stock.price - cfg.atrStopMult * atr) +
        ' / emerg ' + fmt2(stock.price - cfg.atrEmergencyMult * atr);
      $('t-exp').innerHTML = exps.map(function (d) { return '<option value="' + d + '">' + d + ' (' + E.dteBetween(date, d) + 'd)</option>'; }).join('');
      $('chain-panel').style.display = 'block';
      msg.textContent = '';
      onExpiration();
    } catch (e) { msg.className = 'err'; msg.textContent = e.message; }
  }

  async function onExpiration() {
    if (!picker.entry) return;
    var exp = $('t-exp').value;
    var tb = $('chain-table').querySelector('tbody');
    tb.innerHTML = ''; $('select-box').style.display = 'none'; picker.selected = null;
    var empty = $('chain-empty'); empty.style.display = 'block'; empty.textContent = 'loading ' + exp + '...';
    try {
      var cfg = getConfig(), p = provider();
      var chain = E.windowStrikes(await p.getOptionChain(picker.entry.ticker, exp) || [], picker.entry.price, 15, 15);
      if (!chain.length) { empty.textContent = 'no calls for ' + exp; return; }
      empty.style.display = 'none';
      var band = cfg.rollUpDeltaBand || [0.65, 0.85];
      chain.forEach(function (c) {
        var mid = (c.bid && c.ask) ? (c.bid + c.ask) / 2 : c.mark;
        var spread = (c.bid && c.ask && mid) ? (c.ask - c.bid) / mid : null;
        var liquid = E.liquidityOK(c, cfg.liquidityMinOI, cfg.liquidityMaxSpreadPct);
        var inBand = c.delta >= band[0] && c.delta <= band[1];
        var tr = document.createElement('tr');
        tr.className = 'chain-row' + (inBand ? ' in-band' : '') + (liquid ? '' : ' illiquid');
        tr.innerHTML =
          '<td>' + c.strike + '</td>' +
          '<td>' + fmt2(c.delta) + '</td>' +
          '<td>' + fmt2(c.bid) + '</td>' +
          '<td>' + fmt2(c.ask) + '</td>' +
          '<td>' + fmt2(c.mark) + '</td>' +
          '<td>' + (c.oi || 0) + (liquid ? '' : '<span class="tag">thin</span>') + '</td>' +
          '<td>' + (spread != null ? (spread * 100).toFixed(1) + '%' : '-') + '</td>' +
          '<td>' + (inBand ? '<span class="tag" style="color:var(--accent)">band</span>' : '') + '</td>';
        tr.onclick = function () { selectContract(c, exp, tr); };
        tb.appendChild(tr);
      });
    } catch (e) { empty.style.display = 'block'; empty.textContent = e.message; }
  }

  function updateSelectSummary() {
    if (!picker.entry || !picker.selected) return;
    var cfg = getConfig(), e = picker.entry, c = picker.selected.contract, exp = picker.selected.expiration;
    var override = parseFloat($('t-prem').value);
    var mark = (isFinite(override) && override > 0) ? override : c.mark;
    var budget = cfg.accountBalance * cfg.riskPct;
    var contracts = Math.max(1, Math.floor(budget / (mark * 100)));
    var totalPremium = mark * 100 * contracts;
    $('t-contracts').textContent = contracts;
    $('select-summary').innerHTML = e.ticker + ' ' + c.strike + 'C ' + exp +
      ' &middot; ' + E.dteBetween(e.date, exp) + 'd &middot; &Delta; ' + fmt2(c.delta) +
      ' &middot; ' + fmtMoney(totalPremium) + ' total' +
      ' &middot; ' + (cfg.riskPct * 100).toFixed(1) + '% risk (' + fmtMoney(budget) + ')';
  }

  function selectContract(c, exp, tr) {
    picker.selected = { contract: c, expiration: exp };
    Array.prototype.forEach.call($('chain-table').querySelectorAll('tr.selected'), function (x) { x.classList.remove('selected'); });
    tr.classList.add('selected');
    $('t-prem').value = fmt2(c.mark);
    updateSelectSummary();
    $('select-box').style.display = 'block';
  }

  function addSelected() {
    var msg = $('t-msg'); msg.className = 'hint';
    if (!picker.entry || !picker.selected) { msg.className = 'err'; msg.textContent = 'pick a contract first'; return; }
    var cfg = getConfig(), e = picker.entry, c = picker.selected.contract, exp = picker.selected.expiration;
    var override = parseFloat($('t-prem').value);
    var entryMark = isFinite(override) ? override : c.mark;
    var budget = cfg.accountBalance * cfg.riskPct;
    var contracts = Math.max(1, Math.floor(budget / (entryMark * 100)));
    var camp = {
      id: E.nextCampaignId(getPositions(), e.ticker, e.date),
      ticker: e.ticker, status: 'open', entryDate: e.date, entryTimeCST: $('t-time').value,
      entryStockPrice: e.price, atrAtEntry: e.atr, riskBudget: budget, contracts: contracts,
      exitStrategyAtEntry: cfg.exitStrategy || 'standard',
      stopLevel: e.price - cfg.atrStopMult * e.atr, emergencyLevel: e.price - cfg.atrEmergencyMult * e.atr,
      rollUpStepsTaken: 0,
      legs: [{ strike: c.strike, expiration: exp, deltaAtEntry: c.delta, entryMark: entryMark, exitMark: null, exitReason: null, realizedPnl: null, openedOn: e.date, closedOn: null }],
      netPnl: null, exitReason: null
    };
    var positions = getPositions(); positions.push(camp); setPositions(positions);
    var history = getHistory();
    history.events.push({ campaign: camp.id, type: 'open', detail: e.ticker + ' ' + c.strike + 'C ' + exp + ' x' + contracts, ts: e.date });
    setHistory(history);
    msg.textContent = 'Added ' + e.ticker + ' ' + c.strike + 'C ' + exp + ' x' + contracts + ' (entry ' + fmt2(entryMark) + ', risk ' + fmtMoney(budget) + ')';
    $('chain-panel').style.display = 'none'; $('t-ticker').value = ''; picker.selected = null;
    if (gh().pat) pushState();
    render();
  }

  /* ---------- live tick ---------- */
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
          for (var ev = 0; ev < res.events.length; ev++) history.events.push(res.events[ev]);
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

  /* ---------- watchlist ---------- */
  function getWatchlist() { return getJSON('lct_watchlist', []); }
  function setWatchlist(w) { setJSON('lct_watchlist', w); }
  function nearestExp(exps, today, targetDte) {
    var best = null, bd = Infinity;
    exps.forEach(function (d) { var diff = Math.abs(E.dteBetween(today, d) - targetDte); if (diff < bd) { bd = diff; best = d; } });
    return best;
  }
  function selectedTargetDte() {
    var el = $('w-exp'), v = el && el.value;
    return v ? E.dteBetween(isoToday(), v) : 45;
  }
  function populateExpDropdown(exps, today) {
    var el = $('w-exp'); if (!el) return;
    var prev = el.value, def = E.pickDefaultExpiration(exps, today);
    var sel = (prev && exps.indexOf(prev) >= 0) ? prev : def;
    el.innerHTML = exps.map(function (d) {
      return '<option value="' + d + '"' + (d === sel ? ' selected' : '') + '>' + d + ' (' + E.dteBetween(today, d) + 'd, ' + (E.isMonthlyExpiration(d) ? 'M' : 'W') + ')</option>';
    }).join('');
  }
  async function ensureExpirations(force) {
    var el = $('w-exp'); if (!el) return;
    if (!force && el.options.length) return;
    var today = isoToday(), cache = getJSON('lct_exps', null);
    if (!force && cache && cache.day === today && cache.list && cache.list.length) { populateExpDropdown(cache.list, today); return; }
    var p; try { p = provider(); } catch (e) { return; }
    try {
      var exps = (await p.getExpirations('SPY')).filter(function (d) { return E.dteBetween(today, d) > 0; });
      if (exps.length) { setJSON('lct_exps', { day: today, list: exps }); populateExpDropdown(exps, today); }
    } catch (e) { /* leave empty; populated on next refresh */ }
  }
  function addSymbols(tickers) {
    var w = getWatchlist(), have = {}, added = 0;
    w.forEach(function (it) { have[it.ticker] = 1; });
    tickers.forEach(function (t) { if (!have[t]) { w.push({ ticker: t, addedOn: isoToday() }); have[t] = 1; added++; } });
    setWatchlist(w); return added;
  }
  function addPasted() {
    var n = addSymbols(E.parseTickerList($('w-paste').value));
    $('w-paste').value = ''; $('w-msg').textContent = n ? ('Added ' + n + ' ticker(s). Click Refresh data for quotes.') : 'No new tickers.';
    renderWatchlist();
  }

  function copyWatchlistTickers() {
    var w = getWatchlist();
    if (!w.length) { $('w-msg').textContent = 'No tickers to copy.'; return; }
    var csv = w.map(function (it) { return it.ticker; }).join(',');
    navigator.clipboard.writeText(csv).then(function () {
      var btn = $('w-copy-tickers');
      btn.textContent = '✅ Copied!';
      $('w-msg').textContent = 'Copied ' + w.length + ' ticker(s) to clipboard: ' + csv;
      setTimeout(function () { btn.textContent = '📋 Copy Tickers'; }, 2000);
    }).catch(function () {
      // fallback
      var ta = document.createElement('textarea');
      ta.value = csv; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy');
      document.body.removeChild(ta);
      $('w-msg').textContent = 'Copied: ' + csv;
    });
  }

  async function doSearch() {
    var q = ($('w-search').value || '').trim(), box = $('w-results');
    if (!q) { box.innerHTML = ''; return; }
    box.innerHTML = '<span class="hint">searching...</span>';
    try {
      var res = await provider().searchSymbols(q);
      if (!res.length) { box.innerHTML = '<span class="hint">no matches</span>'; return; }
      box.innerHTML = res.slice(0, 12).map(function (r) { return '<span class="chip" data-sym="' + r.symbol + '">' + r.symbol + (r.name ? (' &middot; ' + r.name) : '') + '</span>'; }).join('');
      Array.prototype.forEach.call(box.querySelectorAll('[data-sym]'), function (c) {
        c.onclick = function () { var s = c.getAttribute('data-sym'); var n = addSymbols([s]); $('w-msg').textContent = n ? ('Added ' + s) : (s + ' already on list'); renderWatchlist(); };
      });
    } catch (e) { box.innerHTML = '<span class="err">' + e.message + '</span>'; }
  }
  async function refreshWatchlist() {
    var w = getWatchlist();
    if (!w.length) { $('w-msg').textContent = 'nothing to refresh'; return; }
    var cfg = getConfig(), p;
    try { p = provider(); } catch (e) { $('w-msg').textContent = 'set API keys in Settings'; return; }
    await ensureExpirations(false);
    var dte = selectedTargetDte(), today = isoToday();
    for (var i = 0; i < w.length; i++) {
      var it = w[i];
      $('w-msg').textContent = 'refreshing ' + it.ticker + ' (' + (i + 1) + '/' + w.length + ')...';
      try {
        var q = await p.getStockQuote(it.ticker);
        var bars = await p.getDailyBars(it.ticker, isoMinusDays(today, 40), today);
        var atr = E.computeATR(bars, 14);
        var prevClose = bars.length ? bars[bars.length - 1].c : null;
        it.last = q.price; it.atr = isFinite(atr) ? atr : null;
        it.dayPct = (prevClose && q.price) ? ((q.price - prevClose) / prevClose * 100) : null;
        try {
          var exps = (await p.getExpirations(it.ticker)).filter(function (d) { return E.dteBetween(today, d) > 0; });
          var exp = nearestExp(exps, today, dte);
          if (exp) {
            var chain = await p.getOptionChain(it.ticker, exp);
            var c = E.pickEntryContract(chain, { targetDelta: cfg.rollUpDeltaTarget || 0.75, minOI: cfg.liquidityMinOI, maxSpreadPct: cfg.liquidityMaxSpreadPct });
            it.sug = c ? { strike: c.strike, delta: c.delta, mark: c.mark, exp: exp } : null;
          } else it.sug = null;
        } catch (e2) { it.sug = null; }
        it.err = null;
      } catch (e) { it.err = e.message; }
    }
    setWatchlist(w); $('w-msg').textContent = 'refreshed ' + w.length + ' ticker(s)'; renderWatchlist();
  }
  function removeTicker(t) { setWatchlist(getWatchlist().filter(function (it) { return it.ticker !== t; })); renderWatchlist(); }
  function clearWatchlist() { setWatchlist([]); $('w-results').innerHTML = ''; renderWatchlist(); }
  function buyFromWatchlist(t) { showTab('positions'); $('t-ticker').value = t; $('t-date').value = isoToday(); loadChain(); }
  function renderWatchlist() {
    var w = getWatchlist(), tb = $('w-table').querySelector('tbody');
    tb.innerHTML = ''; $('w-empty').style.display = w.length ? 'none' : 'block';
    w.forEach(function (it) {
      var sug = it.sug ? (it.sug.strike + 'C / ' + fmt2(it.sug.delta) + ' / ' + fmt2(it.sug.mark) + ' / ' + it.sug.exp) : (it.err ? ('<span class="err">' + it.err + '</span>') : '-');
      var pct = (it.dayPct != null) ? ('<span class="' + signClass(it.dayPct) + '">' + (it.dayPct > 0 ? '+' : '') + it.dayPct.toFixed(2) + '%</span>') : '-';
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td><strong>' + it.ticker + '</strong></td>' +
        '<td>' + (it.last != null ? fmt2(it.last) : '-') + '</td>' +
        '<td>' + pct + '</td>' +
        '<td>' + (it.atr != null ? fmt2(it.atr) : '-') + '</td>' +
        '<td>' + sug + '</td>' +
        '<td><button class="ghost" data-chain="' + it.ticker + '" style="padding:4px 10px">Chain</button> <button class="btn" data-buy="' + it.ticker + '" style="padding:4px 12px">Buy</button></td>' +
        '<td><button class="danger" data-rm="' + it.ticker + '">x</button></td>';
      tb.appendChild(tr);
    });
    Array.prototype.forEach.call(tb.querySelectorAll('[data-buy]'), function (b) { b.onclick = function () { buyFromWatchlist(b.getAttribute('data-buy')); }; });
    Array.prototype.forEach.call(tb.querySelectorAll('[data-rm]'), function (b) { b.onclick = function () { removeTicker(b.getAttribute('data-rm')); }; });
    Array.prototype.forEach.call(tb.querySelectorAll('[data-chain]'), function (b) { b.onclick = function () { toggleChain(b.getAttribute('data-chain'), b.parentNode.parentNode); }; });
  }

  function toggleChain(ticker, tr) {
    var nxt = tr.nextSibling;
    if (nxt && nxt.getAttribute && nxt.getAttribute('data-detail') === ticker) { nxt.parentNode.removeChild(nxt); return; }
    Array.prototype.forEach.call($('w-table').querySelectorAll('tr[data-detail]'), function (x) { x.parentNode.removeChild(x); });
    var detail = document.createElement('tr'); detail.setAttribute('data-detail', ticker);
    var td = document.createElement('td'); td.colSpan = 7; td.innerHTML = '<div class="hint">loading chain for ' + ticker + '...</div>';
    detail.appendChild(td); tr.parentNode.insertBefore(detail, tr.nextSibling);
    renderInlineChain(ticker, td);
  }
  async function renderInlineChain(ticker, td) {
    var p; try { p = provider(); } catch (e) { td.innerHTML = '<span class="err">set API keys in Settings</span>'; return; }
    try {
      var today = isoToday();
      var exps = (await p.getExpirations(ticker)).filter(function (d) { return E.dteBetween(today, d) > 0; });
      if (!exps.length) { td.innerHTML = '<span class="err">no expirations</span>'; return; }
      var dte = selectedTargetDte(), sel = nearestExp(exps, today, dte);
      var price = null; try { price = (await p.getStockQuote(ticker)).price; } catch (e) {}
      td.innerHTML = '<div class="row" style="align-items:flex-end;margin-bottom:8px"><div class="field"><label>Expiration</label><select class="ic-exp">' +
        exps.map(function (d) { return '<option value="' + d + '"' + (d === sel ? ' selected' : '') + '>' + d + ' (' + E.dteBetween(today, d) + 'd)</option>'; }).join('') +
        '</select></div></div><div class="ic-table"></div>';
      var expSel = td.querySelector('.ic-exp'), box = td.querySelector('.ic-table');
      expSel.onchange = function () { drawInlineStrikes(ticker, expSel.value, box, price); };
      drawInlineStrikes(ticker, sel, box, price);
    } catch (e) { td.innerHTML = '<span class="err">' + e.message + '</span>'; }
  }
  async function drawInlineStrikes(ticker, exp, box, refPrice) {
    box.innerHTML = '<div class="hint">loading ' + exp + '...</div>';
    var cfg = getConfig(), p = provider();
    try {
      var chain = E.windowStrikes(await p.getOptionChain(ticker, exp) || [], refPrice, 15, 15);
      if (!chain.length) { box.innerHTML = '<span class="hint">no calls for ' + exp + '</span>'; return; }
      var band = cfg.rollUpDeltaBand || [0.65, 0.85];
      var rows = chain.map(function (c) {
        var mid = (c.bid && c.ask) ? (c.bid + c.ask) / 2 : c.mark;
        var spread = (c.bid && c.ask && mid) ? ((c.ask - c.bid) / mid * 100).toFixed(1) + '%' : '-';
        var liquid = E.liquidityOK(c, cfg.liquidityMinOI, cfg.liquidityMaxSpreadPct), inBand = c.delta >= band[0] && c.delta <= band[1];
        return '<tr class="chain-row' + (inBand ? ' in-band' : '') + (liquid ? '' : ' illiquid') + '"><td>' + c.strike + '</td><td>' + fmt2(c.delta) + '</td><td>' + fmt2(c.bid) + '</td><td>' + fmt2(c.ask) + '</td><td>' + fmt2(c.mark) + '</td><td>' + (c.oi || 0) + '</td><td>' + spread + '</td></tr>';
      }).join('');
      box.innerHTML = '<table><thead><tr><th>Strike</th><th>&Delta;</th><th>Bid</th><th>Ask</th><th>Mark</th><th>OI</th><th>Spread</th></tr></thead><tbody>' + rows + '</tbody></table>';
    } catch (e) { box.innerHTML = '<span class="err">' + e.message + '</span>'; }
  }

  function deleteCampaign(id) {
    if (!window.confirm('Delete this campaign from the record? This cannot be undone.')) return;
    setPositions(getPositions().filter(function (c) { return c.id !== id; }));
    var h = getHistory(); h.events = (h.events || []).filter(function (e) { return e.campaign !== id; }); setHistory(h);
    if (gh().pat) pushState();
    render();
  }
  function clearAllPositions() {
    if (!window.confirm('Clear ALL positions, events, and the equity curve? This cannot be undone.')) return;
    setPositions([]); setHistory({ events: [], equity: [] });
    if (gh().pat) pushState();
    render();
  }

  /* ---------- render ---------- */
  function render() { renderWatchlist(); renderPositions(); renderScorecard(); renderCalendar(); updateShareBanner(); }

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
        '<td>' + (c.status === 'open' ? '<button class="danger" data-close="' + c.id + '">Close</button> ' : '') + '<button class="danger" data-del="' + c.id + '" title="delete from record">x</button></td>';
      tb.appendChild(tr);
    });
    Array.prototype.forEach.call(tb.querySelectorAll('[data-close]'), function (b) {
      b.onclick = function () { closeCampaign(b.getAttribute('data-close')); };
    });
    Array.prototype.forEach.call(tb.querySelectorAll('[data-del]'), function (b) {
      b.onclick = function () { deleteCampaign(b.getAttribute('data-del')); };
    });
  }

  function renderScorecard() {
    var positions = getPositions();
    var s = E.scorecard(positions);
    var grid = $('sc-grid');
    var metrics = [
      ['Trades', s.trades],
      ['Win rate', (s.winRate * 100).toFixed(1) + '%'],
      ['Profit factor', isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞'],
      ['Expectancy', s.expectancyR.toFixed(2) + 'R'],
      ['Max drawdown', fmtMoney(s.maxDrawdown)],
      ['Payoff ratio', s.payoffRatio.toFixed(2)],
      ['Avg win', fmtMoney(s.avgWin)],
      ['Avg loss', fmtMoney(s.avgLoss)],
      ['Avg rolls', s.avgRolls.toFixed(2)],
      ['Largest win', fmtMoney(s.largestWin)],
      ['Largest loss', fmtMoney(s.largestLoss)],
      ['Total P&L', fmtMoney(s.totalPnl)]
    ];
    grid.innerHTML = metrics.map(function (m) {
      var cls = (m[0] === 'Total P&L') ? signClass(s.totalPnl) : (m[0] === 'Largest win') ? 'pos' : (m[0] === 'Largest loss') ? 'neg' : '';
      var tip = METRIC_TOOLTIPS[m[0]] || '';
      return '<div class="metric"><div class="tooltip">' + tip + '</div><div class="v ' + cls + '">' + m[1] + '</div><div class="k">' + m[0] + '</div></div>';
    }).join('');

    var br = s.exitReasonBreakdown || {};
    var parts = Object.keys(br).map(function (k) { return k + ': ' + br[k]; });
    $('sc-breakdown').textContent = parts.length ? ('Exit reasons — ' + parts.join(', ')) : 'No closed campaigns yet.';

    renderExitPerformance(positions);
    renderEquity();
  }

  function renderExitPerformance(positions) {
    var closed = (positions || []).filter(function (c) { return c.status === 'closed'; });
    var wrap = $('exit-perf-wrap');
    if (!closed.length) { wrap.innerHTML = '<div class="hint">No closed campaigns yet.</div>'; return; }
    // group by exit reason
    var groups = {};
    closed.forEach(function (c) {
      var reason = c.exitReason || 'unknown';
      if (!groups[reason]) groups[reason] = { trades: 0, wins: 0, pnls: [], Rs: [] };
      var g = groups[reason];
      g.trades++;
      if ((c.netPnl || 0) > 0) g.wins++;
      g.pnls.push(c.netPnl || 0);
      g.Rs.push(c.riskBudget ? (c.netPnl || 0) / c.riskBudget : 0);
    });
    var labels = {
      emergency: '🛑 Emergency stop', stop: '⛔ ATR stop', regime: '📉 Regime exit',
      dte_close: '⏱️ DTE close (no roll)', dte_roll: '⏱️ Time roll', roll_up: '🎯 Winner roll-up',
      manual: '✋ Manual close', unknown: '? Unknown'
    };
    function mean(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : 0; }
    var rows = Object.keys(groups).sort().map(function (reason) {
      var g = groups[reason];
      var totalPnl = g.pnls.reduce(function (s, x) { return s + x; }, 0);
      return '<tr>' +
        '<td>' + (labels[reason] || reason) + '</td>' +
        '<td>' + g.trades + '</td>' +
        '<td>' + (g.wins / g.trades * 100).toFixed(0) + '%</td>' +
        '<td class="' + signClass(totalPnl) + '">' + fmtMoney(totalPnl) + '</td>' +
        '<td>' + mean(g.Rs).toFixed(2) + 'R</td>' +
        '<td class="' + signClass(mean(g.pnls)) + '">' + fmtMoney(mean(g.pnls)) + '</td>' +
        '</tr>';
    }).join('');
    wrap.innerHTML = '<table class="exit-perf-table">' +
      '<thead><tr><th>Exit reason</th><th>Trades</th><th>Win %</th><th>Total P&L</th><th>Avg R</th><th>Avg P&L</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>';
  }

  function renderEquity() {
    var eq = (getHistory().equity || []);
    var box = $('equity');
    if (eq.length < 2) { box.innerHTML = '<div class="hint">Equity curve appears once there are at least two daily snapshots.</div>'; return; }
    var vals = eq.map(function (p) { return p.equity; });
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals), W = 720, H = 140, padV = 8;
    var span = (max - min) || 1;
    var pts = vals.map(function (v, i) {
      var x = padV + i * (W - 2 * padV) / (vals.length - 1);
      var y = H - padV - (v - min) / span * (H - 2 * padV);
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    var up = vals[vals.length - 1] >= vals[0];
    box.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H + '">' +
      '<polyline fill="none" stroke="' + (up ? 'var(--green)' : 'var(--red)') + '" stroke-width="2" points="' + pts + '"/></svg>' +
      '<div class="hint">' + eq[0].date + ' → ' + eq[eq.length - 1].date + ' &middot; ' + fmtMoney(vals[0]) + ' → ' + fmtMoney(vals[vals.length - 1]) + '</div>';
  }

  /* ---------- calendar ---------- */
  var calState = { year: null, month: null };

  function renderCalendar() {
    var now = new Date();
    if (calState.year === null) { calState.year = now.getFullYear(); calState.month = now.getMonth(); }
    drawCalendar(calState.year, calState.month);
  }

  function buildDailyPnl() {
    var map = {};
    var positions = getPositions();
    positions.forEach(function (c) {
      if (c.status !== 'closed' || !c.netPnl) return;
      var legs = c.legs || [];
      // use last leg's closedOn date
      var closeDate = null;
      for (var i = legs.length - 1; i >= 0; i--) {
        if (legs[i].closedOn) { closeDate = legs[i].closedOn; break; }
      }
      if (!closeDate) return;
      if (!map[closeDate]) map[closeDate] = { pnl: 0, trades: [] };
      map[closeDate].pnl += (c.netPnl || 0);
      map[closeDate].trades.push(c);
    });
    return map;
  }

  function drawCalendar(year, month) {
    var grid = $('cal-grid');
    if (!grid) return;
    var monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    $('cal-month-label').textContent = monthNames[month] + ' ' + year;

    var dailyPnl = buildDailyPnl();
    var firstDay = new Date(year, month, 1).getDay(); // 0=Sun
    var daysInMonth = new Date(year, month + 1, 0).getDate();
    var daysInPrev = new Date(year, month, 0).getDate();

    var cells = [];
    // prev month fill
    for (var i = 0; i < firstDay; i++) {
      cells.push({ day: daysInPrev - firstDay + 1 + i, other: true });
    }
    // this month
    for (var d = 1; d <= daysInMonth; d++) {
      var iso = year + '-' + pad(month + 1) + '-' + pad(d);
      cells.push({ day: d, iso: iso, data: dailyPnl[iso] || null });
    }
    // next month fill
    var remaining = 42 - cells.length;
    for (var j = 1; j <= remaining; j++) {
      cells.push({ day: j, other: true });
    }

    grid.innerHTML = cells.map(function (cell) {
      if (cell.other) return '<div class="cal-cell other-month"><div class="cal-day">' + cell.day + '</div></div>';
      var hasPnl = cell.data && cell.data.pnl !== 0;
      var cls = 'cal-cell' + (hasPnl ? ' has-pnl ' + signClass(cell.data.pnl) : '');
      var pnlHtml = hasPnl ? '<div class="cal-pnl ' + signClass(cell.data.pnl) + '">' + fmtMoney(cell.data.pnl) + '</div>' : '';
      return '<div class="' + cls + '" data-iso="' + cell.iso + '">' +
        '<div class="cal-day">' + cell.day + '</div>' + pnlHtml + '</div>';
    }).join('');

    Array.prototype.forEach.call(grid.querySelectorAll('.cal-cell.has-pnl'), function (el) {
      el.onclick = function () { showCalDetail(el.getAttribute('data-iso'), dailyPnl); };
    });

    // monthly summary
    var monthPnl = 0, monthTrades = 0;
    Object.keys(dailyPnl).forEach(function (iso) {
      if (iso.startsWith(year + '-' + pad(month + 1))) {
        monthPnl += dailyPnl[iso].pnl;
        monthTrades += dailyPnl[iso].trades.length;
      }
    });
    var summary = $('cal-monthly-summary');
    if (summary) {
      if (monthTrades > 0) {
        summary.innerHTML = '<strong>' + monthNames[month] + ' ' + year + '</strong>: ' +
          monthTrades + ' closed trade' + (monthTrades !== 1 ? 's' : '') + ' · Total P&L: <span class="' + signClass(monthPnl) + '">' + fmtMoney(monthPnl) + '</span>';
        summary.className = '';
      } else {
        summary.textContent = 'No closed trades in ' + monthNames[month] + ' ' + year + '.';
        summary.className = 'hint';
      }
    }
  }

  function showCalDetail(iso, dailyPnl) {
    var detailBox = $('cal-detail');
    var dateLabel = $('cal-detail-date');
    var tb = $('cal-detail-table').querySelector('tbody');
    if (!dailyPnl[iso]) { detailBox.style.display = 'none'; return; }
    dateLabel.textContent = iso;
    tb.innerHTML = '';
    dailyPnl[iso].trades.forEach(function (c) {
      var r = (c.netPnl != null && c.riskBudget) ? c.netPnl / c.riskBudget : null;
      var tr = document.createElement('tr');
      tr.innerHTML = '<td>' + c.ticker + '</td>' +
        '<td>' + (c.exitReason || '-') + '</td>' +
        '<td>' + (c.legs.length - 1) + ' roll' + (c.legs.length !== 2 ? 's' : '') + '</td>' +
        '<td class="' + signClass(c.netPnl) + '">' + fmtMoney(c.netPnl) + '</td>' +
        '<td class="' + signClass(r) + '">' + (r != null ? (r > 0 ? '+' : '') + r.toFixed(2) + 'R' : '-') + '</td>';
      tb.appendChild(tr);
    });
    detailBox.style.display = 'block';
  }

  /* ---------- share banner ---------- */
  function updateShareBanner() {
    var banner = $('share-banner');
    if (!banner) return;
    var positions = getPositions();
    if (positions.length > 0) {
      var url = generateShareURL();
      if (url) {
        banner.style.display = 'flex';
        $('share-url-text').textContent = url.length > 80 ? url.slice(0, 77) + '...' : url;
        $('share-url-text').title = url;
      }
    } else {
      banner.style.display = 'none';
    }
  }

  /* ---------- settings ---------- */
  function renderExitRules() {
    var cfg = getConfig();
    var strategy = cfg.exitStrategy || 'standard';
    var rules = EXIT_STRATEGY_RULES[strategy] || EXIT_STRATEGY_RULES.standard;
    var box = $('exit-rules-display');
    if (!box) return;
    box.innerHTML = rules.map(function (r) {
      return '<div class="exit-rule">' +
        '<div class="exit-rule-badge">' + r.badge + ' ' + r.name + '</div>' +
        '<div class="exit-rule-body"><div>' + r.desc + '</div><div class="exit-rule-trigger">⏰ ' + r.trigger + '</div></div>' +
        '</div>';
    }).join('');
  }

  function onExitStrategyChange() {
    var strategy = $('s-exit-strategy').value;
    var preset = EXIT_PRESETS[strategy] || EXIT_PRESETS.standard;
    if (strategy !== 'custom') {
      $('s-atr-stop').value = preset.atrStopMult;
      $('s-atr-emerg').value = preset.atrEmergencyMult;
      $('s-dte-trigger').value = preset.dteRollTrigger;
      $('s-ru-dmin').value = preset.rollUpDeltaBand[0];
      $('s-ru-dmax').value = preset.rollUpDeltaBand[1];
    }
  }

  function loadSettings() {
    var c = getConfig();
    $('s-bal').value = c.accountBalance; $('s-risk').value = c.riskPct;
    $('s-exit-strategy').value = c.exitStrategy || 'standard';
    $('s-atr-stop').value = c.atrStopMult || 1;
    $('s-atr-emerg').value = c.atrEmergencyMult || 3;
    $('s-dte-trigger').value = c.dteRollTrigger || 7;
    $('s-ru-dmin').value = (c.rollUpDeltaBand || [0.65, 0.85])[0];
    $('s-ru-dmax').value = (c.rollUpDeltaBand || [0.65, 0.85])[1];
    $('s-p-opt').value = c.providers.optionsGreeks; $('s-p-eq').value = c.providers.equityPriceAtr; $('s-p-spy').value = c.providers.spyEma;
    $('s-fmp').value = lsGet('lct_fmp', ''); $('s-tproxy').value = lsGet('lct_tproxy', '');
    $('s-tlive').value = lsGet('lct_tlive', ''); $('s-ttok').value = lsGet('lct_ttok', '');
    $('s-tenv').value = lsGet('lct_tenv', 'prod'); $('s-tacct').value = lsGet('lct_tacct', '');
    $('s-akey').value = lsGet('lct_akey', ''); $('s-asec').value = lsGet('lct_asec', '');
    $('s-gh-owner').value = lsGet('lct_gh_owner', ''); $('s-gh-repo').value = lsGet('lct_gh_repo', '');
    $('s-gh-branch').value = lsGet('lct_gh_branch', 'main'); $('s-gh-pat').value = lsGet('lct_gh_pat', '');
    renderExitRules();
  }

  function saveSettings() {
    var c = getConfig();
    c.accountBalance = parseFloat($('s-bal').value) || c.accountBalance;
    c.riskPct = parseFloat($('s-risk').value) || c.riskPct;
    c.exitStrategy = $('s-exit-strategy').value;
    c.atrStopMult = parseFloat($('s-atr-stop').value) || 1;
    c.atrEmergencyMult = parseFloat($('s-atr-emerg').value) || 3;
    c.dteRollTrigger = parseInt($('s-dte-trigger').value) || 7;
    var dmin = parseFloat($('s-ru-dmin').value), dmax = parseFloat($('s-ru-dmax').value);
    c.rollUpDeltaBand = [isFinite(dmin) ? dmin : 0.65, isFinite(dmax) ? dmax : 0.85];
    c.providers = { optionsGreeks: $('s-p-opt').value, equityPriceAtr: $('s-p-eq').value, spyEma: $('s-p-spy').value };
    setConfig(c);
    lsSet('lct_fmp', $('s-fmp').value); lsSet('lct_tproxy', $('s-tproxy').value);
    lsSet('lct_tlive', $('s-tlive').value); lsSet('lct_ttok', $('s-ttok').value);
    lsSet('lct_tenv', $('s-tenv').value); lsSet('lct_tacct', $('s-tacct').value);
    lsSet('lct_akey', $('s-akey').value); lsSet('lct_asec', $('s-asec').value);
    lsSet('lct_gh_owner', $('s-gh-owner').value); lsSet('lct_gh_repo', $('s-gh-repo').value);
    lsSet('lct_gh_branch', $('s-gh-branch').value || 'main'); lsSet('lct_gh_pat', $('s-gh-pat').value);
    $('s-msg').textContent = 'Saved.'; setTimeout(function () { $('s-msg').textContent = ''; }, 2000);
    renderExitRules();
    render();
  }

  async function testConnection() {
    var box = $('s-test-msg'); box.className = 'hint'; box.textContent = 'testing (using the values in the fields above)...';
    var cfg = Object.assign({}, getConfig(), { providers: { optionsGreeks: $('s-p-opt').value, equityPriceAtr: $('s-p-eq').value, spyEma: $('s-p-spy').value } });
    var sec = {
      fmpKey: $('s-fmp').value, tradierProxy: $('s-tproxy').value, tradierLiveToken: $('s-tlive').value,
      tradierToken: $('s-ttok').value, tradierEnv: $('s-tenv').value, tradierAccount: $('s-tacct').value,
      alpacaKey: $('s-akey').value, alpacaSecret: $('s-asec').value
    };
    var p = DP.createProvider(cfg, sec), out = [];
    try { var q = await p.getStockQuote('SPY'); out.push('equity/' + cfg.providers.equityPriceAtr + ': OK ($' + fmt2(q.price) + ')'); }
    catch (e) { out.push('equity/' + cfg.providers.equityPriceAtr + ': ' + e.message); }
    try { var ex = await p.getExpirations('SPY'); out.push('options/' + cfg.providers.optionsGreeks + ': OK (' + ex.length + ' expirations)'); }
    catch (e) { out.push('options/' + cfg.providers.optionsGreeks + ': ' + e.message); }
    var bad = out.some(function (r) { return r.indexOf('OK') < 0; });
    box.className = bad ? 'err' : 'pos';
    box.textContent = out.join('   |   ') + (bad && /401/.test(out.join(' ')) ? '  — 401 = bad/empty token or sandbox key on the production host; check the environment toggle and the key.' : '');
  }

  /* ---------- tabs + init ---------- */
  function showTab(name) {
    Array.prototype.forEach.call(document.querySelectorAll('nav button'), function (b) { b.classList.toggle('active', b.getAttribute('data-tab') === name); });
    Array.prototype.forEach.call(document.querySelectorAll('main section'), function (s) { s.classList.toggle('active', s.id === name); });
    if (name === 'watchlist') ensureExpirations(false);
    if (name === 'calendar') renderCalendar();
  }

  function init() {
    // seed config from bundled config.json if not customized yet
    if (localStorage.getItem('lct_config') == null) {
      fetch('config.json').then(function (r) { return r.json(); }).then(function (j) { setConfig(j); loadSettings(); }).catch(function () {});
    }
    $('t-date').value = isoToday();
    // repair duplicate IDs
    setPositions(E.dedupeCampaignIds(getPositions()));

    // check for shared state in URL before rendering
    checkURLShare();

    // tabs
    Array.prototype.forEach.call(document.querySelectorAll('nav button'), function (b) { b.onclick = function () { showTab(b.getAttribute('data-tab')); }; });

    // positions tab
    $('t-load').onclick = loadChain;
    $('t-add').onclick = addSelected;
    $('t-prem').oninput = updateSelectSummary;
    $('t-exp').onchange = onExpiration;
    $('refresh').onclick = tick;
    $('pos-clear').onclick = clearAllPositions;

    // share banner (positions tab)
    $('copy-share-url').onclick = function () {
      var url = generateShareURL();
      if (!url) return;
      navigator.clipboard.writeText(url).then(function () {
        $('copy-share-url').textContent = '✅ Copied!';
        setTimeout(function () { $('copy-share-url').textContent = 'Copy link'; }, 2000);
      }).catch(function () {
        $('share-url-input').value = url;
        $('share-url-box').style.display = 'block';
      });
    };
    $('refresh-share-url').onclick = function () { updateShareBanner(); };

    // scorecard — nothing extra needed

    // calendar nav
    $('cal-prev').onclick = function () {
      calState.month--;
      if (calState.month < 0) { calState.month = 11; calState.year--; }
      drawCalendar(calState.year, calState.month);
    };
    $('cal-next').onclick = function () {
      calState.month++;
      if (calState.month > 11) { calState.month = 0; calState.year++; }
      drawCalendar(calState.year, calState.month);
    };

    // settings
    $('s-save').onclick = saveSettings;
    $('s-test').onclick = testConnection;
    $('s-exit-strategy').onchange = function () { onExitStrategyChange(); renderExitRules(); };
    $('gh-pull').onclick = pullFromRepo;
    $('gh-push').onclick = pushState;

    // settings share
    $('gen-share-url').onclick = function () {
      var url = generateShareURL();
      if (!url) { alert('No data to share yet.'); return; }
      $('share-url-input').value = url;
      $('share-url-box').style.display = 'block';
      navigator.clipboard.writeText(url).then(function () {
        $('gen-share-url').textContent = '✅ Link copied!';
        setTimeout(function () { $('gen-share-url').textContent = 'Generate shareable link'; }, 3000);
      }).catch(function () {});
    };
    $('import-share-url').onclick = function () {
      var url = prompt('Paste a shareable link:');
      if (!url) return;
      try {
        var params = new URLSearchParams(url.split('?')[1] || '');
        var share = params.get('share');
        if (!share) throw new Error('no share param');
        var ok = importSharePayload(share);
        if (ok) { alert('Data imported successfully!'); markSynced(); }
        else alert('Failed to import. The link may be invalid or corrupted.');
      } catch (e) {
        alert('Invalid link: ' + e.message);
      }
    };

    // watchlist
    $('w-add').onclick = addPasted;
    $('w-search-btn').onclick = doSearch;
    $('w-search').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
    $('w-refresh').onclick = refreshWatchlist;
    $('w-clear').onclick = clearWatchlist;
    $('w-copy-tickers').onclick = copyWatchlistTickers;

    loadSettings();
    render();
    ensureExpirations(false);

    // poll when keys configured
    setInterval(function () { if (secrets().fmpKey || secrets().tradierLiveToken || secrets().alpacaKey) tick(); }, 90000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.LCT = { tick: tick, render: render };
})();
