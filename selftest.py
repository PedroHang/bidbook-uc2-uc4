"""
selftest.py — acceptance checks, no browser, no live model calls
(the committed cache serves the seed document's responses).

Run:  .venv/bin/python selftest.py
"""

from __future__ import annotations

import re
import sys
from collections import Counter
from pathlib import Path

import pymupdf

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from pipeline import convert, normalize, run, verify  # noqa: E402

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
    res = run.analyze(seed)
    lines = res["lines"]
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
