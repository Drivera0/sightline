"""Rules about the library code itself, so they stay true as it grows."""

from __future__ import annotations

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / "sightline"
LANE_D_FILES = [
    ROOT / "contract.py",
    *ROOT.joinpath("pipeline").glob("*.py"),
    *ROOT.joinpath("api").glob("*.py"),
]


def test_there_are_files_to_check():
    assert len(LANE_D_FILES) > 10


def test_library_code_does_not_use_assert_for_checks():
    """`python -O` removes assert statements, so a check written as one silently disappears."""
    offenders = [
        f"{path.relative_to(ROOT.parent)}:{node.lineno}"
        for path in LANE_D_FILES
        for node in ast.walk(ast.parse(path.read_text()))
        if isinstance(node, ast.Assert)
    ]

    assert offenders == []
