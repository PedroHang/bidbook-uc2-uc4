"""
match.py — the catalogue matching funnel.

Order matters and is the demo's argument: (1) the CSI code is a HARD filter
that collapses the catalogue deterministically (6-digit section, else 4-digit,
else division) BEFORE any semantics runs; (2) the surviving handful is ranked
semantically (one batched Gemini call, lexical-overlap fallback); (3) assembly
is deterministic: top 3 with a why each, or an explicit catalogue-gap state.
Zero candidates after the hard filter is a GAP, never an invented match.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Dict, List, Optional

import contract
import gemini

HERE = Path(__file__).resolve().parent.parent
CATALOGUE = json.loads((HERE / "data" / "sample_catalogue.json").read_text(encoding="utf-8"))["items"]

STOP = set("the a an of and or to in at for with shall be is are by all any per".split())


def hard_filter(csi: Optional[str]) -> List[dict]:
    """csi is 'XX XX XX' or None. Section -> 4-digit level -> division -> []."""
    if not csi:
        return []
    digits = csi.replace(" ", "")
    for prefix_len in (6, 4, 2):
        prefix = digits[:prefix_len]
        hits = [c for c in CATALOGUE if c["csi_section"].replace(" ", "").startswith(prefix)]
        if hits:
            return hits[:8]
    return []


def _tokens(s: str) -> set:
    return {w for w in re.findall(r"[a-z]+", s.lower()) if w not in STOP and len(w) > 2}


def _lexical_rank(line: dict, candidates: List[dict]) -> List[dict]:
    base = _tokens(line["summary"] + " " + line["quote"])
    scored = []
    for c in candidates:
        overlap = base & _tokens(c["description"])
        scored.append((len(overlap), sorted(overlap), c))
    scored.sort(key=lambda t: -t[0])
    out = []
    for n, words, c in scored:
        why = (f"shares '{', '.join(words[:3])}' with the scope text" if n
               else "same CSI filter level only; no description overlap")
        out.append({**c, "why": why})
    return out


def rank_all(lines: List[dict], use_cache: bool = True) -> Dict[str, List[dict]]:
    """line id -> ordered candidate dicts (with 'why'). Model ranks, code assembles."""
    work = []
    pre: Dict[str, List[dict]] = {}
    for l in lines:
        cands = hard_filter(l.get("csi"))
        pre[l["id"]] = cands
        if len(cands) >= 2:
            work.append({
                "id": l["id"], "csi": l.get("csi") or "no code", "summary": l["summary"],
                "quote": l["quote"][:280],
                "candidates": [{"code": c["code"], "description": c["description"], "uom": c["uom"]} for c in cands],
            })

    model_order: Dict[str, contract.Ranking] = {}
    if work:
        try:
            batch = gemini.call(contract.rank_prompt(work), contract.RANK_SYSTEM,
                                contract.RankingBatch, use_cache=use_cache)
            model_order = {r.line_id: r for r in batch.rankings}
        except Exception as exc:  # noqa: BLE001
            gemini.warn(f"catalogue ranking call failed ({exc}); using lexical fallback ordering")

    out: Dict[str, List[dict]] = {}
    for l in lines:
        cands = pre[l["id"]]
        if not cands:
            out[l["id"]] = []
            continue
        r = model_order.get(l["id"])
        if r:
            by_code = {c["code"]: c for c in cands}
            ordered = []
            for code, why in zip(r.ordered_codes, r.why):
                if code in by_code:                      # never accept an invented code
                    ordered.append({**by_code.pop(code), "why": why})
            ordered += _lexical_rank(l, list(by_code.values()))  # anything the model skipped
            out[l["id"]] = ordered[:3]
        else:
            out[l["id"]] = _lexical_rank(l, cands)[:3]
    return out


def gap_reason(csi: Optional[str]) -> str:
    if not csi:
        return "No CSI code on the line, so the hard filter had nothing to filter on."
    digits = csi.replace(" ", "")
    return (f"No catalogue line under section {csi} or its division {digits[:2]}; "
            "flagged for pricing. The hard filter returned zero candidates before "
            "semantic ranking ran, so nothing was invented.")
