"""Camera moves and pacing in post, for captions.py's program step (README.md, "Camera moves and pacing").

From ``captions.yaml``'s ``moves`` section, per shot:

- ``push_in: {x, y, scale, start, end}``: zoom from 1 to ``scale`` about the point (x, y) between ``start``
  and ``end`` seconds into the shot (ease-in-out cubic; before ``start`` it is 1, after ``end`` it holds).
  x and y are in the 1920x1080 viewport's CSS pixels (the page's own coordinates; default the centre);
  ``focus: click`` takes the shot's last click from shots.json instead. The point stays where it is on
  screen while everything around it grows, so the frame never leaves the picture;
- ``hold: true`` (no move) or ``hold: {x, y, scale}`` (a still crop);
- ``speed``: a number (the whole shot) or a list of ``{start, end, rate}`` (a wait inside it), in the
  shot's own recorded seconds. Applied with ``setpts`` after the move, so a move's times are the recorded
  ones; the shots' times after speed-up are written back to shots.json (``program_start_s``/``_end_s``).

``default`` applies to a shot with no entry of its own (a gentle centred push 1.0 -> 1.08 over the shot).
The pieces between shots (settle frames) are plain. Everything is rendered from the 4K master: ``zoompan``
on a copy scaled up ``upscale`` times first, because zoompan rounds its crop to whole pixels and shakes
(ffmpeg trac #4298; the workaround on ffmpeg-user is to upscale first), then lanczos down to the output.
"""

from __future__ import annotations

import itertools
from dataclasses import dataclass, field

VIEW_W, VIEW_H = 1920, 1080  # the viewport the coordinates are in


@dataclass
class Piece:
    """A stretch of the master rendered as one: a shot (its move and speed) or the frames between."""

    name: str  # the shot id, or "gap"
    src_start: float
    src_end: float
    move: dict = field(default_factory=dict)  # resolved: {"kind": push_in|hold|none, ...}
    speed: list[tuple[float, float, float]] = field(
        default_factory=list
    )  # (start, end, rate), shot-relative

    @property
    def src_s(self) -> float:
        return self.src_end - self.src_start

    @property
    def out_s(self) -> float:
        return out_time(self.src_s, self.speed)


def out_time(t: float, speed: list[tuple[float, float, float]]) -> float:
    """Seconds into the piece after the speed-up, for `t` recorded seconds into it."""
    return t - sum((min(max(t, a), b) - a) * (1 - 1 / r) for a, b, r in speed)


def speed_ranges(spec, length: float) -> list[tuple[float, float, float]]:
    if spec in (None, 1, 1.0):
        return []
    if isinstance(spec, int | float):
        spec = [{"start": 0.0, "end": length, "rate": spec}]
    out = []
    for r in spec:
        a, b = max(0.0, float(r.get("start", 0.0))), min(length, float(r.get("end", length)))
        rate = float(r["rate"])
        if rate <= 0:
            raise SystemExit(f"speed rate {rate} must be > 0")
        if b > a and rate != 1:
            out.append((a, b, rate))
    out.sort()
    for (_, b1, _), (a2, _, _) in itertools.pairwise(out):
        if a2 < b1:
            raise SystemExit("speed ranges overlap")
    return out


def resolve(shot: dict, cfg: dict) -> tuple[dict, list[tuple[float, float, float]]]:
    """(move, speed ranges) for a shot from the config's ``moves`` (its own entry, else ``default``)."""
    moves = cfg.get("moves") or {}
    entry = moves.get(shot["id"], moves.get("default", {})) or {}
    length = shot["end_s"] - shot["start_s"]
    speed = speed_ranges(entry.get("speed"), length)
    hold = entry.get("hold")
    push = entry.get("push_in")
    clicks = (shot.get("extra") or {}).get("clicks") or []

    def point(spec: dict) -> tuple[float, float]:
        if spec.get("focus") == "click" and clicks:
            return float(clicks[-1][1]), float(clicks[-1][2])
        return float(spec.get("x", VIEW_W / 2)), float(spec.get("y", VIEW_H / 2))

    if hold:
        spec = hold if isinstance(hold, dict) else {}
        x, y = point(spec)
        return {"kind": "hold", "x": x, "y": y, "scale": float(spec.get("scale", 1.0))}, speed
    if push:
        x, y = point(push)
        a = float(push.get("start", 0.0))
        b = float(push.get("end", length))
        b = min(b, length) if b > a else length
        scale = float(push.get("scale", 1.08))
        if not 1.0 <= scale <= 2.0:
            raise SystemExit(f"{shot['id']}: push_in scale {scale} is outside 1-2")
        return {"kind": "push_in", "x": x, "y": y, "scale": scale, "start": a, "end": b}, speed
    return {"kind": "none"}, speed


