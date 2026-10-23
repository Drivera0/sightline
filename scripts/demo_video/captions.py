"""From a recorded run (record.py) to the files for the editor and the README:

    uv run --extra video python scripts/demo_video/captions.py runs/video/<timestamp> [--only mp4,srt,burn,cuts,gif] [--force]
    uv run --extra video python scripts/demo_video/captions.py runs/video/<timestamp> --size 2560x1440   # the 1440p upload

In the run folder, from the 4K master (``master_4k.mp4``) + ``shots.json`` + ``captions.yaml`` (next to this
script):

- ``master.mp4``: the program, 1920x1080 at the master's frame rate: the sync mark painted out, each shot's
  camera move (``moves``: a slow push-in by default) and speed-up rendered from the 4K frames
  (``moves.py``), lanczos down to the output; uncaptioned. The shots' times in it go back into
  shots.json (``program_start_s`` / ``program_end_s``) for the labels, the cuts and the narration;
- ``captions.srt`` / ``captions.ass``: one short burned-in caption per shot that ran (not narration), at
  most 42 characters a line, two lines, on screen at least 1.2 s, in the site's type (Geist, copied into
  ``fonts/`` for libass); never demo/recorded/scripted/simulated, never "clear" or "rule out";
- ``master_captioned.mp4``: the program with the captions burned in after the move, so they stay sharp
  and still; the export profile (H.264 High, BT.709, 8 Mbit/s at 30 fps or 12 at 60 for 1080p, YouTube's
  table, ``+faststart``);
- ``cut_opencv.mp4`` (<= 4:30) and ``cut_nebius.mp4`` (<= 2:50): silent cuts in each video's story
  order: black slots for footage, the owner on camera and slides made elsewhere (with placeholder
  captions), the disclosure card rendered here, and the shots, cut from ``master.mp4`` with their own
  captions (``cut_<name>.srt`` / ``.ass``); ``cut_<name>.json`` lists every segment with its source and
  output times;
- ``demo.gif``: <= 16 s for the README (12 fps, 960 px wide, one palette, <= 3 MB), from the 4K
  recording without the camera moves (the program's push-ins change every pixel, about 15 times the size),
  first and last frame matched so it loops; over 3 MB it tries a shorter window, then fewer colours.

``--size 2560x1440`` writes the same files with a ``_1440p`` suffix (the program rendered at that size).
Each step is skipped when its output is newer than its inputs (``--force`` redoes it).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import textwrap
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
import moves
from story_facts import fill

W, H = 1920, 1080
MAX_LINE, MAX_LINES, MIN_LABEL_S = 42, 2, 1.2  # Netflix's timed-text limits, and the shortest label
COLOR = [
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-colorspace",
    "bt709",
    "-color_range",
    "tv",
]
# the program's pieces: near-lossless, encoded again once for the export
MEZZANINE = ["-c:v", "libx264", "-preset", "fast", "-crf", "10", "-pix_fmt", "yuv420p", *COLOR]


def export_x264(fps: float = 60, height: int = 1080) -> list[str]:
    """The upload profile: H.264 High, yuv420p, BT.709, YouTube's recommended SDR bitrates (1080p: 8
    Mbit/s at 24-30 fps, 12 at 48-60; 1440p: 16 / 24), a VBV cap at 1.5x, ``+faststart``."""
    hi = fps > 30
    mbit = {1080: (8, 12), 1440: (16, 24), 2160: (45, 68)}.get(height, (8, 12))[hi]
    return ["-c:v", "libx264", "-preset", "slow", "-profile:v", "high", "-b:v", f"{mbit}M",
            "-maxrate", f"{mbit * 1.5:g}M", "-bufsize", f"{mbit * 2}M", "-pix_fmt", "yuv420p", *COLOR,
            "-movflags", "+faststart"]  # fmt: skip


X264 = export_x264()  # the 1080p60 profile (narrate.py re-encodes with it)
AAC = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000"]


def run(cmd: list[str], cwd: Path | None = None) -> None:
    print("  $ " + " ".join(cmd if len(" ".join(cmd)) < 400 else [*cmd[:6], "…"]), flush=True)
    subprocess.run(cmd, check=True, cwd=cwd)


def fresh(out: Path, *inputs: Path) -> bool:
    return out.exists() and all(
        out.stat().st_mtime >= i.stat().st_mtime for i in inputs if i.exists()
    )


def ts(t: float) -> str:
    ms = round(max(0.0, t) * 1000)
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def span(s: dict) -> tuple[float, float]:
    """A shot's (start, end) in master.mp4: after the moves and the speed-up when the program step has
    run, else as recorded."""
    if "program_start_s" in s:
        return s["program_start_s"], s["program_end_s"]
    return s["start_s"], s["end_s"]


def ran(shots: list[dict]) -> list[dict]:
    return [s for s in shots if s["status"] == "ok" and span(s)[1] - span(s)[0] > 0.5]


def probe(video: Path, entries: str = "stream=width,height,r_frame_rate:format=duration") -> dict:
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", entries, "-of", "json",
                        str(video)], capture_output=True, text=True, check=True)  # fmt: skip
    j = json.loads(r.stdout)
    st = (j.get("streams") or [{}])[0]
    num, _, den = st.get("r_frame_rate", "0/1").partition("/")
    return {"w": st.get("width"), "h": st.get("height"), "fps": float(num) / float(den or 1),
            "duration": float(j.get("format", {}).get("duration", 0.0))}  # fmt: skip


# --- (0) the captions ------------------------------------------------------------------------------

# Inside the story nothing says what kind of search it is: the disclosure card says it once (storyCopy.ts
# STORY_BANNED, the same words). Never an area called clear or ruled out, anywhere.
STORY_BANNED = re.compile(r"\b(demo|demos|recorded|scripted|simulated|simulation)\b", re.IGNORECASE)
NO_CLEAR = re.compile(r"clear|\brul(?:e|ed|es|ing) out\b", re.IGNORECASE)


def check_words(text: str, where: str, disclosure: bool = False) -> None:
    """Stops the run on a caption that calls an area done, or that breaks the story's disclosure rule (a
    card marked as the disclosure is the one place those words go)."""
    if NO_CLEAR.search(text):
        raise SystemExit(
            f"{where} says {NO_CLEAR.search(text).group(0)!r}: a searched area is 'searched at POD x'"
        )
    if not disclosure and STORY_BANNED.search(text):
        raise SystemExit(
            f"{where} says {STORY_BANNED.search(text).group(0)!r}: only the disclosure card says that"
        )


def wrap(text: str, sid: str) -> str:
    """At most MAX_LINES lines of MAX_LINE characters: the label's own line breaks kept, a long line
    wrapped at a space; a label that still doesn't fit stops the run (rewrite it in captions.yaml)."""
    lines = [ln for part in text.split("\n") for ln in (textwrap.wrap(part, MAX_LINE) or [""])]
    if len(lines) > MAX_LINES:
        raise SystemExit(
            f"label for {sid} needs {len(lines)} lines of <= {MAX_LINE} characters "
            f"(at most {MAX_LINES}): {text!r}"
        )
    return "\n".join(lines)


