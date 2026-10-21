"""Radio protocol, deterministic parts (LANE_E §8.3): no model calls.

What the radio desk needs to read speech reliably and to speak numbers safely: transcripts are
normalised (number words to digits, "niner" to 9, "point" to ".", "minus" to "-"), callsigns are
mapped to team ids, confirmation replies are classified, and numbers and coordinates are spoken
digit by digit, so the model never writes a coordinate itself.

Parakeet already writes many numbers as digits ("Team 2") and sometimes splits words ("Sight
line"); ``normalize`` makes both forms the same (``docs/feedback/radio.md``, finding 3).
"""

from __future__ import annotations

import re
from typing import Literal

PROWORDS = {"over", "out", "affirmative", "negative", "say again", "confirm", "copy", "roger"}

DIGIT_WORDS = {
    "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
    "six": "6", "seven": "7", "eight": "8", "nine": "9", "niner": "9",
}  # fmt: skip
SPOKEN_DIGITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "niner"]

# Team id -> callsign; LANE_E default roster (T1..T4). Pass the mission's roster to override.
DEFAULT_CALLSIGNS = {"T1": "Team One", "T2": "Team Two", "T3": "Team Three", "T4": "Team Four"}

# Speech recognition often hears a callsign's number as a sound-alike word ("Team Two" → "team to",
# seen live with Parakeet). Only directly after "team", so "to" and "for" elsewhere are untouched.
_TEAM_SOUNDALIKES = [
    (re.compile(r"\bteam (to|too)\b"), "team two"),
    (re.compile(r"\bteam (for|fore)\b"), "team four"),
    (re.compile(r"\bteam won\b"), "team one"),
    (re.compile(r"\bteam (tree|free)\b"), "team three"),
    (re.compile(r"\bteam ate\b"), "team eight"),
]


def fix_callsign_words(text: str) -> str:
    """``text`` with sound-alike callsign numbers corrected ("team to" → "Team Two"), otherwise
    unchanged: what the model reads (the turn keeps the transcript as heard)."""
    for pattern, fixed in _TEAM_SOUNDALIKES:
        text = re.compile(pattern.pattern, re.IGNORECASE).sub(fixed.title(), text)
    return text


_AFFIRMATIVE = {"affirmative", "affirm", "correct", "confirmed", "that is correct"}
_NEGATIVE = {"negative", "incorrect", "wrong", "that is wrong"}
_SAY_AGAIN = {"say again", "repeat", "say again all"}


def normalize(text: str) -> str:
    """Lower-case words, number words joined into numbers ("four niner point three" → "49.3",
    "minus one two two" → "-122", "Team Two" → "team 2"), "sight line" → "sightline", punctuation
    other than inside numbers removed."""
    t = text.lower().replace("sight line", "sightline").replace("sight-line", "sightline")
    for pattern, fixed in _TEAM_SOUNDALIKES:
        t = pattern.sub(fixed, t)
    t = re.sub(r"(?<=\d),(?=\d{3}\b)", "", t)  # 1,200 -> 1200
    # A comma is the pause between two numbers ("..., minus one two two"): keep it as a boundary.
    tokens = re.findall(r"-?\d+(?:\.\d+)?|[a-z]+|,", t)
    out: list[str] = []
    num = ""
    sign = ""

    def flush() -> None:
        nonlocal num, sign
        if num:
            out.append(sign + num.rstrip("."))
        elif sign:
            out.append("minus")
        num, sign = "", ""

    for i, tok in enumerate(tokens):
        nxt = tokens[i + 1] if i + 1 < len(tokens) else ""
        if tok == ",":
            flush()
        elif tok in DIGIT_WORDS or re.fullmatch(r"-?\d+(?:\.\d+)?", tok):
            digits = DIGIT_WORDS.get(tok, tok)
            if digits.startswith("-") and not num:
                sign, digits = "-", digits[1:]
            num += digits
        elif tok == "point" and num and "." not in num and (nxt in DIGIT_WORDS or nxt.isdigit()):
            num += "."
        elif tok == "minus" and (nxt in DIGIT_WORDS or nxt.isdigit()):
            flush()  # a minus ends the number before it: "...three eight one, minus one two two"
            sign = "-"
        else:
            flush()
            out.append(tok)
    flush()
    return " ".join(out)


def parse_callsign(text: str, callsigns: dict[str, str] | None = None) -> str | None:
    """The team id whose callsign the speaker used ("Sightline, Team Two, ..." → "T2"), or
    ``None``. Matches on normalised text, so "Team 2" and "Team Two" are the same."""
    norm = normalize(text)
    for team_id, callsign in (callsigns or DEFAULT_CALLSIGNS).items():
        if re.search(rf"\b{re.escape(normalize(callsign))}\b", norm):
            return team_id
    return None


def classify_reply(text: str) -> Literal["affirmative", "negative", "say_again", "other"]:
    """A team's answer to a readback. Only an explicit affirmative commits a clue; "copy" and
    "roger" only acknowledge, so they are ``other``."""
    norm = " " + re.sub(r"\s+", " ", normalize(text)) + " "
    if any(f" {w} " in norm for w in _SAY_AGAIN):
        return "say_again"
    if any(f" {w} " in norm for w in _NEGATIVE):
        return "negative"
    if any(f" {w} " in norm for w in _AFFIRMATIVE):
        return "affirmative"
    return "other"


def spoken_number(n: float, decimals: int) -> str:
    """Digit by digit, radio style: 49.381 → "four niner point three eight one",
    -122.94 → "minus one two two point niner four zero" (with ``decimals=3``)."""
    s = f"{abs(n):.{decimals}f}"
    words = ["point" if c == "." else SPOKEN_DIGITS[int(c)] for c in s]
    return ("minus " if n < 0 and float(s) != 0 else "") + " ".join(words)


def spoken_coord(lat: float, lon: float, decimals: int = 3) -> str:
    """Latitude then longitude, each digit by digit (3 decimals ≈ 100 m)."""
    return f"{spoken_number(lat, decimals)}, {spoken_number(lon, decimals)}"
