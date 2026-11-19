"""Browser shims so the real FastAPI apps run unmodified inside Pyodide.

Provides minimal stand-ins for `fastapi`, `httpx` and `dotenv`. The project
code is imported as-is; only the transport layer is swapped:
  * FastAPI decorators just record routes; `dispatch()` calls the handlers.
  * httpx.AsyncClient uses the browser's fetch (pyodide.http.pyfetch).
"""
from __future__ import annotations

import asyncio
import inspect
import json
import re
import sys
import types
from urllib.parse import parse_qs, urlencode, urlsplit


# ── fastapi ──────────────────────────────────────────────────────────────────
class HTTPException(Exception):
    def __init__(self, status_code: int = 500, detail=None, headers=None):
        self.status_code, self.detail = status_code, detail


class Response:
    media_type = "text/plain"

    def __init__(self, content=None, status_code: int = 200, media_type=None, headers=None, **_):
        self.content, self.status_code = content, status_code
        self.media_type = media_type or self.media_type
        self.headers = dict(headers or {})


class JSONResponse(Response):
    media_type = "application/json"


class PlainTextResponse(Response):
    media_type = "text/plain"


class HTMLResponse(Response):
    media_type = "text/html"


class FileResponse(Response):
    def __init__(self, path, *a, **k):
        super().__init__(content="", status_code=404)


class StreamingResponse(Response):
    def __init__(self, content, *a, media_type=None, headers=None, **k):
        super().__init__(content, 200, media_type, headers)


class StaticFiles:
    def __init__(self, *a, **k):
        pass


class WebSocketDisconnect(Exception):
    def __init__(self, code: int = 1000, reason=None):
        self.code = code


class _Param:
    def __init__(self, default=None, *a, **k):
        self.default = default


def Query(default=None, *a, **k):
    return _Param(default)


def Body(default=None, *a, **k):
    return _Param(default)


def Path(default=None, *a, **k):
    return _Param(default)


class Request:
    def __init__(self, body: str, query: dict):
        self._body, self.query_params = body, query

    async def json(self):
        return json.loads(self._body) if self._body else {}

    async def body(self):
        return (self._body or "").encode()


class BackgroundTasks:
    def add_task(self, fn, *a, **k):
        res = fn(*a, **k)
        if inspect.isawaitable(res):
            asyncio.ensure_future(res)


class _Route:
    def __init__(self, method, path, fn):
        self.method, self.fn = method, fn
        names = []

        def repl(m):
            names.append(m.group(1).split(":")[0])
            return "(?P<%s>[^/]+)" % names[-1] if not m.group(1).endswith(":path") else "(?P<%s>.+)" % names[-1]

        self.regex = re.compile("^" + re.sub(r"\{([^}]+)\}", repl, path) + "$")


class FastAPI:
    def __init__(self, *a, lifespan=None, **k):
        self.routes: list[_Route] = []
        self.startup: list = []
        self.shutdown: list = []
        self.lifespan = lifespan

    def _add(self, method, path):
        def deco(fn):
            self.routes.append(_Route(method, path, fn))
            return fn
        return deco

    def get(self, path, **_):
        return self._add("GET", path)

    def post(self, path, **_):
        return self._add("POST", path)

    def put(self, path, **_):
        return self._add("PUT", path)

    def delete(self, path, **_):
        return self._add("DELETE", path)

    def patch(self, path, **_):
        return self._add("PATCH", path)

    def websocket(self, path, **_):
        return self._add("WS", path)

    def api_route(self, path, methods=("GET",), **_):
        def deco(fn):
            for m in methods:
                self._add(m.upper(), path)(fn)
            return fn
        return deco

    def on_event(self, kind):
        def deco(fn):
            (self.startup if kind == "startup" else self.shutdown).append(fn)
            return fn
        return deco

    def mount(self, *a, **k):
        pass

    def add_middleware(self, *a, **k):
        pass

    def include_router(self, router, prefix="", **_):
        for r in router.routes:
            self.routes.append(_Route(r.method, prefix + r.path_src, r.fn))

    def exception_handler(self, *a, **k):
        return lambda fn: fn

    def middleware(self, *a, **k):
        return lambda fn: fn


class APIRouter(FastAPI):
    def _add(self, method, path):
        def deco(fn):
            r = _Route(method, path, fn)
            r.path_src = path
            self.routes.append(r)
            return fn
        return deco