def labels(spans: list[tuple], cfg: dict) -> list[tuple[float, float, str]]:
    """(start, end, text) for each (shot id, start, end[, text]) in the order they play, numbered in that
    order when the label asks for it; a span's own text (a cut's `label`) replaces the shot's. A label is
    at most two lines, never says "clear", and never says demo/recorded/scripted/simulated."""
    out, n = [], 0
    for sid, a, b, *own in spans:
        lab = cfg["labels"].get(sid)
        if not lab and not (own and own[0]):
            continue
        text = fill(own[0] if own and own[0] else lab["text"])
        if lab and lab.get("number"):
            n += 1
            text = f"{n} · {text}"
        check_words(text, f"label for {sid}")
        out.append((a, b, wrap(text, sid)))
    return out


def timed(events: list[tuple], cfg: dict) -> list[tuple]:
    """Each (start, end, text[, style]) with the lead-in and lead-out, and never shorter than 1.2 s."""
    st = cfg["style"]
    out = []
    for a, b, text, *style in events:
        start, end = a + st["lead_in_s"], b - st["lead_out_s"]
        out.append((start, max(end, start + MIN_LABEL_S), text, *style))
    return out


def srt(spans: list[tuple], cfg: dict, path: Path) -> None:
    write_srt_events(timed(labels(spans, cfg), cfg), path)


