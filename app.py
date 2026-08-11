"""
app.py — Scope IQ demo server. FastAPI + static vanilla JS. Port 8023.

State is in-process and single-document: the demo analyzes one specification
at a time (the seeded Starbucks workletter until something is uploaded).
Processing runs on a background thread; the front end polls /state.

Both tabs are live: Scope Intelligence (UC#2) and Bid Decision (UC#4, the
customer-owned scorecard). The scorecard seed mirrors the customer's real
spreadsheet; runtime edits are versioned and audit-logged (pipeline/scorecard).
"""

from __future__ import annotations

import json
import threading
import traceback
from pathlib import Path

import pymupdf
from fastapi import Body, FastAPI, File, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

import gemini
from pipeline import convert, evaluate, run, scorecard

HERE = Path(__file__).resolve().parent
SEED = HERE / "data" / "seed" / "Starbucks 1.docx"
UPLOADS = HERE / "data" / "uploads"
UPLOADS.mkdir(parents=True, exist_ok=True)
PORTFOLIO = json.loads((HERE / "data" / "sample_portfolio.json").read_text(encoding="utf-8"))

app = FastAPI(title="Scope IQ demo")

_LOCK = threading.Lock()
_STATE: dict = {
    "mode": "starting",          # starting | processing | idle | blocked | error
    "stage": -1,
    "stage_detail": "",
    "error": "",
    "error_title": "",
    "result": None,              # output of pipeline.run.analyze
    "upload_seq": 0,
    "current_src": str(SEED),
}
_PDF_BY_ID: dict[str, Path] = {}


def _set(**kw) -> None:
    with _LOCK:
        _STATE.update(kw)


def _snapshot() -> dict:
    with _LOCK:
        return dict(_STATE)


def _analyze_async(src: Path, use_cache: bool, force_scope: bool = False) -> None:
    def stage_cb(i: int, detail: str) -> None:
        _set(stage=i, stage_detail=detail)

    def work() -> None:
        _set(mode="processing", stage=0, stage_detail=src.name, error="", error_title="",
             current_src=str(src))
        try:
            result = run.analyze(src, scorecard.current(), on_stage=stage_cb,
                                 use_cache=use_cache, force_scope=force_scope)
            pdf = src if src.suffix.lower() == ".pdf" else src.with_suffix(".pdf")
            _PDF_BY_ID[result["doc"]["id"]] = pdf
            _set(mode="idle", stage=-1, result=result)
        except convert.ScannedPdfError:
            _set(mode="blocked", stage=-1,
                 error_title="This PDF has no text layer — it looks scanned.",
                 error="Nothing was extracted, on purpose: without selectable text there is "
                       "no sentence to quote and no page to point at. Send a digital PDF or "
                       "the original Word file.")
        except run.NotScopeDocError as exc:
            _set(mode="blocked", stage=-1,
                 error_title=f"This looks like a {exc.doc_type}, not a scope document.",
                 error=f"{exc.reason} Nothing was scored or extracted, on purpose: this tool "
                       "reads construction scope and specification documents (spec books, "
                       "workletters, ITB packages). Upload one of those instead.")
        except Exception as exc:  # noqa: BLE001 — surfaced to the UI, never swallowed
            traceback.print_exc()
            _set(mode="error", stage=-1, error_title="The analysis failed.",
                 error=f"{type(exc).__name__}: {exc}")

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
        "error_title": s["error_title"],
        "result": s["result"],
        "scorecard": scorecard.current(),
        "personas": list(scorecard.PERSONAS.values()),
        "portfolio": PORTFOLIO["bids"],
        "audit": scorecard.audit_log(),
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
    """Clear cache + uploads, restore the seed scorecard and audit log, re-run live."""
    s = _snapshot()
    if s["mode"] == "processing":
        return JSONResponse({"ok": False, "error": "wait for the current run to finish"}, status_code=409)
    n = gemini.clear_cache()
    dropped = 0
    for p in UPLOADS.glob("u*"):
        p.unlink()
        dropped += 1
    scorecard.reset()
    _PDF_BY_ID.clear()
    _set(result=None)
    _analyze_async(SEED, use_cache=False)
    return JSONResponse({"ok": True, "cleared": n, "dropped_uploads": dropped})


