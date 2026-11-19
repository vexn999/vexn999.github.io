/* STORMCHASER SPA — hash router + WebSocket live ticker. No frameworks, no build.
   Every trade action here calls /api/trade or /api/approvals/*, which resolve
   through PaperExchange only — see stormchaser/trading/exchange.py. Nothing in
   this file can hold a key or sign a transaction. */
"use strict";

const view = document.getElementById("view");
let ticker = null;
let settingsCache = null;
let route = { page: "radar", arg: null };
let pollTimer = null;
let selectedSymbol = null;
let renderGen = 0; // bumped on every navigation; lets in-flight renders from a
                    // previous screen detect they're stale and bail instead of
                    // overwriting the new screen and re-arming their own timer

/* ---------- fetch helpers ---------- */

async function api(path) {
  const r = await fetch("/api" + path);
  return r.json();
}
async function post(path, body) {
  const r = await fetch("/api" + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}),
  });
  return r.json();
}

/* ---------- small helpers ---------- */

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtPct(v) { v = v || 0; return (v >= 0 ? "+" : "") + v.toFixed(1) + "%"; }
function timeAgo(ts) {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return Math.floor(s) + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  return Math.floor(s / 3600) + "h ago";
}
function colorVar(name) { return `var(--${name})`; }
function avatarHtml(av, px) {
  return `<div class="avatar" style="width:${px}px;height:${px}px;font-size:${Math.round(px * 0.56)}px;background:radial-gradient(circle at 35% 30%, oklch(0.72 0.14 ${av.hue}), oklch(0.38 0.11 ${av.hue}))">${av.icon}</div>`;
}
function sparkPolyline(ys, color, h) {
  h = h || 26;
  if (!ys || ys.length < 2) return `<svg style="width:100%;height:${h}px"></svg>`;
  const n = ys.length;
  const pts = ys.map((y, i) => (i / (n - 1) * 100).toFixed(1) + "," + y.toFixed(1)).join(" ");
  return `<svg viewBox="0 0 100 30" preserveAspectRatio="none" style="width:100%;height:${h}px;display:block"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6" opacity="0.85"></polyline></svg>`;
}
function headerSpark(vals, color) {
  if (!vals || vals.length < 2) return "<svg style='width:60px;height:18px'></svg>";
  const lo = Math.min(...vals), hi = Math.max(...vals), sp = (hi - lo) || 1;
  const pts = vals.map((v, i) => (i / (vals.length - 1) * 100).toFixed(1) + "," + (28 - (v - lo) / sp * 24).toFixed(1)).join(" ");
  return `<svg viewBox="0 0 100 30" preserveAspectRatio="none" style="width:60px;height:18px"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.4" opacity="0.9"></polyline></svg>`;
}
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }

/* ---------- theme ---------- */

const THEMES = { "NEO-TOKYO": "", "EVA UNIT-01": "theme-eva", "KANEDA": "theme-kaneda", "STORM TERMINAL": "theme-storm" };
function applyTheme(name) { document.body.className = THEMES[name] ?? "theme-eva"; }

/* ---------- websocket (live ticker) ---------- */

function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (e) => { ticker = JSON.parse(e.data); renderHeader(); renderWalletDock(); };
  ws.onclose = () => setTimeout(connectWs, 2000);
  ws.onerror = () => ws.close();
}

/* ---------- header / nav / wallet dock ---------- */

const NAV_ITEMS = [["radar", "RADAR"], ["discover", "DISCOVER"], ["pulse", "PULSE"], ["forecast", "FORECAST"],
  ["cockpit", "COCKPIT"], ["journal", "JOURNAL"], ["storm", "STORM LOG"], ["systems", "SYSTEMS"], ["settings", "SETTINGS"]];

function renderNav() {
  document.getElementById("nav").innerHTML = NAV_ITEMS.map(([id, label]) =>
    `<a href="#/${id}${id === "forecast" && selectedSymbol ? "/" + encodeURIComponent(selectedSymbol) : ""}" class="${route.page === id ? "active" : ""}">${label}</a>`
  ).join("");
}

function renderHeader() {
  const chip = document.getElementById("mode-chip");
  const mode = ticker?.mode || "GHOST";
  const modeColor = mode === "GHOST" ? "var(--acc)" : "var(--warn)";
  chip.textContent = "MODE: " + mode;
  chip.style.borderColor = modeColor; chip.style.color = modeColor;

  let gateChip = document.getElementById("gate-chip");
  if (!gateChip) {
    gateChip = document.createElement("div");
    gateChip.id = "gate-chip";
    gateChip.className = "mode-chip";
    chip.after(gateChip);
  }
  const gateLabel = ticker?.exit_only ? "EXIT-ONLY" : ticker?.paused ? "PAUSED" : "OPEN";
  const gateColor = ticker?.exit_only ? "var(--down)" : ticker?.paused ? "var(--warn)" : "var(--up)";
  gateChip.textContent = "GATE: " + gateLabel;
  gateChip.style.borderColor = gateColor; gateChip.style.color = gateColor;

  const t = document.getElementById("hdr-tickers");
  if (!ticker) { t.innerHTML = ""; return; }
  const solColor = ticker.sol.change_pct >= 0 ? "var(--up)" : "var(--down)";
  const btcColor = ticker.btc.change_pct >= 0 ? "var(--up)" : "var(--down)";
  const healthColor = ticker.health.startsWith("GREEN") ? "var(--up)" : ticker.health.startsWith("YELLOW") ? "var(--warn)" : "var(--down)";
  t.innerHTML = `
    <div class="dim mono" style="font-size:10px;letter-spacing:1px">JET STREAM</div>
    <div class="hdr-pill"><span class="dim">SOL</span><span>${ticker.sol.price_fmt}</span><span style="color:${solColor}">${fmtPct(ticker.sol.change_pct)}</span>${headerSpark(ticker.sol.sparkline, "var(--up)")}</div>
    <div class="hdr-pill"><span class="dim">BTC</span><span>${ticker.btc.price_fmt}</span><span style="color:${btcColor}">${fmtPct(ticker.btc.change_pct)}</span>${headerSpark(ticker.btc.sparkline, "var(--warn)")}</div>
    <div class="hdr-gate"><span class="dot" style="background:${healthColor}"></span>${ticker.health}</div>
  `;
  renderTickerStrip();
}

function renderTickerStrip() {
  if (!ticker) return;
  const base = [
    { pre: "SOL " + ticker.sol.price_fmt, hot: fmtPct(ticker.sol.change_pct), color: ticker.sol.change_pct >= 0 ? "var(--up)" : "var(--down)" },
    { pre: "BTC " + ticker.btc.price_fmt, hot: fmtPct(ticker.btc.change_pct), color: ticker.btc.change_pct >= 0 ? "var(--up)" : "var(--down)" },
    { pre: "MODE", hot: ticker.mode, color: ticker.mode === "GHOST" ? "var(--acc)" : "var(--warn)" },
    { pre: "COPILOT QUEUE", hot: ticker.pending_approvals + " PENDING", color: "var(--warn)" },
    { pre: "DATA", hot: (ticker.data_ok.coingecko ? "COINGECKO OK" : "COINGECKO STALE"), color: ticker.data_ok.coingecko ? "var(--up)" : "var(--down)" },
    { pre: "DATA", hot: (ticker.data_ok.dexscreener ? "DEXSCREENER OK" : "DEXSCREENER STALE"), color: ticker.data_ok.dexscreener ? "var(--up)" : "var(--down)" },
    { pre: "STORM WARNINGS", hot: "LIVE", color: "var(--down)" },
    { pre: "SAVED THIS WEEK", hot: "~1.7 SOL", color: "var(--up)" },
    { pre: "GHOST P&L 14D", hot: "+3.41 SOL", color: "var(--up)" },
    { pre: "HOT META", hot: "DOG SZN", color: "var(--warn)" },
  ];
  const items = [...base, ...base];
  document.getElementById("ticker-track").innerHTML = items.map(i =>
    `<span class="dim">${esc(i.pre)} <span style="color:${i.color}">${esc(i.hot)}</span></span>`).join("");
}

async function refreshWalletDock() {
  settingsCache = await api("/settings");
  applyTheme(settingsCache.theme);
  document.getElementById("scan-overlay").classList.toggle("on", !!settingsCache.scanlines);
  renderWalletDock();
}

function renderWalletDock() {
  const el = document.getElementById("wallet-dock");
  if (!settingsCache || !ticker) { el.innerHTML = ""; return; }
  const g = settingsCache.wallets.ghost, c = settingsCache.wallets.copilot;
  el.innerHTML = `
    <div class="dim" style="letter-spacing:1px">WALLETS</div>
    <div class="dock-pill"><span class="acc">◈ GHOST</span><span>${g.balance_sol.toFixed(2)} SOL</span></div>
    <div class="dock-pill"><span class="acc2">⬢ COPILOT</span><span>${c.balance_sol.toFixed(2)} SOL</span><span class="dim">SIMULATED · NO WALLET</span></div>
    <div class="flex1"></div>
    <div class="dock-btn ${ticker.paused ? "warn-on" : ""}" data-act="pause">${ticker.paused ? "▶ RESUME ENTRIES" : "⏸ PAUSE NEW ENTRIES"}</div>
    <div class="dock-btn ${ticker.exit_only ? "down-on" : ""}" data-act="exit-only">${ticker.exit_only ? "EXIT-ONLY: ON" : "EXIT-ONLY MODE"}</div>
  `;
  el.querySelector('[data-act="pause"]').onclick = async () => { await post("/controls/pause"); refreshWalletDock(); };
  el.querySelector('[data-act="exit-only"]').onclick = async () => { await post("/controls/exit-only"); refreshWalletDock(); };
}

/* ---------- router ---------- */