def write_srt_events(events: list[tuple], path: Path) -> None:
    lines = []
    for i, (a, b, text, *_) in enumerate(events, 1):
        lines += [str(i), f"{ts(a)} --> {ts(b)}", text, ""]
    path.write_text("\n".join(lines))
    print(f"  wrote {path} ({len(events)} captions)")


def write_srt(doc: dict, cfg: dict, path: Path) -> None:
    srt([(s["id"], *span(s)) for s in ran(doc["shots"])], cfg, path)


# --- the type: the site's face, rendered by libass ---------------------------------------------------


def fonts(cfg: dict, d: Path) -> str:
    """Copies the site's font files into `<d>/fonts` (libass's fontsdir) and returns the face to ask for:
    the site's (Geist) when its files are there, else the fallback (Inter, from the system)."""
    st = cfg["style"]
    src = ROOT / st.get("fonts_from", "")
    dst = d / "fonts"
    files = sorted(src.glob("*latin-wght-normal.woff2")) if src.is_dir() else []
    if not files:
        return st.get("fallback_font", "Inter")
    dst.mkdir(exist_ok=True)
    for f in files:
        if not (dst / f.name).exists():
            shutil.copy(f, dst / f.name)
    return st.get("font", "Geist")


def ass_time(t: float) -> str:
    cs = round(max(0.0, t) * 100)
    h, cs = divmod(cs, 360_000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def ass(events: list[tuple], cfg: dict, path: Path, font: str) -> None:
    """An .ass file on a 1920x1080 canvas with three styles: Label (the lower third, a dark box), Card
    (the disclosure card, centred, faded in and out) and Credit (narrate.py's, above the label). Each event
    is (start, end, text[, style])."""
    st = cfg["style"]
    lab, card, credit = st.get("label", {}), st.get("card", {}), st.get("credit", {})
    box = lab.get("box", "&H99000000")
    fmt = ("Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, "
           "Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, "
           "MarginL, MarginR, MarginV, Encoding")  # fmt: skip
    rows = [
        "[Script Info]", "ScriptType: v4.00+", "PlayResX: 1920", "PlayResY: 1080", "WrapStyle: 2",
        "ScaledBorderAndShadow: yes", "", "[V4+ Styles]", fmt,
        (f"Style: Label,{font},{lab.get('size', 34)},&H00FFFFFF,&H00FFFFFF,{box},{box},0,0,0,0,100,100,0,0,3,"
         f"{lab.get('outline', 10)},0,2,60,60,{lab.get('margin_v', 40)},1"),
        f"Style: Card,{font},{card.get('size', 58)},&H00F2F2F2,&H00F2F2F2,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,120,120,0,1",
        (f"Style: Credit,{font},{credit.get('size', 26)},&H00E6E6E6,&H00E6E6E6,{box},{box},0,0,0,0,100,100,0,0,3,"
         f"{max(4, lab.get('outline', 10) - 4)},0,2,60,60,{credit.get('margin_v', 112)},1"),
        "", "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]  # fmt: skip
    for a, b, text, *style in events:
        name = style[0] if style else "Label"
        body = text.replace("\n", "\\N")
        if name == "Card":
            body = "{\\fad(400,400)}" + body
        rows.append(f"Dialogue: 0,{ass_time(a)},{ass_time(b)},{name},,0,0,0,,{body}")
    path.write_text("\n".join(rows) + "\n")


def ass_filter(name: str, fontsdir: str | None) -> str:
    """The ass filter for a run-folder relative .ass (run ffmpeg from that folder: the filter's own
    quoting doesn't take a full path)."""
    return f"ass={name}" + (f":fontsdir={fontsdir}" if fontsdir else "")


# --- (a) the program: moves and pacing from the 4K master --------------------------------------------


def program(
    doc: dict, cfg: dict, d: Path, size: tuple[int, int], suffix: str, shots_path: Path
) -> None:
    """master.mp4 from the recorded master: each piece (a shot, or the frames between two) rendered on
    its own, in parallel, then joined without re-encoding. Writes the shots' program times back into
    shots.json."""
    src = d / doc["video"]
    info = probe(src)
    fps = round(doc.get("fps") or info["fps"])
    total = info["duration"] or doc["total_s"]
    pcfg = cfg.get("program", {})
    upscale = float(pcfg.get("upscale", 2))
    pieces = moves.plan(doc["shots"], total, cfg)
    tmp = d / f"program{suffix}"
    tmp.mkdir(exist_ok=True)
    jobs = []
    for i, p in enumerate(pieces):
        out = tmp / f"{i:03d}_{p.name}.mp4"
        vf = moves.filters(p, size, fps, upscale, doc.get("delogo"))
        cmd = ["ffmpeg", "-v", "error", "-y", "-ss", f"{p.src_start:.3f}", "-t", f"{p.src_s:.3f}", "-i", str(src),
               "-vf", vf, "-an", *MEZZANINE, "-fps_mode", "passthrough", str(out)]  # fmt: skip
        jobs.append((p, out, cmd))
    t0 = time.monotonic()
    workers = max(1, min(len(jobs), (os.cpu_count() or 4) // 6))
    print(f"  {len(jobs)} pieces at {size[0]}x{size[1]} {fps} fps, {workers} at a time (zoompan on the master x{upscale:g})", flush=True)  # fmt: skip
    with ThreadPoolExecutor(workers) as ex:
        for f in [ex.submit(subprocess.run, cmd, check=True) for _, _, cmd in jobs]:
            f.result()
    listing = tmp / "pieces.ffconcat"
    listing.write_text("ffconcat version 1.0\n" + "".join(f"file '{o.name}'\n" for _, o, _ in jobs))
    master = d / f"master{suffix}.mp4"
    run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy",
         "-movflags", "+faststart", str(master)])  # fmt: skip
    # the shots' places in the program, from the pieces' actual lengths (frame-rounded)
    t, at = 0.0, {}
    for p, out, _ in jobs:
        n = probe(out)["duration"]
        if p.name != "gap":
            at[p.name] = (round(t, 3), round(t + n, 3), p)
        t += n
    shutil.rmtree(tmp, ignore_errors=True)
    took = time.monotonic() - t0
    print(f"  {master.name}: {t:.1f} s from {total:.1f} s recorded, rendered in {took:.0f} s ({t * fps / max(took, 1e-3):.1f} frames/s)")  # fmt: skip
    if suffix:  # a second size: the timings are the same, shots.json already has them
        return
    for s in doc["shots"]:
        if s["id"] in at:
            a, b, p = at[s["id"]]
            s["program_start_s"], s["program_end_s"] = a, b
            s["move"] = p.move
            s["speed"] = [list(r) for r in p.speed]
        else:  # skipped before it ran: zero length where the next piece starts
            s["program_start_s"] = s["program_end_s"] = None
    nxt = 0.0
    for s in reversed(doc["shots"]):
        if s["program_start_s"] is None:
            s["program_start_s"] = s["program_end_s"] = nxt
        else:
            nxt = s["program_start_s"]
    doc["program"] = {"video": master.name, "size": list(size), "fps": fps, "total_s": round(t, 3),
                      "source": doc["video"], "upscale": upscale}  # fmt: skip
    shots_path.write_text(json.dumps(doc, indent=2) + "\n")
    os.utime(master)  # newer than the shots.json it just wrote: the step stays fresh


def burn(doc: dict, cfg: dict, d: Path, suffix: str, fps: float, height: int) -> None:
    font = fonts(cfg, d)
    ass(
        timed(labels([(s["id"], *span(s)) for s in ran(doc["shots"])], cfg), cfg),
        cfg,
        d / "captions.ass",
        font,
    )
    vf = ass_filter("captions.ass", "fonts" if (d / "fonts").is_dir() else None)
    src, dst = f"master{suffix}.mp4", f"master{suffix}_captioned.mp4"
    print(f"  $ (in {d}) ffmpeg -i {src} -vf {vf} … {dst}", flush=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", src, "-vf", vf, "-an", *export_x264(fps, height), dst],
                   cwd=d, check=True)  # fmt: skip


# --- (d) the cuts -----------------------------------------------------------------------------------


def plan_cut(doc: dict, spec: dict) -> list[dict]:
    """The segments in order: shots (source in/out in master.mp4, speed), black slots (footage, the owner
    on camera, a slide made elsewhere; with placeholder captions) and title cards, fitted to max_s."""
    by_id = {s["id"]: s for s in ran(doc["shots"])}
    segs: list[dict] = []
    if spec.get("lead_black_s"):
        segs.append(
            {
                "kind": "black",
                "name": "on camera (open)",
                "s": float(spec["lead_black_s"]),
                "on_camera": True,
            }
        )
    for item in spec["segments"]:
        item = {"shot": item} if isinstance(item, str) else item
        if "slot" in item:
            seg = {"kind": "black", "name": f"slot: {item['slot']}", "s": float(item["s"])}
            if item.get("on_camera"):
                seg["on_camera"] = True
            if item.get("captions"):
                seg["captions"] = list(item["captions"])
            segs.append(seg)
        elif "card" in item:
            segs.append(
                {
                    "kind": "card",
                    "name": f"card: {item['card']}",
                    "s": float(item["s"]),
                    "text": item["text"],
                }
            )
        elif item["shot"] in by_id:
            s = by_id[item["shot"]]
            a, b = span(s)
            speed = float(item.get("speed", 1.0))
            seg = {
                "kind": "shot",
                "name": s["id"],
                "in": a,
                "out": b,
                "speed": speed,
                "s": (b - a) / speed,
            }
            if item.get("label"):
                seg["label"] = item["label"]  # this cut's own label for the shot
            if item.get("min_s"):
                seg["min_s"] = min(float(item["min_s"]), seg["s"])  # never trimmed below this
            segs.append(seg)
        else:
            print(
                f"  {item['shot']}: not in the recording (skipped or failed), left out of the cut"
            )
    if spec.get("tail_black_s"):
        segs.append(
            {
                "kind": "black",
                "name": "on camera (close)",
                "s": float(spec["tail_black_s"]),
                "on_camera": True,
            }
        )
    fixed = sum(x["s"] for x in segs if x["kind"] != "shot")
    moving = sum(x["s"] for x in segs if x["kind"] == "shot")
    room = spec["max_s"] - fixed - 0.5  # half a second of margin for frame rounding
    if moving > room > 0:
        # one factor for every shot, except that none goes under its min_s: those are held there and
        # the others share what is left
        shots = [x for x in segs if x["kind"] == "shot"]
        held: list[dict] = []
        while True:
            free = [x for x in shots if x not in held]
            k = (room - sum(x["min_s"] for x in held)) / (sum(x["s"] for x in free) or 1.0)
            low = [x for x in free if x["s"] * k < x.get("min_s", 0.0)]
            if not low:
                break
            held += low
        for x in shots:
            f = x["min_s"] / x["s"] if x in held else k
            x["s"] *= f
            x["out"] = x["in"] + x["s"] * x["speed"]  # trim from the tail
            x["trimmed"] = round(f, 3)
    t = 0.0
    for x in segs:
        x["at"] = round(t, 3)
        t += x["s"]
        x["s"] = round(x["s"], 3)
    return segs


def cut_events(segs: list[dict], cfg: dict) -> list[tuple]:
    """The cut's captions: each shot's label (or the cut's own), a slot's placeholder captions spread
    evenly over it, and the card, all checked (the disclosure card is the one place its words go)."""
    shots = [
        (x["name"], x["at"], x["at"] + x["s"], x.get("label")) for x in segs if x["kind"] == "shot"
    ]
    events = [(*e, "Label") for e in timed(labels(shots, cfg), cfg)]
    for x in segs:
        if x["kind"] == "card":
            check_words(x["text"], x["name"], disclosure=x["name"] == "card: disclosure")
            if len(x["text"]) > 60 or "\n" in x["text"]:
                raise SystemExit(f"{x['name']}: a card is one line of at most 60 characters")
            events.append((x["at"], x["at"] + x["s"], x["text"], "Card"))
        caps = [fill(c) for c in x.get("captions") or []]
        for i, c in enumerate(caps):
            check_words(c, x["name"])
            a = x["at"] + x["s"] * i / len(caps)
            events += [
                (*e, "Label") for e in timed([(a, a + x["s"] / len(caps), wrap(c, x["name"]))], cfg)
            ]
    return sorted(events, key=lambda e: e[0])


def cut(d: Path, name: str, segs: list[dict], cfg: dict, size: tuple[int, int], fps: float) -> None:
    """The segments from the uncaptioned program, then this cut's own captions and card burned in (the
    site's type through libass), timed to its (sped-up, trimmed) segments. Also `cut_<name>.srt`, the same
    captions for the editor."""
    w, h = size
    events = cut_events(segs, cfg)
    write_srt_events(events, d / f"cut_{name}.srt")
    font = fonts(cfg, d)
    ass(events, cfg, d / f"cut_{name}.ass", font)
    parts, labels_ = [], []
    for i, x in enumerate(segs):
        lab = f"v{i}"
        if x["kind"] in ("black", "card"):
            parts.append(
                f"color=c=black:s={w}x{h}:r={fps:g}:d={x['s']:.3f},format=yuv420p,setsar=1[{lab}]"
            )
        else:
            parts.append(
                f"[0:v]trim=start={x['in']:.3f}:end={x['out']:.3f},setpts=(PTS-STARTPTS)/{x['speed']},fps={fps:g},format=yuv420p,setsar=1[{lab}]"
            )
        labels_.append(f"[{lab}]")
    vf = ass_filter(f"cut_{name}.ass", "fonts" if (d / "fonts").is_dir() else None)
    graph = ";".join(parts) + f";{''.join(labels_)}concat=n={len(segs)}:v=1:a=0[c];[c]{vf}[out]"
    out = d / f"cut_{name}.mp4"
    print(f"  $ (in {d}) ffmpeg -i master.mp4 -filter_complex … {out.name}", flush=True)
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", "master.mp4", "-filter_complex", graph, "-map", "[out]",
         "-an", *export_x264(fps, h), out.name],
        cwd=d,
        check=True,
    )  # fmt: skip
    total = segs[-1]["at"] + segs[-1]["s"]
    (d / f"cut_{name}.json").write_text(
        json.dumps({"video": out.name, "total_s": round(total, 3), "segments": segs}, indent=2)
        + "\n"
    )
    print(f"  {out.name}: {total:.1f} s, {sum(1 for x in segs if x['kind'] == 'shot')} shots")


