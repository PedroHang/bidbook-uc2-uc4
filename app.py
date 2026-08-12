"""
app.py — local runner. Serves the same stateless API as the Vercel deploy,
plus the front end from ./public.

    .venv/bin/uvicorn app:app --host 127.0.0.1 --port 8023

Everything the app does lives in server.py (the API) and pipeline/ (the work).
This file only adds the static mount, so local and hosted behave identically
apart from LibreOffice being available here.
"""

from __future__ import annotations

from pathlib import Path

from fastapi.staticfiles import StaticFiles

from server import api as app

HERE = Path(__file__).resolve().parent

app.mount("/", StaticFiles(directory=HERE / "public", html=True), name="public")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8023)
