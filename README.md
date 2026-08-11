# Scope IQ — BidBook UC#2 / UC#4 demo

One FastAPI + vanilla-JS app, two tabs:

- **Scope Intelligence (UC#2, working)** — upload a specification (.docx or .pdf)
  and it becomes a grounded, categorized, catalogue-matched scope table with an
  intelligence dashboard: CSI-division donut, who-pays split, catalogue coverage,
  filters wired to every chart, and a document viewer that opens on the cited
  page with the quoted sentence highlighted.
- **Bid Decision (UC#4, static preview this batch)** — the designed evaluation
  view of the customer-owned scorecard, seeded with the customer's real
  spreadsheet (52.5 / 70 = 75, HIGH PRIORITY, BID). The interactive build
  (editable weights, knockouts, gate, audit log) is the next batch.

## Trust architecture (carried over from the UC#1 demo)

- Every extracted line carries a **verbatim quote**; the server verifies it as an
  exact substring of the parsed text and resolves word-level highlight
  rectangles. A quote that fails lands as **NEEDS REVIEW**, never silently dropped.
- The **quantity column stays blank** unless the number is literally inside the
  verified quote. Quantities come from drawings, not from a language model.
- **The model never does arithmetic.** Every dashboard figure is recomputed from
  the lines in plain code (client-side, inspectable).
- Catalogue matching is a funnel: **CSI hard filter first** (deterministic),
  semantic ranking second, and an explicit **catalogue gap** state when the
  filter returns nothing. The catalogue is fabricated and labeled SAMPLE;
  it contains no prices.

## Run

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
# needs LibreOffice for .docx conversion:  apt-get install libreoffice-writer
export GEMINI_API_KEY=...        # optional: the committed cache serves the seed run
.venv/bin/uvicorn app:app --host 127.0.0.1 --port 8023
# open http://localhost:8023
```

The seed document (`data/seed/Starbucks 1.docx`, the real UC#2 sample) is
analyzed at startup — from the committed response cache when present, so first
paint is fast and free. **Run live** (gear / button) clears the cache, drops
uploads and re-runs everything against the model.

## Self-test

```bash
.venv/bin/python selftest.py     # 450+ checks, no browser, no live calls
```

Covers: CSI normalization (including the five-digit codes in the real sample),
the verbatim-quote gate, highlight rect sanity, the quantity gate, review-note
presence, catalogue-gap reasons, deliberate catalogue absences (division 27),
rollup partition math, and the scanned-PDF refusal.

## Layout

```
app.py                  FastAPI server, port 8023 (+ the static Bid Decision data)
contract.py             model schemas + prompts (PROMPT_VERSION keys the cache)
gemini.py               model layer: live Interactions call + response cache
pipeline/convert.py     docx -> PDF (LibreOffice), PDF -> page text (PyMuPDF)
pipeline/extract.py     (in run.py) chunked extraction
pipeline/normalize.py   CSI code hygiene + MasterFormat divisions
pipeline/verify.py      quote gate, highlight rects, responsibility + quantity checks
pipeline/match.py       catalogue funnel: hard filter -> semantic rank -> top 3 / gap
pipeline/run.py         orchestrator with stage callbacks
static/                 vanilla JS front end (no framework, no build, no CDN)
data/seed/              the real sample document
data/sample_catalogue.json  fabricated SAMPLE price book (no prices), see gen_catalogue.py
cache/                  committed model-response cache for the seed run
selftest.py             acceptance checks
```
