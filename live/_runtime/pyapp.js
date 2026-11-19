/* Runs a project's real Python backend in the browser via Pyodide, then loads
 * its real frontend. fetch('/api/...') and new WebSocket('.../ws') are routed
 * into the in-browser app instead of a server.
 *
 * Page sets window.PYAPP = { bundle, boot, scripts, packages?, apiPrefix?, wsPaths? }
 *   bundle  — JSON file {path: source} written into the Python filesystem
 *   boot    — Python that builds the app and assigns it to `app`
 *   scripts — frontend scripts to load once the backend is up
 */
(function () {
  const PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v0.29.5/full/';
  const cfg = window.PYAPP;
  const apiPrefix = cfg.apiPrefix || '/api';
  const here = document.currentScript.src.replace(/[^/]*$/, '');

  // ── loading overlay ───────────────────────────────────────────────────────
  const ov = document.createElement('div');
  ov.id = 'pyapp-loading';
  ov.innerHTML = `<style>
    #pyapp-loading{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;
      background:#07080c;color:#cfd6e4;font:500 13px/1.6 "JetBrains Mono",ui-monospace,monospace}
    #pyapp-loading .b{width:min(460px,86vw)} #pyapp-loading h1{font-size:15px;letter-spacing:.18em;margin:0 0 10px;color:#fff}
    #pyapp-loading .bar{height:3px;background:#1b1f2a;margin:14px 0 8px;overflow:hidden}
    #pyapp-loading .bar i{display:block;height:100%;width:0;background:#00f5ff;box-shadow:0 0 12px #00f5ff;transition:width .4s}
    #pyapp-loading .s{color:#7d869a;font-size:12px} #pyapp-loading .e{color:#ff5a6e;white-space:pre-wrap}
  </style><div class="b"><h1>BOOTING ${(cfg.name || 'APP').toUpperCase()}</h1>
    <div class="s">Running the real Python backend in your browser (Pyodide / WebAssembly).</div>
    <div class="bar"><i></i></div><div class="s" id="pyapp-step">loading Python runtime…</div></div>`;
  document.documentElement.appendChild(ov);
  const step = (t, pct) => { ov.querySelector('#pyapp-step').textContent = t; ov.querySelector('.bar i').style.width = pct + '%'; };
  const fail = (e) => { console.error(e); ov.querySelector('#pyapp-step').className = 'e'; ov.querySelector('#pyapp-step').textContent = 'Failed to start: ' + (e && e.message || e); };

  // ── fetch + WebSocket interception (installed immediately, queue until ready) ──
  let ready, py;
  const readyP = new Promise(r => (ready = r));
  const realFetch = window.fetch.bind(window);
  const isApi = (u) => { try { const x = new URL(u, location.href); return x.origin === location.origin && x.pathname.startsWith(apiPrefix) || (!/^https?:/.test(u) && String(u).startsWith(apiPrefix)); } catch { return false; } };
  const apiPath = (u) => { const x = new URL(u, location.origin); return x.pathname + x.search; };

  window.fetch = async function (input, init = {}) {
    const url = typeof input === 'string' ? input : input.url;
    if (!isApi(url)) return realFetch(input, init);
    await readyP;
    const method = (init.method || (input.method) || 'GET').toUpperCase();
    let body = init.body || '';
    if (body && typeof body !== 'string') body = body instanceof URLSearchParams ? body.toString() : await new Response(body).text();
    const out = JSON.parse(await py.dispatch(method, apiPath(url), body));
    return new Response(out.status === 204 ? null : out.body, { status: out.status, headers: { 'Content-Type': out.type } });
  };

  const RealWS = window.WebSocket;
  let sidSeq = 0;
  const wsPaths = cfg.wsPaths || ['/ws'];
  class InBrowserSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = url; this.readyState = 0; this.sid = ++sidSeq;
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      readyP.then(() => {
        this.readyState = 1; this._emit('open', new Event('open'));
        py.ws_open(this.sid, new URL(url).pathname,
          (text) => setTimeout(() => this._emit('message', new MessageEvent('message', { data: text }))),
          () => this.close());
      });
    }
    _emit(type, ev) { const h = this['on' + type]; if (h) h.call(this, ev); this.dispatchEvent(ev); }
    send(t) { if (this.readyState === 1) py.ws_message(this.sid, String(t)); }
    close() { if (this.readyState > 1) return; this.readyState = 3; py && py.ws_close(this.sid); this._emit('close', new CloseEvent('close', { code: 1000 })); }
  }
  InBrowserSocket.CONNECTING = 0; InBrowserSocket.OPEN = 1; InBrowserSocket.CLOSING = 2; InBrowserSocket.CLOSED = 3;
  window.WebSocket = function (url, protocols) {
    try { const u = new URL(url, location.href); if (u.host === location.host && wsPaths.some(p => u.pathname.startsWith(p))) return new InBrowserSocket(u.href); } catch {}
    return new RealWS(url, protocols);
  };
  Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });

  // ── "running in your browser" badge ──────────────────────────────────────
  function badge(persisted, reset) {
    const b = document.createElement('div');
    b.innerHTML = `<style>
      #pyapp-badge{position:fixed;right:12px;bottom:12px;z-index:99998;display:flex;gap:8px;align-items:center;
        padding:6px 10px;border:1px solid #2a3142;border-radius:4px;background:rgba(7,8,12,.92);color:#9aa3b5;
        font:500 11px/1.3 "JetBrains Mono",ui-monospace,monospace;letter-spacing:.04em;backdrop-filter:blur(4px)}
      #pyapp-badge i{width:7px;height:7px;border-radius:50%;background:#16e37a;box-shadow:0 0 8px #16e37a}
      #pyapp-badge button{all:unset;cursor:pointer;color:#00f5ff;border-left:1px solid #2a3142;padding-left:8px}
      #pyapp-badge button:hover{text-decoration:underline}
    </style><div id="pyapp-badge" title="This app's real Python backend is running in your browser via WebAssembly. Prices are live; money is simulated.">
      <i></i><span>LIVE · Python in your browser${persisted ? ' · saved locally' : ''}</span><button>reset</button></div>`;
    b.querySelector('button').onclick = () => { if (confirm('Reset this demo? Your paper trades and settings will be cleared.')) reset(); };
    document.body.appendChild(b);
  }

  // ── boot ──────────────────────────────────────────────────────────────────
  const loadScript = (src) => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.body.appendChild(s); });

  (async () => {
    await loadScript(PYODIDE + 'pyodide.js');
    const pyodide = await loadPyodide({ indexURL: PYODIDE });
    step('loading packages…', 35);
    await pyodide.loadPackage(['sqlite3', ...(cfg.packages || [])]);
    step('installing project code…', 60);
    const [shims, bundle] = await Promise.all([
      realFetch(here + 'shims.py').then(r => r.text()),
      realFetch(cfg.bundle).then(r => r.json()),
    ]);
    const FS = pyodide.FS;
    const ROOT = '/' + (cfg.id || 'app');
    FS.mkdirTree(ROOT + '/data');
    // Persist the app's data/ dir (its SQLite DB) in IndexedDB so paper
    // trades survive reloads. The mount path doubles as the IDB name.
    let persisted = false;
    try {
      FS.mount(pyodide.FS.filesystems.IDBFS, {}, ROOT + '/data');
      await new Promise((res, rej) => FS.syncfs(true, e => e ? rej(e) : res()));
      persisted = true;
    } catch (e) { console.warn('persistence unavailable', e); }
    for (const [p, src] of Object.entries(bundle)) {
      const full = ROOT + '/' + p;
      FS.mkdirTree(full.replace(/\/[^/]*$/, ''));
      FS.writeFile(full, src);
    }
    FS.writeFile(ROOT + '/_shims.py', shims);
    const save = () => persisted && FS.syncfs(false, () => {});
    setInterval(save, 8000);
    addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', () => document.hidden && save());
    step('starting backend…', 80);
    pyodide.runPython(`import os, sys; os.chdir('${ROOT}'); sys.path.insert(0, '${ROOT}')\nimport _shims; _shims.install()`);
    await pyodide.runPythonAsync(cfg.boot + `\nawait _shims.startup(app)\n` + (cfg.after || ''));
    const S = pyodide.pyimport('_shims');
    py = {
      dispatch: (m, u, b) => S.dispatch(m, u, b),
      ws_open: (sid, path, send, close) => S.ws_open(sid, path, send, close),
      ws_message: (sid, t) => S.ws_message(sid, t),
      ws_close: (sid) => S.ws_close(sid),
    };
    window.__pyodide = pyodide;
    ready();
    step('loading interface…', 95);
    for (const s of cfg.scripts || []) await loadScript(s);
    document.dispatchEvent(new Event('DOMContentLoaded'));
    ov.remove();
    badge(persisted, async () => {
      FS.unmount(ROOT + '/data');
      await new Promise(r => { const q = indexedDB.deleteDatabase(ROOT + '/data'); q.onsuccess = q.onerror = q.onblocked = r; });
      location.reload();
    });
  })().catch(fail);
})();
