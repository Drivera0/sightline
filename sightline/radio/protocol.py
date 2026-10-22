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


_NINER_AS_ER = re.compile(r"\b(\d*9)er(?![a-z])")


def _niner_as_or(prev: str, num: str, nxt: str) -> bool:
    """Parakeet's other rendering of "niner": "nine or" ("point nine or three six" for "point niner
    three six"). Only inside a number with digits on both sides: after the word "nine", or after a
    digit run ending in 9 that already has its decimal point ("122.9 or 36")."""
    if not num.endswith("9") or not (nxt in DIGIT_WORDS or nxt.isdigit()):
        return False
    return prev == "nine" or ("." in num and bool(re.fullmatch(r"-?\d+(?:\.\d+)?", prev)))


def normalize(text: str) -> str:
    """Lower-case words, number words joined into numbers ("four niner point three" → "49.3",
    "minus one two two" → "-122", "Team Two" → "team 2", Parakeet's "49er.381" → "49.381"), "sight line" → "sightline", punctuation
    other than inside numbers removed."""
    t = text.lower().replace("sight line", "sightline").replace("sight-line", "sightline")
    for pattern, fixed in _TEAM_SOUNDALIKES:
        t = pattern.sub(fixed, t)
    t = re.sub(r"(?<=\d),(?=\d{3}\b)", "", t)  # 1,200 -> 1200
    # Parakeet does not know "niner": "four niner" comes out as "49er" and "point niner four zero" as
    # ".9er40". Only a digit run ending in 9 loses its "er", so words ("either", "never") are kept.
    t = _NINER_AS_ER.sub(r"\1", t)
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
        prev = tokens[i - 1] if i else ""
        if tok == ",":
            flush()
        elif tok == "or" and _niner_as_or(prev, num, nxt):
            continue  # "nine or three" = "niner three"
        elif tok in DIGIT_WORDS or re.fullmatch(r"-?\d+(?:\.\d+)?", tok):
            digits = DIGIT_WORDS.get(tok, tok)
            if digits.startswith("-") and not num:
                sign, digits = "-", digits[1:]
            num += digits
        elif tok == "point" and num and "." not in num and (nxt in DIGIT_WORDS or nxt.isdigit()):
            num += "."
        elif tok == "minus" and (nxt in DIGIT_WORDS or re.fullmatch(r"\d+(?:\.\d+)?", nxt)):
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


# --- text as it is spoken ------------------------------------------------------------------------
# Magpie reads text literally: "mm/h", "01:12Z", "NE" and "°" come out as noise. Everything spoken goes
# through ``speakable`` first. Times are spoken radio style in local time; the demo area is BC.

LOCAL_TZ = "America/Vancouver"  # TODO (lane E): the mission's time zone once missions carry one

_ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
         "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]  # fmt: skip
_TENS = {2: "twenty", 3: "thirty", 4: "forty", 5: "fifty"}

_ISO_TIME = re.compile(r"\b\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?Z\b")
_Z_TIME = re.compile(r"\b(\d{1,2}):(\d{2})\s?Z\b")
_LOCAL_TIME = re.compile(r"\b([01]?\d|2[0-3]):([0-5]\d)\b")
_SPOKEN_UNITS = [
    (re.compile(r"(?<=\d)\s?mm/h\b"), " millimetres per hour"),
    (re.compile(r"(?<=\d)\s?km/h\b"), " kilometres per hour"),
    (re.compile(r"\bkph\b", re.IGNORECASE), "kilometres per hour"),
    # After a number already in words ("eighteen km/h"), which the rules above don't see.
    (re.compile(r"\bkm/h\b"), "kilometres per hour"),
    (re.compile(r"\bmm/h\b"), "millimetres per hour"),
    (re.compile(r"(?<=\d)\s?°C\b"), " degrees Celsius"),
    (re.compile(r"\s?°"), " degrees"),
    (re.compile(r"(?<=\d)\s?km\b"), " kilometres"),
    (re.compile(r"(?<=\d)\s?m\b"), " metres"),
    (re.compile(r"(?<=\d)\s?%"), " percent"),
]
_COMPASS = {"NE": "north-east", "NW": "north-west", "SE": "south-east", "SW": "south-west"}
_NUMBER_IN_TEXT = re.compile(r"-?\d+(?:\.\d+)?")


def number_words(n: int) -> str:
    """0–59 as words ("forty five"), for spoken times."""
    if n < 20:
        return _ONES[n]
    tens, ones = divmod(n, 10)
    return _TENS[tens] + (f" {_ONES[ones]}" if ones else "")


def _below_thousand(n: int) -> str:
    hundreds, rest = divmod(n, 100)
    words = [f"{_ONES[hundreds]} hundred"] if hundreds else []
    if rest or not words:
        words.append(number_words(rest) if rest < 60 else _tens_words(rest))
    return " ".join(words)


