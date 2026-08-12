"""
server.py — the stateless API. One app object, two deploy targets.

There is NO server-held session state: every endpoint is a pure function of its
request plus the read-only bundled data. The browser holds the analysis result,
the scorecard and the audit log, and drives the pipeline one call at a time.

That is what makes this deployable on serverless hosting (Vercel), where a
background thread would die at the end of the response and an in-process dict
would not survive to the next request. It also removed the polling loop that
used to re-render the page every few seconds.

Uploaded PDFs are cached in the OS temp dir, keyed by content hash, purely so
page images and highlight rects can be produced without re-uploading. A cold
serverless instance simply misses that cache; the client re-posts the file to
/api/rehydrate and carries on. Nothing depends on the cache surviving.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import List, Optional

import pymupdf
from fastapi import Body, FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse, Response

import contract
import gemini
from pipeline import convert, evaluate, run, scorecard

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
SEED_DOCX = DATA / "seed" / "Starbucks 1.docx"
SEED_PDF = DATA / "seed" / "Starbucks 1.pdf"
PRECOMPUTED = DATA / "precomputed" / "seed.json"
TMP = Path(tempfile.gettempdir()) / "siq-docs"
TMP.mkdir(parents=True, exist_ok=True)

PORTFOLIO = json.loads((DATA / "sample_portfolio.json").read_text(encoding="utf-8"))["bids"]

api = FastAPI(title="Scope IQ API")


def _err(msg: str, code: int = 422, **extra) -> JSONResponse:
    return JSONResponse({"ok": False, "error": msg, **extra}, status_code=code)


def _pdf_for(doc_id: str) -> Optional[Path]:
    """Server-resident PDF for a doc id, if this instance happens to have it."""
    if doc_id == _seed_doc_id():
        return SEED_PDF
    p = TMP / f"{doc_id}.pdf"
    return p if p.exists() else None


_SEED_ID: Optional[str] = None


def _seed_doc_id() -> str:
    global _SEED_ID
    if _SEED_ID is None:
        _SEED_ID = run.doc_id_for(SEED_PDF)
    return _SEED_ID


# ------------------------------------------------------------------ boot

@api.get("/api/bootstrap")
def bootstrap() -> JSONResponse:
    return JSONResponse({
        "stages": run.STAGES,
        "personas": list(scorecard.PERSONAS.values()),
        "portfolio": PORTFOLIO,
        "scorecard_seed": scorecard.seed(),
        "seed_doc_id": _seed_doc_id(),
        # smaller windows on serverless: each extraction call must finish well
        # inside the function's max duration, and Vercel's default is 60s
        "extract_chunk_pages": 6 if os.environ.get("VERCEL") else run.CHUNK_PAGES,
        "has_key": gemini.has_key(),
        "features": {
            "docx": convert.libreoffice_available(),
            "cache_writable": gemini.cache_writable_in_repo(),
        },
    })


@api.get("/api/seed")
def seed() -> JSONResponse:
    """The precomputed analysis of the sample document: instant, no model call.

    Committed so a fresh deploy demos with no API key at all. It is a real run,
    not hand-authored: regenerate it with `python tools/precompute_seed.py`.
    """
    if not PRECOMPUTED.exists():
        return _err("no precomputed seed in this build; run tools/precompute_seed.py", 503)
    return Response(content=PRECOMPUTED.read_text(encoding="utf-8"), media_type="application/json")


# --------------------------------------------------------------- pipeline

@api.post("/api/prepare")
async def prepare(file: UploadFile = File(...)) -> JSONResponse:
    """Convert (if Word), parse, and run the document-type gate."""
    suffix = Path(file.filename or "upload").suffix.lower()
    if suffix not in (".pdf", ".docx", ".doc"):
        return _err(f"unsupported file type {suffix or '(none)'}; send .docx or .pdf")
    if suffix != ".pdf" and not convert.libreoffice_available():
        return _err("This host cannot convert Word files (LibreOffice is not installed here). "
                    "Upload a PDF instead, or run the app locally.", 501)

    workdir = Path(tempfile.mkdtemp(prefix="siq-in-", dir=TMP))
    src = workdir / Path(file.filename or f"upload{suffix}").name
    src.write_bytes(await file.read())
    gemini.begin_run()
    try:
        prep = run.prepare(src)
    except convert.ScannedPdfError:
        return _err("This PDF has no text layer — it looks scanned. Nothing was extracted, on "
                    "purpose: without selectable text there is no sentence to quote and no page "
                    "to point at. Send a digital PDF or the original Word file.",
                    422, title="This PDF has no text layer — it looks scanned.", kind="scanned")
    except run.NotScopeDocError as exc:
        return _err(f"{exc.reason} Nothing was scored or extracted, on purpose: this tool reads "
                    "construction scope and specification documents (spec books, workletters, "
                    "ITB packages). Upload one of those instead.",
                    422, title=f"This looks like a {exc.doc_type}, not a scope document.",
                    kind="not_scope")
    except convert.ConversionError as exc:
        return _err(str(exc), 422, title="The file could not be converted.")
    finally:
        pass

    # keep the PDF around for page images and rects; harmless if it vanishes
    doc_id = prep["doc"]["id"]
    try:
        shutil.copyfile(prep["pdf"], TMP / f"{doc_id}.pdf")
    except OSError:
        pass
    shutil.rmtree(workdir, ignore_errors=True)

    return JSONResponse({"ok": True, "doc": prep["doc"], "page_texts": prep["page_texts"],
                         "warnings": gemini.drain_warnings()})


@api.post("/api/evaluate")
def evaluate_bid(payload: dict = Body(...)) -> JSONResponse:
    """UC#4 scoring. Document rules see the model; nothing else does."""
    sc = payload.get("scorecard") or {}
    page_texts: List[str] = payload.get("page_texts") or []
    problems = scorecard.validate(sc)
    if problems:
        return _err("; ".join(problems))
    if not page_texts:
        return _err("page_texts is required")
    gemini.begin_run()
    pdf = _pdf_for(payload.get("doc_id") or "")
    try:
        ev = evaluate.evaluate(sc, page_texts, pdf, use_cache=payload.get("use_cache", True))
    except Exception as exc:  # noqa: BLE001
        return _err(f"{type(exc).__name__}: {exc}", 500)
    return JSONResponse({"ok": True, "evaluation": ev, "provenance": gemini.current_provenance(),
                         "warnings": gemini.drain_warnings()})


