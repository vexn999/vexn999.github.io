"""Rebuild the in-browser live demos from the real project sources.

    python3 live/build.py            # all apps
    python3 live/build.py stormchaser

For each app: copies the frontend into live/<app>/, bundles the Python
package into live/<app>/bundle.json, and injects the Pyodide runtime
(live/_runtime/pyapp.js) into index.html in place of the original scripts.
"""
from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROJ = Path.home() / "projects"

APPS = {
    "stormchaser": {
        "name": "StormChaser",
        "src": PROJ / "crypto/stormchaser",
        "frontend": "frontend",
        "packages": ["stormchaser"],
        "boot": "from stormchaser.app import AppContext\n"
                "from stormchaser.api.server import create_app\n"
                "ctx = AppContext()\napp = create_app(ctx)",
    },
    "tradebot": {
        "name": "Tradebot",
        "src": PROJ / "crypto/tradebot",
        "frontend": "frontend",
        "packages": ["tradebot"],
        "pyodide_packages": ["pandas"],
        # api.binance.com geo-blocks some visitors (HTTP 451); the official
        # public market-data mirror serves the same read-only endpoints.
        "rewrites": {"https://api.binance.com/api/v3": "https://data-api.binance.vision/api/v3"},
        "boot": "from tradebot.app import AppContext\n"
                "from tradebot.api.server import create_app\n"
                "ctx = AppContext()\napp = create_app(ctx)\n"
                # Same backfill ml.train does: real 1h Binance klines into ohlcv_history,
                # so charts and history-hungry rules work on a fresh in-browser DB.
                "for _s in ctx.cfg.symbols:\n"
                "    ctx.db.add_ohlcv_bars(_s, await ctx.binance.get_klines(_s, '1h', limit=1000), 3600, 'binance')",
        "after": "import asyncio\nasyncio.ensure_future(ctx.signals.scan())",
    },
    "cryptodeck": {
        "name": "CryptoDeck",
        "src": PROJ / "crypto/cryptodeck",
        "frontend": "frontend",
        "packages": ["cryptodeck"],
        "boot": "from cryptodeck.app import AppContext\n"
                "from cryptodeck.api.server import create_app\n"
                "ctx = AppContext()\napp = create_app(ctx)",
        # A fresh browser DB has no price_snapshots, so the backtester has nothing
        # to replay. Seed the last 24h of real 5-minute CoinGecko prices for the majors.
        "after": "import asyncio\nfrom cryptodeck.models import Quote\n"
                 "async def _seed():\n"
                 "    for gid, coin in list(ctx.hub._majors.items())[:3]:\n"
                 "        if len(ctx.db.snapshot_history(coin.id, 24)) > 50: continue\n"
                 "        for ts, p in (await ctx.hub.coingecko.market_chart(gid, days=1))[:-1]:\n"
                 "            ctx.db.add_snapshot(coin.id, Quote(price_usd=p, ts=ts))\n"
                 "asyncio.ensure_future(_seed())",
    },
}

SKIP_DIRS = {"__pycache__", ".pytest_cache", "tests", ".venv", "venv", "node_modules"}


def bundle_python(src: Path, packages: list[str]) -> dict[str, str]:
    out = {}
    for pkg in packages:
        for f in sorted((src / pkg).rglob("*.py")):
            if SKIP_DIRS & set(f.relative_to(src).parts):
                continue
            out[str(f.relative_to(src))] = f.read_text()
    return out


def apply_rewrites(files: dict[str, str], rewrites: dict[str, str]) -> dict[str, str]:
    for k, v in files.items():
        for a, b in rewrites.items():
            v = v.replace(a, b)
        files[k] = v
    return files


def build(key: str, cfg: dict) -> None:
    src, dest = cfg["src"], HERE / key
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(src / cfg["frontend"], dest)

    (dest / "bundle.json").write_text(json.dumps(apply_rewrites(bundle_python(src, cfg["packages"]), cfg.get("rewrites", {}))))

    index = dest / "index.html"
    html = index.read_text()
    scripts = re.findall(r'<script[^>]*src="([^"]+)"[^>]*></script>', html)
    local = [s for s in scripts if not s.startswith("http")]
    for s in local:
        html = re.sub(r'\s*<script[^>]*src="%s"[^>]*></script>' % re.escape(s), "", html)
    # absolute "/static/x" asset paths → relative
    html = re.sub(r'(href|src)="/(?:static/)?([^"/][^"]*)"', r'\1="\2"', html)
    conf = {"id": key, "name": cfg["name"], "bundle": "bundle.json", "scripts": [s.lstrip("/").replace("static/", "", 1) for s in local],
            "packages": cfg.get("pyodide_packages", []), "boot": cfg["boot"], "after": cfg.get("after", "")}
    inject = ('\n<script>window.PYAPP = %s;</script>\n<script src="../_runtime/pyapp.js"></script>\n'
              % json.dumps(conf))
    html = html.replace("</body>", inject + "</body>")
    index.write_text(html)
    print(f"built live/{key}  ({len(json.loads((dest / 'bundle.json').read_text()))} py files)")


if __name__ == "__main__":
    for k in sys.argv[1:] or APPS:
        build(k, APPS[k])