function parseHash() {
  const h = location.hash.replace(/^#\//, "") || "radar";
  const parts = h.split("/");
  return { page: parts[0] || "radar", arg: parts[1] ? decodeURIComponent(parts[1]) : null };
}

const RENDERERS = {
  radar: renderRadar, discover: renderDiscover, pulse: renderPulse, forecast: renderForecast,
  cockpit: renderCockpit, journal: renderJournal, storm: renderStormLog, systems: renderSystems, settings: renderSettingsPage,
};

async function render() {
  renderGen++;
  route = parseHash();
  renderNav();
  clearTimeout(pollTimer);
  const fn = RENDERERS[route.page] || renderRadar;
  try {
    await fn(route.arg);
  } catch (e) {
    console.error(e);
    view.innerHTML = `<p class="down mono">error rendering ${esc(route.page)}: ${esc(String(e))}</p>`;
  }
}

/* ================= RADAR ================= */

let radarView = "cells", radarFilter = "ALL";

async function renderRadar() {
  const myGen = renderGen;
  const data = await api("/tokens");
  if (myGen !== renderGen) return;
  const tokens = data.tokens;
  const glance = data.glance;
  const filters = ["ALL", "LAUNCH", "DISCOVERY", "TREND", "GRADUATED"];
  const filtered = tokens.filter(t => radarFilter === "ALL" || t.phase === radarFilter ||
    (radarFilter === "GRADUATED" && t.phase === "DISTRIBUTION"));

  view.innerHTML = `
    <div class="screen">
      <div class="screen-head">
        <div><div class="screen-title">TOKEN RADAR</div><div class="screen-sub">scanning ${tokens.length} live DexScreener tokens · ${glance.blocked} blocked by storm warning · sweep 4.0s</div></div>
        <div class="flex1"></div>
        <div style="display:flex;gap:6px">${["CELLS", "SWEEP", "SPLIT"].map(v => `<div class="btn ${radarView === v.toLowerCase() ? "active" : ""}" data-view="${v.toLowerCase()}">${v}</div>`).join("")}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${filters.map(f => `<div class="btn ${radarFilter === f ? "active" : ""}" data-filter="${f}">${f}</div>`).join("")}</div>
      </div>
      <div class="glance-row">
        <div class="chip" style="border-color:var(--up);color:var(--up)">▲ ${glance.qualify} SETUPS QUALIFY</div>
        <div class="chip" style="color:var(--dim)">◌ ${glance.watching} WATCHING</div>
        <div class="chip" style="border-color:var(--down);color:var(--down)">✕ ${glance.blocked} BLOCKED</div>
        <div class="chip" style="border-color:var(--acc);color:var(--acc)">LIVE PRICES · COINGECKO + DEXSCREENER</div>
      </div>
      <div class="narrative-row">
        <span class="dim">NARRATIVE ROTATION</span>
        ${narrativeChipsHtml(tokens)}
        <span class="dim">· hot meta = forecast tailwind · bleeding meta = entries throttled</span>
      </div>
      <div style="display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start;justify-content:center">
        ${radarView !== "cells" ? radarSweepHtml(filtered) : ""}
        ${radarView !== "sweep" ? `<div class="cell-grid">${filtered.map(tokenCardHtml).join("") || emptyMsg()}</div>` : ""}
      </div>
    </div>`;
  wireRadarEvents();
  pollTimer = setTimeout(renderRadar, 8000);
}

function narrativeChipsHtml(tokens) {
  return tokens.slice(0, 6).map(t => {
    const n = t.narrative || {};
    const state = n.state || "ROTATING";
    const color = state === "HOT" ? "var(--up)" : state === "BLEEDING" ? "var(--down)" : "var(--warn)";
    const flow = (n.move >= 0 ? "+" : "") + (n.move || 0) + "%";
    return `<div class="meta-chip" style="border-color:${color};color:var(--ink2)">${esc(n.icon)} ${esc(n.name)} <span style="color:${color}">${esc(flow)}</span> <span style="color:${color};font-size:8px;letter-spacing:.5px">${esc(state)}</span></div>`;
  }).join("");
}

function emptyMsg() { return `<div class="dim mono">no tokens matched — waiting on the next DexScreener poll…</div>`; }

function radarSweepHtml(toks) {
  const blips = toks.map((t, i) => {
    const h = hashStr(t.symbol);
    const ang = (i / Math.max(1, toks.length)) * Math.PI * 2 + 0.4;
    const rad = t.risk === "LOW" ? 16 + (h % 12) : t.risk === "MODERATE" ? 30 + (h % 8) : 43;
    const x = (50 + Math.cos(ang) * rad).toFixed(1), y = (50 + Math.sin(ang) * rad).toFixed(1);
    const color = t.risk === "SEVERE" ? "var(--down)" : t.dir > 0 ? (t.prob >= 65 ? "var(--up)" : "var(--acc)") : "var(--warn)";
    return `<div style="position:absolute;left:${x}%;top:${y}%;transform:translate(-50%,-50%);cursor:pointer;text-align:center;z-index:2" data-go="${esc(t.symbol)}">
      <div style="width:9px;height:9px;border-radius:50%;background:${color};box-shadow:0 0 10px ${color};margin:0 auto;animation:scRadarFade 4s linear infinite;animation-delay:${(hashStr(t.symbol) % 10) / 10}s"></div>
      <div class="mono" style="font-size:9px;color:${color};margin-top:3px">${esc(t.symbol.replace("$", ""))}</div>
      <div class="mono" style="font-size:8px;color:var(--dim)">${t.prob}%</div>
    </div>`;
  }).join("");
  return `<div style="flex:0 1 560px;min-width:320px;background:var(--panel);border:1px solid var(--border);border-radius:3px;padding:20px">
    <div style="position:relative;width:100%;aspect-ratio:1;border-radius:50%;background:radial-gradient(circle,var(--bg2) 0%,var(--bg) 72%);border:1px solid var(--border);overflow:hidden">
      <div style="position:absolute;inset:0;border-radius:50%;background:conic-gradient(from 0deg,color-mix(in srgb,var(--up) 32%,transparent),color-mix(in srgb,var(--up) 6%,transparent) 70deg,transparent 90deg);animation:scSweep 4s linear infinite"></div>
      <div style="position:absolute;inset:16%;border:1px solid color-mix(in srgb,var(--acc) 16%,transparent);border-radius:50%"></div>
      <div style="position:absolute;inset:32%;border:1px solid color-mix(in srgb,var(--acc) 16%,transparent);border-radius:50%"></div>
      <div style="position:absolute;inset:44%;border:1px solid color-mix(in srgb,var(--acc) 20%,transparent);border-radius:50%"></div>
      <div style="position:absolute;left:50%;top:50%;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:50%;background:var(--acc);box-shadow:0 0 12px var(--acc);z-index:3"></div>
      ${blips}
    </div>
    <div style="display:flex;gap:16px;justify-content:center;margin-top:14px;font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--dim);flex-wrap:wrap">
      <span>DISTANCE = STORM RISK</span><span style="color:var(--up)">● CLEAR</span><span style="color:var(--warn)">● WATCH</span><span style="color:var(--down)">● SEVERE</span>
    </div>
  </div>`;
}

function tokenCardHtml(t) {
  const rc = t.risk === "LOW" ? "up" : t.risk === "MODERATE" ? "warn" : "down";
  const chgColor = t.change_pct >= 0 ? "var(--up)" : "var(--down)";
  const conflColor = t.confl >= 75 ? "var(--up)" : t.confl >= 55 ? "var(--acc)" : "var(--dim)";
  return `<div class="token-card ${t.risk === "SEVERE" ? "severe" : ""}" data-go="${esc(t.symbol)}">
    <div class="token-card-top">
      ${avatarHtml(t.avatar, 28)}
      <div class="mono" style="font-weight:800;font-size:17px">${esc(t.symbol)}</div>
      <div style="font-size:11px;color:var(--dim)">${esc(t.name)}</div>
      <div class="flex1"></div>
      <div class="mono" style="font-size:12px;color:${chgColor}">${fmtPct(t.change_pct)}</div>
    </div>
    <div class="token-card-meta">
      <span class="dim">AGE ${t.age}</span>
      <span style="padding:1px 7px;border-radius:3px;background:var(--track);color:var(--acc)">${t.phase}</span>
      <span style="padding:1px 7px;border-radius:3px;background:color-mix(in srgb,var(--${rc}) 14%,transparent);color:var(--${rc})">${t.risk}</span>
    </div>
    <div class="token-card-prob">
      <b style="color:${t.dir > 0 ? (t.prob >= 65 ? "var(--up)" : "var(--ink2)") : "var(--down)"}">${t.prob}<span style="font-size:15px">% ${t.dir > 0 ? "↑" : "↓"}</span></b>
      <div style="font-size:10px;color:var(--dim);line-height:1.5" class="mono">${t.window === "—" ? "NO WINDOW" : "NEXT " + t.window}<br>CONF: ${t.conf}</div>
    </div>
    ${sparkPolyline(t.spark, chgColor)}
    <div style="margin-top:8px">
      <div class="mono" style="display:flex;justify-content:space-between;font-size:9px;color:var(--dim)"><span>CONFLUENCE</span><span style="color:${conflColor}">${t.confl} · ${t.grade}</span></div>
      <div class="confl-bar"><div class="confl-fill" style="width:${t.confl}%;background:${conflColor}"></div></div>
    </div>
    <div class="verdict-chip" style="color:${colorVar(t.verdict.color)};background:color-mix(in srgb,${colorVar(t.verdict.color)} 10%,transparent);border:1px solid color-mix(in srgb,${colorVar(t.verdict.color)} 35%,transparent)">${esc(t.verdict.text)}</div>
    <div class="quick-buys">
      <span style="font-size:8px;color:var(--dim)">⚡</span>
      ${["0.1", "0.5", "1.0"].map(a => `<div class="qbtn" data-buy="${esc(t.symbol)}" data-amt="${a}" style="border-color:${t.blocked ? "var(--dim)" : "var(--up)"};color:${t.blocked ? "var(--dim)" : "var(--up)"}">+${a}</div>`).join("")}
      <span class="flex1"></span>
      <span class="mono" data-msg="${esc(t.symbol)}" style="font-size:8px"></span>
    </div>
  </div>`;
}

function wireRadarEvents() {
  view.querySelectorAll("[data-view]").forEach(b => b.onclick = () => { radarView = b.dataset.view; renderRadar(); });
  view.querySelectorAll("[data-filter]").forEach(b => b.onclick = () => { radarFilter = b.dataset.filter; renderRadar(); });
  view.querySelectorAll("[data-go]").forEach(el => el.addEventListener("click", (e) => {
    if (e.target.closest("[data-buy]")) return;
    goForecast(el.dataset.go);
  }));
  wireQuickBuys();
}

function wireQuickBuys() {
  view.querySelectorAll("[data-buy]").forEach(b => b.onclick = async (e) => {
    e.stopPropagation();
    const sym = b.dataset.buy, amt = b.dataset.amt;
    const r = await post("/trade", { symbol: sym, side: "buy", sol_amount: parseFloat(amt) });
    const msgEl = view.querySelector(`[data-msg="${CSS.escape(sym)}"]`);
    if (msgEl) {
      msgEl.textContent = r.status === "filled" ? "✓ FILLED · 0.4s" : "⛔ " + (r.reject_reason || "blocked");
      msgEl.style.color = r.status === "filled" ? "var(--up)" : "var(--down)";
    }
    refreshWalletDock();
  });
}

function goForecast(symbol) { selectedSymbol = symbol; location.hash = "#/forecast/" + encodeURIComponent(symbol); }

/* ================= DISCOVER ================= */

let discTab = "TRENDING", discPreset = 1, discCustom = null;
const DISC_PRESETS = [0.1, 0.5, 1.0];
let discFilterOpen = false;
let discFilters = {
  q: "", liqMin: "", liqMax: "", conflMin: 0,
  risk: { LOW: true, MODERATE: true, SEVERE: true },
  phase: { LAUNCH: true, DISCOVERY: true, TREND: true, GRADUATED: true, DISTRIBUTION: true },
  dexPaid: false, ageMin: "", ageMax: "",
};

function ageToHours(age) {
  if (!age || age === "?") return null;
  const s = String(age).trim();
  const m = s.match(/^([0-9.]+)\s*(m|h|d|mo|y)$/i);
  if (!m) return null;
  const v = parseFloat(m[1]), unit = m[2].toLowerCase();
  if (unit === "m") return v / 60;
  if (unit === "h") return v;
  if (unit === "d") return v * 24;
  if (unit === "mo") return v * 24 * 30;
  if (unit === "y") return v * 24 * 365;
  return null;
}
function parseLiq(s) {
  if (!s) return null;
  s = String(s).trim().replace(/[$,]/g, "").toUpperCase();
  let mul = 1;
  if (s.endsWith("K")) { mul = 1e3; s = s.slice(0, -1); }
  else if (s.endsWith("M")) { mul = 1e6; s = s.slice(0, -1); }
  else if (s.endsWith("B")) { mul = 1e9; s = s.slice(0, -1); }
  const n = parseFloat(s);
  return isNaN(n) ? null : n * mul;
}
function discActiveFilterCount() {
  let n = 0;
  if (discFilters.q) n++;
  if (discFilters.liqMin || discFilters.liqMax) n++;
  if (discFilters.conflMin > 0) n++;
  if (!discFilters.risk.LOW || !discFilters.risk.MODERATE || !discFilters.risk.SEVERE) n++;
  if (!discFilters.phase.LAUNCH || !discFilters.phase.DISCOVERY || !discFilters.phase.TREND || !discFilters.phase.GRADUATED || !discFilters.phase.DISTRIBUTION) n++;
  if (discFilters.dexPaid) n++;
  if (discFilters.ageMin || discFilters.ageMax) n++;
  return n;
}
function discMatchesFilters(t) {
  const f = discFilters;
  const q = f.q.toLowerCase();
  if (q && !t.symbol.toLowerCase().includes(q) && !t.name.toLowerCase().includes(q)) return false;
  const liq = parseLiq(t.liquidity_fmt);
  const liqMin = parseLiq(f.liqMin), liqMax = parseLiq(f.liqMax);
  if (liq != null && liqMin != null && liq < liqMin) return false;
  if (liq != null && liqMax != null && liq > liqMax) return false;
  if (t.confl < f.conflMin) return false;
  if (!f.risk[t.risk]) return false;
  if (!f.phase[t.phase]) return false;
  if (f.dexPaid && !t.audit.dex_paid) return false;
  const ah = ageToHours(t.age);
  const ageMin = parseFloat(f.ageMin), ageMax = parseFloat(f.ageMax);
  if (ah != null && !isNaN(ageMin) && ah < ageMin) return false;
  if (ah != null && !isNaN(ageMax) && ah > ageMax) return false;
  return true;
}

async function renderDiscover() {
  const myGen = renderGen;
  const data = await api("/tokens");
  if (myGen !== renderGen) return;
  const tokens = data.tokens;
  const preset = discCustom ?? DISC_PRESETS[discPreset];
  const tabs = {
    TRENDING: () => true, SURGE: t => Math.abs(t.change_pct) >= 10,
    "NEW PAIRS": t => t.phase === "LAUNCH" || t.phase === "DISCOVERY", QUALIFIED: t => t.confl >= 55,
  };
  let rows = tokens.filter(tabs[discTab]).filter(discMatchesFilters).sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct));

  view.innerHTML = `
    <div class="screen">
      <div class="screen-head">
        <div><div class="screen-title">DISCOVER</div><div class="screen-sub">real DexScreener pairs, trending by boosted attention · pre-entry audit is simulated · quick buy respects paused/exit-only</div></div>
        <div class="flex1"></div>
        ${Object.keys(tabs).map(k => `<div class="btn ${discTab === k ? "active" : ""}" data-tab="${k}">${k}</div>`).join("")}
      </div>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px" class="mono">
        <div class="btn ${discFilterOpen ? "active" : ""}" id="disc-filter-btn" style="position:relative">
          ⛭ FILTERS ${discActiveFilterCount() ? `<span style="display:inline-block;margin-left:6px;padding:1px 5px;border-radius:3px;background:var(--acc);color:var(--bg);font-size:9px">${discActiveFilterCount()}</span>` : ""}
        </div>
        <div style="display:flex;align-items:center;gap:8px;padding:5px 12px;background:var(--panel);border:1px solid var(--border);border-radius:3px;font-size:10px">
          <span class="dim" style="letter-spacing:1px">⚡ QUICK BUY</span>
          <input id="disc-amt" value="${preset}" style="width:44px;background:var(--bg2);border:1px solid var(--border);border-radius:2px;color:var(--acc2);font-family:'JetBrains Mono',monospace;font-size:11px;padding:2px 5px;outline:none;text-align:right">
          <span class="dim">SOL</span>
          ${["P1", "P2", "P3"].map((l, i) => `<span data-preset="${i}" style="cursor:pointer;padding:2px 8px;border-radius:2px;${discPreset === i && discCustom == null ? "color:var(--acc2);background:color-mix(in srgb,var(--acc2) 14%,transparent);font-weight:700" : "color:var(--dim)"}">${l}</span>`).join("")}
        </div>
      </div>
      <div style="position:relative">
        ${discFilterOpen ? discoverFilterPanelHtml(tokens.length, rows.length) : ""}
        <div class="disc-table"><div class="disc-row-inner">
          <div class="disc-grid disc-head"><span>PAIR INFO</span><span>PRICE</span><span>CHART</span><span class="right">MKT CAP</span><span class="right">LIQUIDITY</span><span class="right">VOLUME</span><span class="right">TXNS</span><span>TOKEN AUDIT</span><span class="right">ACTION</span></div>
          ${rows.map(t => discRowHtml(t, preset)).join("") || `<div style="padding:16px" class="dim mono">no rows match this tab yet</div>`}
        </div></div>
      </div>
    </div>`;
  wireDiscoverEvents();
  if (!discFilterOpen) pollTimer = setTimeout(renderDiscover, 8000);
}