class WebSocket:
    """Server-side socket handed to the app's @app.websocket handler."""

    def __init__(self, send_cb):
        self._send_cb = send_cb
        self._inbox: asyncio.Queue = asyncio.Queue()
        self.closed = False

    async def accept(self):
        pass

    async def send_json(self, data, *a, **k):
        if self.closed:
            raise WebSocketDisconnect()
        self._send_cb(json.dumps(data, default=str))

    async def send_text(self, text):
        if self.closed:
            raise WebSocketDisconnect()
        self._send_cb(text)

    async def receive_text(self):
        msg = await self._inbox.get()
        if msg is None:
            raise WebSocketDisconnect()
        return msg

    async def receive_json(self):
        return json.loads(await self.receive_text())

    async def close(self, *a, **k):
        self.closed = True


def _install_fastapi():
    fa = types.ModuleType("fastapi")
    for n in ("FastAPI", "APIRouter", "WebSocket", "WebSocketDisconnect", "HTTPException", "Query",
              "Body", "Path", "Request", "BackgroundTasks", "Response"):
        setattr(fa, n, globals()[n])
    resp = types.ModuleType("fastapi.responses")
    for n in ("JSONResponse", "FileResponse", "PlainTextResponse", "HTMLResponse", "StreamingResponse", "Response"):
        setattr(resp, n, globals()[n])
    st = types.ModuleType("fastapi.staticfiles")
    st.StaticFiles = StaticFiles
    mw = types.ModuleType("fastapi.middleware")
    cors = types.ModuleType("fastapi.middleware.cors")
    cors.CORSMiddleware = object
    sys.modules.update({"fastapi": fa, "fastapi.responses": resp, "fastapi.staticfiles": st,
                        "fastapi.middleware": mw, "fastapi.middleware.cors": cors,
                        "starlette": types.ModuleType("starlette"),
                        "starlette.websockets": fa, "starlette.responses": resp})


# ── httpx (browser fetch) ────────────────────────────────────────────────────
class HTTPError(Exception):
    pass


class HTTPStatusError(HTTPError):
    def __init__(self, msg, request=None, response=None):
        super().__init__(msg)
        self.response = response


class _HxResponse:
    def __init__(self, status, text, url, headers):
        self.status_code, self.text, self.url, self.headers = status, text, url, headers
        self.content = text.encode()
        self.is_success = 200 <= status < 300

    def json(self):
        return json.loads(self.text)

    def raise_for_status(self):
        if not self.is_success:
            raise HTTPStatusError(f"HTTP {self.status_code} for {self.url}", response=self)
        return self


_FORBIDDEN = {"user-agent", "accept-encoding", "connection", "host", "referer"}


class AsyncClient:
    def __init__(self, *a, base_url="", headers=None, timeout=None, params=None, **k):
        self.base_url = base_url or ""
        self.headers = {k2: v for k2, v in (headers or {}).items() if k2.lower() not in _FORBIDDEN}
        self.params = params or {}

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        pass

    async def aclose(self):
        pass

    async def request(self, method, url, params=None, json=None, data=None, headers=None, **_):
        from pyodide.http import pyfetch
        url = url if url.startswith("http") else self.base_url.rstrip("/") + "/" + url.lstrip("/")
        q = {**self.params, **(params or {})}
        if q:
            url += ("&" if "?" in url else "?") + urlencode({k2: v for k2, v in q.items() if v is not None}, doseq=True)
        h = {**self.headers, **{k2: v for k2, v in (headers or {}).items() if k2.lower() not in _FORBIDDEN}}
        body = None
        if json is not None:
            import json as _j
            body = _j.dumps(json)
            h.setdefault("Content-Type", "application/json")
        elif data is not None:
            body = data if isinstance(data, str) else urlencode(data)
        try:
            r = await pyfetch(url, method=method, headers=h, body=body)
            text = await r.string()
        except Exception as e:  # network / CORS failure
            raise HTTPError(str(e))
        return _HxResponse(r.status, text, url, dict(r.headers) if hasattr(r, "headers") else {})

    async def get(self, url, **k):
        return await self.request("GET", url, **k)

    async def post(self, url, **k):
        return await self.request("POST", url, **k)


def _install_httpx():
    hx = types.ModuleType("httpx")
    hx.AsyncClient, hx.HTTPError, hx.HTTPStatusError = AsyncClient, HTTPError, HTTPStatusError
    hx.RequestError = hx.TimeoutException = hx.ConnectError = HTTPError
    hx.Timeout = lambda *a, **k: None
    hx.Response = _HxResponse
    sys.modules["httpx"] = hx


def _install_dotenv():
    d = types.ModuleType("dotenv")
    d.load_dotenv = lambda *a, **k: False
    sys.modules["dotenv"] = d


