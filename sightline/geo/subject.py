"""The lost person's profile from a public bulletin: Tavily ``search`` (trusted domains only), then
``extract`` of the best pages, then Nemotron Nano reads them and returns each field **with the
sentence it came from**. The same pattern as ``conditions.py``: a value is kept only when its quote
is found verbatim in the page and actually says it; anything else stays empty, nothing is guessed.

Fields: age, category (one of ``sightline.search.prior.CATEGORIES``, read from the quote with the
prior's own rule ``subject_category``), last seen time, last seen place, clothing.

**Sources.** ``include_domains`` = ``SOURCE_DOMAINS``: police, search-and-rescue groups and local
news. Tavily's agent guidance: use ``include_domains`` "when source trust matters", and search, then
extract the chosen URLs for grounded answers (https://docs.tavily.com/agents.md).

**Privacy.** A name is never stored. The model is told to leave names out of every value and to list
the names it saw (that list is used for redaction and then dropped). Code also finds names with the
patterns bulletins use ("Jordan Example, 34", "34-year-old Jordan Example", "Mr. Example") and
replaces every name, and each part of it, with ``[name]`` in the quotes and page titles that are
traced or cached. A URL is never edited word by word: when a name occurs in its path, everything after
the host becomes ``/[redacted]``, so the link still shows the source's domain and leaks no slug.
A search result that was not read has no known names, so it is traced by host only. Quotes are
checked against the page before redaction, then stored redacted.

**Cost.** At most one search and one extract call per mission per clock hour: the result is cached
in ``cache_dir/<YYYYMMDDHH>.json`` (redacted) and a second lookup in the hour reuses it.

``SIGHTLINE_FAKE_TAVILY=1``: ``FakeBulletinTavily`` serves the synthetic bulletin in
``tests/geo/fixtures/subject_bulletin_synthetic.html`` (labelled "SYNTHETIC, for the demo"), so the
demo and the tests run offline.
"""

from __future__ import annotations

import json
import logging
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sightline.geo.conditions import TavilyLike
from sightline.search.prior import CATEGORIES, subject_category

log = logging.getLogger(__name__)

# Police, search and rescue, local news (BC first: the demo area). Short, as Tavily advises.
SOURCE_DOMAINS: tuple[str, ...] = (
    "rcmp.ca",
    "rcmp-grc.gc.ca",
    "bcsara.com",
    "northshorerescue.com",
    "vpd.ca",
    "nsnews.com",
    "cbc.ca",
    "ctvnews.ca",
    "globalnews.ca",
    "vancouversun.com",
)
MAX_RESULTS = 5
EXTRACT_TOP = 2  # pages read in full
DOC_CHARS = 6000
FIELDS = ("age", "category", "last_seen_time", "last_seen_place", "clothing")
KINDS = sorted({name.split("/")[0] for name in CATEGORIES})  # "dementia", "hiker"
NAME = "[name]"
REDACTED_PATH = "/[redacted]"
SYNTHETIC_FIXTURE = (
    Path(__file__).resolve().parents[2] / "tests/geo/fixtures/subject_bulletin_synthetic.html"
)
SYNTHETIC_URL = "https://sightline.invalid/synthetic-bulletin"

EXTRACT_PROMPT = f"""You read public bulletins about a missing person for a search-and-rescue team.
From the numbered documents, give each field with the exact quote (copied character for character
from that document) that states it, or null if no document states it:
- age: a number;
- category: one of {", ".join(KINDS)} (a hiker, backpacker or day hiker is "hiker"; a person with
  dementia or Alzheimer's is "dementia"), or null for anything else;
- last_seen_time: when the person was last seen, as written;
- last_seen_place: where the person was last seen, as written;
- clothing: what the person was wearing or carrying.
Never put a person's name in any value. List every person's name you saw in "names" (it is used
only to remove names from the quotes). Reply with JSON only:
{{"fields": {{"age": {{"value": number|null, "quote": str|null, "doc": int|null}}, ... for each of
{", ".join(FIELDS)}}}, "names": [str]}}"""


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


# --- privacy -------------------------------------------------------------------------------------