# --- (c) the GIF ------------------------------------------------------------------------------------


def frames(video: Path, start: float, dur: float, fps: int = 10, size: tuple[int, int] = (96, 54)):
    import numpy as np

    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-i", str(video),
                          "-vf", f"fps={fps},scale={size[0]}:{size[1]},format=gray", "-f", "rawvideo", "-"],
                         capture_output=True, check=True).stdout  # fmt: skip
    return np.frombuffer(raw, np.uint8).reshape(-1, size[1], size[0]).astype(float)


def gif_source(
    doc: dict, d: Path, name: str
) -> tuple[Path, Callable[[dict], tuple[float, float]], float, str]:
    """(video, a shot's span in it, its length, filters to put first) for a GIF source: ``capture`` is the
    4K recording itself (no camera moves, so a frame differs from the one before only where the page
    changed, and the GIF's frame diffs stay small; the sync mark painted out), ``program`` the captioned
    program (its push-ins change every pixel of every frame: several times the size at the same width)."""
    if name == "capture":
        pre = f"{doc['delogo']}," if doc.get("delogo") else ""
        return d / doc["video"], lambda s: (s["start_s"], s["end_s"]), float(doc["total_s"]), pre
    total = float(doc.get("program", {}).get("total_s", doc["total_s"]))
    return d / "master_captioned.mp4", span, total, ""


