"""The demo fixtures' team voices (``sightline/radio/voices.py``, ``scripts/make_voice_fixture.py``):
one Magpie speaker per team, the desk in speaker 0, clips attached to the timeline only while they
still say the line. No NeMo here: the script's dry run speaks silence and hears the line back."""

from __future__ import annotations

import importlib.util
import json
import shutil
from pathlib import Path

import pytest

from sightline.radio.tts import SIGHTLINE_SPEAKER, TEAM_SPEAKERS, VOICES
from sightline.radio.voices import attach_audio, clip_name, radio_lines, speaker_of, spoken

ROOT = Path(__file__).resolve().parents[2]

IN = {"id": "e00010", "kind": "radio", "turn_id": "r0004", "direction": "in", "team": "T2",
      "text": "Sightline, Team Two. Blue water bottle by the creek crossing, over. (typed for the demo fixture)"}  # fmt: skip
OUT = {"id": "e00010-reply", "kind": "radio", "turn_id": "r0004", "direction": "out", "team": "T2",
       "text": "Team Two, Sightline. Copy a blue water bottle by the creek crossing. Confirm, over."}  # fmt: skip
CLUE = {"id": "e00011", "kind": "clue", "text": "object: blue water bottle", "team": "T2"}


def test_one_speaker_per_team_and_the_desk_in_zero() -> None:
    assert SIGHTLINE_SPEAKER == 0 and sorted(TEAM_SPEAKERS.values()) == [1, 2, 3, 4]
    assert VOICES["T3"] == 3 and VOICES["desk"] == 0 and VOICES["en_female"] == 0
    assert speaker_of(IN) == 2 and speaker_of(OUT) == 0
    assert speaker_of({**IN, "team": None}) == 0  # an unknown caller in the desk's voice


def test_clip_names_and_what_is_spoken() -> None:
    assert clip_name(IN) == "r0004.mp3" and clip_name(OUT) == "r0004-desk.mp3"
    assert clip_name(CLUE) is None and clip_name({**IN, "turn_id": "../x"}) is None
    assert spoken(IN["text"]).endswith("crossing, over.")
    assert [x[1] for x in radio_lines([IN, OUT, CLUE, IN])] == ["r0004.mp3", "r0004-desk.mp3"]


def _script():
    spec = importlib.util.spec_from_file_location(
        "make_voice_fixture", ROOT / "scripts/make_voice_fixture.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")
def test_the_dry_run_writes_clips_a_manifest_and_the_timeline_audio(
    tmp_path: Path, monkeypatch
) -> None:
    mod = _script()
    fix, public = tmp_path / "fix", tmp_path / "public"
    (fix / "scenarios").mkdir(parents=True)
    (fix / "demo_mission.json").write_text(json.dumps({"timeline": [IN, OUT, CLUE]}))
    (fix / "scenarios/dementia.json").write_text(json.dumps({"timeline": [OUT]}))
    monkeypatch.setattr(mod, "FIX", fix)
    monkeypatch.setattr(mod, "PUBLIC", public)
    assert mod.main(["--dry-run"]) == 0
    tl = json.loads((fix / "demo_mission.json").read_text())["timeline"]
    assert [x.get("audio") for x in tl] == [
        "voices/demo/r0004.mp3",
        "voices/demo/r0004-desk.mp3",
        None,
    ]
    assert (public / "voices/demo/r0004.mp3").stat().st_size > 0
    manifest = json.loads((public / "voices/demo/voices.json").read_text())
    assert manifest["clips"]["r0004.mp3"]["speaker"] == 2 and "DRY RUN" in manifest["note"]
    assert (public / "voices/dementia/r0004-desk.mp3").is_file()
    # a changed line loses its clip until it is spoken again
    changed = [{**IN, "text": "Sightline, Team Two. Something else, over."}, OUT]
    assert attach_audio(changed, "demo", public) == 1 and changed[0]["audio"] is None