_CAP = r"[A-Z][a-z'’-]+"
_FULL = rf"{_CAP}(?:\s+{_CAP}){{1,3}}"
# "Jordan Example, 34" / "Jordan Example, aged 34" / "Jordan Example (34)"
_NAME_AGE = re.compile(rf"\b({_FULL}),?\s*(?:\(|aged?\s+)?\d{{1,3}}\b")
# "34-year-old Jordan Example" / "34-year-old man Jordan Example"
_AGE_NAME = re.compile(
    rf"\b\d{{1,3}}-year-old\s+(?:(?:man|woman|male|female|boy|girl)\s+)?({_FULL})"
)
# "Mr. Example", "Ms Example"
_TITLE = re.compile(rf"\b(?:Mr|Mrs|Ms|Miss|Mx)\.?\s+({_CAP})")
# Capitalised words a name pattern can catch that are not names
_NOT_NAMES = {
    "police", "rcmp", "search", "rescue", "north", "south", "east", "west", "mount", "the",
    "october", "november", "december", "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "monday", "tuesday", "wednesday", "thursday", "friday",
    "saturday", "sunday", "missing", "hiker", "update", "found", "help", "local", "news",
}  # fmt: skip


def find_names(text: str) -> set[str]:
    """Names written the way bulletins write them, each full name and each part of it."""
    out: set[str] = set()
    for pattern in (_NAME_AGE, _AGE_NAME, _TITLE):
        for m in pattern.finditer(text):
            parts = [p for p in m.group(1).split() if p.lower() not in _NOT_NAMES]
            if parts:
                out.add(" ".join(parts))
                out.update(p for p in parts if len(p) >= 3)
    return out


_URL = re.compile(r"(https?://[^/\s\"'<>()]+)(/[^\s\"'<>(),]*)?")


def name_words(names: set[str]) -> set[str]:
    """Every word (3+ letters, lower case) of every name, minus words that are not names."""
    words = {w.lower() for n in names for w in re.findall(r"[^\W\d_]+", n)}
    return {w for w in words if len(w) >= 3 and w not in _NOT_NAMES}


def redact_url(url: str, names: set[str]) -> str:
    """``url`` unchanged, or ``scheme://host/[redacted]`` when a word of a name (or ``[name]``) is
    in its path. The host is never touched, so the link still says which source it came from."""
    m = _URL.fullmatch(url)
    if not m or not m.group(2):
        return url
    path = m.group(2)
    if NAME in path or set(re.findall(r"[^\W\d_]+", path.lower())) & name_words(names):
        return m.group(1) + REDACTED_PATH
    return url


def host_only(url: str) -> str:
    """``scheme://host/[redacted]``, for a page that was not read (its names are not known)."""
    m = _URL.match(url or "")
    return m.group(1) + REDACTED_PATH if m else REDACTED_PATH


def _redact_words(text: str, names: set[str]) -> str:
    for n in sorted(names, key=len, reverse=True):
        if len(n) < 3 or n.lower() in _NOT_NAMES:
            continue
        pattern = r"\s+".join(re.escape(w) for w in n.split())
        text = re.sub(rf"\b{pattern}\b", NAME, text, flags=re.IGNORECASE)
    return text


def redact(text: str, names: set[str]) -> str:
    """``text`` with every name in ``names`` (whole words, any case, longest first) replaced by
    ``[name]``. A URL inside it is not edited word by word: it goes through ``redact_url``."""
    out, last = [], 0
    for m in _URL.finditer(text):
        out += [_redact_words(text[last : m.start()], names), redact_url(m.group(0), names)]
        last = m.end()
    out.append(_redact_words(text[last:], names))
    return "".join(out)


# --- extract -------------------------------------------------------------------------------------


def _words(text: str, min_len: int) -> list[str]:
    return [w for w in re.findall(r"[a-z0-9]+", _norm(text)) if len(w) >= min_len or w.isdigit()]


def _supported(value: str, quote: str) -> bool:
    """At least half of the value's words (3+ letters, or numbers) are in the quote."""
    want = _words(value, 3)
    have = set(_words(quote, 1))
    return bool(want) and sum(w in have for w in want) * 2 >= len(want)


def _check(field: str, value: Any, quote: str) -> Any:
    """The value to keep, or None when the quote doesn't say it."""
    if field == "age":
        try:
            age = int(float(value))
        except (TypeError, ValueError):
            return None
        nums = {int(x) for x in re.findall(r"\d{1,3}", quote)}
        return age if 0 < age <= 110 and age in nums else None
    if field == "category":
        # the prior's own rule, applied to the quote: the kind must be written there
        cat = subject_category(quote)
        return cat if cat is not None and cat.split("/")[0] == str(value).lower() else None
    value = str(value).strip()
    if not value or not _supported(value, quote):
        return None
    if field == "last_seen_time" and not re.search(r"\d", quote):
        return None
    return value[:120]