function discoverFilterPanelHtml(total, hits) {
  const f = discFilters;
  const chk = (name, key, obj) => `<label style="display:flex;align-items:center;gap:7px;cursor:pointer;font-size:10px;color:var(--ink2)"><input type="checkbox" data-fkey="${key}" data-fname="${name}" ${obj[name] ? "checked" : ""} style="width:auto;margin:0">${name}</label>`;
  return `<div class="filter-panel" id="disc-filter-panel">
    <div style="display:flex;align-items:center;margin-bottom:14px">
      <span style="font-size:12px;font-weight:700;letter-spacing:2px;color:var(--ink)">FILTERS</span>
      <span class="flex1"></span>
      <span id="disc-filter-reset" style="font-size:9px;color:var(--warn);cursor:pointer;letter-spacing:1px;margin-right:14px">⟲ RESET</span>
      <span id="disc-filter-close" style="font-size:12px;color:var(--dim);cursor:pointer">✕</span>
    </div>
    <label style="font-size:9px;color:var(--dim);letter-spacing:1px">SEARCH SYMBOL / NAME<input id="disc-f-q" value="${esc(f.q)}" placeholder="e.g. WIF" style="display:block;width:100%;margin-top:4px;background:var(--panel);border:1px solid var(--border);border-radius:2px;color:var(--ink);font-family:'JetBrains Mono',monospace;font-size:11px;padding:5px 7px;outline:none;box-sizing:border-box"></label>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px 14px;margin-top:12px">
      <label style="font-size:9px;color:var(--dim);letter-spacing:1px">LIQUIDITY $ MIN<input id="disc-f-liqmin" value="${esc(f.liqMin)}" placeholder="e.g. 50K" style="display:block;width:100%;margin-top:4px;background:var(--panel);border:1px solid var(--border);border-radius:2px;color:var(--ink);font-family:'JetBrains Mono',monospace;font-size:11px;padding:5px 7px;outline:none;box-sizing:border-box"></label>
      <label style="font-size:9px;color:var(--dim);letter-spacing:1px">LIQUIDITY $ MAX<input id="disc-f-liqmax" value="${esc(f.liqMax)}" placeholder="e.g. 2M" style="display:block;width:100%;margin-top:4px;background:var(--panel);border:1px solid var(--border);border-radius:2px;color:var(--ink);font-family:'JetBrains Mono',monospace;font-size:11px;padding:5px 7px;outline:none;box-sizing:border-box"></label>
      <label style="font-size:9px;color:var(--dim);letter-spacing:1px">AGE HOURS MIN<input id="disc-f-agemin" value="${esc(f.ageMin)}" placeholder="e.g. 1" style="display:block;width:100%;margin-top:4px;background:var(--panel);border:1px solid var(--border);border-radius:2px;color:var(--ink);font-family:'JetBrains Mono',monospace;font-size:11px;padding:5px 7px;outline:none;box-sizing:border-box"></label>
      <label style="font-size:9px;color:var(--dim);letter-spacing:1px">AGE HOURS MAX<input id="disc-f-agemax" value="${esc(f.ageMax)}" placeholder="e.g. 48" style="display:block;width:100%;margin-top:4px;background:var(--panel);border:1px solid var(--border);border-radius:2px;color:var(--ink);font-family:'JetBrains Mono',monospace;font-size:11px;padding:5px 7px;outline:none;box-sizing:border-box"></label>
    </div>
    <div style="margin-top:12px">
      <div style="font-size:9px;color:var(--dim);letter-spacing:1px;margin-bottom:6px">MIN CONFLUENCE <span style="float:right;color:var(--acc)">${f.conflMin}</span></div>
      <input id="disc-f-confl" type="range" min="0" max="90" value="${f.conflMin}" style="width:100%;margin:0">
    </div>
    <div style="margin-top:14px">
      <div style="font-size:9px;color:var(--dim);letter-spacing:1px;margin-bottom:6px">RISK</div>
      <div style="display:flex;gap:12px;flex-wrap:wrap">${["LOW","MODERATE","SEVERE"].map(r => chk(r, "risk", f.risk)).join("")}</div>
    </div>
    <div style="margin-top:14px">
      <div style="font-size:9px;color:var(--dim);letter-spacing:1px;margin-bottom:6px">PHASE</div>
      <div style="display:flex;gap:12px;flex-wrap:wrap">${["LAUNCH","DISCOVERY","TREND","GRADUATED","DISTRIBUTION"].map(p => chk(p, "phase", f.phase)).join("")}</div>
    </div>
    <div style="margin-top:14px;display:flex;align-items:center;gap:8px;cursor:pointer" id="disc-f-dexpaid">
      <span style="width:14px;height:14px;border:1px solid var(--border);border-radius:3px;display:flex;align-items:center;justify-content:center;font-size:10px;color:${f.dexPaid ? "var(--up)" : "transparent"}">${f.dexPaid ? "✓" : ""}</span>
      <span style="font-size:10px;color:var(--ink2)">DEX PAID ONLY</span>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:16px;border-top:1px solid var(--track);padding-top:12px">
      <span style="font-size:9px;color:var(--dim)">${hits} OF ${total} PAIRS MATCH</span>
      <div id="disc-filter-apply" style="font-size:10px;font-weight:700;letter-spacing:1px;padding:7px 18px;border-radius:2px;cursor:pointer;background:var(--acc);color:var(--bg)">APPLY</div>
    </div>
  </div>`;
}

function discRowHtml(t, preset) {
  const chgColor = t.change_pct >= 0 ? "var(--up)" : "var(--down)";
  const a = t.audit;
  const hColor = a.top10 > 30 ? "var(--down)" : a.top10 > 20 ? "var(--warn)" : "var(--up)";
  const sColor = a.snipers > 15 ? "var(--down)" : a.snipers > 5 ? "var(--warn)" : "var(--up)";
  return `<div class="disc-grid disc-body-row" data-go="${esc(t.symbol)}">
    <div style="display:flex;align-items:center;gap:9px">
      ${avatarHtml(t.avatar, 30)}
      <div><div class="mono" style="font-size:12px;font-weight:800">${esc(t.symbol)} <span style="font-weight:400;color:var(--dim);font-size:10px">${esc(t.name)}</span></div>
      <div class="mono" style="font-size:9px;color:var(--acc)">${t.age} · ${esc(t.phase)} · ${esc(t.dex_id)}</div></div>
    </div>
    <div class="mono" style="font-size:11px"><div>${t.price_fmt}</div><div style="font-size:10px;color:${chgColor}">${fmtPct(t.change_pct)}</div></div>
    ${sparkPolyline(t.spark, chgColor)}
    <div class="right mono">${t.mcap_fmt}</div>
    <div class="right mono">${t.liquidity_fmt}</div>
    <div class="right mono">${t.volume_fmt}</div>
    <div class="right mono"><div>${t.txns_buy + t.txns_sell}</div><div style="font-size:9px"><span class="up">${t.txns_buy}</span> <span class="dim">/</span> <span class="down">${t.txns_sell}</span></div></div>
    <div class="mono" style="display:flex;flex-direction:column;gap:3px;font-size:8.5px">
      <span><span style="color:${hColor}">⚉ TOP10 ${a.top10}%</span> <span style="color:${sColor}">◎ SNIPE ${a.snipers}%</span></span>
      <span class="dim">DEX ${a.dex_paid ? "PAID" : "UNPAID"}</span>
    </div>
    <div style="display:flex;justify-content:flex-end">
      <div class="qbtn" data-buy="${esc(t.symbol)}" data-amt="${preset}" style="border-color:${t.blocked ? "var(--dim)" : "var(--up)"};color:${t.blocked ? "var(--dim)" : "var(--up)"};max-width:80px">${t.blocked ? "LOCKED" : "BUY " + preset}</div>
    </div>
  </div>`;
}

function wireDiscoverEvents() {
  view.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => { discTab = b.dataset.tab; renderDiscover(); });
  view.querySelectorAll("[data-preset]").forEach(b => b.onclick = () => { discPreset = +b.dataset.preset; discCustom = null; renderDiscover(); });
  const amtInput = document.getElementById("disc-amt");
  if (amtInput) amtInput.onchange = () => { discCustom = parseFloat(amtInput.value) || DISC_PRESETS[discPreset]; };
  const toggle = () => { discFilterOpen = !discFilterOpen; renderDiscover(); };
  const closeBtn = document.getElementById("disc-filter-close");
  if (closeBtn) closeBtn.onclick = toggle;
  const btn = document.getElementById("disc-filter-btn");
  if (btn) btn.onclick = toggle;
  const apply = document.getElementById("disc-filter-apply");
  if (apply) apply.onclick = toggle;
  const reset = document.getElementById("disc-filter-reset");
  if (reset) reset.onclick = () => {
    discFilters = { q: "", liqMin: "", liqMax: "", conflMin: 0,
      risk: { LOW: true, MODERATE: true, SEVERE: true },
      phase: { LAUNCH: true, DISCOVERY: true, TREND: true, GRADUATED: true, DISTRIBUTION: true },
      dexPaid: false, ageMin: "", ageMax: "" };
    renderDiscover();
  };
  const qIn = document.getElementById("disc-f-q");
  if (qIn) qIn.oninput = () => discFilters.q = qIn.value;
  const liqMin = document.getElementById("disc-f-liqmin"), liqMax = document.getElementById("disc-f-liqmax");
  if (liqMin) liqMin.oninput = () => discFilters.liqMin = liqMin.value;
  if (liqMax) liqMax.oninput = () => discFilters.liqMax = liqMax.value;
  const ageMin = document.getElementById("disc-f-agemin"), ageMax = document.getElementById("disc-f-agemax");
  if (ageMin) ageMin.oninput = () => discFilters.ageMin = ageMin.value;
  if (ageMax) ageMax.oninput = () => discFilters.ageMax = ageMax.value;
  const confl = document.getElementById("disc-f-confl");
  if (confl) confl.oninput = () => discFilters.conflMin = parseInt(confl.value);
  view.querySelectorAll("[data-fkey]").forEach(b => b.onchange = () => {
    const k = b.dataset.fkey, name = b.dataset.fname;
    if (k === "risk") discFilters.risk[name] = b.checked;
    if (k === "phase") discFilters.phase[name] = b.checked;
  });
  const dexPaid = document.getElementById("disc-f-dexpaid");
  if (dexPaid) dexPaid.onclick = () => { discFilters.dexPaid = !discFilters.dexPaid; renderDiscover(); };
  view.querySelectorAll("[data-go]").forEach(el => el.addEventListener("click", (e) => {
    if (e.target.closest("[data-buy]") || e.target.closest(".filter-panel") || e.target.closest("#disc-filter-btn")) return;
    goForecast(el.dataset.go);
  }));
  wireQuickBuys();
}