@app.post("/scope/run-anyway")
def run_anyway() -> JSONResponse:
    """Run the scope extraction even though the bid gate failed. Explicit escape hatch."""
    s = _snapshot()
    if s["mode"] == "processing":
        return JSONResponse({"ok": False, "error": "already processing"}, status_code=409)
    _analyze_async(Path(s["current_src"]), use_cache=True, force_scope=True)
    return JSONResponse({"ok": True})


# ------------------------------------------------------------ UC#4 surface

@app.put("/scorecard")
def save_scorecard(payload: dict = Body(...)) -> JSONResponse:
    """payload: {scorecard: <full object>, persona: id, flips_note: str}"""
    try:
        sc, changes = scorecard.save(payload.get("scorecard") or {},
                                     payload.get("persona") or "dana",
                                     payload.get("flips_note") or "")
    except ValueError as exc:
        return JSONResponse({"ok": False, "error": str(exc)}, status_code=422)
    return JSONResponse({"ok": True, "version": sc.get("version"), "changes": len(changes)})


@app.post("/evaluation/score")
def human_score(payload: dict = Body(...)) -> JSONResponse:
    """One-tap human score: {rule_id, score 1-5 | null to clear, persona}."""
    rule_id = payload.get("rule_id")
    score = payload.get("score", None)
    persona = payload.get("persona") or "dana"
    if score is not None and score not in (1, 2, 3, 4, 5):
        return JSONResponse({"ok": False, "error": "score must be 1-5 or null"}, status_code=422)
    with _LOCK:
        result = _STATE.get("result")
        if not result:
            return JSONResponse({"ok": False, "error": "no evaluation yet"}, status_code=409)
        ev = result["evaluation"]
        line = next((l for l in ev["lines"] if l["rule_id"] == rule_id), None)
        if line is None:
            return JSONResponse({"ok": False, "error": f"unknown rule {rule_id}"}, status_code=422)
        p = scorecard.PERSONAS.get(persona, scorecard.PERSONAS["dana"])
        if score is None:
            line["score"] = None
            line["needs_human"] = True
            line["scored_by"] = None
            line["evidence"] = "The model never sees this rule. Tap a score."
        else:
            line["score"] = int(score)
            line["needs_human"] = False
            line["scored_by"] = p["id"]
            line["evidence"] = f"Scored by {p['name']} ({p['role']})"
        # weights snapshot: reaggregate under the evaluation's own snapshot, so a
        # scorecard edited since this run does not silently rescore old evidence
        snap_sc = {"id": ev["scorecard_id"], "bands": scorecard.current().get("bands", []),
                   "threshold": scorecard.current().get("threshold", 0),
                   "gate_enforced": scorecard.current().get("gate_enforced", False)}
        agg = evaluate.reaggregate(snap_sc, ev["lines"])
        ev.update(agg)
        # narrative regen is a model call; run it off-thread so the tap lands instantly
        lines_copy = [dict(l) for l in ev["lines"]]

        def regen() -> None:
            nb = evaluate.narrative_for(lines_copy, agg, use_cache=True)
            with _LOCK:
                res_now = _STATE.get("result")
                if res_now and res_now["evaluation"] is ev:
                    ev["narrative"] = nb
        threading.Thread(target=regen, daemon=True).start()
        # gate may have flipped either way; reflect on the scope side without rerunning
        if result.get("lines") is None and agg["gate"]["passed"]:
            result["scope_block_reason"] = ""
        result["scope_blocked"] = (agg["gate"]["enforced"] and not agg["gate"]["passed"]
                                   and result.get("lines") is None)
        if result["scope_blocked"]:
            if agg["knockouts_triggered"]:
                result["scope_block_reason"] = "knockout triggered: " + ", ".join(agg["knockouts_triggered"])
            else:
                result["scope_block_reason"] = (f"score {agg['normalized']} is below the bid "
                                                f"threshold ({agg['gate']['threshold']})")
    return JSONResponse({"ok": True})


@app.post("/evaluation/rerun")
def rerun_evaluation() -> JSONResponse:
    """Re-score the current document under the CURRENT scorecard (new snapshot)."""
    s = _snapshot()
    if s["mode"] == "processing":
        return JSONResponse({"ok": False, "error": "already processing"}, status_code=409)
    _analyze_async(Path(s["current_src"]), use_cache=True)
    return JSONResponse({"ok": True})


# --------------------------------------------------------------- assets

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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8023)
