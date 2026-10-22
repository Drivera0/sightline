"""``scripts/remote_check.py``: the summary line comes first and any failure exits non-zero (the
scheduled judging check opens an issue on that)."""

from __future__ import annotations

import importlib.util
import socket
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("remote_check", ROOT / "scripts" / "remote_check.py")
assert spec and spec.loader
remote_check = importlib.util.module_from_spec(spec)
sys.modules["remote_check"] = remote_check
spec.loader.exec_module(remote_check)


def test_summary_line() -> None:
    assert (
        remote_check.summary("https://x", 5, 5, []) == "remote check PASSED 5/5 against https://x"
    )
    assert (
        remote_check.summary("https://x", 5, 1, ["HTTPS + health"], read_only=True)
        == "remote check FAILED 1/5 (read-only) against https://x: HTTPS + health, 4 not run"
    )


def test_unreachable_api_fails_with_the_summary_first(capsys: pytest.CaptureFixture[str]) -> None:
    with socket.socket() as s:  # a port nobody listens on
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    code = remote_check.main(
        ["--api", f"http://127.0.0.1:{port}", "--read-only", "--mission", "m0000001"]
    )
    out = capsys.readouterr().out.splitlines()
    assert code == 1
    assert out[0].startswith("remote check FAILED 1/5 (read-only)") and "4 not run" in out[0]
    assert out[1].startswith("  FAIL HTTPS + health")
