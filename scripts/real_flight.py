"""Real aerial footage through the live API, honestly (docs/REAL_FLIGHT.md).

    uv run python scripts/real_flight.py inspect FOLDER [--height-m 40]
    uv run python scripts/real_flight.py frames VIDEO [--srt FILE | --log FILE] --every 2s --out DIR
    uv run python scripts/real_flight.py run FOLDER --api URL [--mission NAME --lkp LAT,LON]
    uv run python scripts/real_flight.py run FOLDER --offline
    uv run python scripts/real_flight.py label FOLDER --source "..." --permission "..."

The footage may come as (1) drone JPEGs with GPS and DJI XMP, (2) a drone video with its ``.SRT``
or a flight log, (3) phone photos with plain EXIF GPS. ``inspect`` says which each file is and
whether it can go to the API as-is; ``frames`` turns a video into geotagged JPEGs (a frame with no
track point within 1 s is skipped and counted: a position is never invented); ``run`` sends the
photos in capture order through the same client path as ``python -m sightline.client watch`` and
writes ``runs/real_flight/<ts>/report.md`` and ``report.json``; ``label`` writes the folder's
``provenance.json`` that the report cites. Any screenshot of a run is labelled "real flight, real
detector, fleet simulated".

With ``SIGHTLINE_API_TOKEN`` set (an API that wants a write token), every write sends it.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import time
from collections import Counter
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any

from sightline.geo.geotag import (
    MATCH_TOLERANCE_S,
    PhotoMeta,
    Track,
    course_deg,
    looks_reencoded,
    nearest,
    parse_flight_log,
    parse_srt,
    read_photo_meta,
    recording_starts,
    write_geotag,
)

ROOT = Path(__file__).resolve().parents[1]
RUNS = ROOT / "runs" / "real_flight"
LABEL = "real flight, real detector, fleet simulated"
PROVENANCE = "provenance.json"
GEOTAG_MANIFEST = "geotag.json"
PHOTO_EXT = {".jpg", ".jpeg"}
VIDEO_EXT = {".mp4", ".mov", ".mkv", ".avi", ".m4v"}
LOG_EXT = {".csv"}
FRAME_W, FRAME_H = 1000, 750  # the API's display frame (sightline/mission/pipeline.py)
TOP_CROPS = 5

Out = Callable[[str], None]


def say(line: str = "") -> None:
    print(line, flush=True)


# --- inspect ------------------------------------------------------------------------------------


def _fmt(v: float | None, unit: str = "", nd: int = 1) -> str:
    return "—" if v is None else f"{v:.{nd}f}{unit}"


def photo_verdict(meta: PhotoMeta) -> tuple[str, str]:
    """``(verdict, why)``: "usable as-is", "needs geotag from log" or "unusable"."""
    if meta.error:
        return "unusable", meta.error
    if meta.gps_zero:
        return "unusable", "GPS is 0,0 (no fix, or stripped by an app): ask for the original file"
    missing = meta.missing_for_api()
    if not missing and meta.nadir:
        return "usable as-is", "GPS, relative altitude, gimbal and focal length all present"
    if not missing:
        return (
            "unusable",
            (
                f"camera not pointing down (gimbal pitch {meta.pitch_deg:.0f}°): the map can't place "
                "it; the detector can still look at it (run --offline)"
            ),
        )
    if not meta.has_exif:
        why = looks_reencoded(meta) or "no EXIF at all"
        return "unusable", f"{why}; ask for the original file (USB or cloud link, not a messenger)"
    if not meta.has_gps:
        if meta.captured_dt():
            return (
                "needs geotag from log",
                f"no GPS; capture time {meta.captured_at} can be matched to a flight log",
            )
        return "unusable", "no GPS and no capture time: nothing to match a log against"
    phone = meta.rel_alt_m is None and meta.yaw_deg is None
    kind = "phone-style photo: GPS but no drone pose" if phone else "GPS but no full drone pose"
    return (
        "needs geotag from log",
        (
            f"{kind} (missing {', '.join(missing)}); `run --height-m H --assume-nadir` sends it with "
            "owner-stated values, else the detector only"
        ),
    )


def _ffprobe(path: Path) -> dict | None:
    if not shutil.which("ffprobe"):
        return None
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)],
        check=False,
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        return None
    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError:
        return None


def sibling_srt(video: Path) -> Path | None:
    for p in video.parent.iterdir():
        if p.stem == video.stem and p.suffix.lower() == ".srt":
            return p
    return None


def inspect_folder(folder: Path, height_m: float | None = None) -> dict:
    """Every file with its type, metadata, GSD and verdict; the flight's span; warnings."""
    files: list[dict] = []
    photos: list[PhotoMeta] = []
    for path in sorted(p for p in folder.iterdir() if p.is_file()):
        if path.name in (PROVENANCE, GEOTAG_MANIFEST) or path.name.startswith("."):
            continue
        ext = path.suffix.lower()
        row: dict[str, Any] = {"file": path.name, "bytes": path.stat().st_size}
        if ext in PHOTO_EXT:
            meta = read_photo_meta(path)
            photos.append(meta)
            g, gsrc = meta.gsd_m(height_m)
            verdict, why = photo_verdict(meta)
            row |= {
                "type": "photo (JPEG)",
                "size_px": [meta.width, meta.height],
                "lat": meta.lat,
                "lon": meta.lon,
                "gps_alt_m": meta.gps_alt_m,
                "rel_alt_m": meta.rel_alt_m,
                "gimbal_yaw_deg": meta.yaw_deg,
                "gimbal_pitch_deg": meta.pitch_deg,
                "f35_mm": meta.f35_mm,
                "focal_mm": meta.focal_mm,
                "camera": " ".join(x for x in (meta.make, meta.model) if x) or None,
                "captured_at": meta.captured_at,
                "gsd_cm": None if g is None else round(g * 100, 2),
                "gsd_from": gsrc,
                "verdict": verdict,
                "why": why,
            }
        elif ext in VIDEO_EXT:
            probe = _ffprobe(path)
            srt = sibling_srt(path)
            subs = [
                s for s in (probe or {}).get("streams", []) if s.get("codec_type") == "subtitle"
            ]
            fmt = (probe or {}).get("format", {})
            row |= {
                "type": "video",
                "duration_s": _float(fmt.get("duration")),
                "created": (fmt.get("tags") or {}).get("creation_time"),
                "srt": srt.name if srt else None,
                "embedded_subtitles": len(subs),
            }
            if srt or subs:
                src = f"--srt {srt.name}" if srt else "its embedded subtitle track"
                row |= {
                    "verdict": "needs geotag from log",
                    "why": f"cut frames with `frames {path.name}` (positions from {src})",
                }
            else:
                note = "" if probe else " (ffprobe missing or failed: subtitle track not checked)"
                row |= {
                    "verdict": "needs geotag from log",
                    "why": f"no .SRT next to it{note}: get the .SRT or the flight log "
                    "(Airdata / DJI Fly CSV) and run `frames --log`",
                }
        elif ext == ".srt":
            track = parse_srt(path.read_text(errors="replace"))
            row |= _track_row(track, "subtitle track (DJI SRT)")
        elif ext in LOG_EXT:
            try:
                track = parse_flight_log(path.read_text(errors="replace"))
                row |= _track_row(track, f"flight log ({track.source})")
            except ValueError as e:
                row |= {"type": "CSV", "verdict": "unusable", "why": str(e)}
        elif ext == ".dng":
            row |= {"type": "RAW (DNG)", "verdict": "unusable", "why": "export a JPEG from it"}
        else:
            row |= {"type": "other", "verdict": "unusable", "why": "not a photo, video or log"}
        files.append(row)
    return {
        "folder": str(folder),
        "files": files,
        "span": flight_span(photos),
        "warnings": strip_warnings(photos),
    }


