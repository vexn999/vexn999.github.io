/* CryptoDeck SPA — hash router + WebSocket live state. No frameworks, no build. */
"use strict";

const view = document.getElementById("view");
const connEl = document.getElementById("conn");
let state = null;          // latest overview push from /ws
let route = { page: "overview", arg: null };
let liveTimer = null;      // per-page auto-refresh; cleared on every route change
const typedEvents = new Set();   // event timestamps already typewriter-animated (Stark theme)

/* ---------- themes ---------- */

const THEMES = { cyberpunk: "Cyberpunk Futurism (端末)", synthwave: "Synthwave",
                 stark: "Stark HUD (Mark-VII)" };
const KANA = "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン";
const KANA_COLORS = ["#0a2a30", "#0d1f35", "#12082a", "#0a2a20"];
let rainTimer = null;

function drawKanaRain() {
  const canvas = document.getElementById("kana-rain");
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth, h = window.innerHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  for (let i = 0; i < 18; i++) {   // the classic widget: re-randomised glyphs
    ctx.font = `bold ${8 + Math.floor(Math.random() * 7)}px "Courier New", monospace`;
    ctx.fillStyle = KANA_COLORS[Math.floor(Math.random() * KANA_COLORS.length)];
    ctx.fillText(KANA[Math.floor(Math.random() * KANA.length)],
                 Math.random() * w, Math.random() * h);
  }
}

function applyTheme(name) {
  if (!THEMES[name]) name = "cyberpunk";
  document.body.className = "theme-" + name;
  localStorage.setItem("cd_theme", name);
  clearInterval(rainTimer); rainTimer = null;
  const canvas = document.getElementById("kana-rain");
  if (name === "cyberpunk") {
    drawKanaRain();
    rainTimer = setInterval(() => { if (!document.hidden) drawKanaRain(); }, 2800);
  } else if (canvas) {
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
  }
}
applyTheme(localStorage.getItem("cd_theme") || "cyberpunk");

/* ---------- HUD sound (synthesized, no asset files) ---------- */

let audioCtx = null;
function initAudio() {
  if (audioCtx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) audioCtx = new AC();
}
window.addEventListener("pointerdown", initAudio, { once: true });
window.addEventListener("keydown", initAudio, { once: true });

function isMuted() { return localStorage.getItem("cd_sound_muted") === "1"; }

function playBeep(kind) {
  if (isMuted() || !audioCtx) return;
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain); gain.connect(audioCtx.destination);
  if (kind === "trade") {
    osc.type = "square"; osc.frequency.setValueAtTime(880, now);
    osc.frequency.exponentialRampToValueAtTime(1320, now + 0.08);
    gain.gain.setValueAtTime(0.05, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    osc.start(now); osc.stop(now + 0.2);
  } else {   // "signal" — softer, lower chirp
    osc.type = "sine"; osc.frequency.setValueAtTime(520, now);
    gain.gain.setValueAtTime(0.04, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    osc.start(now); osc.stop(now + 0.14);
  }
}

/* ---------- utilities ---------- */

const fmtUsd = (v, digits) => {
  if (v == null) return "—";
  if (digits == null) digits = v >= 1000 ? 0 : v >= 1 ? 2 : 6;
  return "$" + Number(v).toLocaleString("en-US", { maximumFractionDigits: digits });
};
const fmtPct = v => v == null ? "—"
  : `<span class="${v >= 0 ? "up" : "down"}">${v >= 0 ? "+" : ""}${v.toFixed(2)}%</span>`;
const fmtTime = ts => new Date(ts * 1000).toLocaleTimeString();
const esc = s => String(s ?? "").replace(/[&<>"]/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function api(path, opts) {
  const r = await fetch("/api" + path, opts);
  return r.json();
}
async function post(path, body) {
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
}

/* Tiny markdown renderer for AI reports (headings, bold, italics, lists, hr). */
function mdToHtml(md) {
  const lines = esc(md).split("\n");
  let html = "", inList = false;
  for (const line of lines) {
    const li = line.match(/^\s*[-*]\s+(.*)/);
    if (li) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${inline(li[1])}</li>`;
      continue;
    }
    if (inList) { html += "</ul>"; inList = false; }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) html += `<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`;
    else if (/^\s*---+\s*$/.test(line)) html += "<hr>";
    else if (line.trim()) html += `<p>${inline(line)}</p>`;
  }
  if (inList) html += "</ul>";
  return html;
  function inline(s) {
    return s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
            .replace(/\*(.+?)\*/g, "<i>$1</i>")
            .replace(/`(.+?)`/g, "<code>$1</code>");
  }
}

function sparkline(canvas, points, color) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 220, h = canvas.clientHeight || 36;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  if (!points || points.length < 2) return;
  const min = Math.min(...points), max = Math.max(...points), span = max - min || 1;
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = (i / (points.length - 1)) * w;
    const y = h - 3 - ((p - min) / span) * (h - 6);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
}

function lineChart(canvas, pairs, opts) {   // pairs: [[ts, y], ...], time-scaled x
  opts = opts || {};
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 800, h = canvas.clientHeight || 260;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  if (!pairs || pairs.length < 2) {
    ctx.fillStyle = "#8f87c0"; ctx.font = "13px sans-serif";
    ctx.fillText(opts.empty || "Collecting history… check back soon.", 16, h / 2);
    return;
  }
  const t0 = pairs[0][0], t1 = pairs[pairs.length - 1][0];
  const tSpan = t1 - t0 || 1;
  const ys = pairs.map(p => p[1]);
  let min = Math.min(...ys), max = Math.max(...ys);
  (opts.markers || []).forEach(m => {              // keep markers inside the scale
    if (m.ts >= t0 && m.ts <= t1) { min = Math.min(min, m.price); max = Math.max(max, m.price); }
  });
  const span = max - min || 1;
  const X = ts => ((ts - t0) / tSpan) * w;
  const Y = v => h - 8 - ((v - min) / span) * (h - 20);

  ctx.strokeStyle = "#322a66";
  for (let i = 1; i < 4; i++) {
    ctx.beginPath(); ctx.moveTo(0, h * i / 4); ctx.lineTo(w, h * i / 4); ctx.stroke();
  }
  ctx.beginPath();
  pairs.forEach((p, i) => i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1])));
  ctx.strokeStyle = opts.color || "#00e5ff"; ctx.lineWidth = 2; ctx.stroke();

  // live tip: pulse dot on the newest point
  if (opts.live) {
    const lx = X(t1), ly = Y(pairs[pairs.length - 1][1]);
    ctx.beginPath(); ctx.arc(lx, ly, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = opts.color || "#00e5ff"; ctx.fill();
  }

  // trade markers: ▲ buy (green, below the line) ▼ sell (red, above)
  (opts.markers || []).forEach(m => {
    if (m.ts < t0 || m.ts > t1) return;
    const x = X(m.ts), y = Y(m.price);
    ctx.beginPath();
    if (m.side === "buy") {
      ctx.moveTo(x, y + 4); ctx.lineTo(x - 5, y + 12); ctx.lineTo(x + 5, y + 12);
      ctx.fillStyle = "#2bffb0";
    } else {
      ctx.moveTo(x, y - 4); ctx.lineTo(x - 5, y - 12); ctx.lineTo(x + 5, y - 12);
      ctx.fillStyle = "#ff5470";
    }
    ctx.closePath(); ctx.fill();
  });

  ctx.fillStyle = "#8f87c0"; ctx.font = "11px sans-serif";
  ctx.fillText(fmtUsd(max), 6, 12);
  ctx.fillText(fmtUsd(min), 6, h - 4);
}

/* ---------- heatmap + gauge (dataviz: diverging w/ neutral midpoint, labels on tiles) ---------- */

const hexToRgb = h => {
  const m = h.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return [128, 128, 128];
  const n = parseInt(m[1], 16);
  return [n >> 16 & 255, n >> 8 & 255, n & 255];
};
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const rgbCss = c => `rgb(${c[0]},${c[1]},${c[2]})`;

function themeVar(name) {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

function heatColor(pct) {
  // diverging: neutral dark midpoint → theme up/down pole, saturating at ±5%
  const neutral = [16, 20, 32];
  const t = Math.max(-1, Math.min(1, (pct || 0) / 5));
  const pole = hexToRgb(themeVar(t >= 0 ? "--up" : "--down"));
  const c = mix(neutral, pole, Math.abs(t));
  const ink = Math.abs(t) > 0.6 ? "#04040f" : themeVar("--text");
  return { bg: rgbCss(c), ink };
}

function renderHeatmap(container, rows) {
  container.innerHTML = "";
  const caps = rows.map(r => Math.sqrt(r.market_cap || 1e6));
  const maxCap = Math.max(...caps);
  rows.forEach((r, i) => {
    const tile = document.createElement("div");
    tile.className = "hm-tile";
    const rel = caps[i] / maxCap;
    tile.style.gridColumn = `span ${rel > 0.66 ? 4 : rel > 0.33 ? 3 : 2}`;
    const { bg, ink } = heatColor(r.change_24h);
    tile.style.background = bg;
    tile.style.color = ink;
    tile.innerHTML = `<span class="s">${esc(r.symbol)}</span>` +
      `<span class="p">${r.change_24h == null ? "—"
        : (r.change_24h >= 0 ? "+" : "") + r.change_24h.toFixed(2) + "%"}</span>`;
    tile.title = `${r.symbol} 24h ${r.change_24h?.toFixed(2)}%`;
    tile.onclick = () => location.hash = `#/coin/${r.coin_id}`;
    container.appendChild(tile);
  });
}

function drawArcGauge(canvas, opts) {   // opts: {value, min=0, max=100, zoneFn, needle=true, label}
  const { value, min = 0, max = 100, zoneFn, needle = true } = opts;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 130, h = canvas.clientHeight || 74;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const cx = w / 2, cy = h - 6, r = Math.min(w / 2 - 6, h - 12);
  ctx.lineWidth = 9;
  ctx.lineCap = "round";
  ctx.strokeStyle = themeVar("--grid") || "#1a1e2e";  // recessive track
  ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI, 2 * Math.PI); ctx.stroke();
  if (value == null) return;
  const v = Math.max(min, Math.min(max, value));
  const frac = (v - min) / (max - min || 1);
  ctx.strokeStyle = themeVar(zoneFn ? zoneFn(v) : "--accent2");
  ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI, Math.PI * (1 + frac)); ctx.stroke();
  if (needle) {
    const a = Math.PI * (1 + frac);
    ctx.strokeStyle = themeVar("--text"); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * (r - 8), cy + Math.sin(a) * (r - 8)); ctx.stroke();
  }
}

