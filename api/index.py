"""
api/index.py — Vercel entry point.

Vercel's Python runtime serves the ASGI callable named `app` from this file.
Static assets live in public/ and are served by Vercel's CDN, so this function
only ever handles /api/* — see vercel.json.
"""

import sys
from pathlib import Path

# the repo root holds contract.py / gemini.py / pipeline/, one level up
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server import api as app  # noqa: E402,F401