def pick_loop(
    doc: dict,
    cfg: dict,
    video: Path,
    at: Callable[[dict], tuple[float, float]] = span,
    total: float | None = None,
) -> tuple[float, float, str, float]:
    """(start, duration, shot, end match): the first candidate, in the config's order of preference, with
    enough happening in its window; its end is the frame within duration -2 s .. +slack closest to its
    first frame, never past ``max_s`` (the GIF then fades that end into the first frame, so the loop has
    no jump). A candidate is a shot id or ``{shot, end_aligned, offset_s, min_motion}``: ``end_aligned``
    takes the window that ends with the shot (a short shot then keeps the screen before it instead of
    running into the next page); ``offset_s`` starts the window that far into the shot (a moment inside
    a long shot: `next` from its clue card on)."""
    g = cfg["gif"]
    total = doc.get("program", {}).get("total_s", doc["total_s"]) if total is None else total
    by_id = {s["id"]: s for s in ran(doc["shots"])}
    fade = 0.5
    for c in g["candidates"]:
        c = {"shot": c} if isinstance(c, str) else c
        sid = c["shot"]
        s = by_id.get(sid)
        if not s:
            continue
        a, b = at(s)
        dur = g["duration_s"]
        start, slack = a + c.get("offset_s", 0.5), 2.0
        if c.get("end_aligned"):
            start, slack = max(0.0, b - 0.3 - dur), 0.0
        slack = min(slack, g.get("max_s", 20) + fade - dur)
        if start + dur + slack > total:
            continue
        f = frames(video, start, dur + slack)
        if len(f) < 10 * (dur - 2):
            continue
        motion = float(abs(f[1:] - f[:-1]).mean())
        lo, hi = int(10 * (dur - 2)), min(len(f), int(10 * (dur + slack)) + 1)
        score, i = min((float(abs(f[k] - f[0]).mean()), k) for k in range(lo, hi))
        print(
            f"  gif candidate {sid:10} start {start:6.1f}  motion {motion:5.2f}  end match {score:5.2f} at {i / 10:.1f} s"
        )
        if motion >= c.get("min_motion", g.get("min_motion", 0.5)):
            return start, i / 10, sid, score
    start = at(next(iter(by_id.values())))[0] if by_id else 0.0
    return start, float(g["duration_s"]), "first shot", float("nan")