function drawFngGauge(canvas, fng) {
  drawArcGauge(canvas, {
    value: fng ? fng.value : null,
    zoneFn: v => v < 25 ? "--down" : v < 45 ? "--warn" : v <= 55 ? "--dim"
               : v <= 75 ? "--accent2" : "--up",
  });
}

function drawCandles(canvas, candles, patterns) {   // candles: [{ts,o,h,l,c}]
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 300, h = canvas.clientHeight || 90;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  if (!candles || candles.length < 2) {
    ctx.fillStyle = "#8f87c0"; ctx.font = "11px sans-serif";
    ctx.fillText("collecting candles…", 8, h / 2);
    return;
  }
  const min = Math.min(...candles.map(c => c.l));
  const max = Math.max(...candles.map(c => c.h));
  const span = max - min || 1;
  const Y = v => h - 4 - ((v - min) / span) * (h - 8);
  const step = w / candles.length;
  const bw = Math.max(2, step * 0.6);
  candles.forEach((c, i) => {
    const x = i * step + step / 2;
    const up = c.c >= c.o;
    ctx.strokeStyle = ctx.fillStyle = up ? "#2bffb0" : "#ff5470";
    ctx.beginPath(); ctx.moveTo(x, Y(c.h)); ctx.lineTo(x, Y(c.l)); ctx.stroke();
    const top = Y(Math.max(c.o, c.c)), bot = Y(Math.min(c.o, c.c));
    ctx.fillRect(x - bw / 2, top, bw, Math.max(1, bot - top));
  });
  // targeting reticle: mark the last (most recently closed) candle with any
  // detected pattern — color by direction, alpha scaled by strength
  (patterns || []).forEach(p => {
    if (p.direction === "neutral") return;
    const last = candles[candles.length - 1];
    const x = (candles.length - 1) * step + step / 2;
    const y = Y((last.h + last.l) / 2);
    const rx = Math.max(14, step * 0.9), ry = Math.max(14, (h - 8) * 0.3);
    const color = p.direction === "bullish" ? "#2bffb0" : "#ff5470";
    ctx.save();
    ctx.globalAlpha = Math.max(0.35, p.strength);
    ctx.strokeStyle = color; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
    // corner brackets
    const bx = rx * 0.7, by = ry * 0.7, bl = 5;
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sy]) => {
      const cx2 = x + sx * bx, cy2 = y + sy * by;
      ctx.beginPath();
      ctx.moveTo(cx2 - sx * bl, cy2); ctx.lineTo(cx2, cy2); ctx.lineTo(cx2, cy2 - sy * bl);
      ctx.stroke();
    });
    ctx.restore();
  });
}

let bootAnimId = null;
function drawRadarSweep(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 300, h = canvas.clientHeight || 220;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 10;
  let angle = 0;
  function frame() {
    if (state || !document.body.contains(canvas)) { bootAnimId = null; return; }
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = themeVar("--grid") || "rgba(79,216,255,0.25)";
    ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
      ctx.beginPath(); ctx.arc(cx, cy, r * i / 3, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, angle - 0.5, angle);
    ctx.closePath();
    ctx.fillStyle = themeVar("--glow") || "rgba(79,216,255,0.18)";
    ctx.fill();
    ctx.strokeStyle = themeVar("--accent2") || "#4fd8ff";
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
    ctx.stroke();
    angle += 0.045;
    bootAnimId = requestAnimationFrame(frame);
  }
  if (bootAnimId == null) bootAnimId = requestAnimationFrame(frame);
}

