"""The E-18 measurement scripts' pure parts (scripts/radio_wer.py, radio_latency.py)."""

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


wer_mod = _load("radio_wer")
lat_mod = _load("radio_latency")


def test_twenty_phrases_four_with_coordinates_or_positions() -> None:
    lines = wer_mod.phrases()
    assert len(lines) == 20
    assert sum(bool(wer_mod.coordinates(p)) for p in lines) == 2  # two spoken coordinates


def test_wer_counts_number_words_and_digits_the_same() -> None:
    assert wer_mod.wer("Sightline, Team Two, over.", "Sightline team 2 over") == 0.0
    assert wer_mod.wer("Sightline, Team Two, over.", "Sightline team 3 over") == 0.25


def test_coordinate_exact_match() -> None:
    ref = "we are at four niner point three seven four, minus one two two point niner three six, over."
    assert wer_mod.coordinates(ref) == [49.374, -122.936]
    assert wer_mod.coordinates("we are at 49.374 -122.936 over") == [49.374, -122.936]


def test_percentiles() -> None:
    assert lat_mod.pct([3, 1, 2, 4, 5], 0.5) == 3 and lat_mod.pct([3, 1, 2, 4, 5], 0.9) == 5