def encode_gif(
    src: Path, out: Path, start: float, dur: float, fps: int, width: int, colors: int, pre: str = ""
) -> float:
    """One GIF of `dur` s of `src` from `start`, palette-optimised (one palette from the frames' changes,
    ordered dither, only the changed rectangle of each frame stored); its size in MB."""
    fade = 0.5
    # the window from just after its half-second mark, its own first half second (and a frame) faded in
    # over its end: the last frame is the window at `fade` exactly and the loop goes on at the frame after
    # it, so it has no jump (fading back to frame 0 replayed half a second)
    head = fade + 1 / fps
    graph = (
        f"[0:v]{pre}trim=0:{dur:.3f},setpts=PTS-STARTPTS,fps={fps},scale={width}:-2:flags=lanczos,split[a][h];"
        f"[a]trim=start={head:.3f},setpts=PTS-STARTPTS[body];"
        f"[h]trim=0:{head:.3f},setpts=PTS-STARTPTS[head];"
        f"[body][head]xfade=transition=fade:duration={fade}:offset={dur - head - fade:.3f},split[x][y];"
        f"[x]palettegen=max_colors={colors}:stats_mode=diff[p];"
        "[y][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle"
    )
    run(["ffmpeg", "-v", "error", "-y", "-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-i", str(src),
         "-filter_complex", graph, "-loop", "0", str(out)])  # fmt: skip
    return out.stat().st_size / 1e6


