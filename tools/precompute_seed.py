"""
precompute_seed.py — bake the sample document's full analysis into
data/precomputed/seed.json.

That file is what /api/seed returns, so a fresh deploy demos instantly with no
API key and no model call. It is a REAL run (served from the committed response
cache), not hand-authored output: re-run this whenever the pipeline, the prompts
or the seed scorecard change.

    .venv/bin/python tools/precompute_seed.py
"""

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

from pipeline import convert, run, scorecard  # noqa: E402

SEED = HERE / "data" / "seed" / "Starbucks 1.docx"
OUT = HERE / "data" / "precomputed" / "seed.json"


def main() -> int:
    sc = scorecard.seed()
    res = run.analyze(SEED, sc, on_stage=lambda i, d: print(f"  stage {i}: {d}"))
    pdf = SEED.with_suffix(".pdf")
    res["page_texts"], _ = convert.parse_pdf(pdf)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(res), encoding="utf-8")
    ev = res["evaluation"]
    print(f"wrote {OUT.relative_to(HERE)}  "
          f"({OUT.stat().st_size // 1024} KB, {len(res['lines'] or [])} scope lines, "
          f"bid {ev['verdict']} {ev['normalized']}/100)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
