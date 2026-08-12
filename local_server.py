"""
local_server.py — run the demo locally.

    .venv/bin/uvicorn local_server:app --host 127.0.0.1 --port 8023

Deliberately NOT called app.py: Vercel's Python framework detection treats a
root-level app.py as the deployment entrypoint and builds that instead of
api/index.py, which is how the first deploy ended up 500ing on every route.
Everything real lives in server.py (the API plus the static mount) and
pipeline/ (the work), so local and hosted run identical code.
"""

from server import api as app  # noqa: F401

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8023)