def gif(doc: dict, cfg: dict, d: Path) -> bool:
    """``demo.gif`` at the config's fps and width (12 fps, 960 px). Over ``max_mb`` it tries, in order,
    each source (``sources``), a shorter window (``shorten_s``: trimmed from the end) and fewer colours,
    keeping fps and width; false (and the last try left there) if none fits."""
    g = cfg["gif"]
    out = d / "demo.gif"
    fade = 0.5
    fps, width, limit = g["fps"], g["width"], g["max_mb"]
    meta: dict = {}
    for name in g.get("sources", ["program"]):
        src, at, total, pre = gif_source(doc, d, name)
        if not src.exists():
            continue
        start, dur, sid, score = pick_loop(doc, cfg, src, at, total)
        for cut in g.get("shorten_s", [0]):
            if dur - cut - fade < g.get("min_s", 8):
                break
            for colors in g.get("colors", [256]):
                mb = encode_gif(src, out, start, dur - cut, fps, width, colors, pre)
                meta = {"gif": out.name, "source": name, "shot": sid, "source_start_s": round(start, 3),
                        "duration_s": round(dur - cut - fade, 3), "end_match": round(score, 3) if cut == 0 else None,
                        "fps": fps, "width": width, "colors": colors, "mb": round(mb, 2)}  # fmt: skip
                if mb <= limit:
                    (d / "gif.json").write_text(json.dumps(meta, indent=2) + "\n")
                    print(
                        f"  {out}: {mb:.2f} MB, {dur - cut - fade:.1f} s from '{sid}' at {start:.1f} s ({name}, {colors} colours)"
                    )
                    return True
                print(
                    f"  {name} {dur - cut - fade:.1f} s, {colors} colours: {mb:.1f} MB is over {limit} MB"
                )
    if meta:
        (d / "gif.json").write_text(json.dumps(meta, indent=2) + "\n")
    print(f"  {out}: no try fits in {limit} MB at {fps} fps, {width} px", file=sys.stderr)
    return False


