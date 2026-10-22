"""Never "clear", in all its forms: the docs and the strings in ``sightline/`` that can reach a user
(briefings, radio replies, proposal reasons, the debrief) must not say an area "clears" or is
"clearing". The runtime guards already catch "clear"/"cleared" in what the models write; this scan
catches the two forms they used to miss, in what we write. A new hit fails until someone reads it and
either rewords it or, if it is not about an area, adds it to the reviewed list below."""

from __future__ import annotations

import ast
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FORMS = re.compile(r"\bclear(s|ing)\b", re.IGNORECASE)
GUARD = re.compile(r"\bclear(s|ed|ing)?\b", re.IGNORECASE)

# Reviewed uses that are not an area state.
ALLOWED_DOCS: tuple[str, ...] = (
    "Switching surveys clears stale cross-screen map selection",  # LANE_B_GEO: UI selection
    '"clear", "clears", "cleared" or "clearing" must be on a reviewed list',  # the rule itself
)
ALLOWED_STRINGS: tuple[str, ...] = (
    '"clear", "clears", "cleared" or "clearing"',  # the prompts telling the models not to say it
    '"clears", "cleared" or "clearing"',  # same, split across a line in the debrief prompt
    "or that a search clears it",  # the radio prompt's version of the same rule
)

# "Rule out" says the same thing as "clear": a searched area is lowered, never removed. In what
# ``sightline/`` writes, only the sanctioned negations may use it. The docs explain the planner
# with it in places ("each photo rules out less"), so there only the proposal-reason form is banned.
RULE_OUT = re.compile(r"\brul(e|es|ed|ing) out\b", re.IGNORECASE)
RULE_OUT_NEGATIONS: tuple[str, ...] = (
    "nothing is ever ruled out",  # the debrief prompt
    "no sector is ruled out",  # the debrief footer
)
REASON_RULE_OUT = re.compile(r"\bexpected to rule out\b", re.IGNORECASE)


def _strings(path: Path) -> list[str]:
    """The string constants in a module, without docstrings (those are for developers)."""
    tree = ast.parse(path.read_text())
    docs = {
        id(n.body[0].value)
        for n in ast.walk(tree)
        if isinstance(n, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))
        and n.body
        and isinstance(n.body[0], ast.Expr)
        and isinstance(n.body[0].value, ast.Constant)
    }
    return [
        n.value
        for n in ast.walk(tree)
        if isinstance(n, ast.Constant) and isinstance(n.value, str) and id(n) not in docs
    ]


def test_no_doc_says_an_area_clears_or_is_clearing() -> None:
    found = [
        f"{p.relative_to(ROOT)}:{i}: {line.strip()[:100]}"
        for p in sorted((ROOT / "docs").rglob("*.md"))
        for i, line in enumerate(p.read_text().splitlines(), 1)
        if FORMS.search(line) and not any(a in line for a in ALLOWED_DOCS)
    ]
    assert found == []


def test_no_sightline_string_says_an_area_clears_or_is_clearing() -> None:
    found = [
        f"{p.relative_to(ROOT)}: {s[:100]!r}"
        for p in sorted((ROOT / "sightline").rglob("*.py"))
        for s in _strings(p)
        if FORMS.search(s) and not any(a in s for a in ALLOWED_STRINGS)
    ]
    assert found == []


def test_no_sightline_string_says_an_area_is_ruled_out() -> None:
    found = [
        f"{p.relative_to(ROOT)}: {s[:100]!r}"
        for p in sorted((ROOT / "sightline").rglob("*.py"))
        for s in _strings(p)
        if RULE_OUT.search(s) and not any(n in s for n in RULE_OUT_NEGATIONS)
    ]
    assert found == []


def test_no_doc_quotes_a_reason_that_rules_out() -> None:
    found = [
        f"{p.relative_to(ROOT)}:{i}: {line.strip()[:100]}"
        for p in sorted((ROOT / "docs").rglob("*.md"))
        if p.parent.name != "review"  # the hostile review quotes the old wording it asked to fix
        for i, line in enumerate(p.read_text().splitlines(), 1)
        if REASON_RULE_OUT.search(line)
    ]
    assert found == []


def test_the_reasons_say_lowered() -> None:
    from sightline.agent import relook_leg
    from sightline.search import planner

    for mod in (planner, relook_leg):
        assert any(
            "expected to lower the remaining probability by" in s
            for s in _strings(Path(mod.__file__))
        )


def test_the_reviewed_lists_are_not_stale() -> None:
    docs = "\n".join(p.read_text() for p in (ROOT / "docs").rglob("*.md"))
    strings = "\n".join(s for p in (ROOT / "sightline").rglob("*.py") for s in _strings(p))
    for a in ALLOWED_DOCS:
        assert a in docs, a
    for a in ALLOWED_STRINGS + RULE_OUT_NEGATIONS:
        assert a in strings, a


def test_the_runtime_guards_catch_every_form() -> None:
    from sightline.agent import loop, verify
    from sightline.mission import validate
    from sightline.radio import turn
    from sightline.search import debrief

    for guard in (loop._CLEAR, verify._CLEAR, validate._CLEAR, turn._CLEAR, debrief._CLEAR):
        for word in ("clear", "Clears", "cleared", "clearing"):
            assert guard.search(f"Sector B3 {word}"), (guard.pattern, word)
        assert not guard.search("clearly unclear clearance")
    assert GUARD.pattern == loop._CLEAR.pattern
