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


def test_the_reviewed_lists_are_not_stale() -> None:
    docs = "\n".join(p.read_text() for p in (ROOT / "docs").rglob("*.md"))
    strings = "\n".join(s for p in (ROOT / "sightline").rglob("*.py") for s in _strings(p))
    for a in ALLOWED_DOCS:
        assert a in docs, a
    for a in ALLOWED_STRINGS:
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