const coinCard = m => {
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `
    <span class="sym">${esc(m.symbol)}</span><span class="name">${esc(m.name || m.chain || "")}</span>
    <div class="price">${fmtUsd(m.price)}</div>
    <div>24h ${fmtPct(m.change_24h)}${m.change_7d != null ? ` · 7d ${fmtPct(m.change_7d)}` : ""}
    ${m.liquidity_usd != null ? ` · <span class="dim">liq ${fmtUsd(m.liquidity_usd, 0)}</span>` : ""}</div>
    ${m.sparkline_7d ? "<canvas></canvas>" : ""}`;
  card.onclick = () => location.hash = `#/coin/${m.coin_id}`;
  if (m.sparkline_7d) {
    requestAnimationFrame(() => sparkline(card.querySelector("canvas"), m.sparkline_7d,
      (m.change_7d ?? 0) >= 0 ? "#2bffb0" : "#ff5470"));
  }
  return card;
};

/* ---------- pages ---------- */

function renderOverview() {
  if (!state) {
    view.innerHTML = `
      <div class="panel">
        <canvas id="boot-radar"></canvas>
        <div class="boot-status">
          <div>&gt; initializing HUD…</div>
          <div>&gt; establishing WS uplink…</div>
          <div>&gt; awaiting first price snapshot…</div>
        </div>
      </div>`;
    drawRadarSweep(document.getElementById("boot-radar"));
    return;
  }
  const wallets = state.wallets || [];
  const totalEquity = wallets.reduce((a, w) => a + w.equity, 0);

  view.innerHTML = `
    <div class="row">
      <div class="panel stat"><div class="k">Total paper equity</div>
        <div class="v">${fmtUsd(totalEquity, 2)}</div></div>
      <div class="panel stat"><div class="k">Bots</div>
        <div class="v">${wallets.length}</div></div>
      <div class="panel stat"><div class="k">Data feed</div>
        <div class="v">${state.data_health && state.data_health.coingecko
          ? "<span class='up'>live</span>" : "<span class='warn'>waiting</span>"}</div></div>
      <div class="panel stat"><div class="k">Fear &amp; Greed</div>
        <div class="fng-wrap"><canvas id="fng"></canvas>
        <div>${state.fear_greed
          ? `<div class="v">${state.fear_greed.value}</div>
             <div class="dim" style="font-size:11px">${esc(state.fear_greed.classification)}</div>`
          : "<span class='dim'>loading…</span>"}</div></div></div>
      <div class="panel stat" id="conviction-box"></div>
      ${state.ai_enabled ? `<div class="panel stat"><div class="k">AI analyst</div>
        <div class="v"><button id="mkt-sum">✨ Market summary</button></div></div>` : ""}
    </div>
    <div id="briefing-box"></div>
    <div class="panel">
      <div class="tradeform">
        <input id="search" type="text" placeholder="Search any token — e.g. WIF, PEPE, BONK…"
               style="flex:1;min-width:220px">
        <button id="search-btn">Search</button>
      </div>
      <div id="search-results"></div>
    </div>
    <div id="mkt-report"></div>
    <h2>Market heatmap</h2>
    <div class="panel"><div class="heatmap" id="heatmap"></div></div>
    <h2>Majors</h2>
    <div class="grid" id="majors"></div>
    <h2>Watchlist</h2>
    <div class="grid" id="watchlist"></div>
    <h2>Activity</h2>
    <div class="panel events" id="events"></div>`;

  drawFngGauge(document.getElementById("fng"), state.fear_greed);
  renderHeatmap(document.getElementById("heatmap"),
                [...(state.majors || []), ...(state.watchlist || [])]);
  renderBriefing();
  renderConviction();

  const majors = document.getElementById("majors");
  (state.majors || []).forEach(m => majors.appendChild(coinCard(m)));
  const wl = document.getElementById("watchlist");
  const wlItems = state.watchlist || [];
  if (wlItems.length) wlItems.forEach(m => wl.appendChild(coinCard(m)));
  else wl.innerHTML = "<span class='dim'>Nothing watched yet — search a token above.</span>";

  const isStark = document.body.classList.contains("theme-stark");
  document.getElementById("events").innerHTML = (state.events || []).slice().reverse()
    .map(e => {
      const isNew = isStark && !typedEvents.has(e.ts);
      if (isNew) typedEvents.add(e.ts);
      const cls = e.type === "reject" ? "down" : e.type === "trade" ? "up"
                : e.type === "signal" ? "warn" : "dim";
      return `<div><span class="t">${fmtTime(e.ts)}</span>` +
             `<span class="dim">[${esc(e.source)}]</span> ` +
             `<span class="${cls}${isNew ? " cd-type" : ""}">${esc(e.message)}</span></div>`;
    }).join("") ||
    "<span class='dim'>No activity yet</span>";

  const doSearch = async () => {
    const q = document.getElementById("search").value.trim();
    const box = document.getElementById("search-results");
    if (q.length < 2) return;
    box.innerHTML = "<p class='dim'>Searching…</p>";
    const results = await api(`/search?q=${encodeURIComponent(q)}`);
    box.innerHTML = results.length ? `<table>
      <tr><th>Token</th><th>Chain</th><th class="num">Price</th><th class="num">24h</th>
          <th class="num">Liquidity</th><th></th></tr>
      ${results.map((r, i) => `<tr>
        <td><b>${esc(r.symbol)}</b> <span class="dim">${esc(r.name)}</span></td>
        <td>${esc(r.chain)}</td>
        <td class="num">${fmtUsd(r.price_usd)}</td>
        <td class="num">${fmtPct(r.change_24h)}</td>
        <td class="num">${fmtUsd(r.liquidity_usd, 0)}</td>
        <td>${r.watched ? "<span class='badge open'>watching</span>"
                        : `<button data-watch="${i}">Watch</button>`}</td>
      </tr>`).join("")}</table>` : "<p class='dim'>No results.</p>";
    box.querySelectorAll("[data-watch]").forEach(b => b.onclick = async () => {
      const r = results[parseInt(b.dataset.watch, 10)];
      const coin = await post("/coins/watch", {
        source_id: r.source_id, symbol: r.symbol, name: r.name, chain: r.chain });
      if (coin.id) location.hash = `#/coin/${coin.id}`;
    });
  };
  document.getElementById("search-btn").onclick = doSearch;
  document.getElementById("search").onkeydown = e => { if (e.key === "Enter") doSearch(); };

  const mktBtn = document.getElementById("mkt-sum");
  if (mktBtn) mktBtn.onclick = async () => {
    const box = document.getElementById("mkt-report");
    box.innerHTML = "<div class='panel dim'>✨ Analysing the market…</div>";
    const rep = await post("/analyze/market");
    box.innerHTML = rep.report_md
      ? `<div class="panel report">${mdToHtml(rep.report_md)}</div>`
      : `<div class="panel down">${esc(rep.error)}</div>`;
  };
}

