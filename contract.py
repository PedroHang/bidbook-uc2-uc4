"""
contract.py — the shapes the model must fill, and the prompts that ask for them.

PROMPT_VERSION participates in every cache key, so editing a prompt here
invalidates exactly the cached responses that prompt produced and nothing else.
"""

from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, Field

PROMPT_VERSION = "uc2-v1"
MODEL = "gemini-3.1-pro-preview"
THINKING_LEVEL = "low"
MAX_OUTPUT_TOKENS = 16384


# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------

class ScopeLine(BaseModel):
    """One obligation pulled out of the specification."""
    csi_raw: str = Field(description="The CSI/MasterFormat code exactly as printed in the document for this scope row, e.g. '033000' or '09 91 23'. Empty string if the document states no code for it.")
    scope_summary: str = Field(description="One or two sentences, plain language: what the obligation is. Never invent detail that is not in the document.")
    responsibility: str = Field(description="Who pays / performs: 'Landlord', 'Tenant', or 'Unclear' when the sentence names neither.")
    verbatim_quote: str = Field(description="The exact sentence(s) this line is based on, copied verbatim from the document text, including punctuation. Never paraphrase. Never abbreviate with ellipses.")
    page_hint: int = Field(description="1-based page number the quote appears on, from the page markers in the input.")
    quantity_stated: str = Field(default="", description="A quantity ONLY if the document literally states one inside the quoted sentence (e.g. 'two (2)', '400 amp', 'R-13'). Empty string otherwise. Never compute or infer.")
    excluded: bool = Field(default=False, description="True when the document explicitly marks this scope N/A / excluded / not part of the Work.")


class Extraction(BaseModel):
    lines: List[ScopeLine]


EXTRACT_SYSTEM = """You extract scope-of-work lines from construction specification documents
(landlord workletters, project manuals, exhibits) for a bid-management tool.

Hard rules, none negotiable:
- verbatim_quote must be copied EXACTLY from the document text. It will be
  checked as an exact substring by a machine; a paraphrase is discarded.
- Never state a quantity unless the document literally states it inside the
  quoted sentence. Quantities otherwise come from drawings, not from you.
- Never do arithmetic. Never total anything.
- responsibility comes from the sentence's own subject (who "shall" do it).
  If the sentence names nobody, say Unclear. Never guess from context.
- One line per distinct scope obligation. Table rows are usually one line each.
- Skip pure boilerplate (insurance certificates, plan-review procedure,
  signatures) unless it creates a priced scope obligation.
- If a row is explicitly N/A or excluded, still return it with excluded=true;
  exclusions are scope intelligence too."""


def extract_prompt(page_texts: List[str], first_page: int) -> str:
    parts = [
        "Extract every scope-of-work line from the following specification pages.",
        "Pages are delimited by '=== PAGE N ===' markers; page_hint must be the N of the page the quote sits on.",
        "",
    ]
    for i, t in enumerate(page_texts):
        parts.append(f"=== PAGE {first_page + i} ===")
        parts.append(t)
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Catalogue ranking
# ---------------------------------------------------------------------------

class Ranking(BaseModel):
    line_id: str = Field(description="The id of the scope line being ranked, copied from the input.")
    ordered_codes: List[str] = Field(description="Catalogue item codes from that line's candidate list, best match first, worst last. Only codes from the candidate list; never invent a code.")
    why: List[str] = Field(description="One short sentence per code, same order, saying why it matches or does not. Reference words shared with the scope text.")


class RankingBatch(BaseModel):
    rankings: List[Ranking]


RANK_SYSTEM = """You rank price-catalogue candidates against extracted scope lines for a
construction estimating tool. The candidate lists were pre-filtered by CSI code
in deterministic code; your only job is semantic order within each list.
Never add codes that are not in the candidate list. Never mention prices
(there are none). Keep each 'why' under 20 words."""


def rank_prompt(items: List[dict]) -> str:
    parts = [
        "For each scope line below, rank its candidate catalogue items best-first.",
        "",
    ]
    for it in items:
        parts.append(f"LINE {it['id']}: [{it['csi']}] {it['summary']}")
        parts.append(f"  quote: {it['quote']}")
        for c in it["candidates"]:
            parts.append(f"  candidate {c['code']}: {c['description']} (uom {c['uom']})")
        parts.append("")
    return "\n".join(parts)
