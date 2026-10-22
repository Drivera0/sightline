"""docs/report/TAVILY.md points judges at tests and code: every one it names must exist."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DOC = ROOT / "docs/report/TAVILY.md"


def test_every_test_the_tavily_report_names_exists() -> None:
    text = DOC.read_text()
    named = re.findall(r"`(tests/[\w/]+\.py)(?:::(\w+))?`", text)
    assert named
    for path, name in named:
        src = (ROOT / path).read_text()
        assert not name or re.search(rf"^def {name}\(", src, re.MULTILINE), f"{path}::{name}"


def test_the_recall_moment_has_its_command_and_says_tavily_was_faked() -> None:
    text = DOC.read_text()
    section = text[text.index("## The recall moment") :]
    assert "scripts/recall_demo.py --serve-local" in section
    assert "Tavily and the model faked" in section
    assert (ROOT / "scripts/recall_demo.py").is_file()
    assert not re.search(r"\bclear(ed)?\b", section, re.IGNORECASE)