let briefingCache = { ts: 0, row: null };
async function renderBriefing(force) {
  const box = document.getElementById("briefing-box");
  if (!box) return;
  if (force || Date.now() - briefingCache.ts > 120000) {
    briefingCache = { ts: Date.now(), row: await api("/briefing/latest").catch(() => null) };
  }
  const r = briefingCache.row;
  const today = r && new Date(r.ts * 1000).toDateString() === new Date().toDateString();
  box.innerHTML = `
    <div class="panel">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <b>🌅 Morning briefing</b>
        <button id="brief-gen">${today ? "Regenerate" : "Generate now"}</button>
      </div>
      ${r && !r.error ? `<div class="report" style="margin-top:8px">${mdToHtml(r.report_md)}</div>`
        : "<div class='dim' style='margin-top:8px'>No briefing yet — one is written " +
          "automatically every morning, or generate one now.</div>"}
    </div>`;
  document.getElementById("brief-gen").onclick = async () => {
    document.getElementById("brief-gen").textContent = "Writing…";
    briefingCache = { ts: Date.now(), row: await post("/briefing/generate") };
    renderBriefing();
  };
}

let convictionCache = { ts: 0, data: null };
async function renderConviction() {
  const box = document.getElementById("conviction-box");
  if (!box) return;
  if (Date.now() - convictionCache.ts > 15000) {
    // slow-polled REST, deliberately not part of the 2s WS push (see /api/conviction)
    convictionCache = { ts: Date.now(), data: await api("/conviction").catch(() => null) };
  }
  const m = convictionCache.data;
  box.innerHTML = `
    <div class="k">Market Conviction</div>
    <div class="fng-wrap"><canvas id="conviction-gauge"></canvas>
    <div>${m
      ? `<div class="v">${m.score}</div>
         <div class="dim" style="font-size:11px">${esc(m.direction)}</div>`
      : "<span class='dim'>loading…</span>"}</div></div>`;
  drawArcGauge(document.getElementById("conviction-gauge"), {
    value: m ? m.score : null,
    zoneFn: v => v <= 40 ? "--down" : v >= 60 ? "--up" : "--dim",
  });
}

async function renderBots() {
  const bots = await api("/bots");
  const manual = (state && state.wallets || []).find(w => w.bot_id === "manual");
  const row = b => {
    const s = b.stats;
    return `<tr>
      <td><a class="coin-link" href="#/bot/${esc(b.bot_id)}">${esc(b.bot_id)}</a>
          ${b.last_error ? `<span class="badge stale" title="${esc(b.last_error)}">err</span>` : ""}</td>
      <td class="num">${fmtUsd(s.equity, 2)}</td>
      <td class="num">${fmtPct(s.return_pct)}</td>
      <td class="num">${fmtUsd(s.realized_pnl, 2)}</td>
      <td class="num">${s.open_positions}</td>
      <td class="num">${s.trades}</td>
      <td class="num">${s.win_rate.toFixed(0)}%</td>
      <td>${b.paused
        ? `<span class="badge stale">paused</span> <button data-resume="${esc(b.bot_id)}">Resume</button>`
        : `<span class="badge open">running</span> <button data-pause="${esc(b.bot_id)}">Pause</button>`}</td>
    </tr>`;
  };
  view.innerHTML = `
    <h2>Leaderboard <a class="coin-link" style="float:right;font-size:13px"
        href="/api/export/trades.csv">⬇ export trades CSV</a></h2>
    <div class="panel"><table>
      <tr><th>Bot</th><th class="num">Equity</th><th class="num">Return</th>
          <th class="num">Realized PnL</th><th class="num">Open</th>
          <th class="num">Trades</th><th class="num">Win rate</th><th>Status</th></tr>
      ${bots.map(row).join("")}
      ${manual ? `<tr><td>manual <span class="dim">(you)</span></td>
        <td class="num">${fmtUsd(manual.equity, 2)}</td>
        <td class="num">${fmtPct(manual.return_pct)}</td>
        <td class="num">${fmtUsd(manual.realized_pnl, 2)}</td>
        <td class="num">${manual.open_positions}</td>
        <td class="num">${manual.trades}</td>
        <td class="num">${manual.win_rate.toFixed(0)}%</td><td></td></tr>` : ""}
    </table>
    <p class="dim" style="margin-top:10px">Every bot trades a separate $1,000 paper wallet.
    dca_baseline is the control — a bot has to beat boring to matter.</p></div>`;
  view.querySelectorAll("[data-pause]").forEach(b =>
    b.onclick = async () => { await post(`/bots/${b.dataset.pause}/pause`); renderBots(); });
  view.querySelectorAll("[data-resume]").forEach(b =>
    b.onclick = async () => { await post(`/bots/${b.dataset.resume}/resume`); renderBots(); });
}

function drawPowerDistribution(canvas, nodes) {   // nodes: [{bot_id, weight, return_pct}]
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600, h = canvas.clientHeight || 320;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 60;
  if (!nodes.length) {
    ctx.fillStyle = "#8f87c0"; ctx.font = "13px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("holding cash — no bot currently shows a positive edge", cx, cy);
    return;
  }
  nodes.forEach((n, i) => {
    const angle = (i / nodes.length) * Math.PI * 2 - Math.PI / 2;
    const nx = cx + Math.cos(angle) * r, ny = cy + Math.sin(angle) * r;
    const { bg } = heatColor(n.return_pct);
    ctx.strokeStyle = bg;
    ctx.lineWidth = Math.max(1.5, n.weight * 22);
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(nx, ny); ctx.stroke();
    ctx.beginPath(); ctx.arc(nx, ny, 5, 0, Math.PI * 2); ctx.fillStyle = bg; ctx.fill();
    ctx.fillStyle = themeVar("--text") || "#fff";
    ctx.font = "12px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(n.bot_id, nx, ny + (Math.sin(angle) >= 0 ? 18 : -10));
    ctx.fillText(`${(n.weight * 100).toFixed(0)}%`, nx, ny + (Math.sin(angle) >= 0 ? 32 : -24));
  });
  // pulsing core
  ctx.beginPath(); ctx.arc(cx, cy, 10, 0, Math.PI * 2);
  ctx.fillStyle = themeVar("--accent2") || "#4fd8ff"; ctx.fill();
}

async function renderAllocator() {
  const [bot, weights] = await Promise.all([
    api("/bots/apex_allocator"), api("/allocator/weights"),
  ]);
  if (bot.error) { view.innerHTML = `<p class="down">${esc(bot.error)}</p>`; return; }
  const s = bot.stats;
  const nodes = Object.entries(weights).map(([bot_id, v]) => ({
    bot_id, weight: v.weight, return_pct: v.score,
  }));
  view.innerHTML = `
    <h2>Apex Allocator <span class="dim" style="font-size:12px">fund-of-funds — rotates
      paper capital toward the best risk-adjusted bots</span></h2>
    <div class="row">
      <div class="panel stat"><div class="k">Equity</div><div class="v">${fmtUsd(s.equity, 2)}</div></div>
      <div class="panel stat"><div class="k">Return</div><div class="v">${fmtPct(s.return_pct)}</div></div>
      <div class="panel stat"><div class="k">Trades</div><div class="v">${s.trades}</div></div>
    </div>
    <div class="panel"><canvas id="power-dist" style="width:100%;height:320px"></canvas></div>
    <p class="dim">Weights recompute every rebalance (params.rebalance_cooldown_hours) from each
    bot's trailing return ÷ (1 + drawdown) over the lookback window — a real edge earns capital,
    a losing streak gets starved. All paper money; this bot only ever trades its own wallet.</p>`;
  drawPowerDistribution(document.getElementById("power-dist"), nodes);
}

