"""
scorecard.py — the customer-owned scorecard: storage, versioning, audit.

The seed (data/scorecard_seed.json) mirrors the customer's real spreadsheet
and is committed read-only. Runtime edits are written to data/runtime/ so a
git checkout stays clean; /reset restores the seed and clears the audit log.

Every save produces audit entries computed by DIFFING old vs new server-side,
so the log records what actually changed, not what the client claimed changed.
Weights are snapshotted onto every evaluation elsewhere; nothing here ever
rewrites an existing evaluation.
"""

from __future__ import annotations

import copy
import json
import threading
import time
from pathlib import Path
from typing import List, Tuple

HERE = Path(__file__).resolve().parent.parent
SEED = HERE / "data" / "scorecard_seed.json"
RUNTIME_DIR = HERE / "data" / "runtime"
RUNTIME = RUNTIME_DIR / "scorecard.json"
AUDIT = RUNTIME_DIR / "audit.json"

_LOCK = threading.RLock()

PERSONAS = {
    "dana": {"id": "dana", "name": "Dana Ruiz", "role": "Estimator"},
    "marcus": {"id": "marcus", "name": "Marcus Hale", "role": "Owner"},
}


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def current() -> dict:
    with _LOCK:
        return _load(RUNTIME) if RUNTIME.exists() else _load(SEED)


def audit_log() -> list:
    with _LOCK:
        return _load(AUDIT) if AUDIT.exists() else []


def reset() -> None:
    with _LOCK:
        RUNTIME.unlink(missing_ok=True)
        AUDIT.unlink(missing_ok=True)


def _rule_index(sc: dict) -> dict:
    return {r["id"]: r for r in sc["rules"]}


def diff(old: dict, new: dict) -> List[dict]:
    """Field-level before/after list. Only fields a customer can edit."""
    changes: List[dict] = []

    def add(path: str, before, after) -> None:
        if before != after:
            changes.append({"path": path, "before": before, "after": after})

    for f in ("threshold", "gate_enforced", "instructions", "name"):
        add(f, old.get(f), new.get(f))
    add("bands", old.get("bands"), new.get("bands"))

    oldr, newr = _rule_index(old), _rule_index(new)
    for rid in oldr:
        if rid not in newr:
            changes.append({"path": f"rule:{oldr[rid]['name']}", "before": "present", "after": "removed"})
    for rid, nr in newr.items():
        if rid not in oldr:
            changes.append({"path": f"rule:{nr['name']}", "before": "absent", "after": "added"})
            continue
        orl = oldr[rid]
        label = nr.get("name") or rid
        for f in ("name", "weight", "source", "active", "anchors", "knockout"):
            add(f"rule:{label}.{f}", orl.get(f), nr.get(f))
    return changes


def validate(sc: dict) -> List[str]:
    problems = []
    if not isinstance(sc.get("rules"), list) or not sc["rules"]:
        return ["scorecard has no rules"]
    seen = set()
    for r in sc["rules"]:
        rid = r.get("id") or ""
        if not rid or rid in seen:
            problems.append(f"rule id missing or duplicated: '{rid}'")
        seen.add(rid)
        if r.get("source") not in ("document", "crm", "derived", "human"):
            problems.append(f"rule {rid}: bad source '{r.get('source')}'")
        w = r.get("weight")
        if not isinstance(w, (int, float)) or not (0.5 <= w <= 3.0):
            problems.append(f"rule {rid}: weight {w} outside 0.5-3.0")
        ko = r.get("knockout")
        if ko is not None and not (isinstance(ko, dict) and ko.get("max_trigger_score") in (1, 2)):
            problems.append(f"rule {rid}: knockout must be null or {{max_trigger_score: 1|2}}")
        if not isinstance(r.get("anchors"), dict) or not r["anchors"]:
            problems.append(f"rule {rid}: anchors missing")
    t = sc.get("threshold")
    if not isinstance(t, (int, float)) or not (0 <= t <= 100):
        problems.append(f"threshold {t} outside 0-100")
    if not any(r.get("active") for r in sc["rules"]):
        problems.append("every rule is inactive; nothing to score")
    return problems


def save(new_sc: dict, persona_id: str, flips_note: str = "") -> Tuple[dict, List[dict]]:
    """Validate, diff, bump version, persist, append audit entries."""
    persona = PERSONAS.get(persona_id, PERSONAS["dana"])
    with _LOCK:
        old = current()
        problems = validate(new_sc)
        if problems:
            raise ValueError("; ".join(problems))
        changes = diff(old, new_sc)
        if not changes:
            return old, []
        out = copy.deepcopy(new_sc)
        out["version"] = int(old.get("version", 1)) + 1
        out["id"] = old["id"]                      # identity is not editable
        RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
        RUNTIME.write_text(json.dumps(out, indent=1), encoding="utf-8")
        entry = {
            "ts": time.strftime("%Y-%m-%d %H:%M:%S"),
            "persona": persona,
            "version_from": old.get("version", 1),
            "version_to": out["version"],
            "changes": changes,
            "flips_note": flips_note,
        }
        log = audit_log()
        log.insert(0, entry)
        AUDIT.write_text(json.dumps(log, indent=1), encoding="utf-8")
        return out, changes