def _float(v: Any) -> float | None:
    try:
        return round(float(v), 2)
    except (TypeError, ValueError):
        return None


def _track_row(track: Track, kind: str) -> dict:
    pts = track.points
    row: dict[str, Any] = {"type": kind, "records": len(pts), "no_fix_records": track.skipped}
    if not pts:
        return row | {"verdict": "unusable", "why": "no record has a position"}
    alts = [p.rel_alt_m for p in pts if p.rel_alt_m is not None]
    row |= {
        "duration_s": round(pts[-1].t_s - pts[0].t_s, 1),
        "bbox": _bbox([(p.lat, p.lon) for p in pts]),
        "rel_alt_m": [round(min(alts), 1), round(max(alts), 1)] if alts else None,
        "has_gimbal_yaw": any(p.yaw_deg is not None for p in pts),
        "has_gimbal_pitch": any(p.pitch_deg is not None for p in pts),
        "notes": track.notes,
        "verdict": "flight log",
        "why": "positions for `frames`",
    }
    return row


def _bbox(pts: list[tuple[float, float]]) -> list[float] | None:
    if not pts:
        return None
    lats, lons = [p[0] for p in pts], [p[1] for p in pts]
    return [round(min(lats), 6), round(min(lons), 6), round(max(lats), 6), round(max(lons), 6)]


def flight_span(photos: list[PhotoMeta]) -> dict:
    with_gps = [m for m in photos if m.has_gps and not m.gps_zero]
    times = sorted(t for m in photos if (t := m.captured_dt()))
    return {
        "photos": len(photos),
        "with_gps": len(with_gps),
        "bbox_lat_lon": _bbox([(m.lat, m.lon) for m in with_gps]),  # type: ignore[misc]
        "first": times[0].isoformat(sep=" ") if times else None,
        "last": times[-1].isoformat(sep=" ") if times else None,
        "duration_s": (times[-1] - times[0]).total_seconds() if times else None,
    }


def strip_warnings(photos: list[PhotoMeta]) -> list[str]:
    out: list[str] = []
    readable = [m for m in photos if not m.error]
    if not readable:
        return out
    zero = [m.path.name for m in readable if m.gps_zero]
    missing = [m.path.name for m in readable if not m.has_gps]
    if len(missing) == len(readable):
        out.append(f"GPS looks stripped: none of the {len(readable)} photos has GPS")
    elif missing:
        out.append(f"{len(missing)} of {len(readable)} photos have no GPS: {_few(missing)}")
    if zero:
        out.append(f"GPS is 0,0 in {len(zero)} photos (stripped or no fix): {_few(zero)}")
    reenc = [f"{m.path.name} ({why})" for m in readable if (why := looks_reencoded(m))]
    if reenc:
        out.append(f"{len(reenc)} photos look re-encoded by a messenger app: {_few(reenc, 2)}")
    return out


def _few(names: list[str], n: int = 4) -> str:
    return ", ".join(names[:n]) + (f" and {len(names) - n} more" if len(names) > n else "")