def _tens_words(n: int) -> str:
    tens, ones = divmod(n, 10)
    name = {6: "sixty", 7: "seventy", 8: "eighty", 9: "ninety"}.get(tens) or _TENS[tens]
    return name + (f" {_ONES[ones]}" if ones else "")


def _digit_by_digit(s: str) -> str:
    """Each character as written, so a bearing keeps its leading zero: "095" → "zero niner five"."""
    words = ["minus" if c == "-" else "point" if c == "." else SPOKEN_DIGITS[int(c)] for c in s]
    return " ".join(words)


def natural_number(n: float, decimals: int = 0) -> str:
    """As said in speech: 600 → "six hundred", 18 → "eighteen", 1250 → "one thousand two hundred
    fifty", 0.4 → "zero point four" (decimals digit by digit), -5 → "minus five"."""
    sign = "minus " if n < 0 else ""
    whole = int(abs(n))
    thousands, rest = divmod(whole, 1000)
    words = []
    if thousands:
        words.append(f"{_below_thousand(thousands)} thousand")
    if rest or not words:
        words.append(_below_thousand(rest))
    text = " ".join(words)
    if decimals:
        frac = f"{abs(n):.{decimals}f}".split(".")[1]
        text += " point " + " ".join(SPOKEN_DIGITS[int(d)] for d in frac)
    return sign + text


def spoken_time(hour: int, minute: int) -> str:
    """Radio style: 18:12 → "eighteen twelve", 06:05 → "six oh five", 14:00 → "fourteen hundred"."""
    if minute == 0:
        return f"{number_words(hour)} hundred"
    return (
        f"{number_words(hour)} {('oh ' + _ONES[minute]) if minute < 10 else number_words(minute)}"
    )


def _utc_to_local(hour: int, minute: int, date: str | None = None) -> tuple[int, int]:
    from datetime import UTC, datetime
    from zoneinfo import ZoneInfo

    day = datetime.fromisoformat(date) if date else datetime.now(UTC)
    t = day.replace(hour=hour, minute=minute, second=0, microsecond=0, tzinfo=UTC)
    local = t.astimezone(ZoneInfo(LOCAL_TZ))
    return local.hour, local.minute


def local_clock(iso_utc: str) -> str:
    """ "2026-10-25T01:12:00Z" → "18:12" in ``LOCAL_TZ`` (24 h, as said on the radio)."""
    m = _ISO_TIME.search(iso_utc)
    if not m:
        return iso_utc
    h, mi = _utc_to_local(int(m.group(1)), int(m.group(2)), iso_utc[:10])
    return f"{h:02d}:{mi:02d}"


def speakable(text: str) -> str:
    """``text`` as it should be spoken: UTC times as local radio time ("eighteen twelve local"), local
    times as words, units and compass abbreviations as words, colons and semicolons as pauses, and
    every other number digit by digit ("one eight"), as ``spoken_number`` does."""

    def iso(m: re.Match) -> str:
        h, mi = _utc_to_local(int(m.group(1)), int(m.group(2)), m.group(0)[:10])
        return f"{spoken_time(h, mi)} local"

    def zulu(m: re.Match) -> str:
        h, mi = _utc_to_local(int(m.group(1)), int(m.group(2)))
        return f"{spoken_time(h, mi)} local"

    text = _ISO_TIME.sub(iso, text)
    text = _Z_TIME.sub(zulu, text)
    text = _LOCAL_TIME.sub(lambda m: spoken_time(int(m.group(1)), int(m.group(2))), text)
    for pattern, words in _SPOKEN_UNITS:
        text = pattern.sub(words, text)
    text = re.sub(r"\b(NE|NW|SE|SW)\b", lambda m: _COMPASS[m.group(1)], text)
    text = re.sub(r"\s*[;:]\s*", ", ", text)

    def number(m: re.Match) -> str:
        s, before = m.group(), text[max(0, m.start() - 12) : m.start()].lower()
        after = text[m.end() : m.end() + 12].lower()
        decimals = len(s.split(".")[1]) if "." in s else 0
        # Digit by digit where a misheard digit changes a place or direction (radio procedure):
        # bearings and headings, coordinates (2+ decimals), and anything we can't classify safely.
        if (
            "bearing" in before
            or "heading" in before
            or decimals >= 2
            or (after.lstrip().startswith("degrees") and "celsius" not in after)
        ):
            return _digit_by_digit(s)
        # Quantities (distances, speeds, temperatures, counts) as said in speech: "six hundred".
        return natural_number(float(s), decimals)

    return re.sub(r"\s{2,}", " ", _NUMBER_IN_TEXT.sub(number, text)).strip()