def plan(shots: list[dict], total: float, cfg: dict) -> list[Piece]:
    """The master cut into pieces in order: each shot that is on the video, and the frames between."""
    on = sorted((s for s in shots if s["end_s"] - s["start_s"] > 0.05), key=lambda s: s["start_s"])
    pieces: list[Piece] = []
    t = 0.0
    for s in on:
        if s["start_s"] - t > 0.01:
            pieces.append(Piece("gap", t, s["start_s"], {"kind": "none"}))
        move, speed = resolve(s, cfg)
        pieces.append(Piece(s["id"], s["start_s"], s["end_s"], move, speed))
        t = s["end_s"]
    if total - t > 0.01:
        pieces.append(Piece("gap", t, total, {"kind": "none"}))
    return pieces


def ease_expr(p: str) -> str:
    """ease-in-out cubic of the ffmpeg expression `p` (0..1)."""
    return f"if(lt({p},0.5),4*pow({p},3),1-pow(-2*{p}+2,3)/2)"


def filters(
    piece: Piece, size: tuple[int, int], fps: int, upscale: float, delogo: str | None
) -> str:
    """The ffmpeg filter chain for one piece, from the master's frames (timestamps from 0) to the
    output size at `fps`: the sync mark painted out, the speed-up, then the move. The speed-up comes
    first because ffmpeg's ``fps`` filter must not follow ``zoompan`` (zoompan ends its stream at a
    timestamp in the wrong time base and fps then pads hundreds of seconds); the move's times are mapped
    through the speed-up, so it still starts and ends where the recording says."""
    w, h = size
    chain = ["setpts=PTS-STARTPTS"]
    if delogo:
        chain.append(delogo)
    if piece.speed:
        terms = "".join(
            f"-(clip(T,{a:.3f},{b:.3f})-{a:.3f})*{1 - 1 / r:.6f}" for a, b, r in piece.speed
        )
        chain += [f"setpts='(T{terms})/TB'", f"fps={fps}"]
    m = piece.move
    if m["kind"] == "push_in" and m["scale"] > 1.0:
        fx, fy = m["x"] / VIEW_W, m["y"] / VIEW_H
        a, b = out_time(m["start"], piece.speed), out_time(m["end"], piece.speed)
        p = f"clip((it-{a:.3f})/{max(b - a, 1e-3):.3f},0,1)"
        z = f"1+{m['scale'] - 1:.5f}*{ease_expr(p)}"
        # zoom about (fx, fy): that point stays put on screen; x, y are the crop's top-left in input
        # pixels. zoompan scales its crop to 2x the output (bicubic), lanczos takes it the rest of the way.
        chain += [
            f"scale=iw*{upscale:g}:ih*{upscale:g}:flags=bicubic",
            f"zoompan=z='{z}':x='{fx:.5f}*iw*(1-1/zoom)':y='{fy:.5f}*ih*(1-1/zoom)':d=1:s={w * 2}x{h * 2}:fps={fps}",
            f"scale={w}:{h}:flags=lanczos",
        ]
    elif m["kind"] == "hold" and m["scale"] > 1.0:
        fx, fy, k = m["x"] / VIEW_W, m["y"] / VIEW_H, m["scale"]
        chain += [
            f"crop=w=iw/{k:.5f}:h=ih/{k:.5f}:x={fx:.5f}*iw*(1-1/{k:.5f}):y={fy:.5f}*ih*(1-1/{k:.5f})",
            f"scale={w}:{h}:flags=lanczos",
        ]
    else:
        chain.append(f"scale={w}:{h}:flags=lanczos")
    chain += ["setsar=1", "format=yuv420p"]
    return ",".join(chain)