def print_inspect(report: dict, out: Out = say) -> None:
    out(f"{report['folder']}: {len(report['files'])} files")
    for f in report["files"]:
        out(f"\n{f['file']}  [{f['type']}]  {f['bytes'] / 1e6:.1f} MB")
        if f["type"].startswith("photo"):
            out(
                f"  GPS {_fmt(f['lat'], '', 6)}, {_fmt(f['lon'], '', 6)}"
                f"  alt {_fmt(f['gps_alt_m'], ' m')}  rel_alt {_fmt(f['rel_alt_m'], ' m')}"
                f"  gimbal yaw {_fmt(f['gimbal_yaw_deg'], '°')} pitch {_fmt(f['gimbal_pitch_deg'], '°')}"
            )
            gsd = f["gsd_from"] if f["gsd_cm"] is None else f"{f['gsd_cm']} cm/px ({f['gsd_from']})"
            out(
                f"  {f['size_px'][0]}×{f['size_px'][1]} px  f35 {_fmt(f['f35_mm'], ' mm', 0)}"
                f"  focal {_fmt(f['focal_mm'], ' mm')}  {f['camera'] or 'camera ?'}"
                f"  taken {f['captured_at'] or '?'}  GSD {gsd}"
            )
        elif f["type"] == "video":
            out(
                f"  {_fmt(f['duration_s'], ' s')}  created {f['created'] or '?'}  "
                f"SRT {f['srt'] or 'none'}  embedded subtitle streams {f['embedded_subtitles']}"
            )
        elif "records" in f:
            out(
                f"  {f['records']} records ({f['no_fix_records']} without a fix)"
                f"  {_fmt(f.get('duration_s'), ' s')}  bbox {f.get('bbox')}"
                f"  rel_alt {f.get('rel_alt_m')}  gimbal yaw {f.get('has_gimbal_yaw')}"
                f" pitch {f.get('has_gimbal_pitch')}"
            )
            for n in f.get("notes") or []:
                out(f"  note: {n}")
        out(f"  -> {f['verdict']}: {f['why']}")
    s = report["span"]
    out(
        f"\nflight: {s['photos']} photos, {s['with_gps']} with GPS, bbox {s['bbox_lat_lon']}, "
        f"{s['first'] or '?'} to {s['last'] or '?'}"
        + ("" if s["duration_s"] is None else f" ({s['duration_s']:.0f} s)")
    )
    counts: dict[str, int] = {}
    for f in report["files"]:
        counts[f["verdict"]] = counts.get(f["verdict"], 0) + 1
    out("verdicts: " + ", ".join(f"{v} {n}" for v, n in counts.items()))
    for w in report["warnings"]:
        out(f"WARNING: {w}")


# --- frames -------------------------------------------------------------------------------------


def parse_every(text: str) -> float:
    m = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*(s|sec|ms)?\s*", text)
    if not m:
        raise argparse.ArgumentTypeError(f"--every {text!r}: give seconds, e.g. 2s or 0.5")
    v = float(m.group(1)) / (1000 if m.group(2) == "ms" else 1)
    if v <= 0:
        raise argparse.ArgumentTypeError("--every must be positive")
    return v


def extract_frames(video: Path, every_s: float, tmp: Path) -> list[tuple[Path, float]]:
    """JPEGs at least ``every_s`` apart with their exact presentation times (ffmpeg ``select`` +
    ``showinfo``)."""
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg not found: install it (apt install ffmpeg)")
    tmp.mkdir(parents=True, exist_ok=True)
    expr = f"select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,{every_s})',showinfo"
    r = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostdin", "-y", "-i", str(video), "-vf", expr,
         "-fps_mode", "vfr", "-q:v", "2", str(tmp / "%06d.jpg")],
        check=False, capture_output=True, text=True,
    )  # fmt: skip
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {r.stderr.strip().splitlines()[-1:]}")
    times = [float(t) for t in re.findall(r"showinfo.*?pts_time:\s*([-\d.]+)", r.stderr)]
    files = sorted(tmp.glob("*.jpg"))
    if len(files) != len(times):
        raise RuntimeError(f"ffmpeg wrote {len(files)} frames but reported {len(times)} times")
    return list(zip(files, times, strict=True))


def embedded_srt(video: Path) -> str | None:
    """The video's first subtitle stream as SRT text (DJI writes the telemetry there too)."""
    if not shutil.which("ffmpeg"):
        return None
    r = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-i", str(video),
         "-map", "0:s:0", "-f", "srt", "-"],
        check=False, capture_output=True, text=True,
    )  # fmt: skip
    return r.stdout if r.returncode == 0 and "-->" in r.stdout else None


def geotag_frames(
    frames: list[tuple[Path, float]],
    track: Track,
    out_dir: Path,
    stem: str,
    *,
    offset_s: float = 0.0,
    heading: float | None = None,
    assume_nadir: bool = False,
    f35: float | None = None,
    height_m: float | None = None,
    tol_s: float = MATCH_TOLERANCE_S,
) -> dict:
    """Write each frame with a track point within ``tol_s`` as a geotagged JPEG in ``out_dir``;
    skip and count the rest. Returns the manifest (``geotag.json``)."""
    written, skipped = [], []
    lenses = Counter(p.f35_mm for p in track.points if p.f35_mm)
    video_lens = lenses.most_common(1)[0][0] if lenses else None  # some cues leave it out
    for src, t in frames:
        p = nearest(track, offset_s + t, tol_s)
        if p is None:
            skipped.append({"t_s": round(t, 3), "reason": f"no track point within {tol_s:g} s"})
            continue
        sources = {"lat": "measured", "lon": "measured"}
        rel = p.rel_alt_m
        sources["rel_alt_m"] = "measured" if rel is not None else "missing"
        if rel is None and height_m is not None:
            rel, sources["rel_alt_m"] = height_m, "owner-stated (--height-m)"
        yaw = p.yaw_deg
        sources["yaw_deg"] = "measured" if yaw is not None else "missing"
        if yaw is None and (c := course_deg(track, offset_s + t)) is not None:
            yaw, sources["yaw_deg"] = c, "derived (course over ground from the track)"
        if yaw is None and heading is not None:
            yaw, sources["yaw_deg"] = heading, "owner-stated (--heading)"
        pitch = p.pitch_deg
        sources["pitch_deg"] = "measured" if pitch is not None else "missing"
        if pitch is None and assume_nadir:
            pitch, sources["pitch_deg"] = -90.0, "owner-stated (--assume-nadir)"
        lens = f35 if f35 is not None else (p.f35_mm or video_lens)
        sources["f35_mm"] = (
            "owner-stated (--f35)"
            if f35 is not None
            else ("measured (SRT focal_len)" if lens is not None else "missing")
        )
        name = f"{stem}_{round(t * 1000):08d}ms.jpg"
        derived = "; ".join(f"{k}: {v}" for k, v in sources.items() if not v.startswith("measured"))
        write_geotag(
            src,
            out_dir / name,
            lat=p.lat,
            lon=p.lon,
            rel_alt_m=rel,
            abs_alt_m=p.abs_alt_m,
            yaw_deg=yaw,
            pitch_deg=pitch,
            f35_mm=lens,
            when=p.when,
            notes={"Source": f"{track.source}, video t={t:.3f} s", "NotMeasured": derived},
        )
        written.append(
            {
                "file": name,
                "t_s": round(t, 3),
                "track_t_s": round(p.t_s, 3),
                "lat": p.lat,
                "lon": p.lon,
                "rel_alt_m": rel,
                "yaw_deg": None if yaw is None else round(yaw, 1),
                "pitch_deg": pitch,
                "f35_mm": lens,
                "sources": sources,
            }
        )
    return {"frames": written, "skipped": skipped}


