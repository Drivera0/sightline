"""From a recorded run (record.py) to the files for the editor and the README:

    uv run --extra video python scripts/demo_video/captions.py runs/video/<timestamp> [--only srt,mp4,burn,cuts,gif] [--force]

In the run folder, from ``master.webm`` + ``shots.json`` + ``captions.yaml`` (next to this script):

- ``captions.srt``: one short burned-in step label per shot that ran (not narration);
- ``master.mp4``: the recording as H.264, CRF 18, 30 fps, the sync mark painted out;
- ``master_captioned.mp4``: the same with the labels burned in;
- ``cut_opencv.mp4`` (<= 5:00) and ``cut_nebius.mp4`` (<= 3:00): silent cuts in each video's story
  order, 12 s of black at the start and 10 s at the end for the on-camera clips, black slots where a
  slide goes; ``cut_<name>.json`` lists every segment with its source and output times;
- ``demo.gif``: 20 s for the README (fps 10, 800 px wide, one palette, < 10 MB), first and last frame
  matched so it loops.

Each step is skipped when its output is newer than its inputs (``--force`` redoes it).
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
FPS = 30
W, H = 1920, 1080


def run(cmd: list[str]) -> None:
    print("  $ " + " ".join(cmd if len(" ".join(cmd)) < 400 else [*cmd[:6], "…"]), flush=True)
    subprocess.run(cmd, check=True)


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


def ran(shots: list[dict]) -> list[dict]:
    return [s for s in shots if s["status"] == "ok" and s["end_s"] - s["start_s"] > 0.5]


# --- (0) the labels ---------------------------------------------------------------------------------


def labels(doc: dict, cfg: dict) -> list[tuple[dict, str]]:
    out, n = [], 0
    for s in ran(doc["shots"]):
        lab = cfg["labels"].get(s["id"])
        if not lab:
            continue
        text = lab["text"]
        if lab.get("number"):
            n += 1
            text = f"{n} · {text}"
        if "clear" in text.lower():
            raise SystemExit(
                f"label for {s['id']} says 'clear': a searched area is 'searched at POD x'"
            )
        out.append((s, text))
    return out


def write_srt(doc: dict, cfg: dict, path: Path) -> None:
    st = cfg["style"]
    lines = []
    for i, (s, text) in enumerate(labels(doc, cfg), 1):
        a, b = s["start_s"] + st["lead_in_s"], s["end_s"] - st["lead_out_s"]
        lines += [str(i), f"{ts(a)} --> {ts(b)}", text, ""]
    path.write_text("\n".join(lines))
    print(f"  wrote {path} ({len(lines) // 4} labels)")


# --- (a, b) the masters -----------------------------------------------------------------------------

X264 = [
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
]


def remux(doc: dict, d: Path) -> None:
    vf = f"{doc.get('delogo', 'null')},fps={FPS},format=yuv420p"
    run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-i",
            str(d / doc["video"]),
            "-vf",
            vf,
            "-an",
            *X264,
            "-r",
            str(FPS),
            str(d / "master.mp4"),
        ]
    )


def burn(cfg: dict, d: Path) -> None:
    # the filter's own quoting: the paths are run-folder relative, so run from there
    style = cfg["style"]["force_style"]
    vf = f"subtitles=captions.srt:force_style='{style}'"
    print(f"  $ (in {d}) ffmpeg -i master.mp4 -vf {vf} … master_captioned.mp4", flush=True)
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-i",
            "master.mp4",
            "-vf",
            vf,
            "-an",
            *X264,
            "master_captioned.mp4",
        ],
        cwd=d,
        check=True,
    )


# --- (d) the cuts -----------------------------------------------------------------------------------


def plan_cut(doc: dict, spec: dict) -> list[dict]:
    """The segments in order: shots (source in/out, speed) and black slots, fitted to max_s."""
    by_id = {s["id"]: s for s in ran(doc["shots"])}
    segs: list[dict] = [{"kind": "black", "name": "on camera (open)", "s": spec["lead_black_s"]}]
    for item in spec["segments"]:
        item = {"shot": item} if isinstance(item, str) else item
        if "slot" in item:
            segs.append({"kind": "black", "name": f"slot: {item['slot']}", "s": float(item["s"])})
        elif item["shot"] in by_id:
            s = by_id[item["shot"]]
            speed = float(item.get("speed", 1.0))
            segs.append({"kind": "shot", "name": s["id"], "in": s["start_s"], "out": s["end_s"], "speed": speed,
                         "s": (s["end_s"] - s["start_s"]) / speed})  # fmt: skip
    segs.append({"kind": "black", "name": "on camera (close)", "s": spec["tail_black_s"]})
    fixed = sum(x["s"] for x in segs if x["kind"] == "black")
    moving = sum(x["s"] for x in segs if x["kind"] == "shot")
    room = spec["max_s"] - fixed - 0.5  # half a second of margin for frame rounding
    if moving > room > 0:
        k = room / moving
        for x in segs:
            if x["kind"] == "shot":
                x["s"] *= k
                x["out"] = x["in"] + x["s"] * x["speed"]  # trim from the tail
                x["trimmed"] = round(k, 3)
    t = 0.0
    for x in segs:
        x["at"] = round(t, 3)
        t += x["s"]
        x["s"] = round(x["s"], 3)
    return segs


def cut(d: Path, name: str, segs: list[dict]) -> None:
    parts, labels_ = [], []
    for i, x in enumerate(segs):
        lab = f"v{i}"
        if x["kind"] == "black":
            parts.append(
                f"color=c=black:s={W}x{H}:r={FPS}:d={x['s']:.3f},format=yuv420p,setsar=1[{lab}]"
            )
        else:
            parts.append(
                f"[0:v]trim=start={x['in']:.3f}:end={x['out']:.3f},setpts=(PTS-STARTPTS)/{x['speed']},fps={FPS},format=yuv420p,setsar=1[{lab}]"
            )
        labels_.append(f"[{lab}]")
    graph = ";".join(parts) + f";{''.join(labels_)}concat=n={len(segs)}:v=1:a=0[out]"
    out = d / f"cut_{name}.mp4"
    run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-i",
            str(d / "master_captioned.mp4"),
            "-filter_complex",
            graph,
            "-map",
            "[out]",
            "-an",
            *X264,
            str(out),
        ]
    )
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


def pick_loop(doc: dict, cfg: dict, video: Path) -> tuple[float, float, str, float]:
    """(start, duration, shot, end match): the first candidate, in the config's order of preference, with
    enough happening in its window; its end is the frame within duration ±2 s closest to its first frame
    (the GIF then fades that end into the first frame, so the loop has no jump)."""
    g = cfg["gif"]
    total = doc["total_s"]
    by_id = {s["id"]: s for s in ran(doc["shots"])}
    for sid in g["candidates"]:
        s = by_id.get(sid)
        if not s:
            continue
        start = s["start_s"] + 0.5
        dur = g["duration_s"]
        if start + dur + 2 > total:
            continue
        f = frames(video, start, dur + 2)
        if len(f) < 10 * (dur - 2):
            continue
        motion = float(abs(f[1:] - f[:-1]).mean())
        lo, hi = 10 * (dur - 2), min(len(f), 10 * (dur + 2))
        score, i = min((float(abs(f[k] - f[0]).mean()), k) for k in range(lo, hi))
        print(
            f"  gif candidate {sid:10} start {start:6.1f}  motion {motion:5.2f}  end match {score:5.2f} at {i / 10:.1f} s"
        )
        if motion >= g.get("min_motion", 0.5):
            return start, i / 10, sid, score
    start = next(iter(by_id.values()))["start_s"] if by_id else 0.0
    return start, float(g["duration_s"]), "first shot", float("nan")


def gif(doc: dict, cfg: dict, d: Path) -> None:
    g = cfg["gif"]
    src = d / "master_captioned.mp4"
    start, dur, sid, score = pick_loop(doc, cfg, src)
    out = d / "demo.gif"
    fade = 0.5
    for fps, width in ((g["fps"], g["width"]), (8, 720), (8, 640), (6, 560)):
        # the window, then its own first half second faded over its end: the last frame is the first
        graph = (
            f"[0:v]trim=0:{dur:.3f},setpts=PTS-STARTPTS,fps={fps},scale={width}:-1:flags=lanczos,split[a][h];"
            f"[h]trim=0:{fade},setpts=PTS-STARTPTS[head];"
            f"[a][head]xfade=transition=fade:duration={fade}:offset={dur - fade:.3f},split[x][y];"
            "[x]palettegen=stats_mode=diff[p];[y][p]paletteuse=dither=bayer:bayer_scale=5"
        )
        run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-y",
                "-ss",
                f"{start:.3f}",
                "-t",
                f"{dur:.3f}",
                "-i",
                str(src),
                "-filter_complex",
                graph,
                "-loop",
                "0",
                str(out),
            ]
        )
        mb = out.stat().st_size / 1e6
        if mb < g["max_mb"]:
            break
        print(f"  {mb:.1f} MB is over {g['max_mb']} MB: smaller")
    meta = {"gif": out.name, "shot": sid, "source_start_s": round(start, 3), "duration_s": round(dur, 3), "end_match": round(score, 3),
            "fps": fps, "width": width, "mb": round(out.stat().st_size / 1e6, 2)}  # fmt: skip
    (d / "gif.json").write_text(json.dumps(meta, indent=2) + "\n")
    print(f"  {out}: {meta['mb']} MB, {dur:.1f} s from '{sid}' at {start:.1f} s")


# --- main -------------------------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("run", type=Path, help="the run folder record.py wrote")
    ap.add_argument("--config", type=Path, default=HERE / "captions.yaml")
    ap.add_argument("--only", default="srt,mp4,burn,cuts,gif", help="comma-separated steps")
    ap.add_argument("--force", action="store_true", help="redo steps whose outputs are fresh")
    args = ap.parse_args(argv)
    d: Path = args.run
    doc = json.loads((d / "shots.json").read_text())
    cfg = yaml.safe_load(args.config.read_text())
    steps = set(args.only.split(","))
    shots, cfgp = d / "shots.json", args.config

    def need(out: Path, *inputs: Path) -> bool:
        if args.force or not fresh(out, *inputs):
            return True
        print(f"  fresh: {out.name}")
        return False

    if "srt" in steps and need(d / "captions.srt", shots, cfgp):
        print("captions.srt")
        write_srt(doc, cfg, d / "captions.srt")
    if "mp4" in steps and need(d / "master.mp4", d / doc["video"]):
        print("master.mp4")
        remux(doc, d)
    if "burn" in steps and need(d / "master_captioned.mp4", d / "master.mp4", d / "captions.srt"):
        print("master_captioned.mp4")
        burn(cfg, d)
    if "cuts" in steps:
        for name, spec in cfg["cuts"].items():
            if need(d / f"cut_{name}.mp4", d / "master_captioned.mp4", shots, cfgp):
                print(f"cut_{name}.mp4")
                cut(d, name, plan_cut(doc, spec))
    if "gif" in steps and need(d / "demo.gif", d / "master_captioned.mp4", cfgp):
        print("demo.gif")
        gif(doc, cfg, d)
    return 0


if __name__ == "__main__":
    sys.exit(main())
