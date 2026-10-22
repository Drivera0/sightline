"""Check docs/report/EVIDENCE_INDEX.md: every cited path exists, every file:line cite is in range.

Stdlib only. Run from anywhere: ``python docs/report/check_evidence_index.py``. Exits 1 and lists each
broken cite when one fails.

What it reads: the Evidence column of the table (the second cell of each row). Every backticked token
that looks like a repository path is checked; a bare ``:12-20`` continues the path before it.
``path::test_name`` checks that the test exists in that file. Skipped on purpose: ``runs/`` (not
committed, see the index's header), tokens with a placeholder (``<ts>``, ``*``), a bare folder name
continuing a ``runs/`` cite, and bare file names that are not at the repo root (release assets such as
``detector_metrics.json``).
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
INDEX = REPO / "docs" / "report" / "EVIDENCE_INDEX.md"

TICK = re.compile(r"`([^`]+)`")
LINES = re.compile(r"^:(\d+)(?:-(\d+))?$")
PATH_LINES = re.compile(r"^(?P<path>[^:\s]+?)(?::(?P<a>\d+)(?:-(?P<b>\d+))?)?$")
TEST = re.compile(r"^::?(?P<name>test_\w+)$")


def rows(text: str) -> list[tuple[int, list[str]]]:
    """(line number, cells) for each data row of the first table."""
    out = []
    for n, line in enumerate(text.splitlines(), 1):
        if not line.startswith("|") or line.startswith(("|---", "| Claim")):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        out.append((n, cells))
    return out


def looks_like_path(token: str) -> bool:
    if " " in token or token.startswith(("http", "#", "-")):
        return False
    # A file at the repo root (`README.md:165-193`); bare release assets are skipped.
    if "/" not in token:
        return (REPO / token.split(":")[0]).is_file()
    if token.startswith("runs/") or "<" in token or "*" in token or "…" in token:
        return False
    # A bare folder after a runs/ cite (`runs/agent_eval/relook-final/`, `relook-live/`) is not committed.
    return not (token.endswith("/") and not (REPO / token.split("/")[0]).exists())


def line_count(path: Path, cache: dict[Path, int]) -> int:
    if path not in cache:
        cache[path] = len(path.read_text(encoding="utf-8", errors="replace").splitlines())
    return cache[path]


def check_range(path: Path, a: int, b: int | None, cache: dict[Path, int]) -> str | None:
    if path.is_dir():
        return "line cite on a directory"
    n = line_count(path, cache)
    hi = b if b is not None else a
    if a < 1 or hi < a:
        return f"bad range {a}-{hi}"
    if hi > n:
        return f"line {hi} past the end ({n} lines)"
    return None


def check(text: str) -> list[str]:
    errors: list[str] = []
    cache: dict[Path, int] = {}
    for n, cells in rows(text):
        if len(cells) < 2:
            errors.append(f"EVIDENCE_INDEX.md:{n}: row has fewer than 2 cells")
            continue
        current: Path | None = None
        for raw in TICK.findall(cells[1]):
            token = raw.strip()
            m = LINES.match(token)
            if m:
                if current is None:
                    errors.append(f"EVIDENCE_INDEX.md:{n}: `{token}` has no file before it")
                elif current.is_file():
                    err = check_range(current, int(m[1]), int(m[2]) if m[2] else None, cache)
                    if err:
                        errors.append(
                            f"EVIDENCE_INDEX.md:{n}: {current.relative_to(REPO)}{token}: {err}"
                        )
                continue
            t = TEST.match(token)
            if t and current is not None and current.is_file():
                if not re.search(rf"def {t['name']}\b", current.read_text(encoding="utf-8")):
                    errors.append(
                        f"EVIDENCE_INDEX.md:{n}: {current.relative_to(REPO)}::{t['name']} not found"
                    )
                continue
            path_part, _, test = token.partition("::")
            if not looks_like_path(path_part):
                current = None
                continue
            pm = PATH_LINES.match(path_part)
            if not pm:
                current = None
                continue
            path = REPO / pm["path"].rstrip("/")
            if not path.exists():
                errors.append(f"EVIDENCE_INDEX.md:{n}: {pm['path']} does not exist")
                current = None
                continue
            current = path
            if pm["a"]:
                err = check_range(path, int(pm["a"]), int(pm["b"]) if pm["b"] else None, cache)
                if err:
                    errors.append(f"EVIDENCE_INDEX.md:{n}: {path_part}: {err}")
            if test and not re.search(
                rf"def {re.escape(test)}\b", path.read_text(encoding="utf-8")
            ):
                errors.append(f"EVIDENCE_INDEX.md:{n}: {token} not found")
    return errors


def main() -> int:
    text = INDEX.read_text(encoding="utf-8")
    errors = check(text)
    n_rows = len(rows(text))
    if errors:
        print(f"{len(errors)} broken cite(s) in {n_rows} rows:")
        for e in errors:
            print("  " + e)
        return 1
    print(
        f"EVIDENCE_INDEX.md: {n_rows} rows, every cited path exists and every line cite is in range"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