def cmd_frames(args: argparse.Namespace, out: Out = say) -> int:
    video: Path = args.video
    if args.srt and args.log:
        raise SystemExit("give --srt or --log, not both")
    offset = 0.0
    if args.log:
        track = parse_flight_log(args.log.read_text(errors="replace"))
        src = f"{track.source} {args.log.name}"
        if args.log_offset is not None:
            offset = args.log_offset
        else:
            starts = recording_starts(track)
            if not starts:
                raise SystemExit(
                    "the log has no isVideo column (or no recording): give --log-offset S, the "
                    "log time in seconds at which the video starts"
                )
            k = args.clip - 1
            if not 0 <= k < len(starts):
                raise SystemExit(f"--clip {args.clip}: the log has {len(starts)} recordings")
            offset = starts[k]
            if len(starts) > 1:
                out(f"the log has {len(starts)} recordings; using no. {args.clip} (--clip)")
    else:
        srt_path = args.srt or sibling_srt(video)
        if srt_path is not None:
            text, src = srt_path.read_text(errors="replace"), f"SRT {srt_path.name}"
        elif (text := embedded_srt(video)) is not None:
            src = f"subtitle track of {video.name}"
        else:
            raise SystemExit(
                f"no --srt, no .SRT next to {video.name}, no subtitle track: give --log"
            )
        track = parse_srt(text)
    if not track.points:
        raise SystemExit(f"{src}: no record has a position")
    out(f"track: {src}: {len(track.points)} points ({track.skipped} without a fix)")
    args.out.mkdir(parents=True, exist_ok=True)
    tmp = args.out / ".frames_tmp"
    try:
        frames = extract_frames(video, args.every, tmp)
        manifest = geotag_frames(
            frames,
            track,
            args.out,
            video.stem,
            offset_s=offset,
            heading=args.heading,
            assume_nadir=args.assume_nadir,
            f35=args.f35,
            height_m=args.height_m,
        )
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    manifest = {
        "video": video.name,
        "track": src,
        "every_s": args.every,
        "log_offset_s": offset if args.log else None,
        "tolerance_s": MATCH_TOLERANCE_S,
        "extracted": len(frames),
        "written": len(manifest["frames"]),
        "skipped_count": len(manifest["skipped"]),
        **manifest,
    }
    (args.out / GEOTAG_MANIFEST).write_text(json.dumps(manifest, indent=1))
    out(
        f"{len(frames)} frames cut every {args.every:g} s: {manifest['written']} geotagged, "
        f"{manifest['skipped_count']} skipped (no track point within {MATCH_TOLERANCE_S:g} s)"
    )
    not_measured = sorted(
        {
            f"{k}: {v}"
            for f in manifest["frames"]
            for k, v in f["sources"].items()
            if not v.startswith("measured")
        }
    )
    for line in not_measured:
        out(f"  not measured: {line}")
    if manifest["frames"] and any(
        f["sources"]["pitch_deg"] == "missing" for f in manifest["frames"]
    ):
        out(
            "  the API needs a gimbal pitch: if the camera pointed straight down, run again with "
            "--assume-nadir (recorded as owner-stated)"
        )
    out(f"wrote {args.out}")
    return 0


# --- run --------------------------------------------------------------------------------------------


def capture_order(paths: list[Path]) -> list[tuple[Path, PhotoMeta]]:
    metas = [(p, read_photo_meta(p)) for p in paths]
    return sorted(metas, key=lambda pm: (pm[1].captured_dt() or datetime.max, pm[0].name))


def stage_photo(
    meta: PhotoMeta,
    staged: Path,
    *,
    height_m: float | None,
    assume_nadir: bool,
    heading: float | None,
    f35: float | None,
) -> tuple[Path | None, str]:
    """A copy the API accepts for a photo with GPS but no drone pose, filled only with values the
    owner stated (``--height-m``, ``--assume-nadir``, ``--heading``/EXIF direction, ``--f35``);
    ``(None, why not)`` when one is missing."""
    yaw = meta.yaw_deg if meta.yaw_deg is not None else meta.img_direction_deg
    if yaw is None:
        yaw = heading
    need = {
        "--height-m": meta.rel_alt_m is not None or height_m is not None,
        "--assume-nadir": meta.pitch_deg is not None or assume_nadir,
        "--heading (no compass direction in EXIF)": yaw is not None,
        "--f35": meta.f35_mm is not None or f35 is not None,
    }
    lacking = [k for k, ok in need.items() if not ok]
    if lacking or not meta.has_gps or meta.gps_zero:
        return None, "detector only: no drone pose (give " + ", ".join(lacking) + ")"
    pitch = meta.pitch_deg if meta.pitch_deg is not None else -90.0
    if abs(pitch + 90) > 10:
        return None, f"detector only: camera not pointing down (pitch {pitch:.0f}°)"
    out = staged / meta.path.name
    write_geotag(
        meta.path,
        out,
        lat=meta.lat,  # type: ignore[arg-type]
        lon=meta.lon,  # type: ignore[arg-type]
        rel_alt_m=meta.rel_alt_m if meta.rel_alt_m is not None else height_m,
        abs_alt_m=meta.gps_alt_m,
        yaw_deg=yaw,
        pitch_deg=pitch,
        f35_mm=meta.f35_mm if meta.f35_mm is not None else f35,
        when=meta.captured_dt(),
        notes={"Source": f"{meta.path.name}, pose completed from values the owner stated"},
    )
    return out, "sent with owner-stated pose values"


