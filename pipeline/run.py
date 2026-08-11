"""
run.py — the orchestrator: one document in, the full analyzed state out.

Pipeline order IS the product's argument:
  convert -> parse -> document-type gate -> UC#4 scoring -> bid gate ->
  UC#2 extraction (only if the gate passes or is off or forced).
The cheap decision protects the expensive analysis. Every gate downstream of
the model is deterministic and lives here or in verify.py, never in a prompt.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Callable, List, Optional

import contract
import gemini
from pipeline import convert, evaluate, match, normalize, verify

CHUNK_PAGES = 12          # pages per extraction call; a workletter fits in 3 calls

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


def doc_gate(page_texts: List[str], use_cache: bool) -> None:
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


def analyze(src: Path, scorecard: dict, on_stage: Optional[StageCb] = None,
            use_cache: bool = True, force_scope: bool = False) -> dict:
    cb = on_stage or (lambda i, d: None)
    gemini.begin_run()

    cb(0, src.name)
    pdf = convert.ensure_pdf(src)

    cb(1, pdf.name)
    page_texts, page_sizes = convert.parse_pdf(pdf)

    cb(2, "is this a scope document?")
    doc_gate(page_texts, use_cache)

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
        lines = _extract_scope(pdf, page_texts, cb, use_cache)

    cb(8, f"{len(lines)} lines" if lines is not None else "skipped — gate")
    return {
        "doc": {
            "id": doc_id_for(pdf),
            "name": src.name,
            "pdf_name": pdf.name,
            "converted": src.suffix.lower() != ".pdf",
            "pages": len(page_texts),
            "page_sizes": page_sizes,
        },
        "evaluation": evaluation,
        "lines": lines,
        "scope_blocked": blocked,
        "scope_block_reason": block_reason,
        "scope_forced": force_scope and gate["enforced"] and not gate["passed"],
        "provenance": gemini.current_provenance(),
        "warnings": gemini.drain_warnings(),
    }


def _extract_scope(pdf: Path, page_texts: List[str], cb: StageCb, use_cache: bool) -> List[dict]:
    cb(5, f"0 of {len(page_texts)} pages")
    raw_lines: List[contract.ScopeLine] = []
    for start in range(0, len(page_texts), CHUNK_PAGES):
        chunk = page_texts[start:start + CHUNK_PAGES]
        res = gemini.call(contract.extract_prompt(chunk, start + 1),
                          contract.EXTRACT_SYSTEM, contract.Extraction, use_cache=use_cache)
        raw_lines.extend(res.lines)
        cb(5, f"{min(start + CHUNK_PAGES, len(page_texts))} of {len(page_texts)} pages · {len(raw_lines)} lines")

    cb(6, f"{len(raw_lines)} quotes")
    lines: List[dict] = []
    for i, rl in enumerate(raw_lines):
        problems: List[str] = []
        csi, div, csi_problem = normalize.normalize_csi(rl.csi_raw)
        if csi_problem:
            problems.append(csi_problem)

        page = verify.find_quote(rl.verbatim_quote, page_texts, rl.page_hint)
        verified = page is not None
        rects: List = []
        if verified:
            rects = verify.quote_rects(pdf, page, rl.verbatim_quote)
        else:
            page = rl.page_hint if 1 <= rl.page_hint <= len(page_texts) else 1
            problems.append("quote not located verbatim in the parsed text")

        resp = rl.responsibility if rl.responsibility in ("Landlord", "Tenant") else "Unclear"
        resp_problem = verify.responsibility_check(resp, rl.verbatim_quote)
        if resp_problem and resp != "Unclear":
            problems.append(resp_problem)
            resp = "Unclear"

        qty = rl.quantity_stated.strip()
        qty_reason = "not stated in document; quantity comes from drawings"
        if qty:
            if verify.quantity_check(qty, rl.verbatim_quote):
                qty_reason = "stated verbatim in the quoted sentence"
            else:
                problems.append(f"stated quantity '{qty}' does not appear in the quote; dropped")
                qty = ""
        if rl.excluded:
            qty = ""
            qty_reason = "excluded scope carries no quantity"

        status = "EXCLUDED" if rl.excluded else ("NEEDS REVIEW" if problems else "VERIFIED")
        lines.append({
            "id": f"L{i+1:03d}",
            "csi": csi, "csi_raw": rl.csi_raw, "div": div,
            "division": normalize.division_name(div) if div else "Unknown",
            "division_full": normalize.division_full_name(div) if div else "Unknown",
            "summary": rl.scope_summary.strip(),
            "resp": resp,
            "page": page, "rects": rects, "verified": verified,
            "quote": rl.verbatim_quote.strip(),
            "qty": qty, "qty_reason": qty_reason,
            "status": status, "excluded": rl.excluded,
            "review_notes": problems,
        })

    cb(7, f"{len(lines)} lines against the SAMPLE catalogue")
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