async function renderBot(botId) {
  clearInterval(liveTimer);
  const [d, j] = await Promise.all([
    api(`/bots/${encodeURIComponent(botId)}`),
    api(`/journal/${encodeURIComponent(botId)}`),
  ]);
  if (d.error) { view.innerHTML = `<p class="down">${esc(d.error)}</p>`; return; }
  const s = d.stats;
  const pf = j.profit_factor != null ? j.profit_factor
           : (j.gross_win > 0 ? "∞" : "—");
  const journalHtml = `
    <h2>Journal</h2>
    <div class="row">
      <div class="panel stat"><div class="k">Profit factor</div><div class="v">${pf}</div></div>
      <div class="panel stat"><div class="k">Avg hold</div>
        <div class="v">${j.avg_hold_hours != null ? j.avg_hold_hours + "h" : "—"}</div></div>
      <div class="panel stat"><div class="k">Best trade</div>
        <div class="v up">${j.best_trade ? esc(j.best_trade.symbol) + " " + fmtUsd(j.best_trade.pnl, 2) : "—"}</div></div>
      <div class="panel stat"><div class="k">Worst trade</div>
        <div class="v down">${j.worst_trade ? esc(j.worst_trade.symbol) + " " + fmtUsd(j.worst_trade.pnl, 2) : "—"}</div></div>
    </div>
    <div class="panel"><table>
      <tr><th>Close reason</th><th class="num">Count</th><th class="num">Total PnL</th></tr>
      ${Object.entries(j.close_reasons || {}).map(([r, v]) =>
        `<tr><td>${esc(r)}</td><td class="num">${v.count}</td>
         <td class="num ${v.pnl >= 0 ? "up" : "down"}">${fmtUsd(v.pnl, 2)}</td></tr>`).join("")
        || "<tr><td class='dim' colspan='3'>No closed positions yet — the journal fills in as trades close.</td></tr>"}
    </table></div>`;
  const posRows = (d.positions || []).map(p => `
    <tr>
      <td><a class="coin-link" href="#/coin/${p.coin_id}">${esc(p.symbol)}</a></td>
      <td><span class="badge ${p.status}">${p.status}</span></td>
      <td class="num">${p.qty.toPrecision(6)}</td>
      <td class="num">${fmtUsd(p.avg_entry_price)}</td>
      <td class="num">${fmtUsd(p.current_price)}</td>
      <td class="num ${p.unrealized_pnl_usd >= 0 ? "up" : "down"}">${fmtUsd(p.unrealized_pnl_usd, 2)}</td>
      <td class="num ${p.realized_pnl_usd >= 0 ? "up" : "down"}">${fmtUsd(p.realized_pnl_usd, 2)}</td>
    </tr>`).join("");
  const tradeRows = (d.trades || []).slice(0, 40).map(t => `
    <tr><td>${fmtTime(t.ts)}</td>
      <td class="${t.side === "buy" ? "up" : "down"}">${t.side.toUpperCase()}</td>
      <td class="num">${t.qty.toPrecision(6)}</td>
      <td class="num">${fmtUsd(t.price)}</td>
      <td class="num">${t.realized_pnl_usd == null ? "—" :
        `<span class="${t.realized_pnl_usd >= 0 ? "up" : "down"}">${fmtUsd(t.realized_pnl_usd, 2)}</span>`}</td>
    </tr>`).join("");
  view.innerHTML = `
    <h2>${esc(botId)}</h2>
    <div class="row">
      <div class="panel stat"><div class="k">Equity</div><div class="v">${fmtUsd(s.equity, 2)}</div></div>
      <div class="panel stat"><div class="k">Return</div><div class="v">${fmtPct(s.return_pct)}</div></div>
      <div class="panel stat"><div class="k">Realized PnL</div><div class="v">${fmtUsd(s.realized_pnl, 2)}</div></div>
      <div class="panel stat"><div class="k">Win rate</div><div class="v">${s.win_rate.toFixed(0)}%</div></div>
    </div>
    <div class="panel"><canvas id="bigchart"></canvas></div>
    <h2>Positions</h2>
    <div class="panel"><table>${posRows ? `<tr><th>Coin</th><th>Status</th>
      <th class="num">Qty</th><th class="num">Entry</th><th class="num">Now</th>
      <th class="num">Unrl PnL</th><th class="num">Rlzd PnL</th></tr>${posRows}`
      : "<tr><td class='dim'>No positions yet</td></tr>"}</table></div>
    ${botId.startsWith("candlestick_trader") ? `
    <h2>What the bot sees <span class="dim" style="font-size:12px">(${botId.endsWith("4h") ? "4-hour" : "30-min"} candles, live)</span></h2>
    <div class="grid" id="vision" style="grid-template-columns:repeat(auto-fill,minmax(320px,1fr))"></div>` : ""}
    ${journalHtml}
    <h2>Recent trades</h2>
    <div class="panel"><table>${tradeRows ? `<tr><th>Time</th><th>Side</th>
      <th class="num">Qty</th><th class="num">Price</th><th class="num">PnL</th></tr>${tradeRows}`
      : "<tr><td class='dim'>No trades yet</td></tr>"}</table></div>`;
  lineChart(document.getElementById("bigchart"),
            (d.equity || []).map(e => [e.ts, e.equity]),
            { color: "#ff2d95", live: true,
              empty: "Equity curve appears after the first snapshots (5min)." });
  if (botId.startsWith("candlestick_trader")) {
    const vision = await api(`/candlestick/vision?tf=${botId.endsWith("4h") ? "4h" : "30m"}`);
    const grid = document.getElementById("vision");
    if (grid) {
      vision.forEach(v => {
        const card = document.createElement("div");
        card.className = "card";
        const buying = v.verdict.startsWith("BUY");
        card.innerHTML = `
          <span class="sym">${esc(v.symbol)}</span>
          <span class="badge ${v.trend === "down" ? "stale" : "open"}">trend ${esc(v.trend)}</span>
          <canvas style="height:90px"></canvas>
          <div style="font-size:12px;margin-top:6px">
            ${v.patterns.length ? v.patterns.map(pt =>
              `<span class="${pt.direction === "bullish" ? "up" : pt.direction === "bearish" ? "down" : "dim"}">
               ${esc(pt.name)} ${(pt.strength * 100).toFixed(0)}%</span>`).join(" · ")
              : "<span class='dim'>no patterns this candle</span>"}
          </div>
          <div class="${buying ? "up" : "dim"}" style="font-size:12px;margin-top:4px">
            ${buying ? "🟢 " : "⏳ "}${esc(v.verdict)}</div>`;
        card.onclick = () => location.hash = `#/coin/${v.coin_id}`;
        grid.appendChild(card);
        drawCandles(card.querySelector("canvas"), v.candles, v.patterns);
      });
    }
  }
  liveTimer = setInterval(() => renderBot(botId), 15000);
}

