(() => {
  "use strict";

  const state = {
    bots: [],
    quotes: {},
    positions: [],
    signals: [],
    equity: {},
    lastPrices: {},
  };

  const el = {
    connDot: document.getElementById("connDot"),
    connText: document.getElementById("connText"),
    botList: document.getElementById("botList"),
    quoteList: document.getElementById("quoteList"),
    equityNumber: document.getElementById("equityNumber"),
    equityPnl: document.getElementById("equityPnl"),
    equityPath: document.getElementById("equityPath"),
    equityFill: document.getElementById("equityFill"),
    equityChart: document.getElementById("equityChart"),
    gaugeGrid: document.getElementById("gaugeGrid"),
    modelGrid: document.getElementById("modelGrid"),
    positionsBody: document.getElementById("positionsBody"),
    signalFeed: document.getElementById("signalFeed"),
    scanlines: document.getElementById("scanlines"),
    cursorGlow: document.getElementById("cursorGlow"),
    candleChart: document.getElementById("candleChart"),
    candleSymbolSelect: document.getElementById("candleSymbolSelect"),
    tradesBody: document.getElementById("tradesBody"),
    leaderboardGrid: document.getElementById("leaderboardGrid"),
    leaderboardRefresh: document.getElementById("leaderboardRefresh"),
    tabBar: document.getElementById("tabBar"),
    summaryEquity: document.getElementById("summaryEquity"),
    summaryPnl: document.getElementById("summaryPnl"),
    summaryBots: document.getElementById("summaryBots"),
  };

  // -- cursor glow ---------------------------------------------------------

  window.addEventListener("mousemove", (e) => {
    el.cursorGlow.style.setProperty("--x", `${e.clientX}px`);
    el.cursorGlow.style.setProperty("--y", `${e.clientY}px`);
  });

  // -- tab navigation --------------------------------------------------------

  el.tabBar.addEventListener("click", (e) => {
    const btn = e.target.closest(".tab-btn");
    if (!btn) return;
    const tab = btn.dataset.tab;

    el.tabBar.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".stage").forEach((s) => s.classList.toggle("active", s.dataset.tab === tab));

    if (tab === "signals") refreshCandles();
    if (tab === "performance") refreshTrades();
  });

  // -- odometer-style number tween -----------------------------------------

  function tweenNumber(node, from, to, durationMs, formatFn) {
    const start = performance.now();
    function frame(now) {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      const value = from + (to - from) * eased;
      node.textContent = formatFn(value);
      if (t < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function animateMoney(node, newValue) {
    const prev = parseFloat(node.dataset.value || newValue);
    node.dataset.value = newValue;
    tweenNumber(node, prev, newValue, 600, (v) => `$${v.toFixed(2)}`);
  }

  function pulseScanlines(side) {
    el.scanlines.classList.add("pulse");
    setTimeout(() => el.scanlines.classList.remove("pulse"), 2000);

    const surge = document.createElement("div");
    surge.className = "data-surge" + (side === "sell" ? " sell" : "");
    document.body.appendChild(surge);
    surge.addEventListener("animationend", () => surge.remove());
  }

  function tweenPercent(node, newValue) {
    const prev = parseFloat(node.dataset.value || newValue);
    node.dataset.value = newValue;
    tweenNumber(node, prev, newValue, 600, (v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);
  }

  // -- bots ------------------------------------------------------------------

  function renderBots() {
    el.botList.innerHTML = "";
    for (const bot of state.bots) {
      const card = document.createElement("div");
      const active = !bot.paused && bot.open_positions > 0;
      card.className = "bot-card" + (bot.paused ? " paused" : "") + (active ? " active" : "");
      card.innerHTML = `
        <div class="bot-card-top">
          <span class="bot-name">${bot.bot_id}</span>
          <span class="dot ${bot.paused ? "" : "live"}"></span>
        </div>
        <div class="bot-desc">${bot.description}</div>
        <div class="bot-equity" data-value="${bot.equity ?? 0}">$${(bot.equity ?? 0).toFixed(2)}</div>
        <button class="bot-toggle" data-bot="${bot.bot_id}" data-action="${bot.paused ? "resume" : "pause"}">
          ${bot.paused ? "RESUME" : "PAUSE"}
        </button>
      `;
      el.botList.appendChild(card);
    }
    el.botList.querySelectorAll(".bot-toggle").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const botId = btn.dataset.bot;
        const action = btn.dataset.action;
        await fetch(`/api/bots/${botId}/${action}`, { method: "POST" });
        await refreshBots();
      });
    });

    if (state.bots.length) {
      const total = state.bots.reduce((sum, b) => sum + (b.equity || 0), 0);
      const totalStart = state.bots.reduce((sum, b) => sum + (b.wallet ? b.wallet.starting_balance : 0), 0);
      const pnlPct = totalStart ? ((total - totalStart) / totalStart) * 100 : 0;

      animateMoney(el.equityNumber, total);
      el.equityPnl.textContent = `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`;
      el.equityPnl.className = "equity-pnl " + (pnlPct >= 0 ? "positive" : "negative");

      animateMoney(el.summaryEquity, total);
      el.summaryPnl.textContent = `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`;
      el.summaryPnl.className = "summary-pnl " + (pnlPct >= 0 ? "positive" : "negative");
    }

    el.summaryBots.innerHTML = state.bots
      .map((bot) => {
        const active = !bot.paused && bot.open_positions > 0;
        const dotCls = bot.paused ? "" : active ? "live" : "idle";
        return `<span class="summary-bot-pill"><span class="dot ${dotCls}"></span>${bot.bot_id}</span>`;
      })
      .join("");
  }

  async function refreshBots() {
    const res = await fetch("/api/bots");
    state.bots = await res.json();
    renderBots();
  }

  // -- quotes ------------------------------------------------------------------

  function renderQuotes() {
    el.quoteList.innerHTML = "";
    for (const [symbol, quote] of Object.entries(state.quotes)) {
      if (!quote) continue;
      const prev = state.lastPrices[symbol];
      const direction = prev == null ? "" : quote.price > prev ? "up" : quote.price < prev ? "down" : "";
      state.lastPrices[symbol] = quote.price;

      const row = document.createElement("div");
      row.className = "quote-row";
      row.style.borderLeftColor = direction === "up" ? "var(--cyan)" : direction === "down" ? "var(--red)" : "var(--muted)";
      row.innerHTML = `
        <span class="quote-symbol">${symbol}</span>
        <span class="quote-price ${direction}">$${quote.price.toFixed(quote.price < 10 ? 6 : 2)}</span>
      `;
      el.quoteList.appendChild(row);
    }
  }

  async function refreshQuotes() {
    const res = await fetch("/api/quotes");
    state.quotes = await res.json();
    renderQuotes();
  }

  // -- equity chart --------------------------------------------------------

  const CHART_POINTS = 60;

  function resample(points, n) {
    if (points.length === 0) return new Array(n).fill(0);
    if (points.length === 1) return new Array(n).fill(points[0].equity);
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const idx = t * (points.length - 1);
      const lo = Math.floor(idx);
      const hi = Math.min(points.length - 1, lo + 1);
      const frac = idx - lo;
      out.push(points[lo].equity + (points[hi].equity - points[lo].equity) * frac);
    }
    return out;
  }

  function renderEquityChart(points) {
    const values = resample(points, CHART_POINTS);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const w = 800;
    const h = 260;
    const step = w / (CHART_POINTS - 1);

    const coords = values.map((v, i) => [i * step, h - ((v - min) / range) * (h - 20) - 10]);
    const line = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    const fill = `${line} L${w},${h} L0,${h} Z`;

    el.equityPath.setAttribute("d", line);
    el.equityFill.setAttribute("d", fill);

    if (!document.getElementById("equityGradient")) {
      const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
      defs.innerHTML = `
        <linearGradient id="equityGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#00f5ff" stop-opacity="0.6" />
          <stop offset="100%" stop-color="#00f5ff" stop-opacity="0" />
        </linearGradient>
      `;
      el.equityChart.prepend(defs);
    }
  }

  async function refreshEquity() {
    if (!state.bots.length) return;
    const allPoints = [];
    for (const bot of state.bots) {
      const res = await fetch(`/api/equity/${bot.bot_id}?hours=24`);
      const rows = await res.json();
      state.equity[bot.bot_id] = rows;
    }
    const bucket = new Map();
    for (const rows of Object.values(state.equity)) {
      for (const row of rows) {
        const key = Math.round(row.ts / 60);
        bucket.set(key, (bucket.get(key) || 0) + row.equity);
      }
    }
    const merged = [...bucket.entries()].sort((a, b) => a[0] - b[0]).map(([ts, equity]) => ({ ts, equity }));
    renderEquityChart(merged);
  }

  // -- ML gauges --------------------------------------------------------------

  function renderGauges(symbols, scores) {
    el.gaugeGrid.innerHTML = "";
    for (const symbol of symbols) {
      const score = scores[symbol];
      const hasScore = score !== undefined;
      const deg = hasScore ? Math.max(-90, Math.min(90, score * 90)) : 0;
      const color = score > 0 ? "var(--cyan)" : "var(--red)";
      const glow = hasScore ? Math.min(1, Math.abs(score)) : 0;

      const wrap = document.createElement("div");
      wrap.className = "gauge";
      wrap.innerHTML = `
        <div class="gauge-symbol">${symbol}</div>
        <svg width="150" height="88" viewBox="0 0 150 88">
          <path d="M12,75 A63,63 0 0 1 138,75" fill="none" stroke="#22262f" stroke-width="8" />
          <line class="gauge-arc-needle" x1="75" y1="75" x2="75" y2="18"
                stroke="${hasScore ? color : "var(--muted)"}" stroke-width="4"
                style="transform: rotate(${deg}deg); filter: drop-shadow(0 0 ${6 + glow * 16}px ${hasScore ? color : "transparent"});" />
          <circle cx="75" cy="75" r="5" fill="${hasScore ? color : "var(--muted)"}" />
        </svg>
        <div class="gauge-score">${hasScore ? score.toFixed(2) : "NO SIGNAL"}</div>
      `;
      el.gaugeGrid.appendChild(wrap);
    }
  }

  // -- model readout (what the ML model is watching) --------------------------

  // turn raw feature names into something a human can read
  function featLabel(name) {
    const MAP = {
      "BBU_20_2.0_2.0": "Near recent high",
      "BBL_20_2.0_2.0": "Near recent low",
      "BBM_20_2.0_2.0": "Distance from average price",
      "BBB_20_2.0_2.0": "How wide the price range is",
      "BBP_20_2.0_2.0": "Where price sits in its range",
      "MACD_12_26_9": "Momentum trend",
      "MACDh_12_26_9": "Momentum strength",
      "MACDs_12_26_9": "Momentum direction",
      "rsi_14": "Overbought / oversold gauge",
      "atr_14": "Typical price swing size",
      "atr_pct": "Swing size vs price",
      "volume_zscore_12": "Unusual trading volume",
    };
    if (MAP[name]) return MAP[name];
    let m;
    if ((m = name.match(/^volatility_(\d+)$/))) return `Choppiness (last ${m[1]}h)`;
    if ((m = name.match(/^return_(\d+)$/))) return `Price change (last ${m[1]}h)`;
    return name; // fall back to the raw name if unmapped
  }

  function renderModelReadout(entries) {
    el.modelGrid.innerHTML = "";
    for (const entry of entries) {
      const card = document.createElement("div");
      card.className = "model-card";
      const exp = entry.explain;

      if (!entry.enabled || !exp) {
        card.innerHTML = `
          <div class="model-symbol">${entry.symbol}</div>
          <div class="model-empty">${entry.enabled ? "WARMING UP" : "NO MODEL"}</div>`;
        el.modelGrid.appendChild(card);
        continue;
      }

      const { up, flat, down } = exp.proba;
      const pct = (v) => `${(v * 100).toFixed(0)}%`;
      const bars = exp.top_features
        .map((f) => {
          const w = Math.min(1, f.weight / (exp.top_features[0].weight || 1));
          return `<div class="feat-row" title="${f.name} (${(f.weight * 100).toFixed(1)}%)">
              <div class="feat-name">${featLabel(f.name)}</div>
              <div class="feat-barline">
                <span class="feat-track"><span class="feat-fill" style="width:${(w * 100).toFixed(0)}%"></span></span>
                <span class="feat-val">${(f.weight * 100).toFixed(0)}%</span>
              </div>
            </div>`;
        })
        .join("");

      card.innerHTML = `
        <div class="model-head">
          <span class="model-symbol">${entry.symbol}</span>
          <span class="model-score ${exp.score >= 0 ? "pos" : "neg"}">${exp.score >= 0 ? "+" : ""}${exp.score.toFixed(2)}</span>
        </div>
        <div class="proba-bar" title="up ${pct(up)} / flat ${pct(flat)} / down ${pct(down)}">
          <span class="proba-up" style="width:${up * 100}%"></span>
          <span class="proba-flat" style="width:${flat * 100}%"></span>
          <span class="proba-down" style="width:${down * 100}%"></span>
        </div>
        <div class="proba-legend">
          <span class="pos">▲ ${pct(up)}</span>
          <span class="muted">■ ${pct(flat)}</span>
          <span class="neg">▼ ${pct(down)}</span>
        </div>
        <div class="feat-label">TOP SIGNALS</div>
        <div class="feat-list">${bars}</div>`;
      el.modelGrid.appendChild(card);
    }
  }

  async function refreshModelReadout() {
    try {
      const res = await fetch("/api/ml/explain");
      renderModelReadout(await res.json());
    } catch (_) { /* leave last render in place */ }
  }

  function latestMlScores() {
    const scores = {};
    for (const sig of state.signals) {
      if (sig.rule !== "ml_indicator") continue;
      if (scores[sig.symbol] !== undefined) continue; // signals are newest-first
      let details = sig.details_json;
      try { details = JSON.parse(details); } catch (_) { /* already an object */ }
      if (details && typeof details.ml_score === "number") scores[sig.symbol] = details.ml_score;
    }
    return scores;
  }

  // -- positions --------------------------------------------------------------

  function renderPositions() {
    if (!state.positions.length) {
      el.positionsBody.innerHTML = `<tr class="empty-row"><td colspan="5">NO OPEN POSITIONS</td></tr>`;
      return;
    }
    el.positionsBody.innerHTML = state.positions
      .map((p) => {
        const current = p.current_price ?? p.avg_entry_price;
        const pnlPct = ((current - p.avg_entry_price) / p.avg_entry_price) * 100;
        const cls = pnlPct >= 0 ? "pnl-positive" : "pnl-negative";
        return `<tr>
          <td>${p.symbol}</td>
          <td>${p.qty.toFixed(6)}</td>
          <td>$${p.avg_entry_price.toFixed(2)}</td>
          <td>$${current.toFixed(2)}</td>
          <td class="${cls}">${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%</td>
        </tr>`;
      })
      .join("");
  }

  async function refreshPositions() {
    const res = await fetch("/api/positions?status=open");
    state.positions = await res.json();
    renderPositions();
  }

  // -- trade history --------------------------------------------------------------

  function renderTrades(trades) {
    if (!trades.length) {
      el.tradesBody.innerHTML = `<tr class="empty-row"><td colspan="8">NO TRADES YET</td></tr>`;
      return;
    }
    el.tradesBody.innerHTML = trades
      .map((t) => {
        const pnlCls = t.realized_pnl_usd > 0 ? "pnl-positive" : t.realized_pnl_usd < 0 ? "pnl-negative" : "";
        return `<tr>
          <td>${t.bot_id || ""}</td>
          <td>${t.symbol}</td>
          <td class="trade-side ${t.side}">${t.side.toUpperCase()}</td>
          <td>${t.qty.toFixed(6)}</td>
          <td>$${t.price.toFixed(2)}</td>
          <td class="${pnlCls}">${t.realized_pnl_usd ? "$" + t.realized_pnl_usd.toFixed(2) : "--"}</td>
          <td>${t.close_reason || "--"}</td>
          <td>${new Date(t.ts * 1000).toLocaleTimeString()}</td>
        </tr>`;
      })
      .join("");
  }

  async function refreshTrades() {
    const all = [];
    for (const bot of state.bots) {
      const res = await fetch(`/api/trades?bot_id=${bot.bot_id}&limit=20`);
      const trades = await res.json();
      for (const t of trades) t.bot_id = bot.bot_id;
      all.push(...trades);
    }
    all.sort((a, b) => b.ts - a.ts);
    renderTrades(all.slice(0, 30));
  }

  // -- backtest leaderboard --------------------------------------------------------

  function renderLeaderboard(results) {
    el.leaderboardGrid.innerHTML = "";
    for (const r of results) {
      const card = document.createElement("div");
      if (r.error) {
        card.className = "leaderboard-card";
        card.innerHTML = `
          <div class="leaderboard-name">${r.strategy}</div>
          <div class="leaderboard-stats">${r.error}</div>
        `;
        el.leaderboardGrid.appendChild(card);
        continue;
      }
      const positive = r.total_return_pct >= 0;
      card.className = "leaderboard-card " + (positive ? "positive" : "negative");
      card.innerHTML = `
        <div class="leaderboard-name">${r.strategy}</div>
        <div class="leaderboard-return ${positive ? "positive" : "negative"}" data-value="0">+0.00%</div>
        <div class="leaderboard-stats">
          <span>WIN ${r.win_rate.toFixed(0)}%</span>
          <span>DD ${r.max_drawdown_pct.toFixed(1)}%</span>
          <span>${r.trade_count} TRADES</span>
        </div>
      `;
      el.leaderboardGrid.appendChild(card);
      tweenPercent(card.querySelector(".leaderboard-return"), r.total_return_pct);
    }
  }

  async function refreshLeaderboard(force = false) {
    const res = await fetch(`/api/leaderboard${force ? "?force=true" : ""}`);
    const results = await res.json();
    renderLeaderboard(results);
  }

  el.leaderboardRefresh.addEventListener("click", () => refreshLeaderboard(true));

  // -- signal feed --------------------------------------------------------------

  // friendly names for the bot/rule that fired a signal
  const RULE_LABELS = {
    ml_indicator: "AI model",
    candlestick: "Chart-pattern bot",
    candlestick_confluence: "Chart-pattern bot",
    trend_pullback: "Trend bot",
    momentum: "Momentum bot",
    volume_spike: "Volume bot",
  };

  function plainSignal(sig) {
    const coin = sig.symbol.replace("USDT", "");
    const who = RULE_LABELS[sig.rule] || "A bot";
    const conf = Math.round(sig.strength * 100);
    let sure = "has a slight hunch";
    if (conf >= 75) sure = "is very confident";
    else if (conf >= 50) sure = "is fairly confident";
    else if (conf >= 35) sure = "leans toward thinking";
    const move =
      sig.direction === "bullish" ? "will go UP" :
      sig.direction === "bearish" ? "will go DOWN" : "will move";
    return `${who} ${sure} ${coin} ${move}`;
  }

  function renderSignals() {
    if (!state.signals.length) {
      el.signalFeed.innerHTML = `<div class="empty-state">No predictions yet — the bots are watching the market and waiting for a good setup.</div>`;
    } else {
      el.signalFeed.innerHTML = state.signals
        .slice(0, 20)
        .map((sig) => {
          let details = sig.details_json;
          try { details = JSON.parse(details); } catch (_) { /* already an object */ }
          const detailStr = details ? Object.entries(details).map(([k, v]) => `${k}=${v}`).join(" ") : "";
          const time = new Date(sig.ts * 1000).toLocaleTimeString();
          const conf = (sig.strength * 100).toFixed(0);
          const techTip = `${sig.rule} // ${sig.direction} // ${conf}% // ${detailStr}`;
          return `<div class="signal-row ${sig.direction}" title="${techTip}">
            <span class="signal-plain">${plainSignal(sig)}</span>
            <span class="signal-meta">${conf}% sure · ${time}</span>
          </div>`;
        })
        .join("");
    }
    renderGauges(Object.keys(state.quotes), latestMlScores());
  }

  async function refreshSignals() {
    const res = await fetch("/api/signals?hours=24");
    state.signals = await res.json();
    renderSignals();
  }

  function addLiveSignal(payload) {
    state.signals.unshift({
      ts: Date.now() / 1000,
      rule: payload.rule,
      symbol: payload.symbol,
      direction: payload.direction,
      strength: payload.strength,
      details_json: payload.details,
    });
    renderSignals();
    const row = el.signalFeed.firstElementChild;
    if (row) {
      const ring = document.createElement("span");
      ring.className = "pulse-ring";
      row.appendChild(ring);
      if (payload.strength > 0.7) {
        const echo = document.createElement("span");
        echo.className = "pulse-ring echo";
        row.appendChild(echo);
      }
    }
  }

  // -- websocket --------------------------------------------------------------

  function connectWs() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);

    ws.onopen = () => {
      el.connDot.classList.add("live");
      el.connDot.classList.remove("down");
      el.connText.textContent = "LIVE";
    };
    ws.onclose = () => {
      el.connDot.classList.remove("live");
      el.connDot.classList.add("down");
      el.connText.textContent = "RECONNECTING";
      setTimeout(connectWs, 2000);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "tick") {
        state.quotes[msg.payload.symbol] = { price: msg.payload.price, ts: msg.payload.ts };
        renderQuotes();
      } else if (msg.type === "signal") {
        addLiveSignal(msg.payload);
      } else if (msg.type === "trade") {
        pulseScanlines(msg.payload.side);
        refreshBots();
        refreshPositions();
        refreshTrades();
      }
    };
  }

  // -- candlestick chart (TradingView Lightweight Charts) -----------------------
  // Rendering only -- data still comes from our own /api/candles (Binance-backed).
  // Chart/series/marker-plugin are created once and reused across refreshes so
  // the user's zoom/pan/crosshair state survives a data update.

  let currentCandleSymbol = "BTCUSDT";
  let lwChart = null;
  let lwSeries = null;
  let lwMarkersPlugin = null;
  let lwPriceLines = [];

  function ensureCandleChart() {
    if (lwChart) return;
    lwChart = LightweightCharts.createChart(el.candleChart, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: "#8892a4",
        fontFamily: "JetBrains Mono, monospace",
      },
      grid: {
        vertLines: { color: "rgba(0, 245, 255, 0.05)" },
        horzLines: { color: "rgba(0, 245, 255, 0.05)" },
      },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      rightPriceScale: { borderColor: "rgba(0, 245, 255, 0.15)" },
      timeScale: { borderColor: "rgba(0, 245, 255, 0.15)", timeVisible: true },
    });
    lwSeries = lwChart.addSeries(LightweightCharts.CandlestickSeries, {
      upColor: "#00f5ff",
      downColor: "#ff003c",
      borderVisible: false,
      wickUpColor: "#00f5ff",
      wickDownColor: "#ff003c",
    });
    lwMarkersPlugin = LightweightCharts.createSeriesMarkers(lwSeries, []);
  }

  function renderCandleChart(data) {
    ensureCandleChart();
    const bars = data.bars || [];
    if (!bars.length) return;

    // The chart can be created while its tab is hidden (display:none), where
    // autoSize's ResizeObserver hasn't fired yet -- force a synchronous
    // resize to the container's current visible box before touching the
    // time scale, or fitContent() below computes a zoom level against a
    // stale/zero width and candles end up bunched at one edge.
    const rect = el.candleChart.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      lwChart.resize(rect.width, rect.height);
    }

    lwSeries.setData(
      bars.map((b) => ({ time: Math.floor(b.ts), open: b.open, high: b.high, low: b.low, close: b.close }))
    );

    lwPriceLines.forEach((pl) => lwSeries.removePriceLine(pl));
    lwPriceLines = (data.levels || []).map((level) =>
      lwSeries.createPriceLine({
        price: level,
        color: "rgba(136, 146, 164, 0.6)",
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: false,
      })
    );

    const markers = (data.markers || [])
      .map((m) => ({
        time: Math.floor(m.ts),
        position: m.direction === "bullish" ? "belowBar" : "aboveBar",
        shape: m.direction === "bullish" ? "arrowUp" : "arrowDown",
        color: m.direction === "bullish" ? "#00f5ff" : "#ff003c",
        text: m.pattern || "",
      }))
      .sort((a, b) => a.time - b.time);
    lwMarkersPlugin.setMarkers(markers);

    lwChart.timeScale().fitContent();
  }

  async function refreshCandles() {
    const res = await fetch(`/api/candles?symbol=${currentCandleSymbol}&limit=120`);
    const data = await res.json();
    renderCandleChart(data);
  }

  el.candleSymbolSelect.addEventListener("change", () => {
    currentCandleSymbol = el.candleSymbolSelect.value;
    refreshCandles();
  });

  // -- boot --------------------------------------------------------------------

  async function boot() {
    await refreshBots();
    await refreshQuotes();
    await refreshPositions();
    await refreshSignals();
    await refreshEquity();
    await refreshCandles();
    await refreshTrades();
    refreshLeaderboard(); // don't block boot on a multi-backtest run
    refreshModelReadout();
    connectWs();

    setInterval(refreshBots, 15000);
    setInterval(refreshPositions, 8000);
    setInterval(refreshSignals, 20000);
    setInterval(refreshEquity, 30000);
    setInterval(refreshCandles, 30000);
    setInterval(refreshLeaderboard, 120000);
    setInterval(refreshModelReadout, 60000);
  }

  boot();
})();
