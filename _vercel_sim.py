"""
_vercel_sim.py — local reproduction of the Vercel routing failure.

Vercel's filesystem routing maps the function to exactly one path, /api/index,
and a rewrite that funnels /api/* at it does not reliably arrive carrying the
original path. This wrapper reproduces that worst case by collapsing every
/api/* request to /api/index before the app sees it.

If the app works under this wrapper it works under either Vercel behaviour.
Not part of the deployment (see .vercelignore).

    .venv/bin/uvicorn _vercel_sim:app --port 8052
"""

from server import api


class CollapsePath:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") == "http" and scope.get("path", "").startswith("/api/"):
            scope = dict(scope)
            scope["path"] = "/api/index"
            scope["raw_path"] = b"/api/index"
        await self.app(scope, receive, send)


app = CollapsePath(api)
