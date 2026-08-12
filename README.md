# Scope IQ — BidBook UC#2 / UC#4 demo

One FastAPI + vanilla-JS app, two tabs:

- **Scope Intelligence (UC#2, working)** — upload a specification (.docx or .pdf)
  and it becomes a grounded, categorized, catalogue-matched scope table with an
  intelligence dashboard: CSI-division donut, who-pays split, catalogue coverage,
  filters wired to every chart, and a document viewer that opens on the cited
  page with the quoted sentence highlighted.
- **Bid Decision (UC#4, working)** — the customer-owned go/no-go scorecard,
  seeded with the customer's real spreadsheet rows. Live evaluation with four
  rule sources (AI-with-quote / CRM named query / derived code / human one-tap),
  a setup mode with draggable weights and a live what-if against a SAMPLE
  portfolio, per-rule knockouts, a bid threshold that gates the scope
  analysis, a confirm-with-consequences save, and a persona-attributed audit
  log. An upload is scored FIRST; only bids that clear the gate reach the
  expensive extraction (with an explicit "Run anyway" override).

---

## Quick start

### What you need

| Requirement | Why | Check it |
| --- | --- | --- |
| **Python 3.11+** | runs the server | `python3 --version` (Windows: `py --version`) |
| **LibreOffice, with the Writer module** | converts .docx uploads to PDF | `soffice --version` |
| **A Gemini API key** *(optional for the seed)* | live extraction on new uploads | free at <https://aistudio.google.com/apikey> |

The committed response cache covers the seed document, so the app boots and
demos **without any API key**. The key is only needed for the "Run live" reset
and for uploading documents the cache has never seen.

### 1. Clone and install

**Linux / macOS**
```bash
git clone https://github.com/PedroHang/bidbook-uc2-uc4
cd bidbook-uc2-uc4
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

**Windows (PowerShell)**
```powershell
git clone https://github.com/PedroHang/bidbook-uc2-uc4
cd bidbook-uc2-uc4
py -m venv .venv
.venv\Scripts\pip install -r requirements.txt
```

### 2. Install LibreOffice (for .docx conversion)

- **Windows / macOS:** install from <https://www.libreoffice.org/download/> —
  the default install includes Writer. Make sure `soffice` is on PATH
  (Windows default: `C:\Program Files\LibreOffice\program`; add that folder to
  PATH or the conversion call will not find it).
- **Debian/Ubuntu:** `sudo apt-get install libreoffice-writer`
  (the bare `libreoffice-core` package is NOT enough — without the Writer
  module the converter fails with "source file could not be loaded").
- Verify: `soffice --headless --convert-to pdf <any .docx>` produces a PDF.

Skipping this is fine if you will only ever upload PDFs: the seed's converted
PDF is committed, and PDF uploads never touch LibreOffice.

### 3. Set the API key (optional but recommended)

Either export it:

```bash
export GEMINI_API_KEY=your-key        # PowerShell: $env:GEMINI_API_KEY="your-key"
```

or create a `.env` file in the repo root (git-ignored):

```
GEMINI_API_KEY=your-key
```

A key already exported in the shell wins over the file. `GOOGLE_API_KEY` is
accepted as an alias. The model used is `gemini-3.1-pro-preview`
(set in `contract.py: MODEL`; if Google retires it, pick a current one from
`client.models.list()` and update that one constant).

### 4. Run locally

**Linux / macOS**
```bash
.venv/bin/uvicorn app:app --host 127.0.0.1 --port 8023
```

**Windows (PowerShell)**
```powershell
.venv\Scripts\uvicorn app:app --host 127.0.0.1 --port 8023
```

Open **<http://localhost:8023>**. On first paint the seed document
(`data/seed/Starbucks 1.docx`, the real UC#2 sample) is already analyzed —
served from the committed cache, fast and free. The progress strip you see on
a fresh boot is the real pipeline, not an animation.

### 5. Verify the install

```bash
.venv/bin/python selftest.py          # Windows: .venv\Scripts\python selftest.py
```

Expected: `485 checks, 0 failures` (count grows as lines change), no browser,
no live calls, done in under a minute.

### 6. Deploy to Vercel

```bash
npm i -g vercel
vercel            # first run links the project
vercel --prod
```

Nothing else to configure. `vercel.json` sends `/api/*` to the Python function
in `api/index.py` and lets Vercel's CDN serve `public/` directly.

**The deployed app works with no API key at all.** `data/precomputed/seed.json`
holds a real, committed run of the sample document, so first paint is instant
and every interactive beat — grounded citations with highlights, the dashboard
and its filters, the scorecard, weight drags, knockouts, the gate, the audit
log — works with zero model calls.

Set `GEMINI_API_KEY` in the Vercel project's environment variables to enable
**uploads and re-scoring** on the hosted app. Two hosted-only limits, both
stated honestly in the UI rather than hidden:

| Limit | Why | What happens |
| --- | --- | --- |
| **PDF uploads only** | LibreOffice is not available in the serverless runtime | A `.docx` upload returns a clear message telling you to send a PDF or run locally |
| **No durable cache** | the deployment bundle is read-only | Responses cache per warm instance only; "Run live" says there is nothing durable to clear |

Regenerate the precomputed seed whenever the pipeline, the prompts or the seed
scorecard change, then redeploy:

```bash
.venv/bin/python tools/precompute_seed.py
```

---

## Architecture note: why the server holds no state

Every endpoint is a pure function of its request plus the read-only bundled
data. **The browser owns the analysis result, the scorecard and the audit log**
(the latter two in `localStorage`), and it drives the pipeline one call at a
time: `prepare → evaluate → [gate] → extract × N → finalize`. The progress
strip reports the step that actually just finished.

This is what makes serverless hosting possible — a background thread would die
when the response returns, and an in-process dict would not survive to the next
request. It also removed a 5-second polling loop that replaced the whole view
mid-scroll, which is why the page no longer jumps back to the top while you
read. Scrollable regions additionally carry a `data-scroll-key` and their
offsets are restored across re-renders.

Uploaded PDFs are cached in the OS temp dir only so page images and highlight
rectangles can be produced without re-uploading. A cold serverless instance
simply misses that cache and the browser re-posts the file to `/api/rehydrate`.
**Quote verification never depends on it** — verification runs against the page
text, so highlights are the only thing that can arrive one call later.

---

## Using the demo

- **Upload specification** (button, or drag a file anywhere onto the top bar):
  accepts `.docx` and `.pdf`. A document-type gate screens uploads first:
  obvious non-scope documents (insurance certificates, invoices, resumes) are
  rejected with a plain explanation before any scoring or extraction runs. Word files convert to PDF server-side so every
  citation has a page number and one viewer serves both formats. New documents
  run live against Gemini (~2-4 min for a 36-page manual, 3 extraction calls +
  1 ranking call); re-analyzing a known document is instant (cache).
- **Click any row** to expand it: verbatim quote, quantity reasoning, and the
  top-3 SAMPLE catalogue candidates or an explicit catalogue-gap card.
- **Click the “ p.N source button** to open the document viewer on the cited
  page with the sentence highlighted. Zoom (50-300%), Fit width, Expand.
- **Click any chart segment or stat tile** to filter the table; active filters
  show as dismissible chips.
- **Run live** (top right of the bar) / the gear icon: clears the model-response
  cache, drops uploads, reseeds, and re-runs the sample against the model for
  real. Use it once before a call so you can honestly say the run is live.
- **CACHED / LIVE RUN chip** in the bar states the current run's provenance.

### Demo tips

- Rehearse once with an upload in place, not only the clean seed.
- The scanned-PDF refusal is a feature: feed it an image-only PDF and it
  explains why it extracted nothing rather than guessing.
- Everything labeled SAMPLE is fabricated (the catalogue, the mini-CRM, the
  derived-formula inputs, the 14-bid portfolio). The document, every quote from
  it, and the scorecard rows themselves are real.
- The strongest UC#4 beat: drag a weight in Scorecard setup and watch the
  what-if panel; then arm a knockout or raise the threshold, save, re-score,
  and show the scope tab blocked by the gate — with the Run-anyway override.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `.docx` upload fails: "LibreOffice could not convert" | LibreOffice missing or Writer module absent. Install per step 2; on Linux specifically `libreoffice-writer`. Verify `soffice` is on PATH. |
| "This PDF has no text layer — it looks scanned" | Deliberate refusal, not a bug: without selectable text there is nothing to quote or cite. Send a digital PDF or the original Word file. |
| Upload stuck / "already processing a document" | One document at a time by design. Wait for the progress strip to finish; it survives ~2-4 min on a large live run. |
| `RuntimeError: No GEMINI_API_KEY set and no cache entry` | You uploaded a new document with no key configured. Do step 3. |
| `404 ... model ... is no longer available` in warnings | Google retired the pinned model. Update `MODEL` in `contract.py` (one line). |
| Port 8023 busy | `--port 8024` (any free port works; nothing else pins 8023). |
| First boot shows the progress strip for minutes | The cache is absent (fresh key, or after Run live), so the seed is running live. Subsequent boots are instant. |
| Blank page / stale UI after pulling changes | Hard-refresh (Ctrl+F5); the front end is static files, the browser may cache them. |
| Hosted: `.docx` upload refused | Expected — no LibreOffice in the serverless runtime. Send a PDF, or run locally. |
| Hosted: a page image fails to load | The instance never saw that upload; the browser re-posts it to `/api/rehydrate` and retries once automatically. |
| Hosted: upload times out on a very large document | Each extraction window is one function call. Lower `extract_chunk_pages` in `server.py`'s bootstrap, or raise `maxDuration` in `vercel.json` (needs a paid plan). |
| Scorecard edits or audit entries reappear/disappear | They live in the browser's `localStorage`, per browser. The gear button restores the seed and clears them. |

---

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

## Layout

```
app.py                  local runner: the API below + the front end from public/
server.py               the stateless API — every endpoint a pure function
api/index.py            Vercel entry point (same app, /api/* only)
vercel.json             function config + /api routing; public/ is served by the CDN
contract.py             model schemas + prompts (PROMPT_VERSION keys the cache; MODEL lives here)
gemini.py               model layer: live Interactions call + response cache + .env loading
pipeline/convert.py     docx -> PDF (LibreOffice), PDF -> page text (PyMuPDF)
pipeline/normalize.py   CSI code hygiene + MasterFormat divisions
pipeline/verify.py      quote gate, highlight rects, responsibility + quantity checks
pipeline/match.py       catalogue funnel: hard filter -> semantic rank -> top 3 / gap
pipeline/run.py         orchestrator: doc-type gate -> UC#4 scoring -> bid gate -> extraction
pipeline/evaluate.py    UC#4 engine: rule partition by source, deterministic aggregation
pipeline/scorecard.py   scorecard store: seed + runtime versioning + server-side diff audit
public/                 vanilla JS front end (no framework, no build, no CDN)
data/seed/              the real sample document (.docx + its converted .pdf)
data/sample_catalogue.json  fabricated SAMPLE price book (no prices), see gen_catalogue.py
data/scorecard_seed.json    the customer's real scorecard rows (seed; runtime edits go to data/runtime/)
data/sample_crm.json        fabricated SAMPLE mini-CRM + derived-formula inputs
data/sample_portfolio.json  fabricated SAMPLE 14-bid portfolio for the what-if panel
cache/                  committed model-response cache for the seed run
data/precomputed/seed.json  a real committed run of the sample; what /api/seed serves
tools/precompute_seed.py    regenerates it
selftest.py             acceptance checks
```

## HTTP surface

```
GET  /            the app
GET  /state       full app state (doc, evaluation, scope lines, scorecard, audit, portfolio)
POST /upload      multipart file -> background analysis (poll /state)
POST /reset       clear cache + uploads, restore seed scorecard + audit, re-run live
GET  /page        ?doc=<id>&n=<page>&scale=<1..3> -> rendered page PNG
PUT  /scorecard   save scorecard changes {scorecard, persona, flips_note} -> version bump + audit
POST /evaluation/score    one-tap human score {rule_id, score|null, persona}
POST /evaluation/rerun    re-score the current document under the current scorecard
POST /scope/run-anyway    run the scope extraction although the bid gate failed
```
