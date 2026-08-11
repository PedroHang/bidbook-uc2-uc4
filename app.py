"""
app.py — Scope IQ demo server. FastAPI + static vanilla JS. Port 8023.

State is in-process and single-document: the demo analyzes one specification
at a time (the seeded Starbucks workletter until something is uploaded).
Processing runs on a background thread; the front end polls /state.

The Bid Decision tab is served static data this batch (see DECISION below):
it is the designed preview of the UC#4 build, clearly labeled, and every
number in it is Schaffhouser's real spreadsheet, not an invention.
"""

from __future__ import annotations

import io
import threading
import traceback
from pathlib import Path

import pymupdf
from fastapi import FastAPI, File, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

import gemini
from pipeline import convert, run

HERE = Path(__file__).resolve().parent
SEED = HERE / "data" / "seed" / "Starbucks 1.docx"
UPLOADS = HERE / "data" / "uploads"
UPLOADS.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Scope IQ demo")

_LOCK = threading.Lock()
_STATE: dict = {
    "mode": "starting",          # starting | processing | idle | blocked | error
    "stage": -1,
    "stage_detail": "",
    "error": "",
    "result": None,              # output of pipeline.run.analyze
    "upload_seq": 0,
}
_PDF_BY_ID: dict[str, Path] = {}


def _set(**kw) -> None:
    with _LOCK:
        _STATE.update(kw)


def _snapshot() -> dict:
    with _LOCK:
        return dict(_STATE)


def _analyze_async(src: Path, use_cache: bool) -> None:
    def stage_cb(i: int, detail: str) -> None:
        _set(stage=i, stage_detail=detail)

    def work() -> None:
        _set(mode="processing", stage=0, stage_detail=src.name, error="")
        try:
            result = run.analyze(src, on_stage=stage_cb, use_cache=use_cache)
            pdf = src if src.suffix.lower() == ".pdf" else src.with_suffix(".pdf")
            _PDF_BY_ID[result["doc"]["id"]] = pdf
            _set(mode="idle", stage=-1, result=result)
        except convert.ScannedPdfError:
            _set(mode="blocked", stage=-1,
                 error="This PDF has no text layer — it looks scanned. Nothing was extracted, "
                       "on purpose: without selectable text there is no sentence to quote and "
                       "no page to point at.")
        except Exception as exc:  # noqa: BLE001 — surfaced to the UI, never swallowed
            traceback.print_exc()
            _set(mode="error", stage=-1, error=f"{type(exc).__name__}: {exc}")

    threading.Thread(target=work, daemon=True).start()


@app.on_event("startup")
def seed() -> None:
    _analyze_async(SEED, use_cache=True)


@app.get("/state")
def state() -> JSONResponse:
    s = _snapshot()
    return JSONResponse({
        "mode": s["mode"],
        "stage": s["stage"],
        "stage_detail": s["stage_detail"],
        "stages": run.STAGES,
        "error": s["error"],
        "result": s["result"],
        "decision": DECISION,
        "has_key": gemini.has_key(),
    })


@app.post("/upload")
async def upload(file: UploadFile = File(...)) -> JSONResponse:
    s = _snapshot()
    if s["mode"] == "processing":
        return JSONResponse({"ok": False, "error": "already processing a document"}, status_code=409)
    suffix = Path(file.filename or "upload").suffix.lower()
    if suffix not in (".pdf", ".docx", ".doc"):
        return JSONResponse({"ok": False, "error": f"unsupported file type {suffix or '(none)'}; "
                                                   "send .docx or .pdf"}, status_code=422)
    with _LOCK:
        _STATE["upload_seq"] += 1
        seq = _STATE["upload_seq"]
    safe = Path(file.filename or f"upload{suffix}").name
    dest = UPLOADS / f"u{seq}-{safe}"
    dest.write_bytes(await file.read())
    _analyze_async(dest, use_cache=True)
    return JSONResponse({"ok": True})


@app.post("/reset")
def reset() -> JSONResponse:
    """Clear the model cache, drop uploads, reseed. The next run calls live."""
    s = _snapshot()
    if s["mode"] == "processing":
        return JSONResponse({"ok": False, "error": "wait for the current run to finish"}, status_code=409)
    n = gemini.clear_cache()
    dropped = 0
    for p in UPLOADS.glob("u*"):
        p.unlink()
        dropped += 1
    _PDF_BY_ID.clear()
    _set(result=None)
    _analyze_async(SEED, use_cache=False)
    return JSONResponse({"ok": True, "cleared": n, "dropped_uploads": dropped})