/* ================= PULSE ================= */

let pulseQ = { NEW: "", FINAL: "", MIG: "" };

async function renderPulse() {
  const myGen = renderGen;
  const data = await api("/tokens");
  if (myGen !== renderGen) return;
  const tokens = data.tokens;
  const groups = {
    NEW: { title: "NEW PAIRS", sub: "under 1h old · live from DexScreener", color: "var(--acc2)", rows: tokens.filter(t => t.phase === "LAUNCH") },
    FINAL: { title: "DISCOVERY", sub: "attention building, unproven", color: "var(--warn)", rows: tokens.filter(t => t.phase === "DISCOVERY") },
    MIG: { title: "ESTABLISHED", sub: "trend / graduated / distribution", color: "var(--up)", rows: tokens.filter(t => ["TREND", "GRADUATED", "DISTRIBUTION"].includes(t.phase)) },
  };
  view.innerHTML = `
    <div class="screen">
      <div class="screen-head"><div><div class="screen-title">PULSE</div><div class="screen-sub">live lifecycle board · storm checks run before any row is buyable</div></div></div>
      <div class="pulse-cols">
        ${Object.entries(groups).map(([key, g]) => {
          const rows = g.rows.filter(r => { const q = pulseQ[key].toLowerCase(); return !q || r.symbol.toLowerCase().includes(q) || r.name.toLowerCase().includes(q); });
          return `<div class="pulse-col">
            <div class="pulse-col-head"><span class="mono" style="font-size:11px;font-weight:700;letter-spacing:2px;color:${g.color}">${g.title}</span><span class="mono dim" style="font-size:9px">${g.sub}</span><span class="flex1"></span><span class="dot" style="background:${g.color}"></span></div>
            <div class="pulse-search"><input placeholder="search by ticker or name" data-pulseq="${key}" value="${esc(pulseQ[key])}"></div>
            <div class="pulse-rows">${rows.map(t => pulseRowHtml(t)).join("") || `<div style="padding:14px" class="dim mono">nothing here right now</div>`}</div>
          </div>`;
        }).join("")}
      </div>
    </div>`;
  wirePulseEvents();
  pollTimer = setTimeout(renderPulse, 8000);
}

function pulseRowHtml(t) {
  const a = t.audit;
  return `<div class="pulse-row" data-go="${esc(t.symbol)}">
    <div style="display:flex;gap:10px;align-items:flex-start">
      ${avatarHtml(t.avatar, 32)}
      <div style="flex:1;min-width:0">
        <div class="mono" style="font-size:12px;font-weight:800">${esc(t.symbol)} <span style="font-weight:400;color:var(--dim);font-size:10px">${esc(t.name)}</span></div>
        <div class="mono dim" style="font-size:9px;margin-top:2px"><span class="acc">${t.age}</span> · ⚉ ${a.holders.toLocaleString()} holders</div>
      </div>
      <div style="text-align:right;flex-shrink:0" class="mono">
        <div style="font-size:11px;font-weight:700">MC ${t.mcap_fmt}</div>
        <div style="font-size:9px;color:var(--dim)">V ${t.volume_fmt}</div>
        <div class="qbtn" data-buy="${esc(t.symbol)}" data-amt="0.5" style="margin-top:6px;padding:4px 10px;font-size:9px;display:inline-block;border-color:${t.blocked ? "var(--dim)" : "var(--up)"};color:${t.blocked ? "var(--dim)" : "var(--up)"}">${t.blocked ? "LOCKED" : "⚡ 0.5"}</div>
      </div>
    </div>
  </div>`;
}

function wirePulseEvents() {
  view.querySelectorAll("[data-pulseq]").forEach(inp => inp.oninput = () => { pulseQ[inp.dataset.pulseq] = inp.value; renderPulse(); });
  view.querySelectorAll("[data-go]").forEach(el => el.addEventListener("click", (e) => {
    if (e.target.closest("[data-buy]")) return;
    goForecast(el.dataset.go);
  }));
  wireQuickBuys();
}

/* ================= FORECAST ================= */

let fcTermTab = "TRADES";

