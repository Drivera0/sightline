"""The demo fixtures' radio voices: which Magpie speaker says each radio line, the clip's file name,
and attaching the clips to a fixture's timeline (``TimelineEntry.audio``, contract 15.7).

Teams speak in Magpie's other baked speakers, one per team (``TEAM_SPEAKERS``: Team One 1 … Team Four
4); the desk (Sightline) stays speaker 0 (``tts.SIGHTLINE_SPEAKER``). ``scripts/make_voice_fixture.py``
speaks every radio line of the demo fixtures into ``web/public/voices/<scenario>/<name>.mp3`` (22.05 kHz
mono, 48 kbps) with a manifest beside them; the fixture scripts call ``attach_audio`` so a regenerated
fixture keeps its clips when the words are the same. Pure: no NeMo, no torch.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

from sightline.radio.tts import SIGHTLINE_SPEAKER, TEAM_SPEAKERS

VOICES_DIR = "voices"  # under web/public/
MANIFEST = "voices.json"
_TYPED = re.compile(r"\s*\(typed for the demo fixture\)\s*$")


def spoken(text: str) -> str:
    """What is said: the line without the fixture's "(typed for the demo fixture)" label."""
    return _TYPED.sub("", text).strip()


def speaker_of(entry: dict) -> int:
    """A team's line (``direction`` "in") in its team's speaker; the desk's (``out``) in 0."""
    if entry.get("direction") == "in":
        return TEAM_SPEAKERS.get(entry.get("team") or "", SIGHTLINE_SPEAKER)
    return SIGHTLINE_SPEAKER


def clip_name(entry: dict) -> str | None:
    """``<turn_id>.mp3`` for a team's line, ``<turn_id>-desk.mp3`` for the desk's; None for a line
    that is not a radio turn."""
    turn = entry.get("turn_id")
    if entry.get("kind") != "radio" or not turn or not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", turn):
        return None
    return f"{turn}.mp3" if entry.get("direction") == "in" else f"{turn}-desk.mp3"


def text_key(text: str, speaker: int) -> str:
    """The manifest's check that a clip still says the line (the words and the voice)."""
    return hashlib.sha256(f"{speaker}|{spoken(text)}".encode()).hexdigest()[:16]


def radio_lines(timeline: list[dict]) -> list[tuple[dict, str, int, str]]:
    """``(entry, clip name, speaker, spoken text)`` of every radio line with words, once per name."""
    seen: set[str] = set()
    out = []
    for e in timeline:
        name = clip_name(e)
        if name is None or name in seen or not spoken(e.get("text") or ""):
            continue
        seen.add(name)
        out.append((e, name, speaker_of(e), spoken(e["text"])))
    return out


def attach_audio(timeline: list[dict], slug: str, public: Path) -> int:
    """Sets ``audio`` (``voices/<slug>/<name>``, a path under the site) on each radio line whose clip
    exists and still says the line (the manifest's key); clears it otherwise. Returns how many."""
    folder = public / VOICES_DIR / slug
    try:
        manifest: dict[str, Any] = json.loads((folder / MANIFEST).read_text())["clips"]
    except (OSError, ValueError, KeyError):
        manifest = {}
    n = 0
    for e in timeline:
        name = clip_name(e)
        e.pop("audio", None)
        if name is None:
            continue
        m = manifest.get(name)
        if m and (folder / name).is_file() and m.get("key") == text_key(e["text"], speaker_of(e)):
            e["audio"] = f"{VOICES_DIR}/{slug}/{name}"
            n += 1
        else:
            e["audio"] = None
    return n