@api.post("/api/extract")
def extract(payload: dict = Body(...)) -> JSONResponse:
    """One extraction call over a window of pages. The client walks the windows."""
    page_texts: List[str] = payload.get("page_texts") or []
    start = int(payload.get("start") or 1)
    count = int(payload.get("count") or run.CHUNK_PAGES)
    if not page_texts:
        return _err("page_texts is required")
    gemini.begin_run()
    try:
        raw = run.extract_chunk(page_texts, start, count, use_cache=payload.get("use_cache", True))
    except Exception as exc:  # noqa: BLE001
        return _err(f"{type(exc).__name__}: {exc}", 500)
    return JSONResponse({"ok": True, "raw_lines": raw, "provenance": gemini.current_provenance(),
                         "warnings": gemini.drain_warnings()})


@api.post("/api/finalize")
def finalize(payload: dict = Body(...)) -> JSONResponse:
    """Verify + normalize + catalogue-match. Every gate here is deterministic."""
    page_texts: List[str] = payload.get("page_texts") or []
    raw: List[dict] = payload.get("raw_lines") or []
    if not page_texts:
        return _err("page_texts is required")
    gemini.begin_run()
    pdf = _pdf_for(payload.get("doc_id") or "")
    try:
        lines = run.finalize_lines(raw, page_texts, pdf, use_cache=payload.get("use_cache", True))
    except Exception as exc:  # noqa: BLE001
        return _err(f"{type(exc).__name__}: {exc}", 500)
    return JSONResponse({"ok": True, "lines": lines, "rects_resolved": pdf is not None,
                         "provenance": gemini.current_provenance(),
                         "warnings": gemini.drain_warnings()})


@api.post("/api/narrative")
def narrative(payload: dict = Body(...)) -> JSONResponse:
    """Pros/cons, generated only AFTER the caller already has the totals."""
    lines = payload.get("lines") or []
    agg = {"verdict": payload.get("verdict") or "", "rating": payload.get("rating") or ""}
    gemini.begin_run()
    nb = evaluate.narrative_for(lines, agg, use_cache=payload.get("use_cache", True))
    return JSONResponse({"ok": True, "narrative": nb, "warnings": gemini.drain_warnings()})


# ------------------------------------------------------------ doc assets

@api.get("/api/page")
def page(doc: str, n: int = 1, scale: float = 2.0) -> Response:
    pdf = _pdf_for(doc)
    if not pdf:
        return _err("this instance does not hold that document; re-post it to /api/rehydrate",
                    404, kind="rehydrate")
    scale = max(1.0, min(3.0, scale))
    d = pymupdf.open(pdf)
    try:
        if not 1 <= n <= len(d):
            return Response(status_code=404)
        pix = d[n - 1].get_pixmap(matrix=pymupdf.Matrix(scale, scale))
        return Response(content=pix.tobytes("png"), media_type="image/png",
                        headers={"Cache-Control": "max-age=3600"})
    finally:
        d.close()


@api.post("/api/rects")
def rects(payload: dict = Body(...)) -> JSONResponse:
    """Resolve highlight rectangles lazily, for deploys that did not keep the PDF
    at extraction time. Verification already happened against the page text."""
    pdf = _pdf_for(payload.get("doc_id") or "")
    if not pdf:
        return _err("document not held by this instance", 404, kind="rehydrate")
    try:
        r = evaluate.verify.quote_rects(pdf, int(payload.get("page") or 1),
                                        payload.get("quote") or "")
    except Exception as exc:  # noqa: BLE001
        return _err(f"{type(exc).__name__}: {exc}", 500)
    return JSONResponse({"ok": True, "rects": r})


@api.post("/api/rehydrate")
async def rehydrate(doc_id: str = Form(...), file: UploadFile = File(...)) -> JSONResponse:
    """Re-seat an already-analyzed PDF on this instance so page images work."""
    dest = TMP / f"{doc_id}.pdf"
    dest.write_bytes(await file.read())
    if run.doc_id_for(dest) != doc_id:
        dest.unlink(missing_ok=True)
        return _err("uploaded file does not match that doc id")
    return JSONResponse({"ok": True})


# ------------------------------------------------------------------ misc

@api.post("/api/clear-cache")
def clear_cache() -> JSONResponse:
    """Local convenience: drop cached model responses so the next run is live.
    On a read-only deploy there is nothing durable to clear, and we say so."""
    if not gemini.cache_writable_in_repo():
        return JSONResponse({"ok": False, "error": "This deploy serves a read-only response "
                                                   "cache, so there is nothing to clear here. "
                                                   "Run the app locally to force a live run."})
    return JSONResponse({"ok": True, "cleared": gemini.clear_cache()})