async function renderForecast(symbolArg) {
  const myGen = renderGen;
  const list = await api("/tokens");
  if (myGen !== renderGen) return;
  const symbol = symbolArg || selectedSymbol || (list.tokens[0] && list.tokens[0].symbol);
  if (!symbol) { view.innerHTML = `<p class="dim mono">no tokens loaded yet</p>`; return; }
  selectedSymbol = symbol;
  const t = await api("/tokens/" + encodeURIComponent(symbol));
  if (myGen !== renderGen) return;
  if (t.error) { view.innerHTML = `<p class="down mono">${esc(t.error)}</p>`; return; }

  const gauges = [
    { label: "LIQUIDITY", val: Math.min(99, Math.round((t.audit.top10 < 20 ? 70 : 35))), color: t.risk === "SEVERE" ? "var(--down)" : "var(--up)" },
    { label: "VOLATILITY", val: Math.min(99, Math.round(Math.abs(t.change_pct))), color: Math.abs(t.change_pct) > 60 ? "var(--down)" : "var(--warn)" },
    { label: "CONFIDENCE", val: t.confl, color: t.confl >= 55 ? "var(--up)" : "var(--dim)" },
  ];

  view.innerHTML = `
    <div class="screen">
      <div class="fc-head">
        <div class="mono acc" style="cursor:pointer" id="fc-back">← RADAR</div>
        ${avatarHtml(t.avatar, 36)}
        <div class="mono" style="font-weight:800;font-size:24px">${esc(t.symbol)}</div>
        <div class="mono" style="font-size:18px">${t.price_fmt}</div>
        <div class="mono" style="font-size:13px;color:${t.change_pct >= 0 ? "var(--up)" : "var(--down)"}">${fmtPct(t.change_pct)}</div>
        <div class="mono dim" style="font-size:10px">AGE ${t.age} · PHASE <span class="acc">${t.phase}</span></div>
        <div class="mono" style="display:flex;gap:18px;flex-wrap:wrap;font-size:10px">
          <span class="dim">MC<br><span class="ink" style="font-size:12px;color:var(--ink)">${t.mcap_fmt}</span></span>
          <span class="dim">LIQUIDITY<br><span style="font-size:12px;color:var(--ink)">${t.liquidity_fmt}</span></span>
          <span class="dim">HOLDERS<br><span style="font-size:12px;color:var(--ink)">${t.audit.holders.toLocaleString()}</span></span>
        </div>
        <div class="flex1"></div>
        <div class="chip" style="background:color-mix(in srgb,${colorVar(t.risk === "SEVERE" ? "down" : t.risk === "MODERATE" ? "warn" : "up")} 14%,transparent);color:${colorVar(t.risk === "SEVERE" ? "down" : t.risk === "MODERATE" ? "warn" : "up")}">STORM RISK: ${t.risk}</div>
      </div>

      <div class="fc-layout">
        <div class="fc-main">
          <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-bottom:14px">
            <div class="verdict-banner" style="color:${colorVar(t.verdict.color)};background:color-mix(in srgb,${colorVar(t.verdict.color)} 12%,transparent);border:1px solid ${colorVar(t.verdict.color)}">${esc(t.verdict.text)}</div>
            <div style="font-size:14px;color:var(--ink2);flex:1;min-width:240px">${esc(t.verdict.plain)}</div>
            <div style="display:flex;align-items:center;gap:10px">
              <div style="width:56px;height:56px;border-radius:50%;background:conic-gradient(var(--up) ${Math.round(t.agree / 6 * 100)}%, var(--track) 0);display:flex;align-items:center;justify-content:center">
                <div class="mono" style="width:42px;height:42px;border-radius:50%;background:var(--bg);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700">${t.agree}/6</div>
              </div>
              <div class="mono dim" style="font-size:9px;letter-spacing:1px;line-height:1.5">MODEL<br>AGREEMENT</div>
            </div>
          </div>

          <div class="panel" style="display:flex;gap:28px;flex-wrap:wrap;align-items:center;margin-bottom:16px">
            <div>
              <div class="mono dim" style="font-size:10px;letter-spacing:1px">FORECAST (SIMULATED)</div>
              <div class="mono" style="font-size:44px;font-weight:800;color:${t.dir > 0 ? "var(--up)" : "var(--down)"};line-height:1.1">${t.prob}% ${t.dir > 0 ? "↑" : "↓"}</div>
              <div class="mono dim" style="font-size:11px">next ${t.window === "—" ? "no window" : t.window} · confidence <span class="ink" style="color:var(--ink)">${t.conf}</span> (${t.agree}/6 models)</div>
            </div>
            <div style="display:flex;gap:18px;flex-wrap:wrap">
              ${gauges.map(g => `<div class="gauge-wrap"><div style="width:74px;height:8px;background:var(--track);border-radius:4px;margin-top:16px"><div style="width:${g.val}%;height:8px;border-radius:4px;background:${g.color}"></div></div><div class="mono dim" style="font-size:8px;letter-spacing:1px;margin-top:4px">${g.label}</div><div class="mono" style="font-size:11px;font-weight:700;color:${g.color}">${g.val}%</div></div>`).join("")}
            </div>
            ${quickTradePanelHtml(t)}
          </div>

          <div class="panel" style="margin-bottom:16px">${chartPanelHtml(t)}</div>

          <div class="panel" style="padding:0;margin-bottom:16px">
            <div class="term-tabs">${["TRADES", "POSITION", "ORDERS", "HOLDERS", "TOP TRADERS", "DEV WALLET"].map(k => `<div class="term-tab ${fcTermTab === k ? "active" : ""}" data-term="${k}">${k}</div>`).join("")}</div>
            <div style="padding:12px 16px">${termTabHtml(t)}</div>
          </div>

          <div style="display:flex;gap:16px;flex-wrap:wrap">
            <div class="panel" style="flex:1 1 380px">
              <h4>ENSEMBLE BREAKDOWN (SIMULATED) · AGREEMENT ${t.agree}/6</h4>
              ${t.ensemble.map(m => `<div class="ensemble-row"><div style="width:96px" class="dim">${m.name}</div><div style="width:16px;color:${colorVar(m.dir_color)};font-weight:700">${m.dir}</div><div class="ensemble-bar"><div class="ensemble-fill" style="width:${m.prob}%;background:${colorVar(m.dir_color)}"></div></div><div style="width:36px;text-align:right">${m.prob}%</div><div style="width:56px;text-align:right;color:var(--dim);font-size:9px">${m.conf}</div></div>`).join("")}
            </div>
            <div class="panel" style="flex:1 1 380px">
              <h4>STORM RISK PANEL (SIMULATED) · PRE-ENTRY CHECKLIST</h4>
              <div style="display:flex;flex-wrap:wrap;gap:8px">
                ${t.checklist.map(k => `<div class="chip" style="border-color:${k.ok ? "var(--up)" : "var(--down)"};color:${k.ok ? "var(--up)" : "var(--down)"}">${k.mark} ${esc(k.label)}</div>`).join("")}
              </div>
              <div class="mono dim" style="margin-top:16px;font-size:11px;line-height:2">RSI-14 <span style="float:right;color:${t.rsi > 70 ? "var(--down)" : t.rsi < 30 ? "var(--up)" : "var(--acc)"}">${t.rsi} · ${t.rsi > 70 ? "OVERBOUGHT" : t.rsi < 30 ? "OVERSOLD" : "NEUTRAL"}</span></div>
            </div>
          </div>

          <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:16px">
            <div class="panel" style="flex:1 1 300px">
              <h4>HOLDER MAP (SIMULATED) · TOP-10 ${t.audit.top10}% · ${t.audit.holders.toLocaleString()} HOLDERS</h4>
              ${holderPieHtml(t.holders)}
            </div>
            <div class="panel" style="flex:1 1 300px">
              <h4>ORDER FLOW (SIMULATED) · LIVE TAPE</h4>
              <div class="progress-track"><div style="width:${t.buy_pct}%;background:linear-gradient(90deg,color-mix(in srgb,var(--up) 55%,transparent),var(--up))"></div><div style="flex:1;background:linear-gradient(90deg,var(--down),color-mix(in srgb,var(--down) 55%,transparent))"></div></div>
              <div style="display:flex;justify-content:space-between;font-size:9px;margin-bottom:10px" class="mono"><span class="up">BUY ${t.buy_pct}%</span><span class="down">SELL ${t.sell_pct}%</span></div>
              ${t.tape.map(tp => `<div style="display:flex;gap:10px;font-size:10px;padding:3.5px 0;border-top:1px solid var(--track)" class="mono"><span class="dim" style="width:46px">${tp.ago}</span><span style="width:34px;font-weight:700;color:${tp.side === "BUY" ? "var(--up)" : "var(--down)"}">${tp.side}</span><span style="flex:1">${tp.amt}</span><span class="acc2" style="font-size:9px">${esc(tp.tag)}</span></div>`).join("")}
            </div>
            <div class="panel" style="flex:1 1 300px">
              <h4>PATTERN MEMORY (SIMULATED) · ${t.matches.length} SIMILAR SETUPS</h4>
              ${t.matches.map(m => `<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">${sparkPolyline([10,14,11,16,12,18,14,20], colorVar(m.color), 26)}<div class="mono" style="flex:1;font-size:10px"><div>${esc(m.tk)} <span class="dim">· ${m.when}</span></div><div class="dim" style="font-size:9px">similarity ${m.sim}%</div></div><div class="mono" style="font-size:12px;font-weight:700;color:${colorVar(m.color)}">${m.out}</div></div>`).join("")}
            </div>
          </div>
        </div>

        <div class="fc-rail">${railHtml(t)}</div>
      </div>
    </div>`;

  wireForecastEvents(t);
  // In LIVE mode the embedded chart updates itself — don't auto-re-render, or
  // we'd tear down & reload the iframe every 8s. FORECAST mode polls as usual.
  if (!(fcChartMode === "live" && t.live_chart_url)) {
    pollTimer = setTimeout(() => renderForecast(symbol), 8000);
  }
}

function quickTradePanelHtml(t) {
  return `<div style="min-width:250px;background:var(--bg2);border:1px solid color-mix(in srgb,var(--acc2) 40%,var(--border));border-radius:3px;padding:14px" class="mono">
    <div style="font-size:10px;color:var(--acc2);letter-spacing:2px;font-weight:700;margin-bottom:10px">⚡ QUICK TRADE</div>
    <div style="display:flex;gap:5px;margin-bottom:6px">
      ${["0.1","0.5","1","2"].map(a => `<div class="qbtn" data-fcbuy="${a}" style="border-color:${t.blocked ? "var(--dim)" : "var(--up)"};color:${t.blocked ? "var(--dim)" : "var(--up)"}">BUY ${a}</div>`).join("")}
    </div>
    ${t.has_position ? `<div style="display:flex;gap:5px;margin-bottom:6px">${["25","50","75","100"].map(p => `<div class="qbtn" data-fcsell="${p}" style="border-color:var(--down);color:var(--down)">SELL ${p}%</div>`).join("")}</div>` : ""}
    <div id="fc-qt-msg" class="inline-msg dim">ready · paper fill only</div>
  </div>`;
}

// chart mode: "live" = real DexScreener/TradingView embed, "forecast" = our
// simulated candles + overlays. Which overlays are shown on the forecast chart.
let fcChartMode = "live";
let fcOverlays = { ema: true, trend: true, cone: true, vol: true };
let fcChartTf = "1M", fcChartStyle = "CANDLES";

function chartPanelHtml(t) {
  const hasLive = !!t.live_chart_url;
  const mode = (fcChartMode === "live" && !hasLive) ? "forecast" : fcChartMode;
  const tabs = `<div class="chart-tabs">
    ${hasLive ? `<div class="chart-tab ${mode === "live" ? "active" : ""}" data-chartmode="live">◉ LIVE</div>` : ""}
    <div class="chart-tab ${mode === "forecast" ? "active" : ""}" data-chartmode="forecast">FORECAST</div>
  </div>`;

  if (mode === "live") {
    return `<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px">
        ${tabs}
        <div class="mono dim" style="font-size:10px;letter-spacing:1px">${esc(t.symbol)} · REAL LIVE CHART · DexScreener (TradingView engine) · updates to the second</div>
        <span class="flex1"></span>
        <a class="mono acc" style="font-size:9px" href="${esc(t.url)}" target="_blank" rel="noopener">↗ open on DexScreener</a>
      </div>
      <div class="chart-area chart-live">
        <iframe src="${esc(t.live_chart_url)}" loading="lazy" title="${esc(t.symbol)} live chart" allow="clipboard-write"></iframe>
      </div>`;
  }
  const tfs = ["1S", "1M", "5M", "15M", "1H"];
  const styles = ["CANDLES", "LINE"];
  const controls = `<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px" class="mono">
      <div style="display:flex;gap:2px">${tfs.map(tf => `<div class="chart-tab ${fcChartTf === tf ? "active" : ""}" data-c_tf="${tf}">${tf}</div>`).join("")}</div>
      <div style="width:1px;height:16px;background:var(--track)"></div>
      <div style="display:flex;gap:2px">${styles.map(s => `<div class="chart-tab ${fcChartStyle === s ? "active" : ""}" data-c_style="${s}">${s}</div>`).join("")}</div>
      <div style="flex:1"></div>
      ${chartLegendHtml(t)}
    </div>`;
  const probs = t.chart_probs || {};
  const strip = `<div style="display:flex;gap:22px;margin-top:12px;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--dim);flex-wrap:wrap">
    <span>P(+25% / 1H) <span style="color:var(--up)">${probs.up_1h ?? "—"}%</span></span>
    <span>P(−50% / 1H) <span style="color:var(--down)">${probs.down_1h ?? "—"}%</span></span>
    <span>EXP. MAX DRAWDOWN <span style="color:var(--warn)">${esc(probs.max_dd ?? "—")}</span></span>
    <span>15M STRUCTURE <span style="color:${colorVar(probs.structure_color || "dim")}">${esc(probs.structure ?? "—")}</span></span>
  </div>`;
  return `<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px">
      ${tabs}
      <div class="mono dim" style="font-size:10px;letter-spacing:1px">${esc(t.symbol)} · SIMULATED OHLCV · EMA / TREND / FORECAST CONE are illustrative, not real OHLC</div>
      <span class="flex1"></span>
    </div>
    ${controls}
    <div class="chart-area">${candleChartHtml(t)}</div>
    <div style="display:flex;justify-content:space-between;font-size:9px;color:var(--dim);margin-top:4px" class="mono"><span>${t.min_price_fmt}</span><span>${t.max_price_fmt}</span></div>
    ${strip}`;
}

function candleChartHtml(t) {
  const isLine = fcChartStyle === "LINE";
  let candles = "";
  if (isLine && t.candles && t.candles.length) {
    const linePts = t.candles.map((c, i) => {
      const x = (c.left + c.w / 2).toFixed(1);
      const y = (c.wick_top + c.wick_h / 2).toFixed(1);
      return `${x},${y}`;
    }).join(" ");
    const first = t.candles[0], last = t.candles[t.candles.length - 1];
    const fx = (first.left + first.w / 2).toFixed(1), fy = (first.wick_top + first.wick_h / 2).toFixed(1);
    const lx = (last.left + last.w / 2).toFixed(1), ly = (last.wick_top + last.wick_h / 2).toFixed(1);
    const area = `${fx},${fy} ${linePts} ${lx},100 0,100`;
    candles = `<svg class="chart-overlay" viewBox="0 0 100 100" preserveAspectRatio="none"><polygon points="${area}" fill="color-mix(in srgb,var(--acc) 10%,transparent)" stroke="none"></polygon><polyline points="${linePts}" fill="none" stroke="var(--acc)" stroke-width="1.2" vector-effect="non-scaling-stroke" opacity="0.9"></polyline></svg>`;
  } else {
    candles = t.candles.map(c => `<div class="candle" style="left:${c.left}%;width:${c.w}%">
      <div class="wick" style="top:${c.wick_top}%;height:${c.wick_h}%;background:${c.up ? "var(--up)" : "var(--down)"}"></div>
      <div class="body" style="top:${c.body_top}%;height:${c.body_h}%;background:${c.up ? "var(--up)" : "var(--down)"}"></div>
    </div>`).join("");
  }

  const pts = a => a.map(p => `${p.x},${p.y}`).join(" ");
  // divider between price chart and volume subplot
  let svg = `<line x1="0" y1="76" x2="100" y2="76" stroke="var(--border)" stroke-width="0.5" vector-effect="non-scaling-stroke" opacity="0.6"></line>`;
  if (fcOverlays.vol && t.volume) {
    svg += t.volume.map((v, i) => `<rect x="${v.x}" y="${v.y}" width="${v.w}" height="${v.h}" fill="${v.up ? "var(--up)" : "var(--down)"}" opacity="0.45" style="animation:scBarGrow .6s ease both;animation-delay:${i * 20}ms;transform-origin:bottom"></rect>`).join("");
  }
  if (fcOverlays.cone && t.cone) {
    const poly = pts(t.cone.up) + " " + pts([...t.cone.lo].reverse());
    svg += `<polygon points="${poly}" fill="color-mix(in srgb,var(--acc2) 15%,transparent)" stroke="none"></polygon>`;
    svg += `<polyline points="${pts(t.cone.mid)}" fill="none" stroke="var(--acc2)" stroke-width="1.2" stroke-dasharray="3 3" vector-effect="non-scaling-stroke" opacity="0.9"></polyline>`;
  }
  if (fcOverlays.ema && t.ema) {
    svg += `<polyline points="${pts(t.ema)}" fill="none" stroke="var(--acc)" stroke-width="1.5" vector-effect="non-scaling-stroke" opacity="0.9"></polyline>`;
  }
  if (fcOverlays.trend && t.trend) {
    svg += `<line x1="${t.trend.x1}" y1="${t.trend.y1}" x2="${t.trend.x2}" y2="${t.trend.y2}" stroke="var(--warn)" stroke-width="1.2" stroke-dasharray="5 3" vector-effect="non-scaling-stroke" opacity="0.85"></line>`;
  }
  // pattern annotations
  if (t.pattern_annotations && t.pattern_annotations.length) {
    svg += t.pattern_annotations.map(a => {
      const col = colorVar(a.dir === "up" ? "up" : "down");
      return `<g><line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${a.x.toFixed(1)}" y2="${(a.y - 6).toFixed(1)}" stroke="${col}" stroke-width="0.6" vector-effect="non-scaling-stroke"></line>
        <rect x="${(a.x - 14).toFixed(1)}" y="${(a.y - 16).toFixed(1)}" width="28" height="9" rx="2" fill="color-mix(in srgb,${col} 14%,var(--bg))" stroke="${col}" stroke-width="0.4" vector-effect="non-scaling-stroke"></rect>
        <text x="${a.x.toFixed(1)}" y="${(a.y - 10).toFixed(1)}" fill="${col}" font-size="3.2" font-family="'JetBrains Mono',monospace" text-anchor="middle">${esc(a.name)} · CONFL ${a.confl}</text></g>`;
    }).join("");
  }
  const overlay = `<svg class="chart-overlay" viewBox="0 0 100 100" preserveAspectRatio="none">${svg}</svg>`;
  return candles + overlay;
}

function chartLegendHtml(t) {
  const items = [["ema", "EMA9", "var(--acc)"], ["trend", "TREND", "var(--warn)"],
                 ["cone", "FORECAST CONE", "var(--acc2)"], ["vol", "VOL", "var(--dim)"]];
  const chips = items.map(([k, label, col]) =>
    `<span class="lg ${fcOverlays[k] ? "on" : ""}" data-overlay="${k}"><span class="lg-dot" style="background:${col}"></span>${label}</span>`).join("");
  const cone = t.cone ? `<span class="flex1"></span><span class="dim">CONE ${t.cone.lo_pct >= 0 ? "+" : ""}${t.cone.lo_pct}% … ${t.cone.up_pct >= 0 ? "+" : ""}${t.cone.up_pct}% · ~80% band</span>` : "";
  return `<div class="chart-legend mono">${chips}${cone}</div>`;
}

function termTabHtml(t) {
  if (fcTermTab === "TRADES") {
    return `<div style="font-family:'JetBrains Mono',monospace">${t.tape.length ? t.tape.map(tp => `<div style="display:flex;gap:14px;padding:6px 0;border-top:1px solid var(--track);font-size:10.5px"><span class="dim" style="width:46px">${tp.ago}</span><span style="width:50px;font-weight:700;color:${tp.side === "BUY" ? "var(--up)" : "var(--down)"}">${tp.side}</span><span style="flex:1">${tp.amt}</span><span class="acc2" style="font-size:9px">${esc(tp.tag)}</span></div>`).join("") : `<div class="dim">no tape yet</div>`}</div>`;
  }
  if (fcTermTab === "POSITION") {
    if (!t.position) return `<div class="dim mono" style="text-align:center;padding:14px">NO OPEN POSITION IN ${esc(t.symbol)} — FORECAST QUALIFIES AT CONFLUENCE ≥ 55</div>`;
    const p = t.position;
    return `<div style="display:flex;gap:24px;flex-wrap:wrap;align-items:center" class="mono">
      <span style="font-weight:700">${esc(p.symbol)}</span>
      <span class="dim">QTY <span class="ink" style="color:var(--ink)">${p.qty.toFixed(3)}</span></span>
      <span class="dim">ENTRY <span style="color:var(--ink)">${p.entry_fmt}</span></span>
      <span class="dim">R <span style="color:${p.r >= 0 ? "var(--up)" : "var(--down)"};font-weight:700">${p.r >= 0 ? "+" : ""}${p.r}R</span></span>
    </div>`;
  }
  if (fcTermTab === "ORDERS") {
    return `<div style="font-family:'JetBrains Mono',monospace;font-size:10.5px">
      <div style="display:flex;gap:18px;padding:7px 0;border-bottom:1px solid var(--track)"><span style="color:var(--down);font-weight:700;width:96px">STOP</span><span style="width:110px">${t.stop_fmt}</span><span class="dim" style="flex:1">below the tail · simulated</span></div>
      <div style="display:flex;gap:18px;padding:7px 0;border-bottom:1px solid var(--track)"><span style="color:var(--up);font-weight:700;width:96px">TARGET</span><span style="width:110px">${t.target_fmt}</span><span class="dim" style="flex:1">R:R ${t.rr}:1 · simulated</span></div>
    </div>`;
  }
  if (fcTermTab === "HOLDERS") return holderPieHtml(t.holders);
  if (fcTermTab === "TOP TRADERS") {
    const rows = t.top_traders || [];
    return `<div style="min-width:0;overflow-x:auto"><div style="min-width:720px">
      <div style="display:grid;grid-template-columns:40px 1fr 110px 110px 90px 80px;gap:10px;padding:8px 16px;border-bottom:1px solid var(--track);font-family:'JetBrains Mono',monospace;font-size:9px;color:var(--dim);letter-spacing:1px">
        <span>#</span><span>TRADER</span><span class="right">PNL</span><span class="right">HELD</span><span class="right">TAG</span><span></span>
      </div>
      ${rows.map(tr => `<div style="display:grid;grid-template-columns:40px 1fr 110px 110px 90px 80px;gap:10px;padding:7px 16px;border-bottom:1px solid var(--track);font-family:'JetBrains Mono',monospace;font-size:10.5px;align-items:center">
        <span style="color:${tr.rank === 1 ? "var(--warn)" : "var(--dim)"};font-weight:700">${tr.rank}</span>
        <span style="color:var(--ink2)">${esc(tr.handle)} <span style="color:var(--dim);font-size:8.5px">${esc(tr.tag)}</span></span>
        <span class="right" style="color:${colorVar(tr.color)};font-weight:700">${fmtPct(tr.pnl_pct)}</span>
        <span class="right" style="color:var(--ink)">${esc(tr.held)}</span>
        <span class="right" style="color:var(--acc);font-size:9px">${esc(tr.tag)}</span>
      </div>`).join("") || `<div class="dim mono" style="padding:14px">no leaderboard data</div>`}
    </div></div>`;
  }
  if (fcTermTab === "DEV WALLET") {
    const rows = t.dev_tokens || [];
    return `<div style="font-family:'JetBrains Mono',monospace;font-size:10.5px">
      ${rows.map(dv => `<div style="display:flex;gap:18px;padding:7px 0;border-bottom:1px solid var(--track);align-items:center;flex-wrap:wrap">
        <span style="color:var(--ink);font-weight:700;width:110px">${esc(dv.symbol)}</span>
        <span style="color:var(--dim);width:90px">${esc(dv.when)}</span>
        <span style="color:${colorVar(dv.color)};font-weight:700;width:90px">${dv.mult >= 0 ? "+" : ""}${dv.mult}x</span>
        <span style="color:var(--dim);flex:1;min-width:200px">${esc(dv.note)}</span>
      </div>`).join("") || `<div class="dim mono" style="padding:14px">no deployer history</div>`}
    </div>`;
  }
  return "";
}

function holderPieHtml(segs) {
  let off = 25;
  const circles = segs.map(s => {
    const c = `<circle cx="21" cy="21" r="15.9" fill="none" stroke="${colorVar(s.color)}" stroke-width="7" stroke-dasharray="${s.pct} 100" stroke-dashoffset="${off}" transform="rotate(-90 21 21)"></circle>`;
    off -= s.pct; return c;
  }).join("");
  return `<div style="display:flex;align-items:center;gap:18px;flex-wrap:wrap">
    <svg class="holder-pie" viewBox="0 0 42 42"><circle cx="21" cy="21" r="15.9" fill="none" stroke="var(--track)" stroke-width="7"></circle>${circles}</svg>
    <div class="mono" style="flex:1;min-width:130px;font-size:10px;line-height:2.1">
      ${segs.map(s => `<div><span style="color:${colorVar(s.color)}">●</span> <span class="ink2">${esc(s.label)}</span> <span style="float:right;color:var(--ink)">${s.pct}%</span></div>`).join("")}
    </div>
  </div>`;
}

let railSide = "BUY", railAmt = "";

function railHtml(t) {
  const buying = railSide === "BUY";
  const blocked = buying && t.blocked;
  return `
    <div class="panel" style="padding:0;overflow:hidden">
      <div style="display:flex">
        ${["BUY", "SELL"].map(s => `<div class="rail-side ${railSide === s ? "active" : ""}" data-side="${s}" style="color:${railSide === s ? (s === "BUY" ? "var(--up)" : "var(--down)") : "var(--dim)"}">${s}</div>`).join("")}
      </div>
      <div style="padding:14px">
        <div class="rail-amount"><span class="dim" style="font-size:9px;letter-spacing:1px">AMOUNT</span><input id="rail-amt" placeholder="0.0" value="${esc(railAmt)}"><span class="acc" style="font-size:10px">SOL</span></div>
        <div style="display:flex;gap:4px;margin-bottom:10px">${["0.01","0.1","0.5","1"].map(p => `<div class="rail-preset" data-railpreset="${p}">${p}</div>`).join("")}</div>
        <div id="rail-go" class="rail-go" style="background:${blocked ? "var(--track)" : buying ? "var(--up)" : "var(--down)"};color:${blocked ? "var(--dim)" : "var(--bg)"}">${blocked ? "⛔ " + (t.risk === "SEVERE" ? "STORM LOCK" : "DOCK CONTROLS") : (buying ? "BUY " : "SELL ") + t.symbol}</div>
        <div id="rail-msg" class="inline-msg up"></div>
        <div class="rail-stats">
          <div><div class="dim">BOUGHT</div><div class="up" style="font-weight:700">${t.position ? t.position.qty.toFixed(2) : "0"}</div></div>
          <div><div class="dim">HOLDING</div><div style="font-weight:700">${t.position ? "YES" : "NO"}</div></div>
          <div><div class="dim">R</div><div style="font-weight:700;color:${t.position && t.position.r >= 0 ? "var(--up)" : "var(--down)"}">${t.position ? t.position.r : "0"}R</div></div>
          <div><div class="dim">RISK</div><div class="acc" style="font-weight:700">${t.risk}</div></div>
        </div>
      </div>
    </div>
    <div class="panel"><h4>TOKEN INFO</h4>
      <div class="rail-info-grid">
        ${[["TOP 10 H.", t.audit.top10 + "%"], ["SNIPERS", t.audit.snipers + "%"], ["INSIDERS", t.audit.insiders + "%"], ["HOLDERS", t.audit.holders.toLocaleString()], ["DEX", esc(t.dex_id)], ["DEX PAID", t.audit.dex_paid ? "YES" : "NO"]]
          .map(([label, val]) => `<div><div style="font-size:11px;font-weight:700">${val}</div><div class="dim" style="font-size:8px;margin-top:2px">${label}</div></div>`).join("")}
      </div>
    </div>
    <div class="panel mono" style="font-size:9.5px;color:var(--dim);line-height:2">
      <div>▤ CA: <span class="ink2" style="word-break:break-all">${esc(t.address)}</span></div>
      ${t.url ? `<div><a href="${esc(t.url)}" target="_blank" rel="noopener">↗ view on DexScreener</a></div>` : ""}
    </div>
    <div class="panel"><h4>SIMILAR TOKENS</h4>
      ${t.similar.map(s => `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;cursor:pointer" data-go="${esc(s.symbol)}">${avatarHtml(s.avatar, 22)}<div style="flex:1"><div style="font-size:11px;font-weight:700">${esc(s.symbol)}</div><div class="dim" style="font-size:8.5px">${s.phase}</div></div><div style="font-size:10px;font-weight:700;color:${s.change_pct >= 0 ? "var(--up)" : "var(--down)"}">${fmtPct(s.change_pct)}</div></div>`).join("")}
    </div>`;
}

function wireForecastEvents(t) {
  document.getElementById("fc-back").onclick = () => location.hash = "#/radar";
  view.querySelectorAll("[data-term]").forEach(b => b.onclick = () => { fcTermTab = b.dataset.term; renderForecast(t.symbol); });
  view.querySelectorAll("[data-overlay]").forEach(b => b.onclick = () => { fcOverlays[b.dataset.overlay] = !fcOverlays[b.dataset.overlay]; renderForecast(t.symbol); });
  view.querySelectorAll("[data-chartmode]").forEach(b => b.onclick = () => { fcChartMode = b.dataset.chartmode; renderForecast(t.symbol); });
  view.querySelectorAll("[data-c_tf]").forEach(b => b.onclick = () => { fcChartTf = b.dataset.c_tf; renderForecast(t.symbol); });
  view.querySelectorAll("[data-c_style]").forEach(b => b.onclick = () => { fcChartStyle = b.dataset.c_style; renderForecast(t.symbol); });
  view.querySelectorAll("[data-fcbuy]").forEach(b => b.onclick = async () => {
    const r = await post("/trade", { symbol: t.symbol, side: "buy", sol_amount: parseFloat(b.dataset.fcbuy) });
    setMsg("fc-qt-msg", r);
    refreshWalletDock();
  });
  view.querySelectorAll("[data-fcsell]").forEach(b => b.onclick = async () => {
    const frac = parseInt(b.dataset.fcsell) / 100;
    const qty = t.position ? t.position.qty * frac : 0;
    const r = await post("/trade", { symbol: t.symbol, side: "sell", qty });
    setMsg("fc-qt-msg", r);
    refreshWalletDock();
  });
  view.querySelectorAll("[data-side]").forEach(b => b.onclick = () => { railSide = b.dataset.side; renderForecast(t.symbol); });
  view.querySelectorAll("[data-railpreset]").forEach(b => b.onclick = () => { railAmt = b.dataset.railpreset; renderForecast(t.symbol); });
  const amtEl = document.getElementById("rail-amt");
  if (amtEl) amtEl.onchange = () => { railAmt = amtEl.value; };
  const go = document.getElementById("rail-go");
  if (go) go.onclick = async () => {
    const amt = parseFloat(railAmt) || 0.1;
    let r;
    if (railSide === "BUY") {
      r = await post("/trade", { symbol: t.symbol, side: "buy", sol_amount: amt });
    } else {
      // Interpret the rail amount as "SOL worth to sell" and convert to qty.
      let qty = 0;
      if (t.position && t.position.qty > 0 && t.position.value_sol > 0) {
        const frac = Math.min(1, Math.max(0, amt / t.position.value_sol));
        qty = t.position.qty * frac;
      }
      r = await post("/trade", { symbol: t.symbol, side: "sell", qty });
    }
    setMsg("rail-msg", r);
    refreshWalletDock();
  };
  view.querySelectorAll("[data-go]").forEach(el => el.onclick = () => goForecast(el.dataset.go));
}

function setMsg(id, r) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = r.status === "filled" ? `✓ filled ${r.qty ? r.qty.toFixed(3) : ""} @ ${r.fill_price ?? ""} · paper` : "⛔ " + (r.reject_reason || "rejected");
  el.style.color = r.status === "filled" ? "var(--up)" : "var(--down)";
}

/* ================= COCKPIT ================= */

async function renderCockpit() {
  const myGen = renderGen;
  const pos = await api("/positions");
  if (myGen !== renderGen) return;
  view.innerHTML = `
    <div class="screen">
      <div class="screen-head">
        <div class="screen-title">COCKPIT</div>
        <div class="mono dim">${pos.count} open · ${pos.mode} mode · ${pos.mode === "COPILOT" ? "simulated approvals" : "paper fills"}</div>
        <div class="flex1"></div>
        <div id="panic-btn" class="chip" style="cursor:pointer;font-size:12px;font-weight:700;letter-spacing:1px;padding:10px 20px;${panicStyle(pos.panic)}">${panicLabel(pos.panic)}</div>
      </div>
      <div class="cockpit-tiles">
        <div class="panel"><h4>DAILY P&amp;L vs -5% BREAKER</h4><div class="mono" style="font-size:26px;font-weight:800;color:${pos.day_pnl_pct >= 0 ? "var(--up)" : "var(--down)"};margin:6px 0">${fmtPct(pos.day_pnl_pct)}</div></div>
        <div class="panel"><h4>POSITIONS</h4><div class="mono" style="font-size:26px;font-weight:800;margin:6px 0">${pos.count}<span class="dim" style="font-size:15px">/3</span></div></div>
        <div class="panel"><h4>DEPLOYED</h4><div class="mono" style="font-size:26px;font-weight:800;margin:6px 0">${pos.deployed_pct}<span class="dim" style="font-size:15px">/25%</span></div></div>
        <div class="panel"><h4>EQUITY</h4><div class="mono" style="font-size:26px;font-weight:800;margin:6px 0">${pos.equity_sol.toFixed(2)}<span class="dim" style="font-size:15px"> SOL</span></div></div>
      </div>
      ${pos.approvals.length ? `<div style="margin-bottom:18px">
        <div class="mono warn-c" style="font-size:10px;letter-spacing:2px;margin-bottom:10px;animation:scBlink 1.6s infinite">◈ COPILOT — ${pos.approvals.length} SIMULATED SIGNATURE REQUEST(S) — NO WALLET IS EVER CONTACTED</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px">
          ${pos.approvals.map(a => approvalCardHtml(a)).join("")}
        </div>
      </div>` : ""}
      ${pos.positions.length ? `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px">
        ${pos.positions.map(p => positionCardHtml(p)).join("")}
      </div>` : `<div class="panel" style="text-align:center;padding:40px" class="mono"><div style="font-size:20px;font-weight:800;color:var(--up);letter-spacing:2px">ALL FLAT</div><div class="dim" style="margin-top:8px">no open ${pos.mode} positions</div></div>`}
    </div>`;
  wireCockpitEvents();
  pollTimer = setTimeout(renderCockpit, 6000);
}

function panicStyle(p) {
  if (p === 0) return "background:color-mix(in srgb,var(--down) 12%,transparent);border:1px solid var(--down);color:var(--down)";
  if (p === 1) return "background:var(--down);color:var(--bg);animation:scBlink 1s infinite";
  return "background:var(--track);border:1px solid var(--border);color:var(--dim)";
}
function panicLabel(p) { return p === 0 ? "⏻ PANIC EXIT ALL" : p === 1 ? "CONFIRM — EXIT ALL NOW" : "ALL FLAT"; }

function approvalCardHtml(a) {
  const secsLeft = Math.max(0, Math.round(a.ttl_s - a.age_s));
  return `<div class="approval-card">
    <div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap">
      <div class="mono" style="font-weight:800;font-size:17px">${esc(a.symbol)}</div>
      <div class="dim mono" style="font-size:10px">${esc(a.setup_note)}</div>
      <div class="flex1"></div>
      <div class="warn-c mono" style="font-size:10px">${esc(a.grade)}</div>
    </div>
    <div class="mono" style="display:flex;gap:18px;margin-top:12px;flex-wrap:wrap;font-size:11px">
      <span class="dim">SIZE <span style="color:var(--ink)">${a.size_sol} SOL · ${esc(a.risk_note)}</span></span>
      <span class="dim">ENTRY <span style="color:var(--ink)">${a.entry_fmt}</span></span>
      <span class="dim">STOP <span class="down">${a.stop_fmt}</span></span>
      <span class="dim">TGT <span class="up">${a.target_fmt}</span></span>
      <span class="dim">R:R <span class="acc">${a.rr}:1</span></span>
    </div>
    <div style="display:flex;gap:10px;margin-top:14px;align-items:center;flex-wrap:wrap" class="mono">
      <div class="qbtn" data-approve="${a.id}" style="background:var(--up);color:var(--bg);padding:8px 18px;font-size:11px">APPROVE ✓</div>
      <div class="qbtn" data-reject="${a.id}" style="border:1px solid var(--border);color:var(--dim);padding:8px 18px;font-size:11px">REJECT</div>
      <div class="dim" style="font-size:9px">SIMULATED · EXPIRES ~${secsLeft}s</div>
    </div>
  </div>`;
}

function positionMiniCandlesHtml(symbol, r) {
  const seed = hashStr(symbol);
  const n = 10;
  const r2 = ((seed * 9301 + 49297) % 233280) / 233280;
  let price = 50;
  const candles = [];
  for (let i = 0; i < n; i++) {
    const drift = (i / n - 0.5) * (r || 0) * 6 + (Math.sin(seed + i) * 8);
    const o = price;
    const c = Math.max(5, Math.min(95, o + drift + (r2 - 0.5) * 12));
    const h = Math.max(o, c) + Math.abs(Math.sin(seed * (i + 3))) * 6;
    const l = Math.min(o, c) - Math.abs(Math.cos(seed * (i + 5))) * 6;
    candles.push({ o, c, h, l });
    price = c;
  }
  const left = i => (i / n * 100).toFixed(1);
  const w = (100 / n * 0.7).toFixed(1);
  return candles.map((c, i) => {
    const up = c.c >= c.o;
    const color = up ? "var(--up)" : "var(--down)";
    const bodyTop = Math.min(c.o, c.c);
    const bodyH = Math.max(2, Math.abs(c.c - c.o));
    return `<g><line x1="${left(i)}" y1="${c.h.toFixed(1)}" x2="${left(i)}" y2="${c.l.toFixed(1)}" stroke="${color}" stroke-width="0.8"></line>
      <rect x="${(i / n * 100 + (100 / n * 0.15)).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${w}" height="${bodyH.toFixed(1)}" fill="${color}"></rect></g>`;
  }).join("");
}

function positionCardHtml(p) {
  const rClamped = Math.max(-1, Math.min(4, p.r));
  const curX = Math.max(2, Math.min(98, 30 + rClamped * 23));
  const tilt = Math.max(-30, Math.min(30, p.r * 8));
  return `<div class="position-card">
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      ${avatarHtml(p.avatar, 30)}
      <div class="mono" style="font-weight:800;font-size:17px">${esc(p.symbol)}</div>
      <div class="dim mono" style="font-size:10px">${esc(p.setup_note || "manual entry")} · ${p.mode}</div>
      <div class="flex1"></div>
      <div class="mono" style="font-size:24px;font-weight:800;color:${p.r >= 0 ? "var(--up)" : "var(--down)"}">${p.r >= 0 ? "+" : ""}${p.r}R</div>
    </div>
    <div class="flight-row">
      <div class="flight-track">
        <svg style="position:absolute;inset:0;width:100%;height:100%" viewBox="0 0 100 34" preserveAspectRatio="none">
          <line x1="2" y1="26" x2="98" y2="26" stroke="var(--track)" stroke-width="1.6"></line>
          <path d="M2,26 Q30,26 50,20 T98,10" fill="none" stroke="var(--acc)" stroke-width="1.4" stroke-dasharray="3 2.2" style="animation:scDash 3s linear infinite" vector-effect="non-scaling-stroke"></path>
          <path d="M50,20 Q75,14 98,10" fill="none" stroke="var(--dim)" stroke-width="0.9" stroke-dasharray="1.6 2.6" opacity=".6" vector-effect="non-scaling-stroke"></path>
        </svg>
        <div style="position:absolute;left:2%;top:22px;width:8px;height:8px;border-radius:50%;background:var(--dim);transform:translate(-50%,-50%)"></div>
        <div style="position:absolute;left:${curX}%;top:16px;transform:translate(-50%,-50%) rotate(${tilt}deg);font-size:15px;color:var(--acc);text-shadow:0 0 10px var(--acc);transition:left 1.2s ease;z-index:2">✈</div>
        <div style="position:absolute;right:2%;top:8px;transform:translate(50%,-50%);width:10px;height:10px;border-radius:50%;border:2px solid var(--up);animation:scGlowPulse 2s infinite"></div>
        <div style="position:absolute;right:2%;top:-4px;transform:translateX(50%);font-family:'JetBrains Mono',monospace;font-size:8px;color:var(--up);letter-spacing:1px">TGT</div>
      </div>
    </div>
    <div class="mini-chart"><svg style="position:absolute;inset:0;width:100%;height:100%" viewBox="0 0 100 100" preserveAspectRatio="none">${positionMiniCandlesHtml(p.symbol, p.r)}</svg></div>
    <div style="display:flex;justify-content:space-between;font-size:9px;color:var(--dim);margin-top:8px" class="mono"><span class="down">STOP ${p.stop_fmt}</span><span>ENTRY ${p.entry_fmt}</span><span class="up">TGT ${p.target_fmt}</span></div>
    <div style="display:flex;gap:6px;margin-top:14px;flex-wrap:wrap">
      ${["25", "50", "75", "100"].map(pct => `<div class="qbtn" data-sellpos="${p.id}" data-symbol="${esc(p.symbol)}" data-pct="${pct}" data-qty="${p.qty}" style="border-color:var(--down);color:var(--down)">SELL ${pct}%</div>`).join("")}
    </div>
    <div class="mono dim" style="margin-top:10px;font-size:10px">held since ${timeAgo(p.held_since)} · current ${p.current_fmt}</div>
  </div>`;
}

function wireCockpitEvents() {
  const panicBtn = document.getElementById("panic-btn");
  if (panicBtn) panicBtn.onclick = async () => { await post("/panic"); renderCockpit(); refreshWalletDock(); };
  view.querySelectorAll("[data-approve]").forEach(b => b.onclick = async () => { await post(`/approvals/${b.dataset.approve}/approve`); renderCockpit(); refreshWalletDock(); });
  view.querySelectorAll("[data-reject]").forEach(b => b.onclick = async () => { await post(`/approvals/${b.dataset.reject}/reject`); renderCockpit(); });
  view.querySelectorAll("[data-sellpos]").forEach(b => b.onclick = async () => {
    const qty = parseFloat(b.dataset.qty) * (parseInt(b.dataset.pct) / 100);
    await post("/trade", { symbol: b.dataset.symbol, side: "sell", qty });
    renderCockpit(); refreshWalletDock();
  });
}

/* ================= JOURNAL ================= */

async function renderJournal() {
  const myGen = renderGen;
  const j = await api("/journal");
  if (myGen !== renderGen) return;
  const eq = j.equity_curve;
  view.innerHTML = `
    <div class="screen">
      <div class="screen-title" style="margin-bottom:4px">JOURNAL</div>
      <div class="screen-sub" style="margin-bottom:18px">${j.stats.trade_count} paper trades · this build's ghost trading history — no ensemble is trained on it yet</div>
      <div class="panel" style="margin-bottom:18px">
        <div class="mono dim" style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;font-size:10px;letter-spacing:1px;margin-bottom:10px"><span>EQUITY CURVE (SOL)</span><span class="${j.stats.total_pnl_sol >= 0 ? "up" : "down"}">${j.stats.total_pnl_sol >= 0 ? "+" : ""}${j.stats.total_pnl_sol.toFixed(3)} SOL realized</span></div>
        <div class="eq-curve">${equityCurveSvg(eq)}</div>
      </div>
      <div class="stat-grid">
        ${[["TRADES", j.stats.trade_count, ""], ["CLOSED", j.stats.closed_count, ""], ["WIN RATE", j.stats.win_rate_pct.toFixed(1) + "%", "of closed"], ["REALIZED PNL", j.stats.total_pnl_sol.toFixed(3) + " SOL", ""], ["AVG WIN", j.stats.avg_win_sol.toFixed(3) + " SOL", ""], ["AVG LOSS", j.stats.avg_loss_sol.toFixed(3) + " SOL", ""], ["PROFIT FACTOR", (j.stats.profit_factor ?? 0).toFixed(2), ""], ["BEST HOUR", j.stats.best_hour ?? "—", "UTC"]]
          .map(([label, val, sub]) => `<div class="stat-tile"><div class="dim mono" style="font-size:9px;letter-spacing:1px">${label}</div><div class="mono" style="font-size:22px;font-weight:800;margin-top:4px">${val}</div><div class="dim mono" style="font-size:9px;margin-top:2px">${sub}</div></div>`).join("")}
      </div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:18px">
        <div class="panel" style="flex:1 1 360px">
          <h4>WIN RATE / PNL BY PATTERN</h4>
          ${(j.by_pattern || []).map(pt => `<div class="bar-row"><div style="width:150px;color:var(--ink2);font-size:10px">${esc(pt.pattern)}</div><div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, pt.win_rate)}%;background:${colorVar(pt.color)}"></div></div><div style="width:56px;text-align:right;color:${colorVar(pt.color)}">${pt.win_rate}%</div><div style="width:60px;text-align:right;color:var(--dim);font-size:9px">${pt.trades} · ${pt.pnl >= 0 ? "+" : ""}${pt.pnl} SOL</div></div>`).join("") || `<div class="dim mono">no pattern data yet</div>`}
        </div>
        <div class="panel" style="flex:1 1 360px">
          <h4>EXPECTANCY BY HOUR (UTC)</h4>
          <div class="hour-grid">
            ${(j.by_hour || []).map(h => `<div style="text-align:center"><div class="hour-cell" style="background:${h.n ? colorVar(h.color) : "var(--track)"};opacity:${h.n ? Math.max(0.25, Math.min(1, Math.abs(h.pnl) * 0.3 + 0.2)) : 1}"></div><div class="mono" style="font-size:8px;color:var(--dim);margin-top:3px">${esc(h.hour)}</div></div>`).join("")}
          </div>
          <div class="mono dim" style="font-size:10px;color:var(--dim);margin-top:12px">tuner: <span style="color:var(--warn)">02–04 UTC auto-throttled</span> · <span style="color:var(--up)">13–16 UTC full aggression</span></div>
        </div>
      </div>
      <div class="panel">
        <h4>RECENT TRADES</h4>
        ${j.recent_trades.length ? j.recent_trades.map(t => `<div class="mono" style="display:flex;gap:14px;align-items:center;padding:9px 0;border-top:1px solid var(--track);flex-wrap:wrap;font-size:11px">
          <span class="dim" style="width:110px">${new Date(t.ts * 1000).toLocaleString()}</span>
          <span style="width:90px;font-weight:700">${esc(t.symbol)}</span>
          <span style="width:50px;color:${t.side === "buy" ? "var(--up)" : "var(--down)"}">${t.side.toUpperCase()}</span>
          <span class="dim" style="flex:1;min-width:140px;font-size:10px">${esc(t.setup_note || "")}</span>
          <span style="width:70px">${t.sol_amount.toFixed(3)} SOL</span>
          <span style="width:70px;text-align:right;color:${t.pnl_sol == null ? "var(--dim)" : t.pnl_sol >= 0 ? "var(--up)" : "var(--down)"}">${t.pnl_sol == null ? "—" : (t.pnl_sol >= 0 ? "+" : "") + t.pnl_sol.toFixed(3)}</span>
        </div>`).join("") : `<div class="dim mono">no trades yet — buy something from RADAR or DISCOVER</div>`}
      </div>
    </div>`;
  pollTimer = setTimeout(renderJournal, 10000);
}

function equityCurveSvg(pts) {
  if (pts.length < 2) return `<div class="dim mono" style="padding:20px;text-align:center">not enough history yet</div>`;
  const vals = pts.map(p => p.equity);
  const lo = Math.min(...vals), hi = Math.max(...vals), sp = (hi - lo) || 1;
  const y = v => (hi - v) / sp * 94 + 3;
  const line = pts.map((p, i) => (i / (pts.length - 1) * 100).toFixed(1) + "," + y(p.equity).toFixed(1)).join(" ");
  const area = "0," + y(vals[0]).toFixed(1) + " " + line + " 100,100 0,100";
  const color = vals[vals.length - 1] >= vals[0] ? "var(--up)" : "var(--down)";
  return `<svg style="position:absolute;inset:0;width:100%;height:100%" viewBox="0 0 100 100" preserveAspectRatio="none">
    <polygon points="${area}" fill="color-mix(in srgb,${color} 12%,transparent)"></polygon>
    <polyline points="${line}" fill="none" stroke="${color}" stroke-width="0.7" stroke-dasharray="300" style="animation:scDraw 2.2s ease both"></polyline>
  </svg>`;
}

/* ================= STORM LOG ================= */

async function renderStormLog() {
  const myGen = renderGen;
  const s = await api("/storm-log");
  if (myGen !== renderGen) return;
  view.innerHTML = `
    <div class="screen">
      <div class="screen-title" style="margin-bottom:4px">STORM LOG</div>
      <div class="screen-sub" style="margin-bottom:18px">simulated rug/coordinated-pump/heartbeat-exit feed — illustrates the design's exit-guarantee language; not derived from real on-chain events in this build</div>
      <div style="max-width:860px">
        ${s.events.map(e => `<div class="event-card" style="position:relative;overflow:hidden">
          ${e.ring_pct != null ? `<div style="position:absolute;inset:0;background:linear-gradient(105deg,transparent 30%,color-mix(in srgb,var(--down) 22%,transparent) 48%,color-mix(in srgb,var(--ink) 30%,transparent) 50%,color-mix(in srgb,var(--down) 22%,transparent) 52%,transparent 70%);animation:scFlash 5s ease-out infinite;pointer-events:none"></div>
          <div style="position:absolute;inset:0;background-image:linear-gradient(170deg,transparent 46%,color-mix(in srgb,var(--acc) 24%,transparent) 50%,transparent 54%);background-size:7px 60px;animation:scRain .7s linear infinite;opacity:.25;pointer-events:none"></div>` : ""}
          <div class="event-dot" style="background:${colorVar(e.color)};box-shadow:0 0 8px ${colorVar(e.color)}"></div>
          <div style="flex:1">
            <div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap">
              <span class="mono" style="font-size:11px;font-weight:700;color:${colorVar(e.color)};letter-spacing:1px">${esc(e.kind)}</span>
              <span style="display:inline-flex;align-items:center;gap:6px">${avatarHtml(e.avatar, 18)}<span class="mono" style="font-size:11px;font-weight:700">${esc(e.symbol)}</span></span>
              <span class="flex1"></span><span class="dim mono" style="font-size:9px">${e.time_ago}</span>
            </div>
            <div style="font-size:12px;color:var(--ink2);margin-top:4px;line-height:1.5">${esc(e.msg)}</div>
            ${e.saved_amt ? `<div class="mono" style="display:inline-block;margin-top:6px;font-size:9px;padding:2px 8px;border-radius:3px;background:color-mix(in srgb,var(--up) 12%,transparent);color:var(--up)">DODGED · SAVED ${esc(e.saved_amt)}</div>` : ""}
          </div>
          ${e.ring_pct != null ? `<div style="display:flex;flex-direction:column;align-items:center;gap:4px;flex-shrink:0">
            <div class="dump-ring" style="background:conic-gradient(var(--down) ${e.ring_pct}%, var(--track) 0)"><div class="dump-ring-inner">${e.ring_pct}%</div></div>
            <div class="dim mono" style="font-size:8px;letter-spacing:1px">DUMP PROB</div>
          </div>` : ""}
        </div>`).join("")}
      </div>
    </div>`;
  pollTimer = setTimeout(renderStormLog, 10000);
}

/* ================= SYSTEMS ================= */

async function renderSystems() {
  const myGen = renderGen;
  const s = await api("/systems");
  if (myGen !== renderGen) return;
  view.innerHTML = `
    <div class="screen">
      <div class="screen-title" style="margin-bottom:4px">SYSTEMS</div>
      <div class="screen-sub" style="margin-bottom:18px">design-spec engineering catalog · ${s.active_count} of ${s.total_count} implemented in this build — see stat line on each card</div>
      ${s.groups.map(g => `<div><div class="sys-group-title">${esc(g.title)}</div><div class="sys-grid">
        ${g.items.map(i => `<div class="sys-card">
          <div style="display:flex;align-items:center;gap:8px">
            <div class="dim mono" style="font-size:9px;width:26px">${esc(i.num)}</div>
            <div class="mono" style="font-size:12px;font-weight:700;flex:1">${esc(i.name)}</div>
            <div class="chip" style="${sysChipStyle(i.status)}font-size:8px;padding:3px 8px">${i.status}</div>
          </div>
          <div style="font-size:11px;color:var(--dim);line-height:1.5;margin-top:6px">${esc(i.blurb)}</div>
          <div class="mono acc" style="font-size:9px;margin-top:6px">▸ ${esc(i.stat)}</div>
        </div>`).join("")}
      </div></div>`).join("")}
    </div>`;
}

function sysChipStyle(status) {
  const c = { ACTIVE: "up", ARMED: "acc", LEARNING: "acc2", SHADOW: "warn", SCHEDULED: "dim" }[status] || "dim";
  return `color:${colorVar(c)};border-color:${colorVar(c)};`;
}

/* ================= SETTINGS ================= */

async function renderSettingsPage() {
  const myGen = renderGen;
  const s = await api("/settings");
  if (myGen !== renderGen) return;
  view.innerHTML = `
    <div class="screen" style="max-width:900px">
      <div class="screen-title" style="margin-bottom:18px">SETTINGS</div>
      <div class="dim mono" style="font-size:10px;letter-spacing:1px;margin-bottom:10px">EXECUTION MODE — AUTOPILOT does not exist in this build, see README</div>
      <div class="mode-cards">
        ${s.modes.map(m => `<div class="mode-card ${m.active ? "active" : ""}" data-setmode="${m.name}">
          <div style="display:flex;align-items:center;gap:8px">
            <div class="mono" style="font-weight:800;font-size:14px;letter-spacing:1px;color:${colorVar(m.color)}">${m.name}</div>
            ${m.active ? `<div class="mono" style="font-size:9px;padding:1px 7px;border-radius:3px;background:${colorVar(m.color)};color:var(--bg);font-weight:700">ACTIVE</div>` : ""}
          </div>
          <div style="font-size:11px;color:var(--dim);margin-top:6px;line-height:1.5">${esc(m.desc)}</div>
        </div>`).join("")}
      </div>
      <div style="display:flex;gap:16px;flex-wrap:wrap">
        <div class="panel" style="flex:1 1 380px">
          <h4>RISK CAPS · ENFORCED SERVER-SIDE</h4>
          ${s.risk_caps.map(rc => `<div class="risk-row"><span class="ink2" style="flex:1">${esc(rc.label)}</span><span style="font-weight:700">${esc(rc.val)}</span><span class="hard-limit">HARD LIMIT</span></div>`).join("")}
        </div>
        <div class="panel" style="flex:1 1 380px">
          <h4>WALLET</h4>
          <div class="mono" style="font-size:12px;line-height:2.1">
            <div style="display:flex;justify-content:space-between"><span>GHOST BALANCE</span><span class="acc">${s.wallets.ghost.balance_sol.toFixed(2)} SOL (paper)</span></div>
            <div style="display:flex;justify-content:space-between"><span>COPILOT BALANCE</span><span class="acc2">${s.wallets.copilot.balance_sol.toFixed(2)} SOL (paper)</span></div>
            <div style="display:flex;justify-content:space-between"><span>REAL WALLET CONNECTED</span><span class="dim">NEVER — not implemented</span></div>
          </div>
        </div>
      </div>
      <div class="panel" style="margin-top:16px">
        <h4>THEME</h4>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
          ${Object.keys(THEMES).map(t => `<div class="btn ${s.theme === t ? "active" : ""}" data-theme="${esc(t)}">${t}</div>`).join("")}
        </div>
        <div class="btn ${s.scanlines ? "active" : ""}" data-scanlines="1">SCANLINES ${s.scanlines ? "ON" : "OFF"}</div>
      </div>
      <div class="panel" style="margin-top:16px">
        <h4>DATA SOURCES</h4>
        <div style="display:flex;flex-wrap:wrap;gap:8px">
          ${s.data_sources.map(ds => `<div class="chip" style="color:${ds.status === "live" ? "var(--up)" : ds.status === "simulated" ? "var(--acc2)" : "var(--down)"}">● ${esc(ds.name)} · ${ds.status}</div>`).join("")}
        </div>
      </div>
    </div>`;
  view.querySelectorAll("[data-setmode]").forEach(b => b.onclick = async () => { await post("/controls/mode", { mode: b.dataset.setmode.toLowerCase() }); renderSettingsPage(); refreshWalletDock(); });
  view.querySelectorAll("[data-theme]").forEach(b => b.onclick = async () => { await post("/settings/theme", { theme: b.dataset.theme }); refreshWalletDock(); renderSettingsPage(); });
  const sl = view.querySelector("[data-scanlines]");
  if (sl) sl.onclick = async () => { await post("/settings/scanlines", { on: !s.scanlines }); refreshWalletDock(); renderSettingsPage(); };
}

/* ---------- boot ---------- */

async function boot() {
  connectWs();
  await refreshWalletDock();
  setInterval(refreshWalletDock, 6000);
  window.addEventListener("hashchange", render);
  await render();
}
boot();
