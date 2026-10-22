"""Every test runs with no network and no keys (CLAUDE.local / LANE rules): even when NEBIUS_API_KEY
or TAVILY_API_KEY are set in the shell, no test may make a paid call. Tavily answers from
``FakeTavily``; the model client is absent unless a test passes a fake one. The API's write rate
limit is off."""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _no_network_keys(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in ("NEBIUS_API_KEY", "TAVILY_API_KEY", "NVIDIA_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("SIGHTLINE_FAKE_TAVILY", "1")
    monkeypatch.setenv("SIGHTLINE_RATE_LIMIT", "off")  # tests that check the limit turn it on