def extract_profile(
    docs: list[dict], client: Any, *, model: str | None = None
) -> tuple[dict, dict[str, str], dict[str, str], set[str], Any]:
    """(values, field → quote, field → URL, names seen, the model result). A value is kept only
    when its quote is verbatim in its document and says it (``_check``). Quotes are NOT yet
    redacted: ``lookup_subject`` does that with the names from here and from ``find_names``."""
    from sightline.agent.llm import MODEL_FAST

    numbered = "\n\n".join(
        f"[doc {i}] {d.get('title', '')} ({d.get('url', '')})\n{d['text'][:DOC_CHARS]}"
        for i, d in enumerate(docs)
    )
    r = client.chat(
        [{"role": "system", "content": EXTRACT_PROMPT}, {"role": "user", "content": numbered}],
        model=model or MODEL_FAST,
        response_format={"type": "json_object"},
        temperature=0.0,
        max_tokens=1500,
    )
    try:
        data = json.loads(r.text[r.text.find("{") : r.text.rfind("}") + 1])
    except ValueError:
        data = {}
    values: dict[str, Any] = dict.fromkeys(FIELDS)
    quotes: dict[str, str] = {}
    urls: dict[str, str] = {}
    for field in FIELDS:
        item = (data.get("fields") or {}).get(field) or {}
        v, q, k = item.get("value"), item.get("quote"), item.get("doc")
        if v is None or not q or not isinstance(k, int) or not 0 <= k < len(docs):
            continue
        if _norm(q) not in _norm(docs[k]["text"]):
            log.info("subject: %s dropped (quote not in the page)", field)
            continue
        kept = _check(field, v, q)
        if kept is None:
            log.info("subject: %s dropped (the quote doesn't say it)", field)
            continue
        values[field], quotes[field], urls[field] = kept, q, docs[k].get("url", "")
    names = {str(n).strip() for n in data.get("names") or [] if str(n).strip()}
    names |= {p for n in list(names) for p in n.split() if len(p) >= 3}
    return values, quotes, urls, names, r


# --- fetch ---------------------------------------------------------------------------------------


def _strip_html(html: str) -> str:
    text = re.sub(r"<(script|style)\b.*?</\1>", " ", html, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"</(p|h\d|li|div|title)>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", text)
    return "\n".join(
        re.sub(r"\s+", " ", line).strip() for line in text.splitlines() if line.strip()
    )


class FakeBulletinTavily:
    """``SIGHTLINE_FAKE_TAVILY=1``: the synthetic bulletin (a test fixture, labelled "SYNTHETIC, for
    the demo" on the page and in its title), no network."""

    def __init__(self, path: Path = SYNTHETIC_FIXTURE) -> None:
        self.text = _strip_html(path.read_text())
        self.title = re.search(r"<title>(.*?)</title>", path.read_text(), re.DOTALL).group(1)  # type: ignore[union-attr]

    def search(self, query: str, **kw: Any) -> dict:
        return {
            "results": [{"url": SYNTHETIC_URL, "title": self.title, "content": self.text[:400]}]
        }

    def extract(self, urls: list[str], **kw: Any) -> dict:
        return {"results": [{"url": u, "raw_content": self.text} for u in urls]}


def _tavily() -> TavilyLike:
    if os.environ.get("SIGHTLINE_FAKE_TAVILY") == "1":
        return FakeBulletinTavily()
    from tavily import TavilyClient

    return TavilyClient(api_key=os.environ["TAVILY_API_KEY"])


MINOR_AGE = 18


def protect_minor(profile: dict) -> bool:
    """A subject under ``MINOR_AGE``: their clothing is dropped (value, quote and URL) before
    anything is stored or traced, and the profile is marked ``minor: true``. True if so."""
    age = profile["values"].get("age")
    if not isinstance(age, int) or age >= MINOR_AGE:
        return False
    profile["values"]["clothing"] = None
    profile["quotes"].pop("clothing", None)
    profile["urls"].pop("clothing", None)
    profile["minor"] = True
    return True


def profile_text(values: dict) -> str:
    """What the mission's subject becomes on approval, with no name, e.g. "hiker, 34, red jacket,
    last seen 3:30 p.m. at the trailhead"."""
    kind = (values.get("category") or "").split("/")[0]
    parts = [p for p in (kind, values.get("age"), values.get("clothing")) if p]
    text = ", ".join(str(p) for p in parts)
    when, where = values.get("last_seen_time"), values.get("last_seen_place")
    if when or where:
        seen = "last seen" + (f" {when}" if when else "") + (f" at {where}" if where else "")
        text = f"{text}, {seen}" if text else seen
    return text


