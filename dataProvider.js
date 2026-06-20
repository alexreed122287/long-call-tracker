/* Long-Call Tracker — pluggable market-data adapter.
 * One interface backed by Tradier / Alpaca / FMP, selected by config.providers.
 * HTTP is injectable (httpJson) so parsing is unit-testable without network. */
(function (factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.DataProvider = api;
})(function () {
  'use strict';

  function defaultHttpJson(url, headers) {
    return fetch(url, { headers: headers || {} }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
      return r.json();
    });
  }

  function _dte(todayISO, expISO) {
    return Math.round((Date.parse(expISO + 'T00:00:00Z') - Date.parse(todayISO + 'T00:00:00Z')) / 86400000);
  }

  /* ---------- pure parsers (exported for tests) ---------- */

  function parseFmpDaily(arr) {
    var rows = (arr || []).map(function (d) {
      return { date: d.date, o: +d.open, h: +d.high, l: +d.low, c: +d.close };
    });
    rows.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
    return rows;
  }

  function parseFmpIntradayAt(arr, etHHMM) {
    var rows = (arr || []).slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    var chosen = null;
    for (var i = 0; i < rows.length; i++) {
      var t = ((rows[i].date || '').split(' ')[1] || '').slice(0, 5);
      if (t <= etHHMM) chosen = rows[i]; else break;
    }
    if (!chosen) chosen = rows[rows.length - 1] || null;
    return chosen ? { price: +chosen.close } : null;
  }

  function parseFmpQuotePrice(a) {
    var q = (a || [])[0] || {};
    return { price: +q.price };
  }

  function parseFmpSearch(arr) {
    return (arr || []).map(function (x) { return { symbol: x.symbol, name: x.name || x.companyName || '' }; })
      .filter(function (x) { return x.symbol; });
  }

  function parseTradierHistory(json) {
    var d = json && json.history && json.history.day;
    if (!d) return [];
    if (!Array.isArray(d)) d = [d];
    return d.map(function (x) { return { date: x.date, o: +x.open, h: +x.high, l: +x.low, c: +x.close }; });
  }

  function parseTradierExpirations(json) {
    var d = json && json.expirations && json.expirations.date;
    if (!d) return [];
    if (!Array.isArray(d)) d = [d];
    return d.slice();
  }

  function parseTradierSearch(json) {
    var s = json && json.securities && json.securities.security;
    if (!s) return [];
    if (!Array.isArray(s)) s = [s];
    return s.map(function (x) { return { symbol: x.symbol, name: x.description || '' }; });
  }

  function parseTradierChain(json) {
    var o = json && json.options && json.options.option;
    if (!o) return [];
    if (!Array.isArray(o)) o = [o];
    var out = [];
    for (var i = 0; i < o.length; i++) {
      var x = o[i];
      if (x.option_type && x.option_type !== 'call') continue;
      var g = x.greeks || {};
      var bid = +x.bid || 0, ask = +x.ask || 0;
      out.push({
        strike: +x.strike, bid: bid, ask: ask,
        mark: (bid && ask) ? (bid + ask) / 2 : (+x.last || 0),
        delta: (g.delta != null) ? parseFloat(g.delta) : NaN,
        oi: +x.open_interest || 0,
        expiration: x.expiration_date, type: 'call'
      });
    }
    return out;
  }

  function parseTradierQuote(json) {
    var q = json && json.quotes && json.quotes.quote;
    if (Array.isArray(q)) q = q[0];
    if (!q) return null;
    var bid = +q.bid || 0, ask = +q.ask || 0, g = q.greeks || {};
    return {
      mark: (bid && ask) ? (bid + ask) / 2 : (+q.last || 0),
      delta: (g.delta != null) ? parseFloat(g.delta) : NaN,
      bid: bid, ask: ask, oi: +q.open_interest || 0
    };
  }

  function parseTradierQuotePrice(json) {
    var q = json && json.quotes && json.quotes.quote;
    if (Array.isArray(q)) q = q[0];
    return { price: q ? (+q.last || +q.close || 0) : 0 };
  }

  function parseAlpacaBars(json) {
    var bars = json && json.bars;
    if (bars && !Array.isArray(bars)) {
      var keys = Object.keys(bars);
      bars = keys.length ? bars[keys[0]] : [];
    }
    return (bars || []).map(function (b) {
      return { date: (b.t || '').slice(0, 10), o: +b.o, h: +b.h, l: +b.l, c: +b.c };
    });
  }

  function parseAlpacaTrade(json) {
    var t = json && json.trade;
    return { price: t ? +t.p : 0 };
  }

  /* ---------- provider factory ---------- */

  function createProvider(cfg, secrets, httpJson) {
    httpJson = httpJson || defaultHttpJson;
    secrets = secrets || {};
    var P = (cfg && cfg.providers) || {};
    var equity = P.equityPriceAtr || 'fmp';
    var options = P.optionsGreeks || 'tradier';
    var spy = P.spyEma || 'fmp';

    function fmpGet(path) {
      var url = 'https://financialmodelingprep.com/stable/' + path +
        (path.indexOf('?') >= 0 ? '&' : '?') + 'apikey=' + encodeURIComponent(secrets.fmpKey || '');
      return httpJson(url);
    }
    function tradierBase() {
      if (secrets.tradierProxy && secrets.tradierLiveToken) {
        return { base: secrets.tradierProxy, headers: { 'X-Live-Token': secrets.tradierLiveToken, 'Accept': 'application/json' } };
      }
      return { base: 'https://api.tradier.com', headers: { 'Authorization': 'Bearer ' + (secrets.tradierToken || ''), 'Accept': 'application/json' } };
    }
    function tradierGet(path) {
      var t = tradierBase();
      return httpJson(t.base + path, t.headers);
    }
    function alpacaGet(url) {
      return httpJson(url, { 'APCA-API-KEY-ID': secrets.alpacaKey || '', 'APCA-API-SECRET-KEY': secrets.alpacaSecret || '' });
    }

    function dailyBars(name, sym, from, to) {
      if (name === 'tradier') return tradierGet('/v1/markets/history?symbol=' + sym + '&interval=daily&start=' + from + '&end=' + to).then(parseTradierHistory);
      if (name === 'alpaca') return alpacaGet('https://data.alpaca.markets/v2/stocks/' + sym + '/bars?timeframe=1Day&start=' + from + '&end=' + to + '&limit=10000').then(parseAlpacaBars);
      return fmpGet('historical-price-eod/full?symbol=' + sym + '&from=' + from + '&to=' + to).then(parseFmpDaily);
    }

    return {
      getDailyBars: function (sym, from, to) {
        return dailyBars(sym === 'SPY' ? spy : equity, sym, from, to);
      },

      getStockQuote: function (sym) {
        if (equity === 'tradier') return tradierGet('/v1/markets/quotes?symbols=' + sym).then(parseTradierQuotePrice);
        if (equity === 'alpaca') return alpacaGet('https://data.alpaca.markets/v2/stocks/' + sym + '/trades/latest').then(parseAlpacaTrade);
        return fmpGet('quote?symbol=' + sym).then(parseFmpQuotePrice);
      },

      getStockPriceAt: function (sym, dateISO, etHHMM) {
        if (equity === 'tradier') {
          return tradierGet('/v1/markets/timesales?symbol=' + sym + '&interval=5min&start=' + dateISO + ' 09:30&end=' + dateISO + ' 16:00')
            .then(function (j) {
              var s = j && j.series && j.series.data; if (!Array.isArray(s)) s = s ? [s] : [];
              var rows = s.map(function (x) { return { date: x.time, close: x.close }; });
              return parseFmpIntradayAt(rows.map(function (r) { return { date: (r.date || '').replace('T', ' '), close: r.close }; }), etHHMM);
            });
        }
        if (equity === 'alpaca') {
          return alpacaGet('https://data.alpaca.markets/v2/stocks/' + sym + '/bars?timeframe=5Min&start=' + dateISO + 'T13:30:00Z&end=' + dateISO + 'T20:00:00Z&limit=200')
            .then(function (j) {
              var bars = parseAlpacaBars(j);
              return bars.length ? { price: bars[bars.length - 1].c } : null;
            });
        }
        return fmpGet('historical-chart/5min?symbol=' + sym + '&from=' + dateISO + '&to=' + dateISO).then(function (a) { return parseFmpIntradayAt(a, etHHMM); });
      },

      getOptionChain: function (sym, expiration) {
        if (options === 'tradier') return tradierGet('/v1/markets/options/chains?symbol=' + sym + '&expiration=' + expiration + '&greeks=true').then(parseTradierChain);
        if (options === 'alpaca') return alpacaGet('https://data.alpaca.markets/v1beta1/options/snapshots/' + sym + '?expiration_date=' + expiration + '&type=call&limit=1000').then(parseAlpacaOptionSnapshots(expiration));
        throw new Error('FMP does not support option chains; set providers.optionsGreeks to tradier or alpaca');
      },

      getOptionQuote: function (occSymbol) {
        if (options === 'tradier') return tradierGet('/v1/markets/quotes?symbols=' + occSymbol + '&greeks=true').then(parseTradierQuote);
        if (options === 'alpaca') return alpacaGet('https://data.alpaca.markets/v1beta1/options/snapshots?symbols=' + occSymbol).then(parseAlpacaOptionQuote(occSymbol));
        throw new Error('FMP does not support option quotes; set providers.optionsGreeks to tradier or alpaca');
      },

      searchSymbols: function (query) {
        var q = encodeURIComponent(query);
        if (equity === 'tradier') return tradierGet('/v1/markets/search?q=' + q + '&indexes=false').then(parseTradierSearch);
        if (equity === 'alpaca') return Promise.resolve([{ symbol: ('' + query).toUpperCase(), name: '' }]);
        return fmpGet('search-symbol?query=' + q + '&limit=10').then(parseFmpSearch);
      },

      getExpirations: function (sym) {
        if (options === 'tradier') return tradierGet('/v1/markets/options/expirations?symbol=' + sym).then(parseTradierExpirations);
        if (options === 'alpaca') {
          return alpacaGet('https://data.alpaca.markets/v1beta1/options/snapshots/' + sym + '?type=call&limit=1000').then(function (j) {
            var rows = parseAlpacaOptionSnapshots(null)(j), set = {};
            rows.forEach(function (c) { if (c.expiration) set[c.expiration] = 1; });
            return Object.keys(set).sort();
          });
        }
        throw new Error('FMP does not support option expirations; set providers.optionsGreeks to tradier or alpaca');
      },

      getOptionCandidates: function (sym, todayISO) {
        if (options === 'tradier') {
          return tradierGet('/v1/markets/options/expirations?symbol=' + sym).then(function (j) {
            var ex = j && j.expirations && j.expirations.date; if (!Array.isArray(ex)) ex = ex ? [ex] : [];
            var future = ex.filter(function (d) { return _dte(todayISO, d) > 0; }).slice(0, 5);
            return Promise.all(future.map(function (d) {
              return tradierGet('/v1/markets/options/chains?symbol=' + sym + '&expiration=' + d + '&greeks=true').then(parseTradierChain);
            })).then(function (chains) {
              var out = [];
              chains.forEach(function (chain) {
                chain.forEach(function (c) { c.dte = _dte(todayISO, c.expiration); out.push(c); });
              });
              return out;
            });
          });
        }
        if (options === 'alpaca') {
          return alpacaGet('https://data.alpaca.markets/v1beta1/options/snapshots/' + sym + '?type=call&limit=1000').then(function (j) {
            var rows = parseAlpacaOptionSnapshots(null)(j);
            rows.forEach(function (c) { c.dte = _dte(todayISO, c.expiration); });
            return rows.filter(function (c) { return c.dte > 0; });
          });
        }
        throw new Error('FMP does not support option candidates; set providers.optionsGreeks to tradier or alpaca');
      }
    };
  }

  function parseAlpacaOptionSnapshots(expiration) {
    return function (json) {
      var snaps = (json && json.snapshots) || {};
      var out = [];
      Object.keys(snaps).forEach(function (occ) {
        var s = snaps[occ] || {};
        var q = s.latestQuote || {}, g = s.greeks || {};
        var bid = +q.bp || 0, ask = +q.ap || 0;
        out.push({
          symbol: occ, strike: occStrike(occ), expiration: expiration || occExpiration(occ),
          bid: bid, ask: ask, mark: (bid && ask) ? (bid + ask) / 2 : 0,
          delta: (g.delta != null) ? +g.delta : NaN, oi: +s.openInterest || 0, type: 'call'
        });
      });
      return out;
    };
  }
  function parseAlpacaOptionQuote(occ) {
    return function (json) {
      var s = (json && json.snapshots && json.snapshots[occ]) || {};
      var q = s.latestQuote || {}, g = s.greeks || {};
      var bid = +q.bp || 0, ask = +q.ap || 0;
      return { mark: (bid && ask) ? (bid + ask) / 2 : 0, delta: (g.delta != null) ? +g.delta : NaN, bid: bid, ask: ask, oi: +s.openInterest || 0 };
    };
  }
  function occStrike(occ) { var m = occ.match(/[CP](\d{8})$/); return m ? (+m[1]) / 1000 : NaN; }
  function occExpiration(occ) { var m = occ.match(/(\d{6})[CP]\d{8}$/); if (!m) return null; var s = m[1]; return '20' + s.slice(0, 2) + '-' + s.slice(2, 4) + '-' + s.slice(4, 6); }

  return {
    createProvider: createProvider,
    defaultHttpJson: defaultHttpJson,
    parseFmpDaily: parseFmpDaily,
    parseFmpIntradayAt: parseFmpIntradayAt,
    parseFmpQuotePrice: parseFmpQuotePrice,
    parseFmpSearch: parseFmpSearch,
    parseTradierHistory: parseTradierHistory,
    parseTradierExpirations: parseTradierExpirations,
    parseTradierSearch: parseTradierSearch,
    parseTradierChain: parseTradierChain,
    parseTradierQuote: parseTradierQuote,
    parseTradierQuotePrice: parseTradierQuotePrice,
    parseAlpacaBars: parseAlpacaBars,
    parseAlpacaTrade: parseAlpacaTrade
  };
});