# --- main -------------------------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("run", type=Path, help="the run folder record.py wrote")
    ap.add_argument("--config", type=Path, default=HERE / "captions.yaml")
    ap.add_argument("--only", default="mp4,srt,burn,cuts,gif", help="comma-separated steps")
    ap.add_argument("--force", action="store_true", help="redo steps whose outputs are fresh")
    ap.add_argument(
        "--size", help="the program's size, e.g. 2560x1440 (default: captions.yaml's program.size)"
    )
    ap.add_argument(
        "--sample", metavar="SHOT", help="also cut 10 s of the captioned program from SHOT"
    )
    args = ap.parse_args(argv)
    d: Path = args.run
    shots_path, cfgp = d / "shots.json", args.config
    doc = json.loads(shots_path.read_text())
    cfg = yaml.safe_load(cfgp.read_text())
    steps = set(args.only.split(","))
    size = (
        tuple(int(v) for v in args.size.split("x"))
        if args.size
        else tuple(cfg.get("program", {}).get("size", (W, H)))
    )
    suffix = "" if size == (W, H) else f"_{size[1]}p"
    src = d / doc["video"]

    def need(out: Path, *inputs: Path) -> bool:
        if args.force or not fresh(out, *inputs):
            return True
        print(f"  fresh: {out.name}")
        return False

    if "mp4" in steps and need(d / f"master{suffix}.mp4", src, cfgp):
        print(f"master{suffix}.mp4")
        program(doc, cfg, d, size, suffix, shots_path)
        doc = json.loads(shots_path.read_text())
    fps = (doc.get("program") or {}).get("fps") or probe(d / f"master{suffix}.mp4")["fps"]
    if "srt" in steps and need(d / "captions.srt", shots_path, cfgp):
        print("captions.srt")
        write_srt(doc, cfg, d / "captions.srt")
    if "burn" in steps and need(
        d / f"master{suffix}_captioned.mp4", d / f"master{suffix}.mp4", d / "captions.srt"
    ):
        print(f"master{suffix}_captioned.mp4")
        burn(doc, cfg, d, suffix, fps, size[1])
    if suffix:  # the cuts and the GIF are made from the 1080p program
        return 0
    if "cuts" in steps:
        for name, spec in cfg["cuts"].items():
            if need(d / f"cut_{name}.mp4", d / "master.mp4", shots_path, cfgp):
                print(f"cut_{name}.mp4")
                cut(d, name, plan_cut(doc, spec), cfg, size, fps)
    if "gif" in steps and need(d / "demo.gif", d / "master_captioned.mp4", cfgp):
        print("demo.gif")
        gif(doc, cfg, d)  # over max_mb it says so; run.sh --publish then refuses to copy it
    if args.sample:
        sample(doc, d, args.sample, fps)
    return 0


def sample(doc: dict, d: Path, sid: str, fps: float, seconds: float = 10.0) -> None:
    """``sample_<shot>.mp4``: `seconds` of the captioned program from the shot's start, to judge a move."""
    s = next((x for x in doc["shots"] if x["id"] == sid), None)
    if s is None:
        raise SystemExit(f"no shot {sid} in shots.json")
    a = span(s)[0]
    out = d / f"sample_{sid}.mp4"
    run(["ffmpeg", "-v", "error", "-y", "-ss", f"{a:.3f}", "-t", f"{seconds:.3f}", "-i", "master_captioned.mp4",
         "-an", *export_x264(fps, 1080), out.name], cwd=d)  # fmt: skip
    print(f"  {out.name}: {seconds:.0f} s of '{sid}' from {a:.1f} s")


if __name__ == "__main__":
    sys.exit(main())
