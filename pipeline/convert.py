"""
convert.py — every uploaded document becomes a PDF, the canonical artifact.

Word files go through LibreOffice headless. The PDF is what the viewer renders
and what page numbers cite, so citations survive the format boundary. A PDF
with no text layer is rejected honestly (scanned), never OCR'd silently.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import List, Tuple

import pymupdf

LO_PROFILE = "file:///tmp/loprofile"


class ScannedPdfError(Exception):
    """The PDF has no usable text layer; there is nothing to quote or cite."""


class ConversionError(Exception):
    pass


def ensure_pdf(src: Path) -> Path:
    """Return a PDF path for src, converting .docx via LibreOffice when needed."""
    if src.suffix.lower() == ".pdf":
        return src
    if src.suffix.lower() not in (".docx", ".doc"):
        raise ConversionError(f"unsupported file type: {src.suffix}")
    out = src.with_suffix(".pdf")
    if out.exists() and out.stat().st_mtime >= src.stat().st_mtime:
        return out
    proc = subprocess.run(
        ["soffice", f"-env:UserInstallation={LO_PROFILE}", "--headless",
         "--convert-to", "pdf", "--outdir", str(src.parent), str(src)],
        capture_output=True, text=True, timeout=240,
    )
    if not out.exists():
        raise ConversionError(
            f"LibreOffice could not convert {src.name}: {proc.stderr.strip() or proc.stdout.strip()}"
        )
    return out


def parse_pdf(pdf: Path) -> Tuple[List[str], List[Tuple[float, float]]]:
    """Return (page texts, page sizes). Raises ScannedPdfError on no text layer."""
    doc = pymupdf.open(pdf)
    texts = [page.get_text() for page in doc]
    sizes = [(page.rect.width, page.rect.height) for page in doc]
    doc.close()
    if sum(len(t.strip()) for t in texts) < 40 * max(1, len(texts)) // 4:
        raise ScannedPdfError(f"{pdf.name} has essentially no text layer")
    return texts, sizes
