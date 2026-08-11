"""
run.py — the orchestrator: one document in, the full analyzed state out.

Stages are reported through a callback so the UI's progress strip shows what
is actually happening rather than an animation. Every gate downstream of the
model is deterministic and lives here or in verify.py, never in a prompt.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Callable, List, Optional

import contract
import gemini
from pipeline import convert, match, normalize, verify

CHUNK_PAGES = 12          # pages per extraction call; a workletter fits in 2-3 calls

StageCb = Callable[[int, str], None]   # (stage index, detail)

STAGES = ["Converting (Word)", "Reading structure", "Extracting scope lines",
          "Verifying quotes", "Matching catalogue", "Building dashboard"]


def doc_id_for(path: Path) -> str:
    return hashlib.sha1(path.read_bytes()).hexdigest()[:12]


def analyze(src: Path, on_stage: Optional[StageCb] = None, use_cache: bool = True) -> dict:
    cb = on_stage or (lambda i, d: None)
    gemini.begin_run()

    # 1 — convert
    cb(0, src.name)
    pdf = convert.ensure_pdf(src)

    # 2 — parse
    cb(1, pdf.name)
    page_texts, page_sizes = convert.parse_pdf(pdf)

    # 3 — extract (chunked on page boundaries, page-tagged text)
    cb(2, f"0 of {len(page_texts)} pages")
    raw_lines: List[contract.ScopeLine] = []
    for start in range(0, len(page_texts), CHUNK_PAGES):
        chunk = page_texts[start:start + CHUNK_PAGES]
        res = gemini.call(contract.extract_prompt(chunk, start + 1),
                          contract.EXTRACT_SYSTEM, contract.Extraction, use_cache=use_cache)
        raw_lines.extend(res.lines)
        cb(2, f"{min(start + CHUNK_PAGES, len(page_texts))} of {len(page_texts)} pages · {len(raw_lines)} lines")

    # 4 — verify + normalize, all deterministic
    cb(3, f"{len(raw_lines)} quotes")
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
                qty_reason = f"stated verbatim in the quoted sentence"
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

    # 5 — catalogue funnel
    cb(4, f"{len(lines)} lines against the SAMPLE catalogue")
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

    # 6 — done; the dashboard is computed FROM these lines, client-side, in code
    cb(5, f"{len(lines)} lines")
    return {
        "doc": {
            "id": doc_id_for(pdf),
            "name": src.name,
            "pdf_name": pdf.name,
            "converted": src.suffix.lower() != ".pdf",
            "pages": len(page_texts),
            "page_sizes": page_sizes,
        },
        "lines": lines,
        "provenance": gemini.current_provenance(),
        "warnings": gemini.drain_warnings(),
    }
