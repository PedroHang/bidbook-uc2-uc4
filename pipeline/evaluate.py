"""
evaluate.py — the UC#4 evaluation engine.

The structural guarantee of abstention: rules are PARTITIONED by source and
the model is only ever shown the document-source rules. CRM rules are named
queries over the SAMPLE mini-CRM; derived rules are plain arithmetic here;
human rules never touch any engine at all.

All aggregation is deterministic and lives in reaggregate(): totals, max,
normalization, bands, knockouts, verdict, gate. Unscored rules are excluded
from BOTH total and max, so honesty never punishes the score. The narrative
is generated in a second model call AFTER the totals exist.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import List, Optional

import contract
import gemini
from pipeline import verify

HERE = Path(__file__).resolve().parent.parent
CRM = json.loads((HERE / "data" / "sample_crm.json").read_text(encoding="utf-8"))


def _anchors_text(r: dict) -> str:
    return " · ".join(f"{v} = {k}" for k, v in sorted(r["anchors"].items(), reverse=True))


# ---------------------------------------------------------------- engines

def _crm_line(rule: dict) -> dict:
    q = CRM["queries"].get(rule.get("crm_query_key") or "", None)
    if q is None:
        return {"score": None, "needs_human": True,
                "evidence": f"named query '{rule.get('crm_query_key')}' is not registered",
                "proposed_by": "query", "records": []}
    return {"score": q["score"], "needs_human": False,
            "evidence": f"Named query {rule['crm_query_key']} → {q['answer']}",
            "proposed_by": "query", "records": q["records"]}


def _derived_line(rule: dict) -> dict:
    p = CRM["project"]
    key = rule.get("derived_formula_key")
    if key == "bid_timeframe":
        days = int(p["bid_due_days_from_now"])
        weeks = max(1, min(5, days // 7))
        return {"score": weeks, "needs_human": False, "proposed_by": "derived",
                "evidence": f"bid due − today = {days} days → {weeks}-week band", "records": []}
    if key == "distance_to_office":
        miles = float(p["distance_to_nearest_office_miles"])
        inside = miles <= 60
        return {"score": 5 if inside else 2, "needs_human": False, "proposed_by": "derived",
                "evidence": f"distance to nearest office = {miles:.0f} mi → {'within' if inside else 'outside'} 60-mile radius",
                "records": []}
    return {"score": None, "needs_human": True, "proposed_by": "derived",
            "evidence": f"derived formula '{key}' is not registered", "records": []}


def _doc_lines(rules: List[dict], instructions: str, page_texts: List[str],
               pdf: Path, use_cache: bool) -> dict:
    """One model call for ALL document rules; verify every quote server-side."""
    if not rules:
        return {}
    payload = [{"id": r["id"], "name": r["name"], "anchors": _anchors_text(r)} for r in rules]
    out: dict = {}
    try:
        res = gemini.call(contract.score_prompt(payload, instructions, page_texts),
                          contract.SCORE_SYSTEM, contract.DocRuleScores, use_cache=use_cache)
        by_id = {s.rule_id: s for s in res.scores}
    except Exception as exc:  # noqa: BLE001 — every doc rule falls to human, visibly
        gemini.warn(f"document-rule scoring call failed ({exc}); rules fall to human entry")
        by_id = {}
    for r in rules:
        s = by_id.get(r["id"])
        if s is None or s.abstain or not (1 <= s.proposed_score <= 5):
            reason = (s.rationale or "no evidence found in the document") if s else "no answer from the model"
            out[r["id"]] = {"score": None, "needs_human": True, "proposed_by": "model",
                            "evidence": f"Abstained: {reason}", "quote": "", "page": 0,
                            "rects": [], "verified": False, "records": []}
            continue
        page = verify.find_quote(s.verbatim_quote, page_texts, s.page_hint)
        if page is None:
            out[r["id"]] = {"score": None, "needs_human": True, "proposed_by": "model",
                            "evidence": "Proposed score discarded: quote not found verbatim in the document",
                            "quote": s.verbatim_quote, "page": s.page_hint or 0,
                            "rects": [], "verified": False, "records": []}
            continue
        rects = verify.quote_rects(pdf, page, s.verbatim_quote)
        out[r["id"]] = {"score": s.proposed_score, "needs_human": False, "proposed_by": "model",
                        "evidence": s.rationale or "scored from the quoted passage",
                        "quote": s.verbatim_quote, "page": page, "rects": rects,
                        "verified": True, "records": []}
    return out


# ------------------------------------------------------------- aggregate

def reaggregate(sc: dict, lines: List[dict]) -> dict:
    """Deterministic: totals, max over scored rules only, band, knockouts, verdict, gate."""
    scored = [l for l in lines if l.get("score") is not None and l.get("active", True)]
    total = sum(l["score"] * l["weight"] for l in scored)
    mx = sum(5 * l["weight"] for l in scored)
    normalized = round(total / mx * 100) if mx else 0
    band = "PASS"
    for b in sorted(sc.get("bands", []), key=lambda b: -b["min"]):
        if normalized >= b["min"]:
            band = b["label"]
            break
    knockouts = [l["name"] for l in scored
                 if l.get("knockout") and l["score"] <= l["knockout"]["max_trigger_score"]]
    below = normalized < sc.get("threshold", 0)
    verdict = "NO-BID" if (knockouts or below) else "BID"
    return {
        "total": round(total, 1), "max": round(mx, 1), "normalized": normalized,
        "rating": band, "verdict": verdict,
        "scored_count": len(scored), "rule_count": len([l for l in lines if l.get("active", True)]),
        "knockouts_triggered": knockouts,
        "gate": {"threshold": sc.get("threshold", 0), "enforced": bool(sc.get("gate_enforced")),
                 "below_threshold": below,
                 "passed": not (knockouts or below)},
    }


def narrative_for(lines: List[dict], agg: dict, use_cache: bool) -> Optional[dict]:
    try:
        res = gemini.call(contract.narrative_prompt(lines, agg["verdict"], agg["rating"]),
                          contract.NARRATIVE_SYSTEM, contract.Narrative, use_cache=use_cache)
        return {"pros": res.pros, "cons": res.cons, "generated_after_total": True}
    except Exception as exc:  # noqa: BLE001
        gemini.warn(f"narrative call failed ({exc}); verdict shown without pros/cons")
        return None


# ------------------------------------------------------------- top level

def evaluate(sc: dict, page_texts: List[str], pdf: Path, use_cache: bool = True) -> dict:
    rules = [r for r in sc["rules"] if r.get("active")]
    doc_rules = [r for r in rules if r["source"] == "document"]
    doc_scored = _doc_lines(doc_rules, sc.get("instructions", ""), page_texts, pdf, use_cache)

    lines: List[dict] = []
    for r in rules:
        base = {
            "rule_id": r["id"], "name": r["name"], "source": r["source"],
            "weight": r["weight"], "anchors": _anchors_text(r),
            "knockout": r.get("knockout"), "active": True,
            "scored_by": None,          # persona id when a human taps a score
            "quote": "", "page": 0, "rects": [], "verified": False, "records": [],
        }
        if r["source"] == "document":
            base.update(doc_scored[r["id"]])
        elif r["source"] == "crm":
            base.update(_crm_line(r))
        elif r["source"] == "derived":
            base.update(_derived_line(r))
        else:
            base.update({"score": None, "needs_human": True, "proposed_by": "human",
                         "evidence": "The model never sees this rule. Tap a score."})
        lines.append(base)

    agg = reaggregate(sc, lines)
    return {
        "scorecard_id": sc["id"], "scorecard_name": sc["name"],
        "scorecard_version": sc.get("version", 1),
        "weights_snapshot": {r["id"]: r["weight"] for r in rules},
        "instructions_snapshot": sc.get("instructions", ""),
        "lines": lines,
        **agg,
        "narrative": narrative_for(lines, agg, use_cache),
    }
