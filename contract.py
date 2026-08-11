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
# Document-type gate
# ---------------------------------------------------------------------------

class DocGate(BaseModel):
    """Is this document worth extracting scope lines from at all?"""
    is_scope_document: bool = Field(description="True only if this is a construction scope/specification document: a spec book or project manual, a landlord workletter, an exhibit describing scope of work, or an ITB package that contains scope. False for anything else.")
    doc_type: str = Field(description="Short name for what the document actually is, e.g. 'landlord workletter', 'specification manual', 'certificate of insurance', 'invoice', 'resume', 'lease agreement'.")
    reason: str = Field(description="One sentence, plain language, naming the evidence: what on the first pages says it is (or is not) a scope document.")


GATE_SYSTEM = """You screen documents for a construction bid tool. The tool extracts
scope-of-work lines, so only construction scope/specification documents should
pass: spec books, project manuals, landlord workletters, scope exhibits, ITB
packages containing scope. Everything else is rejected: insurance certificates,
invoices, contracts without scope, resumes, drawings-only sets, marketing PDFs.
Judge ONLY from the text given. When genuinely unsure, pass it through
(is_scope_document=true) and say so in the reason — a false rejection costs
more than a wasted extraction."""


def gate_prompt(first_pages_text: str) -> str:
    return (
        "Classify the document whose opening pages read as follows.\n\n"
        "=== OPENING PAGES ===\n" + first_pages_text[:12000]
    )


# ---------------------------------------------------------------------------
# UC#4 — document-source rule scoring
# ---------------------------------------------------------------------------

class RuleScore(BaseModel):
    """The model's proposal for ONE document-source scorecard rule."""
    rule_id: str = Field(description="The rule id, copied from the input.")
    abstain: bool = Field(default=False, description="True when the document does not answer this rule. Abstaining is correct and expected; never guess.")
    proposed_score: int = Field(default=0, ge=0, le=5, description="1-5 per the rule's anchors. 0 when abstaining.")
    verbatim_quote: str = Field(default="", description="The exact sentence(s) the score is based on, copied verbatim from the document. Empty when abstaining.")
    page_hint: int = Field(default=0, description="1-based page the quote appears on, from the page markers. 0 when abstaining.")
    rationale: str = Field(default="", description="One short sentence: how the quote maps to the anchor chosen (or why abstaining).")


class DocRuleScores(BaseModel):
    scores: List[RuleScore]


SCORE_SYSTEM = """You score a construction bid against a customer's go/no-go scorecard.
You are given ONLY the rules whose answer can come from the document itself.

Hard rules, none negotiable:
- Score each rule 1-5 strictly per its stated anchors. The anchors are the
  customer's rubric, not yours.
- verbatim_quote must be copied EXACTLY from the document text; a machine
  checks it as an exact substring and discards paraphrases.
- If the document does not answer a rule, abstain. Abstention is a correct
  answer, never a failure. Never guess from context or general knowledge.
- Never do arithmetic. Never total anything. Never mention other rules.
- Apply the customer's scoring instructions where given; they refine the
  anchors, they never override the verbatim-quote or abstention rules."""


def score_prompt(rules: List[dict], instructions: str, page_texts: List[str]) -> str:
    parts = ["Score the following rules against the document below.", ""]
    for r in rules:
        parts.append(f"RULE {r['id']}: {r['name']}")
        parts.append(f"  anchors: {r['anchors']}")
    if instructions.strip():
        parts += ["", "CUSTOMER SCORING INSTRUCTIONS:", instructions.strip()]
    parts += ["", "=== DOCUMENT, PAGE-TAGGED ==="]
    for i, t in enumerate(page_texts):
        parts.append(f"=== PAGE {i + 1} ===")
        parts.append(t)
    return "\n".join(parts)


class Narrative(BaseModel):
    pros: List[str] = Field(description="3-5 short bullets FOR pursuing this bid, each grounded in one scored rule.")
    cons: List[str] = Field(description="3-5 short bullets AGAINST, each grounded in one scored rule.")


NARRATIVE_SYSTEM = """You write the pros/cons summary for a bid decision AFTER the score has
been computed. You are given the scored rules and the final verdict. Your text
must agree with the numbers you are given — you never produce or adjust a
number, never state a total, and never contradict the verdict. Each bullet
names the fact from one rule, under 15 words, no fluff."""


def narrative_prompt(lines: List[dict], verdict: str, rating: str) -> str:
    parts = [f"Verdict already computed: {verdict} ({rating}). Scored rules:", ""]
    for l in lines:
        s = "unscored (needs human)" if l.get("needs_human") else f"score {l['score']} x weight {l['weight']}"
        parts.append(f"- {l['name']}: {s}. {l.get('evidence','')}")
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