def _upload_one(http, mission_id: str, path: Path, sleep: Callable[[float], None]) -> dict:
    import httpx

    from sightline.client import upload

    for _ in range(6):
        try:
            return upload(http, mission_id, [path])
        except httpx.HTTPStatusError as e:
            if e.response.status_code != 429:
                raise
            sleep(float(e.response.headers.get("Retry-After", "5")))
    raise RuntimeError("rate limited six times in a row")


def _get(http, path: str) -> Any:
    from sightline.client import _call

    return _call(http, "GET", path).json()


def run_api(
    http,
    folder: Path,
    *,
    mission_id: str | None = None,
    name: str | None = None,
    lkp: tuple[float, float] | None = None,
    height_m: float | None = None,
    assume_nadir: bool = False,
    heading: float | None = None,
    f35: float | None = None,
    pace_s: float = 0.0,
    wait_s: float = 600.0,
    proposal_wait_s: float = 60.0,
    out_dir: Path,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
    out: Out = say,
) -> dict:
    """Send the folder's photos to a live API in capture order and collect what it made of them."""
    from sightline.api.limits import MAX_PHOTO_BYTES
    from sightline.client import create_mission

    paths = [p for p in folder.iterdir() if p.suffix.lower() in PHOTO_EXT and p.is_file()]
    if not paths:
        raise SystemExit(f"no JPEG in {folder}")
    ordered = capture_order(paths)
    to_send: list[tuple[Path, Path, PhotoMeta]] = []  # (original, file to send, meta)
    not_sent: list[dict] = []
    for p, meta in ordered:
        verdict, why = photo_verdict(meta)
        if p.stat().st_size > MAX_PHOTO_BYTES:
            not_sent.append({"name": p.name, "reason": f"over {MAX_PHOTO_BYTES / 1e6:g} MB"})
        elif verdict == "usable as-is":
            to_send.append((p, p, meta))
        elif meta.has_gps and not meta.gps_zero and not meta.error:
            staged, why2 = stage_photo(
                meta,
                out_dir / "staged",
                height_m=height_m,
                assume_nadir=assume_nadir,
                heading=heading,
                f35=f35,
            )
            if staged:
                to_send.append((p, staged, meta))
            else:
                not_sent.append({"name": p.name, "reason": why2})
        else:
            not_sent.append({"name": p.name, "reason": f"{verdict}: {why}"})
    if not to_send:
        raise SystemExit(
            "no photo the API can place; `inspect` says why, `run --offline` runs the detector"
        )
    lkp_note = "given (--lkp)"
    if mission_id is None:
        if lkp is None:
            m = to_send[0][2]
            lkp, lkp_note = (m.lat, m.lon), "the first photo's position (no --lkp given)"  # type: ignore[assignment]
        title = name or f"Real flight: {folder.name}"
        mission_id = create_mission(http, title, lkp, area_name=f"Real flight ({folder.name})")
        out(f"mission {mission_id}: {title} (last-known point: {lkp_note})")
    else:
        lkp_note = "existing mission"

    t0 = clock()
    accepted: dict[str, str] = {}  # original name -> upload id
    rejected: list[dict] = []
    for i, (orig, send, _meta) in enumerate(to_send):
        ts = clock()
        r = _upload_one(http, mission_id, send, sleep)
        if r["accepted"]:
            accepted[orig.name] = r["accepted"][0]
            out(f"{r['accepted'][0]}  {orig.name}  {round((clock() - ts) * 1000)} ms")
        else:
            rejected.append({"name": orig.name, "reason": r["rejected"][0]["reason"]})
            out(f"rejected {orig.name}: {r['rejected'][0]['reason']}")
        if pace_s and i < len(to_send) - 1:
            sleep(max(0.0, pace_s - (clock() - ts)))

    timings: dict[str, float | None] = {"first_frame_s": None, "first_detection_s": None}
    timings["first_proposal_s"] = None
    failed: list[str] = []
    end = clock() + wait_s
    done_at: float | None = None
    while True:
        survey = _get(http, f"/missions/{mission_id}/survey")
        dets = _get(http, f"/missions/{mission_id}/detections")
        state = _get(http, f"/missions/{mission_id}/state")
        now = clock()
        if survey["frames"] and timings["first_frame_s"] is None:
            timings["first_frame_s"] = round(now - t0, 1)
        if any(dets.get("frames", {}).values()) and timings["first_detection_s"] is None:
            timings["first_detection_s"] = round(now - t0, 1)
        if state["proposals"] and timings["first_proposal_s"] is None:
            timings["first_proposal_s"] = round(now - t0, 1)
        trace = _get(http, f"/missions/{mission_id}/trace")
        failed = [
            e["summary"] for e in trace if str(e.get("summary", "")).startswith("photo.failed")
        ]
        processed = len(survey["frames"]) + len(failed) >= len(accepted)
        if processed and done_at is None:
            done_at = now
            out(f"processed: {len(survey['frames'])} frames, {len(failed)} failed")
        if timings["first_proposal_s"] is not None and processed:
            break
        if done_at is not None and now - done_at >= proposal_wait_s:
            break
        if now >= end:
            out(f"gave up waiting after {wait_s:g} s")
            break
        sleep(1.0)

    by_frame = {f["id"]: f for f in survey["frames"]}
    sizes = {orig.name: (m.width, m.height) for orig, _s, m in to_send}
    photos = []
    all_dets = []
    for fid, frame in by_frame.items():
        name_ = frame["source"]["image"]
        w, h = sizes.get(name_, (FRAME_W, FRAME_H))
        rows = []
        for d in dets.get("frames", {}).get(fid, []):
            x1, y1, x2, y2 = d["box_px"]
            row = {
                "id": d["id"],
                "score": d["conf"],
                "box_frame_px": [x2 - x1, y2 - y1],
                "box_photo_px": [round((x2 - x1) * w / FRAME_W), round((y2 - y1) * h / FRAME_H)],
                "lat": d.get("lat"),
                "lon": d.get("lon"),
                "crop": d.get("crop"),
            }
            rows.append(row)
            all_dets.append((row, name_, d["box_px"], (w, h)))
        photos.append(
            {"name": name_, "frame": fid, "gsd_m": frame["pose"]["gsd_m"], "detections": rows}
        )
    crops = save_crops(
        all_dets,
        folder,
        out_dir / "crops",
        fetch=lambda rel: _fetch_file(http, mission_id, rel),
    )
    proposals = [
        {k: p.get(k) for k in ("id", "kind", "summary", "status", "created_by", "created_at")}
        for p in state["proposals"]
    ]
    health = _get(http, "/health")
    return {
        "mode": "api",
        "detector": health.get("backend"),
        "mission_id": mission_id,
        "lkp": list(lkp) if lkp else None,
        "lkp_from": lkp_note,
        "photos_found": len(paths),
        "photos_sent": len(to_send),
        "accepted": len(accepted),
        "rejected": rejected,
        "failed": failed,
        "not_sent": not_sent,
        "photos": photos,
        "top_crops": crops,
        "proposals": proposals,
        "timings_s": timings,
    }