def lookup_subject(
    query: str,
    *,
    cache_dir: Path,
    now: str | None = None,
    tavily: TavilyLike | None = None,
    client: Any = None,
    trace: Any = None,
) -> dict:
    """Search → extract → read, for one model-written ``query``. Returns ``{"values", "quotes",
    "urls", "sources", "query", "fetched_at", "cached", "error", "minor"}``, everything redacted;
    a subject under 18 has no clothing (``protect_minor``).
    ``trace(kind=..., summary=..., input=..., output=..., result=...)`` gets one entry per Tavily
    call and one for the model, written after redaction so no name reaches the trace."""
    now = now or _now()
    cache_dir = Path(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    hour_file = cache_dir / f"{datetime.fromisoformat(now).strftime('%Y%m%d%H')}.json"
    if hour_file.is_file():
        return {**json.loads(hour_file.read_text()), "cached": True}
    out: dict[str, Any] = {
        "values": dict.fromkeys(FIELDS),
        "quotes": {},
        "urls": {},
        "sources": [],
        "query": query,
        "fetched_at": now,
        "cached": False,
        "error": None,
        "minor": False,
    }
    entries: list[dict] = []  # traced after redaction
    docs: list[dict] = []
    try:
        tavily = tavily or _tavily()
        kw = {"search_depth": "advanced", "max_results": MAX_RESULTS, "chunks_per_source": 3,
              "include_domains": list(SOURCE_DOMAINS)}  # fmt: skip
        res = tavily.search(query, **kw).get("results", [])
        top = [r for r in res if r.get("url")][:EXTRACT_TOP]
        # a result that is not read has no known names: traced by host only, with no title
        listed = [{"url": r.get("url"), "title": r.get("title")} if r in top
                  else {"url": host_only(r.get("url") or ""), "title": None} for r in res]  # fmt: skip
        entries.append({"kind": "tool_call", "summary": f"Tavily search (subject): {query}",
                        "input": {"query": query, "domains": list(SOURCE_DOMAINS)},
                        "output": {"results": listed}})  # fmt: skip
        if top:
            ext = tavily.extract([r["url"] for r in top], format="text").get("results", [])
            entries.append({"kind": "tool_call", "summary": f"Tavily extract: {len(top)} page(s)",
                            "input": {"urls": [r["url"] for r in top]},
                            "output": {"results": [{"url": e.get("url"), "chars": len(e.get("raw_content") or "")} for e in ext]}})  # fmt: skip
            full = {e.get("url"): e.get("raw_content") or "" for e in ext}
            for r in top:
                docs.append({"url": r["url"], "title": r.get("title", ""),
                             "text": full.get(r["url"]) or r.get("content", "")})  # fmt: skip
    except Exception as e:  # noqa: BLE001 - no key, no network, Tavily down: no profile, said why
        log.warning("subject lookup failed: %s", e)
        out["error"] = f"Tavily failed ({type(e).__name__})"
    names: set[str] = set()
    for d in docs:
        names |= find_names(f"{d['title']}\n{d['text']}")
    result = None
    if docs and client is not None:
        try:
            values, quotes, urls, seen, result = extract_profile(docs, client)
            names |= seen
            out["values"], out["quotes"], out["urls"] = values, quotes, urls
            if protect_minor(out):
                log.info("subject: under %d, clothing not stored", MINOR_AGE)
        except Exception as e:  # noqa: BLE001 - a failed read leaves the fields empty
            log.warning("subject extraction failed: %s", e)
            out["error"] = f"model failed ({type(e).__name__})"
    elif docs:
        out["error"] = "no model client"

    def clean(x: Any) -> Any:
        if isinstance(x, str):
            return redact(x, names)
        if isinstance(x, dict):
            return {k: clean(v) for k, v in x.items()}
        if isinstance(x, list):
            return [clean(v) for v in x]
        return x

    out = clean(out)
    out["sources"] = sorted({clean(d["url"]) for d in docs})
    out["redacted"] = bool(names)
    if trace is not None:
        for e in entries:
            trace(**clean(e))
        if result is not None:
            fields = {k: {"value": out["values"][k], "quote": out["quotes"].get(k),
                          "url": out["urls"].get(k)} for k in FIELDS if out["values"][k] is not None}  # fmt: skip
            trace(kind="model_call", summary="subject profile extracted with quotes (names redacted)",
                  input={"documents": out["sources"]}, output={"fields": fields}, result=result)  # fmt: skip
    if out["error"] is None:
        hour_file.write_text(json.dumps(out, indent=2))
    return out