function renderSweepHeatmap(container, results, keys) {
  const [xKey, yKey] = keys;
  const xVals = [...new Set(results.map(r => r.params[xKey]))].sort((a, b) => a - b);
  const yVals = [...new Set(results.map(r => r.params[yKey]))].sort((a, b) => a - b);
  const cell = (x, y) => results.find(r => r.params[xKey] === x && r.params[yKey] === y);
  let html = `<div style="display:grid;grid-template-columns:auto repeat(${xVals.length},1fr);` +
             `gap:3px;font-size:12px">` + `<div></div>` +
             xVals.map(x => `<div class="dim" style="text-align:center">${xKey}=${x}</div>`).join("");
  yVals.forEach(y => {
    html += `<div class="dim" style="align-self:center">${yKey}=${y}</div>`;
    xVals.forEach(x => {
      const c = cell(x, y);
      if (!c || c.error) { html += `<div class="hm-tile dim">—</div>`; return; }
      const { bg, ink } = heatColor(c.return_pct);
      html += `<div class="hm-tile" style="background:${bg};color:${ink}">` +
              `<span class="p">${c.return_pct >= 0 ? "+" : ""}${c.return_pct}%</span>` +
              `<span class="p" style="opacity:.8">${c.trades} trades</span></div>`;
    });
  });
  html += `</div>`;
  container.innerHTML = html;
}

