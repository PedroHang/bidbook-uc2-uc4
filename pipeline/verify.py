"""
verify.py — the quote gate, all deterministic.

A quote the model returns is only believed after it is found as an exact
substring of the parsed document text (whitespace-normalized, punctuation
intact). Location resolves to word-level rectangles via PyMuPDF search so the
viewer can draw the highlight. A quote that cannot be found is NEVER dropped:
the line survives with status NEEDS REVIEW, because a wrong line a human can
see beats a right line silently deleted.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import List, Optional, Tuple

import pymupdf


def _squash(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def _norm_quotes(s: str) -> str:
    """Word smart-quotes vs ASCII must not fail a verbatim check."""
    return (s.replace("’", "'").replace("‘", "'")
             .replace("“", '"').replace("”", '"')
             .replace("–", "-").replace("—", "-"))


def find_quote(quote: str, page_texts: List[str], page_hint: int) -> Optional[int]:
    """Return the 1-based page containing the quote, honouring the hint first."""
    needle = _squash(_norm_quotes(quote))
    if not needle:
        return None
    order = []
    if 1 <= page_hint <= len(page_texts):
        order.append(page_hint - 1)
    order += [i for i in range(len(page_texts)) if i != page_hint - 1]
    for i in order:
        if needle in _squash(_norm_quotes(page_texts[i])):
            return i + 1
    return None


def quote_rects(pdf: Path, page_no: int, quote: str) -> List[Tuple[float, float, float, float]]:
    """Normalized (0..1) rects for the quote on the page. Empty when not locatable.

    search_for caps needle length; long quotes are searched in sentence pieces
    so a three-sentence quote still lights up line by line.
    """
    doc = pymupdf.open(pdf)
    try:
        page = doc[page_no - 1]
        w, h = page.rect.width, page.rect.height
        pieces = [p.strip() for p in re.split(r"(?<=[.;])\s+", _squash(quote)) if len(p.strip()) >= 8]
        if not pieces:
            pieces = [_squash(quote)]
        rects: List[Tuple[float, float, float, float]] = []
        for piece in pieces:
            for r in page.search_for(piece[:400]):
                rects.append((r.x0 / w, r.y0 / h, r.x1 / w, r.y1 / h))
        return rects
    finally:
        doc.close()


def responsibility_check(resp: str, quote: str) -> Optional[str]:
    """Deterministic agreement check between the label and the sentence subject."""
    q = quote.lower()
    landlord = "landlord shall" in q or "by landlord" in q or "landlord's work" in q
    tenant = "tenant shall" in q or "by tenant" in q or "tenant's expense" in q or "tenant's work" in q
    if resp == "Landlord" and tenant and not landlord:
        return "label says Landlord but the sentence subject reads Tenant"
    if resp == "Tenant" and landlord and not tenant:
        return "label says Tenant but the sentence subject reads Landlord"
    if resp in ("Landlord", "Tenant") and not (landlord or tenant):
        return f"label says {resp} but the sentence names no responsible party"
    return None


def quantity_check(quantity: str, quote: str) -> bool:
    """A stated quantity is accepted only if it literally appears in the quote."""
    if not quantity:
        return True
    return _squash(_norm_quotes(quantity)).lower() in _squash(_norm_quotes(quote)).lower()