def _fetch_file(http, mission_id: str, rel: str) -> bytes | None:
    from sightline.client import Offline, _call

    try:
        return _call(http, "GET", f"/missions/{mission_id}/files/{rel}").content
    except (Offline, Exception):  # noqa: BLE001 - a missing crop is cut locally instead
        return None


def save_crops(
    dets: list[tuple[dict, str, list[int], tuple[int, int]]],
    folder: Path,
    crop_dir: Path,
    fetch: Callable[[str], bytes | None] | None = None,
    frame_px: bool = True,
) -> list[dict]:
    """The ``TOP_CROPS`` highest-scoring detections as JPEGs: the server's crop when it made one,
    else cut here from the original photo (``sightline.ml.crops.make_crop``)."""
    from sightline.ml.crops import make_crop
    from sightline.ml.types import Box

    crop_dir.mkdir(parents=True, exist_ok=True)
    out = []
    top = sorted(dets, key=lambda d: -d[0]["score"])[:TOP_CROPS]
    for k, (row, name, box, (w, h)) in enumerate(top, 1):
        path = crop_dir / f"{k}_{row['id']}_{row['score']:.2f}.jpg"
        data = fetch(row["crop"]) if fetch and row.get("crop") else None
        if data:
            path.write_bytes(data)
            how = "server crop"
        else:
            sx, sy = (w / FRAME_W, h / FRAME_H) if frame_px else (1.0, 1.0)
            b = Box(round(box[0] * sx), round(box[1] * sy), round(box[2] * sx), round(box[3] * sy))
            make_crop(folder / name, b, path)
            how = "cut locally from the original"
        out.append(
            {"file": str(path.relative_to(crop_dir.parent)), "photo": name, "how": how, **row}
        )
    return out


def run_offline(folder: Path, *, out_dir: Path, detector=None, out: Out = say) -> dict:
    """The detector on this machine on every JPEG, no server: a quick check."""
    from sightline.mission.store import SAVE_THRESHOLD

    if detector is None:
        from sightline.ml.backend import make_detector

        detector = make_detector()
    paths = [p for p in folder.iterdir() if p.suffix.lower() in PHOTO_EXT and p.is_file()]
    if not paths:
        raise SystemExit(f"no JPEG in {folder}")
    photos, all_dets, unreadable = [], [], []
    t0 = time.monotonic()
    for p, meta in capture_order(paths):
        if meta.error:
            unreadable.append({"name": p.name, "reason": meta.error})
            continue
        found = detector.detect_tiled(p, conf=SAVE_THRESHOLD)
        rows = []
        for k, d in enumerate(sorted(found, key=lambda d: -d.conf), 1):
            b = d.box
            row = {
                "id": f"{p.stem}-d{k:02d}",
                "score": round(d.conf, 3),
                "box_photo_px": [b.x2 - b.x1, b.y2 - b.y1],
            }
            rows.append(row)
            all_dets.append((row, p.name, [b.x1, b.y1, b.x2, b.y2], (meta.width, meta.height)))
        g, gsrc = meta.gsd_m()
        photos.append({"name": p.name, "gsd_m": g, "gsd_from": gsrc, "detections": rows})
        out(
            f"{p.name}: {len(rows)} detections" + (f", best {rows[0]['score']:.2f}" if rows else "")
        )
    crops = save_crops(all_dets, folder, out_dir / "crops", frame_px=False)
    return {
        "mode": "offline",
        "detector": type(detector).__name__,
        "photos_found": len(paths),
        "photos_sent": 0,
        "not_sent": unreadable,
        "photos": photos,
        "top_crops": crops,
        "proposals": [],
        "timings_s": {"detector_wall_s": round(time.monotonic() - t0, 1)},
    }


def load_provenance(folder: Path) -> dict | None:
    p = folder / PROVENANCE
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text())
    except json.JSONDecodeError:
        return None


