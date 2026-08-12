"""
run.py — the pipeline, exposed as SEPARATE STEPS the caller drives.

Pipeline order IS the product's argument:
  convert -> parse -> document-type gate -> UC#4 scoring -> bid gate ->
  UC#2 extraction (only if the gate passes, is off, or is explicitly overridden).
The cheap decision protects the expensive analysis.

Every step is a pure-ish function so the browser can orchestrate them one HTTP
call at a time. That is what makes the app deployable on serverless hosting
(no background threads, no server-held state) and it is also why the progress
strip reports real stages instead of an animation.

`pdf` is OPTIONAL throughout. Verification only needs the page TEXT; the PDF is
needed solely to resolve highlight rectangles, which the viewer can fetch
lazily. A deploy that does not keep the uploaded file around still verifies
every quote — it just draws the highlight one call later.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Callable, List, Optional

import contract
import gemini
from pipeline import convert, evaluate, match, normalize, verify

CHUNK_PAGES = 12          # pages per extraction call

StageCb = Callable[[int, str], None]   # (stage index, detail)

STAGES = ["Converting (Word)", "Reading structure", "Checking document type",
          "Scoring bid decision", "Gate check", "Extracting scope lines",
          "Verifying quotes", "Matching catalogue", "Building dashboard"]


class NotScopeDocError(Exception):
    """The upload is not a scope/specification document at all."""

    def __init__(self, doc_type: str, reason: str):
        super().__init__(f"{doc_type}: {reason}")
        self.doc_type = doc_type
        self.reason = reason


# Deterministic fast-reject: documents that are unmistakably something else.
# Checked before any model call so a COI bounces instantly and offline.
_REJECT_PATTERNS = [
    (r"certificate of (liability )?insurance", "certificate of insurance"),
    (r"\bACORD\b", "certificate of insurance (ACORD form)"),
    (r"this certificate is issued as a matter of information", "certificate of insurance"),
    (r"\binvoice\s*(number|no\.?|#)", "invoice"),
    (r"\bremittance advice\b", "remittance advice"),
    (r"curriculum vitae|\bresume\b", "resume / CV"),
]


def _deterministic_reject(first_text: str) -> Optional[str]:
    low = first_text.lower()
    for pat, name in _REJECT_PATTERNS:
        if re.search(pat, low):
            return name
    return None


def doc_gate(page_texts: List[str], use_cache: bool = True) -> None:
    """Raise NotScopeDocError unless this looks like a scope document."""
    head = "\n".join(page_texts[:3])
    hard = _deterministic_reject(head)
    if hard:
        raise NotScopeDocError(hard, "matched an unmistakable non-scope pattern on the first pages")
    try:
        res = gemini.call(contract.gate_prompt(head), contract.GATE_SYSTEM,
                          contract.DocGate, use_cache=use_cache)
    except Exception as exc:  # noqa: BLE001 — never block the pipeline on a gate failure
        gemini.warn(f"document-type gate call failed ({exc}); document passed through unchecked")
        return
    if not res.is_scope_document:
        raise NotScopeDocError(res.doc_type, res.reason)


def doc_id_for(path: Path) -> str:
    return hashlib.sha1(path.read_bytes()).hexdigest()[:12]


# ---------------------------------------------------------------- step 1

def prepare(src: Path) -> dict:
    """Convert if needed, parse, gate. Returns doc meta + page texts."""
    pdf = convert.ensure_pdf(src)
    page_texts, page_sizes = convert.parse_pdf(pdf)
    doc_gate(page_texts)
    return {
        "doc": {
            "id": doc_id_for(pdf),
            "name": src.name,
            "pdf_name": pdf.name,
            "converted": src.suffix.lower() != ".pdf",
            "pages": len(page_texts),
            "page_sizes": page_sizes,
        },
        "page_texts": page_texts,
        "pdf": pdf,
    }


# ---------------------------------------------------------------- step 2

def extract_chunk(page_texts: List[str], start_page: int, count: int,
                  use_cache: bool = True) -> List[dict]:
    """One extraction call over a page window. start_page is 1-based."""
    chunk = page_texts[start_page - 1:start_page - 1 + count]
    res = gemini.call(contract.extract_prompt(chunk, start_page),
                      contract.EXTRACT_SYSTEM, contract.Extraction, use_cache=use_cache)
    return [l.model_dump() for l in res.lines]


# ---------------------------------------------------------------- step 3

def finalize_lines(raw_lines: List[dict], page_texts: List[str],
                   pdf: Optional[Path] = None, use_cache: bool = True) -> List[dict]:
    """Verify, normalize and catalogue-match. All gates here are deterministic."""
    lines: List[dict] = []
    for i, rl in enumerate(raw_lines):
        problems: List[str] = []
        csi, div, csi_problem = normalize.normalize_csi(rl.get("csi_raw", ""))
        if csi_problem:
            problems.append(csi_problem)

        quote = (rl.get("verbatim_quote") or "").strip()
        hint = int(rl.get("page_hint") or 0)
        page = verify.find_quote(quote, page_texts, hint)
        verified = page is not None
        rects: List = []
        if verified:
            rects = verify.quote_rects(pdf, page, quote) if pdf else []
        else:
            page = hint if 1 <= hint <= len(page_texts) else 1
            problems.append("quote not located verbatim in the parsed text")

        resp = rl.get("responsibility")
        resp = resp if resp in ("Landlord", "Tenant") else "Unclear"
        resp_problem = verify.responsibility_check(resp, quote)
        if resp_problem and resp != "Unclear":
            problems.append(resp_problem)
            resp = "Unclear"

        excluded = bool(rl.get("excluded"))
        qty = (rl.get("quantity_stated") or "").strip()
        qty_reason = "not stated in document; quantity comes from drawings"
        if qty:
            if verify.quantity_check(qty, quote):
                qty_reason = "stated verbatim in the quoted sentence"
            else:
                problems.append(f"stated quantity '{qty}' does not appear in the quote; dropped")
                qty = ""
        if excluded:
            qty = ""
            qty_reason = "excluded scope carries no quantity"

        status = "EXCLUDED" if excluded else ("NEEDS REVIEW" if problems else "VERIFIED")
        lines.append({
            "id": f"L{i+1:03d}",
            "csi": csi, "csi_raw": rl.get("csi_raw", ""), "div": div,
            "division": normalize.division_name(div) if div else "Unknown",
            "division_full": normalize.division_full_name(div) if div else "Unknown",
            "summary": (rl.get("scope_summary") or "").strip(),
            "resp": resp,
            "page": page, "rects": rects, "verified": verified,
            "quote": quote,
            "qty": qty, "qty_reason": qty_reason,
            "status": status, "excluded": excluded,
            "review_notes": problems,
        })

    matchable = [l for l in lines if not l["excluded"]]
    ranked = match.rank_all(matchable, use_cache=use_cache)
    for l in lines:
        if l["excluded"]:
            l["match"] = {"state": "excluded", "candidates": [],
                          "gap_reason": "Excluded scope is not matched to the catalogue."}
            continue
        cands = ranked.get(l["id"], [])
        if not cands:
            l["match"] = {"state": "no match", "candidates": [],
                          "gap_reason": match.gap_reason(l["csi"])}
        else:
            state = "alternates only" if l["status"] == "NEEDS REVIEW" else "matched"
            l["match"] = {"state": state, "gap_reason": "",
                          "candidates": [{"name": c["description"], "code": c["code"],
                                          "uom": c["uom"], "why": c["why"], "best": j == 0}
                                         for j, c in enumerate(cands)]}
    return lines


# ------------------------------------------------- whole-pipeline convenience

def analyze(src: Path, scorecard: dict, on_stage: Optional[StageCb] = None,
            use_cache: bool = True, force_scope: bool = False) -> dict:
    """Run every step in order. Used by the local CLI paths and the selftest;
    the browser calls the steps individually so no request runs for minutes."""
    cb = on_stage or (lambda i, d: None)
    gemini.begin_run()

    cb(0, src.name)
    cb(1, src.name)
    cb(2, "is this a scope document?")
    prep = prepare(src)
    pdf, page_texts = prep["pdf"], prep["page_texts"]

    cb(3, f"{scorecard['name']} v{scorecard.get('version', 1)}")
    evaluation = evaluate.evaluate(scorecard, page_texts, pdf, use_cache=use_cache)

    cb(4, evaluation["verdict"])
    gate = evaluation["gate"]
    blocked = gate["enforced"] and not gate["passed"] and not force_scope
    block_reason = ""
    if gate["enforced"] and not gate["passed"]:
        if evaluation["knockouts_triggered"]:
            block_reason = "knockout triggered: " + ", ".join(evaluation["knockouts_triggered"])
        else:
            block_reason = (f"score {evaluation['normalized']} is below the bid threshold "
                            f"({gate['threshold']})")

    lines: Optional[List[dict]] = None
    if not blocked:
        raw: List[dict] = []
        for start in range(1, len(page_texts) + 1, CHUNK_PAGES):
            raw.extend(extract_chunk(page_texts, start, CHUNK_PAGES, use_cache))
            cb(5, f"{min(start + CHUNK_PAGES - 1, len(page_texts))} of {len(page_texts)} pages · {len(raw)} lines")
        cb(6, f"{len(raw)} quotes")
        cb(7, f"{len(raw)} lines against the SAMPLE catalogue")
        lines = finalize_lines(raw, page_texts, pdf, use_cache)

    cb(8, f"{len(lines)} lines" if lines is not None else "skipped — gate")
    return {
        "doc": prep["doc"],
        "evaluation": evaluation,
        "lines": lines,
        "scope_blocked": blocked,
        "scope_block_reason": block_reason,
        "scope_forced": force_scope and gate["enforced"] and not gate["passed"],
        "provenance": gemini.current_provenance(),
        "warnings": gemini.drain_warnings(),
    }
