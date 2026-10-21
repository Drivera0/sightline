"""LANE_E §9 Python tests 1–2 for the radio core (sightline/radio/), plus the fakes. No GPU,
network or NeMo: ParakeetAsr and MagpieTts are checked on the GPU desktop (docs/feedback/radio.md)."""

from __future__ import annotations

import io
import random
import re
import subprocess
import sys
import wave
from pathlib import Path

import pytest

from sightline.radio.asr import FakeAsr
from sightline.radio.protocol import (
    classify_reply,
    fix_callsign_words,
    normalize,
    parse_callsign,
    spoken_coord,
    spoken_number,
)
from sightline.radio.tts import FakeTts

# --- test 1: normalize / spoken_coord round trip ----------------------------------------------


def _coords(n: int = 30) -> list[tuple[float, float]]:
    rng = random.Random(7)
    pts = [(49.381, -122.94), (0.0, 0.001), (-33.865, 151.209)]
    pts += [
        (round(rng.uniform(-89, 89), 3), round(rng.uniform(-179, 179), 3)) for _ in range(n - 3)
    ]
    return pts


@pytest.mark.parametrize(("lat", "lon"), _coords())
def test_spoken_coordinates_read_back_to_the_same_numbers(lat: float, lon: float) -> None:
    spoken = spoken_coord(lat, lon)
    assert not re.search(r"\d", spoken)  # spoken as words only
    got = [float(x) for x in re.findall(r"-?\d+(?:\.\d+)?", normalize(spoken))]
    assert got == pytest.approx([lat, lon], abs=5e-4)


def test_spoken_number_examples() -> None:
    assert spoken_number(49.381, 3) == "four niner point three eight one"
    assert spoken_number(-122.94, 3) == "minus one two two point niner four zero"
    assert spoken_number(-0.0001, 3) == "zero point zero zero zero"  # no "minus zero"


@pytest.mark.parametrize(
    ("heard", "normal"),
    [
        ("four niner point three eight one", "49.381"),
        ("Team Two, Sightline", "team 2 sightline"),
        ("Sight line, Team 2, say again", "sightline team 2 say again"),
        (
            "Team 2. Sight line. New assignment. Sector Bravo. 3.",
            "team 2 sightline new assignment sector bravo 3",
        ),
        ("we are at 1,200 metres", "we are at 1200 metres"),
        ("we went to the creek for water", "we went to the creek for water"),
        ("minus one two two point niner four zero", "-122.940"),
    ],
)
def test_normalize(heard: str, normal: str) -> None:
    assert normalize(heard) == normal


# --- test 2: parse_callsign and classify_reply --------------------------------------------------


@pytest.mark.parametrize(
    ("text", "team"),
    [
        ("Sightline, Team Two, say again the sector boundary, over.", "T2"),
        ("Sightline Team 2", "T2"),
        ("Sight line team two found a blue backpack", "T2"),
        ("Team Four returning to base, over", "T4"),
        ("Sightline, radio check, over", None),
        ("Team Twenty", None),
        ("Sightline team to say again the sector boundary over", "T2"),  # heard live
        ("Sightline, team too, over", "T2"),
        ("Team for returning, over", "T4"),
        ("Team won, over", "T1"),
        ("we went to the creek for water", None),  # sound-alikes only right after "team"
    ],
)
def test_parse_callsign(text: str, team: str | None) -> None:
    assert parse_callsign(text) == team


def test_parse_callsign_uses_the_mission_roster() -> None:
    assert parse_callsign("Sightline, Ridge Runner, over", {"T7": "Ridge Runner"}) == "T7"


@pytest.mark.parametrize(
    ("text", "kind"),
    [
        ("Affirmative, over", "affirmative"),
        ("affirm", "affirmative"),
        ("That is correct", "affirmative"),
        ("Negative, over", "negative"),
        ("incorrect", "negative"),
        ("Say again, over", "say_again"),
        ("repeat", "say_again"),
        ("Copy", "other"),  # acknowledges, does not confirm a readback
        ("Roger that", "other"),
        ("blue backpack", "other"),
    ],
)
def test_classify_reply(text: str, kind: str) -> None:
    assert classify_reply(text) == kind