def report_md(r: dict) -> str:
    from sightline.mission.store import CANDIDATE_THRESHOLD

    prov = r.get("provenance")
    fake = "fake" in str(r.get("detector", "")).lower()
    lines = [
        f"# Real flight run: {Path(r['folder']).name}",
        "",
        *(
            ["**This run used the fake detector (fixed boxes, no model): not for the take.**", ""]
            if fake
            else []
        ),
        (
            f"**Label for any screenshot: {LABEL}.** The photos are real and the detector is the real "
            "one; no drone fleet flew in this run, and any fleet on screen is simulated."
        ),
        "",
        f"- Folder: `{r['folder']}`",
        f"- Run: {r['started']} ({r['mode']}"
        + (f", mission `{r['mission_id']}` on {r['api']}" if r["mode"] == "api" else "")
        + ")",
        f"- Detector: {r.get('detector') or 'unknown'}",
    ]
    if prov:
        lines.append(
            f"- Source: {prov.get('source')}; permission: {prov.get('permission')} "
            f"(`{PROVENANCE}`, written {prov.get('written_at')})"
        )
        for field_, how in (prov.get("fields") or {}).items():
            lines.append(f"  - {field_}: {how}")
    else:
        lines.append(f"- Source: not labelled (no `{PROVENANCE}`; run `real_flight.py label`)")
    if r["mode"] == "api":
        lines.append(f"- Last-known point: {r['lkp']} ({r['lkp_from']})")
    lines += [
        f"- Photos found {r['photos_found']}, sent {r['photos_sent']}"
        + (
            f", accepted {r['accepted']}, rejected {len(r['rejected'])}, failed {len(r['failed'])}"
            if r["mode"] == "api"
            else ""
        ),
        "",
        "## Timings",
        "",
    ]
    names = {
        "first_frame_s": "first photo sent → first frame on the map",
        "first_detection_s": "first photo sent → first detection",
        "first_proposal_s": "first photo sent → first proposal",
        "detector_wall_s": "detector wall time (all photos)",
    }
    for k, v in r["timings_s"].items():
        lines.append(f"- {names.get(k, k)}: " + ("none seen" if v is None else f"{v} s"))
    lines += [
        "",
        f"## Detections (score ≥ {CANDIDATE_THRESHOLD} is a candidate)",
        "",
        "| Photo | Detection | Score | Box w × h (photo px) | GSD (cm/px) |",
        "|---|---|---|---|---|",
    ]
    for p in r["photos"]:
        g = p.get("gsd_m")
        gs = "unknown" if g is None else f"{g * 100:.2f}"
        if not p["detections"]:
            lines.append(f"| {p['name']} | none | | | {gs} |")
        for d in p["detections"]:
            w, h = d["box_photo_px"]
            lines.append(f"| {p['name']} | {d['id']} | {d['score']:.2f} | {w} × {h} | {gs} |")
    lines += ["", "## Top crops", ""]
    for c in r["top_crops"]:
        lines.append(f"- `{c['file']}`: {c['photo']}, score {c['score']:.2f} ({c['how']})")
    if not r["top_crops"]:
        lines.append("- none: the detector found nothing")
    if r["mode"] == "api":
        lines += ["", "## Proposals on the map", ""]
        for p in r["proposals"]:
            lines.append(
                f"- {p['id']} {p['kind']} ({p['status']}, {p['created_by']}): {p['summary']}"
            )
        if not r["proposals"]:
            lines.append("- none within the wait")
    if r.get("not_sent") or r.get("rejected") or r.get("failed"):
        lines += ["", "## Not on the map", ""]
        for x in r.get("not_sent", []) + r.get("rejected", []):
            lines.append(f"- {x['name']}: {x['reason']}")
        for s in r.get("failed", []):
            lines.append(f"- {s}")
    return "\n".join(lines) + "\n"


def write_report(r: dict, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "report.json").write_text(json.dumps(r, indent=1, default=str))
    (out_dir / "report.md").write_text(report_md(r))


def _latlon(text: str) -> tuple[float, float]:
    try:
        lat, lon = (float(x) for x in text.split(","))
    except ValueError:
        raise argparse.ArgumentTypeError("give LAT,LON, e.g. 49.375,-122.94") from None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise argparse.ArgumentTypeError(f"{text}: not a latitude,longitude")
    return lat, lon


def cmd_run(args: argparse.Namespace, out: Out = say) -> int:
    folder: Path = args.folder
    out_dir = args.out or RUNS / time.strftime("%Y%m%d-%H%M%S")
    started = datetime.now().astimezone().isoformat(timespec="seconds")
    if args.offline:
        r = run_offline(folder, out_dir=out_dir, out=out)
    else:
        if not args.api:
            raise SystemExit("give --api URL, or --offline")
        import httpx

        with httpx.Client(base_url=args.api, timeout=httpx.Timeout(60.0, connect=10.0)) as http:
            r = run_api(
                http,
                folder,
                mission_id=args.mission_id,
                name=args.mission,
                lkp=args.lkp,
                height_m=args.height_m,
                assume_nadir=args.assume_nadir,
                heading=args.heading,
                f35=args.f35,
                pace_s=args.pace,
                wait_s=args.wait_s,
                proposal_wait_s=args.proposal_wait_s,
                out_dir=out_dir,
                out=out,
            )
        r["api"] = args.api
    r |= {"folder": str(folder), "started": started, "label": LABEL}
    r["provenance"] = load_provenance(folder)
    write_report(r, out_dir)
    out(f"\n{report_md(r)}")
    out(f"wrote {out_dir / 'report.md'} and report.json")
    return 0


# --- label ------------------------------------------------------------------------------------------