def _install_asyncio_patches():
    # No threads in the browser: run "background thread" work inline.
    async def to_thread(fn, *a, **k):
        return fn(*a, **k)
    asyncio.to_thread = to_thread


def install():
    _install_asyncio_patches()
    _install_fastapi()
    _install_httpx()
    _install_dotenv()


# ── dispatcher ───────────────────────────────────────────────────────────────
APP: FastAPI | None = None
_SOCKETS: dict = {}


def _coerce(val, ann):
    ann = ann if isinstance(ann, str) else getattr(ann, "__name__", "")
    ann = ann.replace("Optional[", "").replace("]", "").split("|")[0].strip()
    try:
        if ann == "int":
            return int(val)
        if ann == "float":
            return float(val)
        if ann == "bool":
            return str(val).lower() in ("1", "true", "yes", "on")
    except (TypeError, ValueError):
        pass
    return val


async def startup(app: FastAPI):
    global APP
    APP = app
    for fn in app.startup:
        r = fn()
        if inspect.isawaitable(r):
            await r
    if app.lifespan:
        cm = app.lifespan(app)
        await cm.__aenter__()
        app._lifespan_cm = cm


def _match(method, path):
    for r in APP.routes:
        if r.method == method:
            m = r.regex.match(path)
            if m:
                return r, m.groupdict()
    return None, None


def _bind(fn, path_params, query, body_text):
    kwargs = {}
    sig = inspect.signature(fn)
    for name, p in sig.parameters.items():
        ann = p.annotation
        ann_s = ann if isinstance(ann, str) else getattr(ann, "__name__", "")
        default = p.default.default if isinstance(p.default, _Param) else p.default
        if name in path_params:
            kwargs[name] = _coerce(path_params[name], ann)
        elif "Request" in ann_s:
            kwargs[name] = Request(body_text, query)
        elif "BackgroundTasks" in ann_s:
            kwargs[name] = BackgroundTasks()
        elif name in query:
            v = query[name]
            kwargs[name] = _coerce(v, ann) if not ann_s.startswith(("list", "List")) else [v]
        elif ann_s.startswith(("dict", "Dict")) or (default is inspect.Parameter.empty and ann_s not in ("int", "float", "str", "bool")):
            data = json.loads(body_text) if body_text else {}
            if hasattr(ann, "model_validate"):
                data = ann.model_validate(data)
            kwargs[name] = data
        elif default is not inspect.Parameter.empty:
            kwargs[name] = default
    return kwargs


async def dispatch(method: str, url: str, body_text: str = "") -> str:
    parts = urlsplit(url)
    query = {k: v[-1] for k, v in parse_qs(parts.query).items()}
    route, params = _match(method.upper(), parts.path)
    if not route:
        return json.dumps({"status": 404, "type": "application/json", "body": json.dumps({"detail": "Not Found"})})
    try:
        res = route.fn(**_bind(route.fn, params, query, body_text))
        if inspect.isawaitable(res):
            res = await res
        status, mtype = 200, "application/json"
        if isinstance(res, Response):
            status, mtype = res.status_code, res.media_type
            res = res.content
            if mtype == "application/json":
                res = json.dumps(res, default=str)
            elif not isinstance(res, str):
                res = "".join(res) if res is not None else ""
        else:
            if hasattr(res, "model_dump"):
                res = res.model_dump()
            res = json.dumps(res, default=str)
    except HTTPException as e:
        status, mtype, res = e.status_code, "application/json", json.dumps({"detail": e.detail})
    except Exception as e:
        import traceback
        traceback.print_exc()
        status, mtype, res = 500, "application/json", json.dumps({"detail": f"{type(e).__name__}: {e}"})
    return json.dumps({"status": status, "type": mtype, "body": res})


def ws_open(sid: int, path: str, send_cb, close_cb):
    route, params = _match("WS", urlsplit(path).path)
    if not route:
        close_cb()
        return
    ws = WebSocket(send_cb)
    _SOCKETS[sid] = ws

    async def run():
        try:
            await route.fn(ws, **{k: v for k, v in params.items()})
        except WebSocketDisconnect:
            pass
        except Exception:
            import traceback
            traceback.print_exc()
        finally:
            _SOCKETS.pop(sid, None)

    asyncio.ensure_future(run())


def ws_message(sid: int, text: str):
    ws = _SOCKETS.get(sid)
    if ws:
        ws._inbox.put_nowait(text)


def ws_close(sid: int):
    ws = _SOCKETS.get(sid)
    if ws:
        ws.closed = True
        ws._inbox.put_nowait(None)