@app.get("/page")
def page(doc: str, n: int = 1, scale: float = 2.0) -> Response:
    pdf = _PDF_BY_ID.get(doc)
    if not pdf or not pdf.exists():
        return Response(status_code=404)
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


@app.get("/")
def index() -> FileResponse:
    return FileResponse(HERE / "static" / "index.html")


app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")


# ---------------------------------------------------------------------------
# Bid Decision — static preview data for this batch.
# Every criterion, score and weight is Schaffhouser's real spreadsheet
# (Project ScoreCard.xlsx, received 2026-08-03): 52.5 / 70 = 75. The bucket
# assignment per rule follows the UC#4 BRD. The interactive scorecard —
# editable weights, knockouts, gate, audit log — is the next build and this
# page says so on its face.
# ---------------------------------------------------------------------------

DECISION = {
    "preview": True,
    "project": "Starbucks Reserve — Schaffhouser Building, Suite 140",
    "scorecard": "Schaffhouser Go / No-Go (customer-owned)",
    "total": 52.5, "max": 70, "normalized": 75,
    "rating": "HIGH PRIORITY", "verdict": "BID",
    "threshold": 60,
    "scored_note": "10 of 10 rules scored — human rows entered by the estimator",
    "groups": [
        {
            "key": "document", "label": "From the document",
            "note": "AI proposes a score with a quoted passage, or abstains. Interactive in the next build.",
            "rules": [
                {"name": "Project Fit", "anchors": "Industrial 5 · Commercial 4 · Municipal 3 · Retail 2 · Education 1",
                 "score": 5, "weight": 2, "evidence": "Sample evidence — in the live build the AI cites the exact sentence and page it read.", "tag": "SAMPLE"},
                {"name": "Real Project or Budgetary?", "anchors": "Real 5 · Budgetary 1",
                 "score": 5, "weight": 1, "evidence": "Sample evidence — cited passage appears here.", "tag": "SAMPLE"},
                {"name": "Net Payment Terms", "anchors": "30d 5 · 60d 4 · 90d 3 · >90d 1",
                 "score": 4, "weight": 1.5, "evidence": "Sample evidence — cited passage appears here.", "tag": "SAMPLE"},
            ],
        },
        {
            "key": "crm", "label": "From your CRM",
            "note": "Named queries against org data — no AI. Simulated with SAMPLE records in the demo.",
            "rules": [
                {"name": "Existing Client", "anchors": "Yes 5 · No 3", "score": 3, "weight": 2,
                 "evidence": "Named query existing_client → No", "tag": "SAMPLE"},
                {"name": "Customer Quality", "anchors": "Probability of future opportunities",
                 "score": 4, "weight": 1, "evidence": "Named query customer_quality_history", "tag": "SAMPLE"},
                {"name": "Local Customer or Regional?", "anchors": "Local 3 · Regional multiple locations 5",
                 "score": 5, "weight": 1, "evidence": "Named query local_or_regional → Regional", "tag": "SAMPLE"},
            ],
        },
        {
            "key": "derived", "label": "Computed",
            "note": "Deterministic code. The model never does date math or geocoding.",
            "rules": [
                {"name": "Bid Time Frame", "anchors": "5wk 5 · 4wk 4 · 3wk 3 · 2wk 2 · 1wk 1",
                 "score": 3, "weight": 1, "evidence": "bid due − today → 3-week band", "tag": None},
                {"name": "Local to a Schaffhouser Office?", "anchors": "Within 60 miles: Yes 5 · No 2",
                 "score": 2, "weight": 1, "evidence": "distance to nearest office > 60 mi", "tag": "SAMPLE"},
            ],
        },
        {
            "key": "human", "label": "Needs a human",
            "note": "The model never sees these rules. One-tap entry in the next build.",
            "rules": [
                {"name": "Bid Position (How Many Bidders?)", "anchors": "Single source 5 · One of two 4 · One of three 3 · Unknown 2 · More than 3: 1",
                 "score": 2, "weight": 2, "evidence": "Entered by the estimator", "tag": None},
                {"name": "Labor Availability", "anchors": "Desperately 5 · Yes 4 · Possibly 3 · Not really 2 · No 1",
                 "score": 5, "weight": 1.5, "evidence": "Entered by the estimator", "tag": None},
            ],
        },
    ],
    "pros": [
        "Project fit scored 5 under the customer's own anchors (heaviest weight)",
        "Real, funded project — not budgetary pricing",
        "Regional customer with multiple locations",
        "Region needs the work — labor is available",
    ],
    "cons": [
        "Not an existing client — no relationship history",
        "More than two bidders expected — weak bid position",
        "Outside the 60-mile office radius",
        "Only a 3-week bid window",
    ],
}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8023)
