"""
normalize.py — CSI MasterFormat code hygiene, all deterministic.

Real documents are sloppy about their own codes: Ray's sample mixes six-digit
('014000') and five-digit ('14100') forms in one table. Normalization pads a
five-digit code with a leading zero (the dropped character is always the
leading zero of division 01..09), formats to 'XX XX XX', and resolves the
division name from the bundled MasterFormat 2020 table so it works offline.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Optional, Tuple

HERE = Path(__file__).resolve().parent.parent
_MF = json.loads((HERE / "data" / "masterformat_2020.json").read_text(encoding="utf-8"))
DIVISIONS: dict[str, str] = dict(_MF.get("active_divisions", {}))

# short display names for tight table cells; anything absent falls back to full
SHORT = {
    "01": "General Reqs.", "02": "Existing Cond.", "03": "Concrete", "04": "Masonry",
    "05": "Metals", "06": "Wood & Plastics", "07": "Thermal & Moist.", "08": "Openings",
    "09": "Finishes", "10": "Specialties", "11": "Equipment", "12": "Furnishings",
    "13": "Special Constr.", "14": "Conveying", "21": "Fire Suppression", "22": "Plumbing",
    "23": "HVAC", "25": "Integrated Autom.", "26": "Electrical", "27": "Communications",
    "28": "Safety & Security", "31": "Earthwork", "32": "Exterior Impr.", "33": "Utilities",
}


def normalize_csi(raw: str) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    """raw -> (formatted 'XX XX XX', division number, problem or None)."""
    digits = re.sub(r"\D", "", raw or "")
    if not digits:
        return None, None, "no CSI code stated in the document for this line"
    if len(digits) == 5:
        digits = "0" + digits          # '14100' -> '014100': the lost leading zero
    if len(digits) == 4:
        digits = digits + "00"         # section stated at 4 digits
    if len(digits) != 6:
        return None, None, f"code '{raw}' does not normalize to six digits"
    div = digits[:2]
    if div not in DIVISIONS:
        return None, None, f"division {div} is not an active MasterFormat 2020 division"
    formatted = f"{digits[0:2]} {digits[2:4]} {digits[4:6]}"
    return formatted, div, None


def division_name(div: str) -> str:
    return SHORT.get(div) or DIVISIONS.get(div, "Other")


def division_full_name(div: str) -> str:
    return DIVISIONS.get(div, "Other")