# --- fakes and lazy imports ---------------------------------------------------------------------


def test_fake_asr_and_tts(tmp_path: Path) -> None:
    asr = FakeAsr({"turn1": "Sightline, Team Two, over"})
    assert asr.transcribe(tmp_path / "turn1.wav").text == "Sightline, Team Two, over"
    r = FakeTts().speak("Team Two, Sightline, over")
    with wave.open(io.BytesIO(r.wav)) as w:
        assert (w.getnchannels(), w.getframerate(), w.getnframes()) == (1, 22050, 4410)


def test_radio_core_imports_without_nemo_or_torch() -> None:
    code = (
        "import sys, sightline.radio.protocol, sightline.radio.asr, sightline.radio.tts; "
        "bad = [m for m in ('nemo', 'torch') if m in sys.modules]; "
        "sys.exit(f'imported {bad}' if bad else 0)"
    )
    root = Path(__file__).resolve().parents[2]
    r = subprocess.run(
        [sys.executable, "-c", code], check=False, cwd=root, capture_output=True, text=True
    )
    assert r.returncode == 0, r.stderr or r.stdout


def test_fix_callsign_words_corrects_only_the_callsign() -> None:
    assert fix_callsign_words("Sightline team to say again the sector boundary over") == (
        "Sightline Team Two say again the sector boundary over"
    )
    assert fix_callsign_words("We went to the creek for water") == "We went to the creek for water"


# --- speakable: what was heard as noise in the first real-voice session -----------------------------


def test_speakable_units_times_and_compass() -> None:
    from sightline.radio.protocol import speakable

    said = speakable("light rain 0.4 mm/h, civil twilight ends 01:12Z")
    assert "millimetres per hour" in said and "mm/h" not in said
    assert "eighteen twelve local" in said or "seventeen twelve local" in said  # UTC-7 / UTC-8
    assert ":" not in said and "Z" not in said
    assert (
        speakable("corners NW, NE, SE, SW")
        == "corners north-west, north-east, south-east, south-west"
    )
    assert speakable("bearing 270°, 600 m, 8 °C") == (
        "bearing two seven zero degrees, six hundred metres, eight degrees Celsius"
    )
    assert speakable("daylight until 18:30") == "daylight until eighteen thirty"
    assert (
        speakable("check in at 14:00 and 06:05") == "check in at fourteen hundred and six oh five"
    )
    assert "twenty five" not in speakable("2026-10-25T01:12:00Z")  # the date isn't read out


def test_spoken_time() -> None:
    from sightline.radio.protocol import spoken_time

    assert spoken_time(18, 12) == "eighteen twelve"
    assert spoken_time(6, 5) == "six oh five"
    assert spoken_time(0, 45) == "zero forty five"


def test_speakable_kph() -> None:
    from sightline.radio.protocol import speakable

    assert speakable("wind eighteen kph") == "wind eighteen kilometres per hour"


@pytest.mark.parametrize(
    ("text", "spoken"),
    [
        # bearings, headings and coordinates: digit by digit (radio procedure)
        ("bearing 270", "bearing two seven zero"),
        ("heading 095", "heading zero niner five"),
        ("turn to 045 degrees", "turn to zero four five degrees"),
        (
            "at 49.374, -122.936",
            "at four niner point three seven four, minus one two two point niner three six",
        ),
        # quantities: as said in speech
        ("600 m", "six hundred metres"),
        ("wind 18 km/h", "wind eighteen kilometres per hour"),
        ("about 250 metres across", "about two hundred fifty metres across"),
        ("1250 m", "one thousand two hundred fifty metres"),
        ("light rain 0.4 mm/h", "light rain zero point four millimetres per hour"),
        ("8 °C", "eight degrees Celsius"),
        ("3 people", "three people"),
    ],
)
def test_numbers_spoken_by_kind(text: str, spoken: str) -> None:
    from sightline.radio.protocol import speakable

    assert speakable(text) == spoken