def field_sources(folder: Path) -> dict[str, str]:
    """For each pose field, how many photos carry it measured (from the camera's own EXIF/XMP) and
    how many got it another way (``geotag.json`` from ``frames``)."""
    manifest = folder / GEOTAG_MANIFEST
    if manifest.is_file():
        frames = json.loads(manifest.read_text()).get("frames", [])
        out: dict[str, str] = {}
        for key in ("lat", "lon", "rel_alt_m", "yaw_deg", "pitch_deg", "f35_mm"):
            counts: dict[str, int] = {}
            for f in frames:
                how = f["sources"].get(key, "missing")
                counts[how] = counts.get(how, 0) + 1
            out[key] = ", ".join(f"{how} in {n}" for how, n in counts.items()) or "no frames"
        out["note"] = (
            f"frames cut from a video; positions from {json.loads(manifest.read_text())['track']}"
        )
        return out
    metas = [read_photo_meta(p) for p in sorted(folder.iterdir()) if p.suffix.lower() in PHOTO_EXT]
    n = len(metas)
    have = {
        "lat/lon (EXIF GPS)": sum(m.has_gps and not m.gps_zero for m in metas),
        "relative altitude (DJI XMP)": sum(m.rel_alt_m is not None for m in metas),
        "gimbal yaw (DJI XMP)": sum(m.yaw_deg is not None for m in metas),
        "gimbal pitch (DJI XMP)": sum(m.pitch_deg is not None for m in metas),
        "35 mm focal length (EXIF)": sum(m.f35_mm is not None for m in metas),
        "capture time (EXIF)": sum(m.captured_dt() is not None for m in metas),
    }
    out = {k: f"measured in {v} of {n} photos" for k, v in have.items()}
    out["derived"] = (
        "ground sampling distance and footprints are computed from altitude and focal length; "
        "anything a `run --height-m/--assume-nadir/--heading` adds is owner-stated, per photo, in "
        "the run's report"
    )
    return out


def cmd_label(args: argparse.Namespace, out: Out = say, ask: Callable[[str], str] = input) -> int:
    folder: Path = args.folder
    source = args.source or ask("Source (e.g. friend's DJI Mini 3, Lynn Canyon, 2026-10-18): ")
    permission = args.permission or ask("Permission / licence line (as the owner gave it): ")
    if not source.strip() or not permission.strip():
        raise SystemExit("a source and a permission line are both needed")
    prov = {
        "source": source.strip(),
        "permission": permission.strip(),
        "recorded_by": args.by,
        "written_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "label": LABEL,
        "fields": field_sources(folder),
    }
    (folder / PROVENANCE).write_text(json.dumps(prov, indent=1))
    out(f"wrote {folder / PROVENANCE}")
    for k, v in prov["fields"].items():
        out(f"  {k}: {v}")
    return 0


# --- CLI ----------------------------------------------------------------------------------------------


def parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = ap.add_subparsers(dest="cmd", required=True)

    def pose_opts(p: argparse.ArgumentParser) -> None:
        p.add_argument("--height-m", type=float, help="camera height above ground (owner-stated)")
        p.add_argument("--heading", type=float, help="camera heading, degrees (owner-stated)")
        p.add_argument("--f35", type=float, help="35 mm-equivalent focal length (owner-stated)")
        p.add_argument(
            "--assume-nadir",
            action="store_true",
            help="the camera pointed straight down (owner-stated; recorded as such)",
        )

    p = sub.add_parser("inspect", help="what each file says about where it was taken")
    p.add_argument("folder", type=Path)
    p.add_argument("--height-m", type=float, help="for GSD of photos with no relative altitude")
    p.add_argument("--json", action="store_true", help="print JSON instead of text")

    p = sub.add_parser("frames", help="cut geotagged JPEGs from a drone video")
    p.add_argument("video", type=Path)
    p.add_argument("--srt", type=Path, help="DJI .SRT (default: next to the video, or embedded)")
    p.add_argument("--log", type=Path, help="Airdata or DJI flight record CSV")
    p.add_argument("--log-offset", type=float, help="log time (s) at which the video starts")
    p.add_argument("--clip", type=int, default=1, help="which recording in the log (1 = first)")
    p.add_argument("--every", type=parse_every, default=2.0, help="e.g. 2s (default) or 500ms")
    p.add_argument("--out", type=Path, required=True)
    pose_opts(p)

    p = sub.add_parser("run", help="send the photos through the live API and report")
    p.add_argument("folder", type=Path)
    p.add_argument("--api", help="API base URL")
    p.add_argument("--mission", help="a new mission's name")
    p.add_argument("--mission-id", help="send to this existing mission")
    p.add_argument("--lkp", type=_latlon, help="last-known point LAT,LON (default: first photo)")
    p.add_argument("--pace", type=float, default=0.0, help="seconds between photos")
    p.add_argument("--wait-s", type=float, default=600.0, help="give up processing after this")
    p.add_argument("--proposal-wait-s", type=float, default=60.0)
    p.add_argument("--offline", action="store_true", help="local detector only, no server")
    p.add_argument("--out", type=Path, help="report folder (default runs/real_flight/<ts>)")
    pose_opts(p)

    p = sub.add_parser("label", help="write provenance.json into the folder")
    p.add_argument("folder", type=Path)
    p.add_argument("--source", help='e.g. "friend\'s DJI Mini 3, Lynn Canyon, 2026-10-18"')
    p.add_argument("--permission", help="the owner's permission or licence line")
    p.add_argument("--by", help="who recorded this")
    return ap


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if args.cmd == "inspect":
        if not args.folder.is_dir():
            raise SystemExit(f"{args.folder} is not a folder")
        report = inspect_folder(args.folder, args.height_m)
        if args.json:
            print(json.dumps(report, indent=1))
        else:
            print_inspect(report)
        return 0
    if args.cmd == "frames":
        return cmd_frames(args)
    if args.cmd == "run":
        return cmd_run(args)
    return cmd_label(args)


if __name__ == "__main__":
    sys.exit(main())