async function renderBacktest() {
  const strategies = await api("/backtest/strategies");
  view.innerHTML = `
    <h2>Backtest</h2>
    <div class="panel">
      <div class="tradeform">
        <select id="bt-strategy">${strategies.map(s =>
          `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join("")}</select>
        <label>Hours <input id="bt-hours" type="number" value="24" min="1" max="168"></label>
        <button class="buy" id="bt-run">Run backtest</button>
      </div>
      <div class="msg dim">Replays your stored price history (up to 7 days) through a
      strategy with the same fee & slippage model. History only — proves nothing
      about the future, but kills bad ideas cheaply.</div>
    </div>
    <div id="bt-results"></div>
    <h2>War Games — parameter sweep</h2>
    <div class="panel">
      <div class="tradeform">
        <select id="sw-strategy">${strategies.filter(s => s.sweep_grid).map(s =>
          `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join("")}</select>
        <label>Hours <input id="sw-hours" type="number" value="24" min="1" max="168"></label>
        <button class="buy" id="sw-run">Run sweep</button>
      </div>
      <div class="msg dim">Grid-searches that strategy's key parameters across the same
      replay engine — find the settings that would have made more (paper) money before
      you trade them live.</div>
    </div>
    <div id="sw-results"></div>`;
  document.getElementById("bt-run").onclick = async () => {
    const box = document.getElementById("bt-results");
    box.innerHTML = "<div class='panel dim'>Replaying history…</div>";
    const r = await post("/backtest", {
      strategy: document.getElementById("bt-strategy").value,
      hours: parseFloat(document.getElementById("bt-hours").value),
    });
    if (r.error) { box.innerHTML = `<div class="panel down">${esc(r.error)}</div>`; return; }
    const st = r.stats;
    box.innerHTML = `
      <div class="row">
        <div class="panel stat"><div class="k">Final equity</div>
          <div class="v">${fmtUsd(st.final_equity, 2)}</div></div>
        <div class="panel stat"><div class="k">Return</div>
          <div class="v">${fmtPct(st.return_pct)}</div></div>
        <div class="panel stat"><div class="k">Trades / win rate</div>
          <div class="v">${st.trades} · ${st.win_rate}%</div></div>
        <div class="panel stat"><div class="k">Max drawdown</div>
          <div class="v down">-${st.max_drawdown_pct}%</div></div>
      </div>
      <div class="panel"><canvas id="bt-chart"></canvas></div>
      <p class="dim">${esc(r.caveats)} (replayed ${r.hours_replayed}h)</p>`;
    lineChart(document.getElementById("bt-chart"), r.equity_curve,
              { color: "#ffcc4d", empty: "No equity points" });
  };
  document.getElementById("sw-run").onclick = async () => {
    const box = document.getElementById("sw-results");
    const strategy = document.getElementById("sw-strategy").value;
    if (!strategy) { box.innerHTML = "<div class='panel down'>No sweep-eligible strategy.</div>"; return; }
    const r = await post("/backtest/sweep", {
      strategy, hours: parseFloat(document.getElementById("sw-hours").value),
    });
    if (r.error) { box.innerHTML = `<div class="panel down">${esc(r.error)}</div>`; return; }
    clearInterval(liveTimer);
    const poll = async () => {
      const s = await api(`/backtest/sweep/${r.job_id}`);
      if (s.error) { box.innerHTML = `<div class="panel down">${esc(s.error)}</div>`; clearInterval(liveTimer); return; }
      const pct = s.progress.total ? Math.round(100 * s.progress.done / s.progress.total) : 0;
      if (s.status === "running") {
        box.innerHTML = `<div class="panel dim">Running sweep… ${s.progress.done}/${s.progress.total} (${pct}%)</div>`;
      } else {
        clearInterval(liveTimer);
        box.innerHTML = `<div class="panel"><div id="sw-heatmap"></div>
          <p class="dim" style="margin-top:8px">Color = return %. Same fee/slippage model as
          live paper trading — history only.</p></div>`;
        renderSweepHeatmap(document.getElementById("sw-heatmap"), s.results, s.keys);
      }
    };
    poll();
    liveTimer = setInterval(poll, 1500);
  };
}

function renderAlerts() {
  api("/alerts?n=100").then(alerts => {
    view.innerHTML = `<h2>Alerts</h2><div class="panel events">` +
      (alerts.length ? alerts.map(a =>
        `<div><span class="t">${fmtTime(a.ts)}</span>` +
        `<span class="${a.level === "warning" ? "warn" : "dim"}">[${esc(a.source)}]</span> ` +
        `${esc(a.message)}</div>`).join("")
      : "<span class='dim'>No alerts</span>") + "</div>";
  });
}

async function renderSettings() {
  const s = await api("/settings");
  const cur = localStorage.getItem("cd_theme") || "cyberpunk";
  view.innerHTML = `
    <h2>Theme</h2>
    <div class="panel">
      <div class="tradeform">
        <select id="theme-pick">${Object.entries(THEMES).map(([k, label]) =>
          `<option value="${k}" ${k === cur ? "selected" : ""}>${esc(label)}</option>`).join("")}</select>
        <span class="dim">applies instantly, saved in this browser</span>
      </div>
      <div class="tradeform" style="margin-top:10px">
        <label><input type="checkbox" id="sound-mute" ${isMuted() ? "checked" : ""}>
          Mute HUD sounds</label>
        <span class="dim">trade-fill chirp &amp; target-lock flash</span>
      </div>
    </div>
    <h2>Settings</h2>
    <div class="panel">
      ${Object.entries(s.values).map(([k, v]) => `
        <div class="tradeform" style="margin-bottom:10px">
          <label style="min-width:200px">${esc(k)}</label>
          ${s.types[k] === "bool"
            ? `<input type="checkbox" data-key="${k}" ${v ? "checked" : ""}>`
            : `<input type="number" step="any" data-key="${k}" value="${v}">`}
        </div>`).join("")}
      <button id="save">Save</button>
      <div class="msg" id="msg"><span class="dim">${esc(s.note)}</span></div>
    </div>`;
  document.getElementById("theme-pick").onchange = e => applyTheme(e.target.value);
  document.getElementById("sound-mute").onchange = e =>
    localStorage.setItem("cd_sound_muted", e.target.checked ? "1" : "0");
  document.getElementById("save").onclick = async () => {
    const payload = {};
    view.querySelectorAll("[data-key]").forEach(i => {
      payload[i.dataset.key] = i.type === "checkbox" ? i.checked : parseFloat(i.value);
    });
    const r = await post("/settings", payload);
    document.getElementById("msg").innerHTML =
      `<span class="up">Saved: ${r.saved.join(", ")}.</span> <span class="dim">${esc(r.note)}</span>`;
  };
}

async function renderCoin(coinId) {
  clearInterval(liveTimer);
  const [d, sigs, reports, priceAlerts] = await Promise.all([
    api(`/coins/${coinId}?hours=24`),
    api(`/signals?coin_id=${coinId}&n=15`),
    api(`/analyses?coin_id=${coinId}&n=3`),
    api(`/price-alerts?coin_id=${coinId}`),
  ]);
  if (d.error) { view.innerHTML = `<p class="down">${esc(d.error)}</p>`; return; }
  const c = d.coin, q = d.quote;
  const markers = (d.trades || []).map(t => ({ ts: t.ts, price: t.price, side: t.side }));
  const botTrades = (d.trades || []).slice(0, 12).map(t => `
    <div><span class="t">${fmtTime(t.ts)}</span>
      <span class="${t.side === "buy" ? "up" : "down"}">${t.side === "buy" ? "▲ BUY" : "▼ SELL"}</span>
      <b>${esc(t.bot_id)}</b> · ${Number(t.qty).toPrecision(4)} @ ${fmtUsd(t.price)}
      ${t.realized_pnl_usd != null ? `· <span class="${t.realized_pnl_usd >= 0 ? "up" : "down"}">${fmtUsd(t.realized_pnl_usd, 2)}</span>` : ""}
    </div>`).join("");
  const aiOn = state && state.ai_enabled;
  const posRows = (d.positions || []).map(p => `
    <tr>
      <td><span class="badge ${p.status}">${p.status}</span></td>
      <td class="num">${p.qty.toPrecision(6)}</td>
      <td class="num">${fmtUsd(p.avg_entry_price)}</td>
      <td class="num">${fmtUsd(p.current_price)}</td>
      <td class="num">${fmtUsd(p.value_usd, 2)}</td>
      <td class="num ${p.unrealized_pnl_usd >= 0 ? "up" : "down"}">${fmtUsd(p.unrealized_pnl_usd, 2)}</td>
      <td>
        <button class="sell" data-close="${p.id}">Close</button>
        ${p.status === "stale" ? `<button data-writeoff="${p.id}">Write off</button>` : ""}
      </td>
    </tr>`).join("");
  const sigRows = sigs.map(s => {
    const arrow = { bullish: "▲", bearish: "▼", risk: "⚠" }[s.direction] || "•";
    const cls = { bullish: "up", bearish: "down", risk: "warn" }[s.direction] || "dim";
    return `<div><span class="t">${fmtTime(s.ts)}</span>
      <span class="${cls}">${arrow} ${esc(s.rule)} (${(s.strength * 100).toFixed(0)}%)</span>
      <span class="dim">${esc(s.details_json || "")}</span></div>`;
  }).join("");

  view.innerHTML = `
    <h2>${esc(c.symbol.toUpperCase())} <span class="dim">${esc(c.name)} · ${esc(c.chain)}</span>
      ${c.watch && c.source === "dexscreener"
        ? `<button style="float:right" data-unwatch="${c.id}">Unwatch</button>` : ""}</h2>
    <div class="row">
      <div class="panel stat"><div class="k">Price</div>
        <div class="v">${q ? fmtUsd(q.price_usd) : "—"}</div></div>
      <div class="panel stat"><div class="k">24h change</div>
        <div class="v">${q ? fmtPct(q.change_24h_pct) : "—"}</div></div>
      <div class="panel stat"><div class="k">24h volume</div>
        <div class="v">${q ? fmtUsd(q.volume_24h, 0) : "—"}</div></div>
      ${q && q.liquidity_usd != null ? `<div class="panel stat"><div class="k">Liquidity</div>
        <div class="v">${fmtUsd(q.liquidity_usd, 0)}</div></div>` : ""}
    </div>
    <div class="panel">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <span class="dim" style="font-size:12px">last 24h ·
          <span class="up">▲ buy</span> <span class="down">▼ sell</span> markers = bot &amp; manual trades</span>
        <span class="badge open">● LIVE</span>
      </div>
      <canvas id="bigchart"></canvas>
    </div>
    ${botTrades ? `<h2>Trading activity on this coin</h2>
    <div class="panel events">${botTrades}</div>` : ""}
    <h2>Paper trade</h2>
    <div class="panel">
      <div class="tradeform">
        <label>USD <input id="usd" type="number" value="100" min="1" step="10"></label>
        <button class="buy" id="buy">Paper BUY</button>
        ${aiOn ? `<button id="ai-report">✨ AI Report</button>` : ""}
        <span class="dim">fills at live price ± slippage, minus fee — simulated balance only</span>
      </div>
      <div class="msg" id="msg"></div>
    </div>
    <h2>Price alerts</h2>
    <div class="panel">
      <div class="tradeform">
        <select id="pa-dir"><option value="above">crosses above</option>
          <option value="below">crosses below</option></select>
        <input id="pa-threshold" type="number" step="any"
               placeholder="${q ? q.price_usd : "price"}" style="width:140px">
        <button id="pa-add">🔔 Alert me</button>
        <span class="dim">fires a desktop/Telegram notification once</span>
      </div>
      <div style="margin-top:8px">${priceAlerts.map(a => `
        <div style="font-size:13px;padding:3px 0">
          ${a.fired_at ? "✅" : "🔔"} ${esc(a.direction)} ${fmtUsd(a.threshold)}
          ${a.fired_at ? `<span class="dim">fired ${fmtTime(a.fired_at)}</span>` : ""}
          <button data-pa-del="${a.id}" style="padding:1px 8px;font-size:11px">✕</button>
        </div>`).join("") || "<span class='dim' style='font-size:12px'>No alerts set</span>"}
      </div>
      <div class="msg" id="pa-msg"></div>
    </div>
    <div id="ai-box">${reports.length
      ? `<h2>AI analysis</h2>` + reports.map(r =>
          `<div class="panel report"><div class="dim" style="font-size:12px">
           ${fmtTime(r.ts)} · ${esc(r.trigger)}</div>${mdToHtml(r.report_md)}</div>`).join("")
      : ""}</div>
    <h2>Signals</h2>
    <div class="panel events">${sigRows || "<span class='dim'>No signals yet</span>"}</div>
    <h2>Positions (all wallets)</h2>
    <div class="panel"><table>
      ${posRows ? `<tr><th>Status</th><th class="num">Qty</th><th class="num">Entry</th>
        <th class="num">Now</th><th class="num">Value</th><th class="num">Unrl PnL</th><th></th></tr>${posRows}`
        : "<tr><td class='dim'>No positions in this coin</td></tr>"}
    </table></div>`;

  lineChart(document.getElementById("bigchart"), d.history,
            { markers, live: true });
  // live refresh: redraw every 8s unless the user is typing in a field
  liveTimer = setInterval(() => {
    const el = document.activeElement;
    if (!(el && view.contains(el) && (el.tagName === "INPUT" || el.tagName === "SELECT")))
      renderCoin(coinId);
  }, 8000);
  const msg = document.getElementById("msg");
  const showResult = r => {
    if (r.status === "filled") {
      msg.innerHTML = `<span class="up">FILLED ✓</span> ${r.qty.toPrecision(6)} @ ` +
        `${fmtUsd(r.fill_price)} (fee ${fmtUsd(r.fee_usd, 2)})`;
    } else {
      msg.innerHTML = `<span class="down">REJECTED ✗</span> ${esc(r.reject_reason || r.error)}`;
    }
    setTimeout(() => renderCoin(coinId), 1200);
  };
  document.getElementById("buy").onclick = async () => {
    msg.textContent = "…";
    showResult(await post("/trade", {
      coin_id: coinId, side: "buy",
      usd: parseFloat(document.getElementById("usd").value),
    }));
  };
  const aiBtn = document.getElementById("ai-report");
  if (aiBtn) aiBtn.onclick = async () => {
    const box = document.getElementById("ai-box");
    box.innerHTML = "<div class='panel dim'>✨ Reading the charts…</div>";
    const rep = await post(`/analyze/coin/${coinId}`);
    box.innerHTML = rep.report_md
      ? `<h2>AI analysis</h2><div class="panel report">${mdToHtml(rep.report_md)}</div>`
      : `<div class="panel down">${esc(rep.error)}</div>`;
  };
  view.querySelectorAll("[data-close]").forEach(b =>
    b.onclick = async () => showResult(await post(`/positions/${b.dataset.close}/close`)));
  view.querySelectorAll("[data-writeoff]").forEach(b =>
    b.onclick = async () => { await post(`/positions/${b.dataset.writeoff}/write-off`);
                              renderCoin(coinId); });
  view.querySelectorAll("[data-unwatch]").forEach(b =>
    b.onclick = async () => { await post(`/coins/${b.dataset.unwatch}/unwatch`);
                              location.hash = "#/"; });
  document.getElementById("pa-add").onclick = async () => {
    const threshold = parseFloat(document.getElementById("pa-threshold").value);
    const r = await post("/price-alerts", {
      coin_id: coinId, direction: document.getElementById("pa-dir").value, threshold });
    document.getElementById("pa-msg").innerHTML = r.error
      ? `<span class="down">${esc(r.error)}</span>` : `<span class="up">Alert set ✓</span>`;
    if (!r.error) setTimeout(() => renderCoin(coinId), 800);
  };
  view.querySelectorAll("[data-pa-del]").forEach(b =>
    b.onclick = async () => { await post(`/price-alerts/${b.dataset.paDel}/delete`);
                              renderCoin(coinId); });
}

/* ---------- router + live updates ---------- */

function parseRoute() {
  const h = location.hash || "#/";
  let m = h.match(/^#\/coin\/(\d+)/);
  if (m) return { page: "coin", arg: parseInt(m[1], 10) };
  m = h.match(/^#\/bot\/([\w-]+)/);
  if (m) return { page: "bot", arg: m[1] };
  if (h.startsWith("#/bots")) return { page: "bots", arg: null };
  if (h.startsWith("#/allocator")) return { page: "allocator", arg: null };
  if (h.startsWith("#/backtest")) return { page: "backtest", arg: null };
  if (h.startsWith("#/alerts")) return { page: "alerts", arg: null };
  if (h.startsWith("#/settings")) return { page: "settings", arg: null };
  return { page: "overview", arg: null };
}

function render() {
  route = parseRoute();
  clearInterval(liveTimer);
  liveTimer = null;
  document.querySelectorAll("nav a").forEach(a =>
    a.classList.toggle("active", a.dataset.route === route.page));
  if (route.page === "coin") renderCoin(route.arg);
  else if (route.page === "bot") renderBot(route.arg);
  else if (route.page === "bots") renderBots();
  else if (route.page === "allocator") renderAllocator();
  else if (route.page === "backtest") renderBacktest();
  else if (route.page === "alerts") renderAlerts();
  else if (route.page === "settings") renderSettings();
  else renderOverview();
}
window.addEventListener("hashchange", render);

let lastOverviewRender = 0;
let lastEventTs = null;   // null = no baseline yet (don't beep for history on first push)
function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => { connEl.textContent = "● live"; connEl.className = "conn ok"; };
  ws.onmessage = ev => {
    state = JSON.parse(ev.data);
    // target-lock flash + beep: diff incoming events against the last seen
    // timestamp so this only fires for genuinely new trades, not the whole
    // 300-entry backlog on the very first push
    if (lastEventTs !== null) {
      (state.events || []).forEach(e => {
        if (e.ts > lastEventTs && e.type === "trade") {
          playBeep("trade");
          const flash = document.getElementById("hud-flash");
          if (flash) {
            flash.classList.remove("flash"); void flash.offsetWidth;   // restart animation
            flash.classList.add("flash");
          }
        }
      });
    }
    if (state.events && state.events.length) {
      lastEventTs = Math.max(lastEventTs ?? 0, ...state.events.map(e => e.ts));
    } else if (lastEventTs === null) {
      lastEventTs = 0;
    }
    // Live-refresh only the overview, and not while the user is typing a search
    const searching = document.activeElement && document.activeElement.id === "search";
    if (route.page === "overview" && !searching
        && Date.now() - lastOverviewRender > 4000) {
      lastOverviewRender = Date.now();
      render();
    }
  };
  ws.onclose = () => {
    connEl.textContent = "○ reconnecting…"; connEl.className = "conn down";
    setTimeout(connect, 3000);
  };
}

connect();
render();
