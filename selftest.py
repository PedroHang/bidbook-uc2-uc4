"""
selftest.py — acceptance checks, no browser, no live model calls
(the committed cache serves the seed document's responses).

Run:  .venv/bin/python selftest.py
"""

from __future__ import annotations

import json
import re
import sys
from collections import Counter
from pathlib import Path

import pymupdf

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from pipeline import convert, evaluate, normalize, run, scorecard, verify  # noqa: E402

CHECKS = 0
FAILS: list[str] = []


def check(cond: bool, msg: str) -> None:
    global CHECKS
    CHECKS += 1
    if not cond:
        FAILS.append(msg)


def squash(s: str) -> str:
    return re.sub(r"\s+", " ", s.replace("’", "'").replace("“", '"').replace("”", '"')
                  .replace("–", "-").replace("—", "-")).strip()


def main() -> int:
    seed = HERE / "data" / "seed" / "Starbucks 1.docx"

    # --- normalization unit checks (Ray's own sample mixes these forms) ---
    check(normalize.normalize_csi("014000") == ("01 40 00", "01", None), "014000 -> 01 40 00")
    check(normalize.normalize_csi("14100") == ("01 41 00", "01", None), "14100 pads its lost leading zero")
    check(normalize.normalize_csi("09 91 23")[0] == "09 91 23", "already-formatted code passes through")
    check(normalize.normalize_csi("")[2] is not None, "empty code reports a problem")
    check(normalize.normalize_csi("990000")[2] is not None, "inactive division reports a problem")

    # --- full pipeline over the seed (cache-served) ---
    sc = scorecard.current()
    res = run.analyze(seed, sc)
    lines = res["lines"]
    check(lines is not None, "seed passes the bid gate, so scope lines exist")
    doc = res["doc"]
    check(doc["pages"] >= 30, f"seed parsed with a real page count (got {doc['pages']})")
    check(doc["converted"] is True, "seed docx marked as converted")
    check(len(lines) >= 30, f"a real extraction volume (got {len(lines)})")

    pdf = seed.with_suffix(".pdf")
    page_texts, _ = convert.parse_pdf(pdf)

    statuses = Counter(l["status"] for l in lines)
    check(statuses.get("VERIFIED", 0) > 0, "some lines verified")
    check(statuses.get("NEEDS REVIEW", 0) > 0, "some lines need review (honesty state exercised)")

    for l in lines:
        # quote gate: every VERIFIED line's quote is literally on its cited page
        if l["status"] == "VERIFIED":
            check(squash(l["quote"]) in squash(page_texts[l["page"] - 1]),
                  f"{l['id']} verified quote is a page substring")
            check(len(l["rects"]) > 0, f"{l['id']} verified line has highlight rects")
            for r in l["rects"]:
                check(all(0 <= v <= 1 for v in r), f"{l['id']} rects normalized 0..1")
        # quantity gate: a stated quantity literally appears in the quote
        if l["qty"]:
            check(squash(l["qty"]).lower() in squash(l["quote"]).lower(),
                  f"{l['id']} qty '{l['qty']}' appears in its quote")
        # unverified lines carry a reason a human can read
        if l["status"] == "NEEDS REVIEW":
            check(len(l["review_notes"]) > 0, f"{l['id']} review has notes")
        # excluded lines are never matched
        if l["excluded"]:
            check(l["match"]["state"] == "excluded" and not l["match"]["candidates"],
                  f"{l['id']} excluded lines carry no candidates")
        # a match always cites only real catalogue codes, max 3, best first
        cands = l["match"]["candidates"]
        check(len(cands) <= 3, f"{l['id']} at most 3 candidates")
        if cands:
            check(cands[0]["best"] is True, f"{l['id']} first candidate flagged best")
        if l["match"]["state"] == "no match":
            check(l["match"]["gap_reason"] != "", f"{l['id']} gap carries a reason")
        # normalized CSI shape
        if l["csi"]:
            check(re.fullmatch(r"\d\d \d\d \d\d", l["csi"]) is not None, f"{l['id']} csi shape")

    # deliberate catalogue gaps: division 27 has no catalogue lines
    div27 = [l for l in lines if l["div"] == "27" and not l["excluded"]]
    if div27:
        check(all(l["match"]["state"] == "no match" for l in div27),
              "division 27 lines land as catalogue gaps (deliberate absence)")

    # dashboard math: rollups recomputed here must equal a second recomputation
    resp = Counter(l["resp"] for l in lines)
    check(sum(resp.values()) == len(lines), "who-pays counts partition the lines")
    divs = Counter(l["div"] for l in lines)
    check(sum(divs.values()) == len(lines), "division counts partition the lines")

    # scanned-PDF honesty: an image-only PDF is rejected, not half-parsed
    scanned = HERE / "data" / "uploads" / "selftest-scanned.pdf"
    d = pymupdf.open()
    d.new_page(width=612, height=792)
    d.save(scanned)
    d.close()
    try:
        convert.parse_pdf(scanned)
        check(False, "text-free PDF must raise ScannedPdfError")
    except convert.ScannedPdfError:
        check(True, "text-free PDF raises ScannedPdfError")
    finally:
        scanned.unlink(missing_ok=True)

    # ---------------------------------------------------------- UC#4 checks
    ev = res["evaluation"]
    # partition guarantee: human rules never carry model output
    for l in ev["lines"]:
        if l["source"] == "human":
            check(l["score"] is None and l["needs_human"], f"{l['rule_id']} human rule unscored by machines")
        if l["source"] == "document" and l.get("verified"):
            check(squash(l["quote"]) != "", f"{l['rule_id']} verified doc rule carries a quote")
            check(len(l["rects"]) > 0, f"{l['rule_id']} verified doc rule has rects")
    # arithmetic: recompute totals from the lines and compare exactly
    scored = [l for l in ev["lines"] if l["score"] is not None]
    total = round(sum(l["score"] * l["weight"] for l in scored), 1)
    mx = round(sum(5 * l["weight"] for l in scored), 1)
    check(ev["total"] == total, f"evaluation total {ev['total']} == recomputed {total}")
    check(ev["max"] == mx, f"evaluation max {ev['max']} == recomputed {mx} (unscored rules excluded)")
    check(ev["normalized"] == round(total / mx * 100), "normalized matches recomputation")
    check(ev["scored_count"] == len(scored), "scored_count partition")
    # narrative is generated after totals and never carries a number contract violation
    if ev["narrative"]:
        check(ev["narrative"]["generated_after_total"] is True, "narrative flagged post-total")

    # knockout + threshold gate, purely deterministic — no model involved.
    # knockouts live on the LINE snapshot (an evaluation keeps the scorecard it
    # was scored under), so the test arms it there, as a re-run would.
    ko_lines = json.loads(json.dumps(ev["lines"]))
    for l in ko_lines:
        if l["rule_id"] == "project_fit":
            l["knockout"] = {"max_trigger_score": 2}
    agg = evaluate.reaggregate(sc, ko_lines)
    check("Project Fit" in agg["knockouts_triggered"], "knockout triggers on the seed's retail score")
    check(agg["verdict"] == "NO-BID", "knockout forces NO-BID regardless of total")
    check(agg["normalized"] == ev["normalized"], "knockout does not hide the computed score")
    sc3 = json.loads(json.dumps(sc))
    sc3["threshold"] = 95
    agg3 = evaluate.reaggregate(sc3, ev["lines"])
    check(agg3["verdict"] == "NO-BID" and agg3["gate"]["below_threshold"], "threshold gate flips the verdict")
    check(not agg3["gate"]["passed"], "gate reports failed below threshold")

    # scorecard store: save produces a version bump + audit diff; reset restores seed
    scorecard.reset()
    base = scorecard.current()
    edited = json.loads(json.dumps(base))
    edited["rules"][0]["weight"] = 2.5
    edited["threshold"] = 65
    out, changes = scorecard.save(edited, "marcus", "test note")
    check(out["version"] == base.get("version", 1) + 1, "save bumps the version")
    check(len(changes) == 2, f"diff finds exactly the 2 edits (got {len(changes)})")
    log = scorecard.audit_log()
    check(log and log[0]["persona"]["id"] == "marcus", "audit entry carries the persona")
    check(log[0]["changes"] == changes, "audit entry records the server-computed diff")
    bad = json.loads(json.dumps(base))
    bad["rules"][0]["weight"] = 9
    try:
        scorecard.save(bad, "dana")
        check(False, "invalid weight must be rejected")
    except ValueError:
        check(True, "invalid weight rejected")
    scorecard.reset()
    check(scorecard.current().get("version", 1) == base.get("version", 1), "reset restores the seed version")
    check(scorecard.audit_log() == [], "reset clears the audit log")

    # document-type gate: deterministic fast-reject needs no model
    try:
        run.doc_gate(["ACORD CERTIFICATE OF LIABILITY INSURANCE\nThis certificate is issued as a matter of information."], use_cache=True)
        check(False, "COI text must be rejected by the deterministic gate")
    except run.NotScopeDocError as exc:
        check("insurance" in exc.doc_type, "COI rejected with the right doc type")

    # quote verifier is whitespace/smart-quote tolerant but not fuzzy
    check(verify.find_quote("Landlord shall provide", ["a Landlord  shall\nprovide b"], 1) == 1,
          "verifier tolerates whitespace")
    check(verify.find_quote("Landlord will provide", ["a Landlord shall provide b"], 1) is None,
          "verifier rejects paraphrase")

    print(f"{CHECKS} checks, {len(FAILS)} failures")
    for f in FAILS:
        print("  FAIL:", f)
    return 1 if FAILS else 0


if __name__ == "__main__":
    raise SystemExit(main())
