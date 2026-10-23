"""Record the story as one 1920x1080 screen recording at device scale 2, shot by shot (shot list v2).

    uv run --extra video python scripts/demo_video/record.py                       # the story (no API)
    uv run --extra video python scripts/demo_video/record.py --live --serve-local  # + the live fleet shots
    uv run --extra video python scripts/demo_video/record.py --live --api http://127.0.0.1:8000
    uv run --extra video python scripts/demo_video/record.py --shots call,photos   # just those (debugging)

Builds the site (``VITE_CACHE_DIR=demo``), serves it with ``vite preview`` on port 5202 (started and
stopped by PID by this script), and drives Chromium through the seven-beat story of PR #200 ("Follow the
search", t0-t6) on the one console: the call, photos land, confirm (Person, Person, Not a person, the
second look), the Trace, where next (the radio clue, the proposal, Approve), the run (the lost link, the
relay), the fleet, Team One's walk, the radio call, the find and the debrief, with eased mouse moves and
clicks, and writes into the run folder:

- ``master_4k.mp4``: the recording, 3840x2160 (the 1920x1080 viewport at device scale 2), captured frame
  by frame with ``page.screencast`` and encoded by ffmpeg (``capture.py``: H.264 CRF 16, BT.709), at 60 fps
  when the renderer keeps up and 30 when it can't (``--fps``); not Playwright's ``recordVideo``, which
  encodes VP8 at about 1 Mbit/s and scales to fit 800x800;
- ``shots.json``: every shot's id, target duration and actual start/end in the recording, and whether
  it ran, was skipped (an element that isn't there, the API down) or failed; the capture's frame rate;
- ``snaps/<NN>_<shot>.png``: the last frame of each shot, to check a run without watching it.

Deterministic where the app allows: a fixed viewport and scale, a fixed time zone and locale, motion
allowed (``prefers-reduced-motion: no-preference``), the page clock started at the demo mission's own
``now`` (its fixture), and 400 ms of settle before each shot.

``--live`` adds the moments that need a mission API (the simulated fleet's link controls and the
gusts → no-fly → recall); without an API they are skipped, with the reason in shots.json.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from capture import FrameCapture
from story_facts import facts

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / "web"
FIXTURE = WEB / "src/command/__fixtures__/demo_mission.json"
PORT = 5202
SIZE = {"width": 1920, "height": 1080}

# A visible pointer: headless Chromium records no cursor, so the page gets one drawn on top (and a ring
# on each click). Injected by the recorder only; the site itself is untouched. Both are vectors, drawn at
# the device scale (crisp at 2x), moved with a sub-pixel translate3d; the ring eases out on a cubic.
CURSOR_JS = r"""
(() => {
  const install = () => {
    if (document.getElementById("__demo_cursor")) return;
    const c = document.createElement("div");
    c.id = "__demo_cursor";
    c.innerHTML = '<svg width="30" height="30" viewBox="0 0 28 28" shape-rendering="geometricPrecision"><path d="M4 2 L4 22 L9.5 17 L13 25.5 L16.5 24 L13 16 L20.5 16 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, {position: "fixed", left: "0", top: "0", zIndex: "2147483647", pointerEvents: "none",
      transform: "translate3d(-100px,-100px,0)", willChange: "transform", filter: "drop-shadow(0 1px 1.5px rgba(0,0,0,.45))"});
    document.documentElement.appendChild(c);
    window.addEventListener("mousemove", (e) => { c.style.transform = `translate3d(${e.clientX - 4.3}px,${e.clientY - 2.1}px,0)`; }, true);
    window.addEventListener("mousedown", (e) => {
      const r = document.createElement("div");
      Object.assign(r.style, {position: "fixed", left: `${e.clientX - 18}px`, top: `${e.clientY - 18}px`, width: "36px", height: "36px",
        borderRadius: "50%", border: "2.5px solid rgba(255,196,0,.95)", boxSizing: "border-box", zIndex: "2147483646", pointerEvents: "none",
        transition: "transform .5s cubic-bezier(.33,1,.68,1), opacity .5s cubic-bezier(.33,1,.68,1)"});
      document.documentElement.appendChild(r);
      requestAnimationFrame(() => requestAnimationFrame(() => { r.style.transform = "scale(1.8)"; r.style.opacity = "0"; }));
      setTimeout(() => r.remove(), 650);
    }, true);
    // The sync mark: a 12 px square near the bottom-right corner, black between shots and magenta or
    // green (alternating) during one. Shot times are read back off the video from this mark, then it is
    // painted out (delogo).
    const m = document.createElement("div");
    m.id = "__demo_sync";
    Object.assign(m.style, {position: "fixed", right: "2px", bottom: "2px", width: "12px", height: "12px",
      background: window.__demoSyncColor || "#000", zIndex: "2147483647", pointerEvents: "none"});
    document.documentElement.appendChild(m);
  };
  window.__demoSync = (color) => {
    window.__demoSyncColor = color;
    const m = document.getElementById("__demo_sync");
    if (m) m.style.background = color;
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install); else install();
})();
"""
SYNC_COLORS = ("#ff00ff", "#00ff00")
# The t2 card the second look rescued: this flight's 0.17 detection (web/src/command/demoReview.ts)
SECOND_LOOK = "f0273-d02"

# Scrolls the element's scrolling ancestor smoothly so the element (and the heading just above it) sits in
# the upper part of it; else scrollIntoView.
SCROLL_TO_JS = r"""
(sel) => {
  const el = document.querySelector(sel);
  if (!el) return false;
  let sc = el.parentElement;
  while (sc && !(/(auto|scroll)/.test(getComputedStyle(sc).overflowY) && sc.scrollHeight > sc.clientHeight)) sc = sc.parentElement;
  if (!sc) { el.scrollIntoView({behavior: "smooth", block: "center"}); return true; }
  const top = sc.scrollTop + el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 0.12 * sc.clientHeight - 80;
  sc.scrollTo({top: Math.max(0, top), behavior: "smooth"});
  return true;
}
"""
SYNC_BOX = (1906, 1066, 12)  # x, y, size of the mark in CSS px (the 1920x1080 viewport)


def delogo(k: float) -> str:
    """Paints the mark out of a video `k` times the viewport's size (captions.py applies it)."""
    return f"delogo=x={round(1903 * k)}:y={round(1063 * k)}:w={round(16 * k)}:h={round(16 * k)}"


DELOGO = delogo(1)


# --- the servers -----------------------------------------------------------------------------------


def port_free(port: int) -> bool:
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def wait_http(url: str, timeout_s: float) -> bool:
    end = time.monotonic() + timeout_s
    while time.monotonic() < end:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status < 500:
                    return True
        except Exception:  # noqa: BLE001 - not up yet
            time.sleep(0.3)
    return False


def stop(proc: subprocess.Popen | None, name: str) -> None:
    """Stops a process this script started, by its PID (its own process group: vite's children too)."""
    if proc is None or proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)  # the group this script created with start_new_session
    except ProcessLookupError:
        return
    try:
        proc.wait(10)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait(5)
    print(f"stopped {name} (pid {proc.pid})", flush=True)


def build_site(out: Path, api: str | None, log) -> Path:
    vite = WEB / "node_modules/.bin/vite"
    if not vite.exists():
        raise SystemExit(f"{vite} is missing: run `pnpm install` in web/ first")
    if not (WEB / "public/cache/demo/map.json").exists():
        raise SystemExit(
            "web/public/cache/demo is missing: build the demo cache first (README, 'The demo cache')"
        )
    dist = out / "dist"
    env = dict(os.environ, VITE_CACHE_DIR="demo")
    if api:
        env["VITE_API_URL"] = api
    else:
        env.pop("VITE_API_URL", None)
    print(f"building the site into {dist} …", flush=True)
    subprocess.run([str(vite), "build", "--outDir", str(dist), "--emptyOutDir"], cwd=WEB, env=env, check=True,
                   stdout=log, stderr=subprocess.STDOUT)  # fmt: skip
    return dist


def start_site(mode: str, dist: Path | None, api: str | None, log) -> subprocess.Popen:
    if not port_free(PORT):
        raise SystemExit(
            f"port {PORT} is taken: stop whatever runs there (this script never kills a process it didn't start)"
        )
    vite = WEB / "node_modules/.bin/vite"
    env = dict(os.environ, VITE_CACHE_DIR="demo")
    if api:
        env["VITE_API_URL"] = api
    if mode == "preview":
        cmd = [str(vite), "preview", "--port", str(PORT), "--strictPort", "--outDir", str(dist)]
    else:
        cmd = [str(vite), "--port", str(PORT), "--strictPort"]
    proc = subprocess.Popen(
        cmd, cwd=WEB, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True
    )
    print(f"site: {' '.join(cmd[1:3])} on :{PORT} (pid {proc.pid})", flush=True)
    if not wait_http(f"http://127.0.0.1:{PORT}/", 60):
        stop(proc, "site")
        raise SystemExit(f"the site did not come up on :{PORT} (see site.log)")
    return proc


def start_api(out: Path) -> tuple[subprocess.Popen, str]:
    """A local mission API for a live rehearsal (README: `python -m sightline.pipeline serve`), its
    missions under the run folder; the agent and Tavily faked, the radio desk in text mode."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    root = out / "api"
    root.mkdir(exist_ok=True)
    env = dict(os.environ, SIGHTLINE_FAKE_LLM="1", SIGHTLINE_FAKE_TAVILY="1")
    onnx = local_file(
        "web/public/models/sightline-detector-v2.onnx"
    )  # the cv2 detector (web/scripts/fetch-model.sh)
    if onnx.exists() and "SIGHTLINE_ONNX" not in env:
        env["SIGHTLINE_ONNX"] = str(onnx)
    cmd = [sys.executable, "-m", "sightline.pipeline", "serve", "--port", str(port), "--radio", "text",
           "--mission-root", str(root / "missions"), "--cache-root", str(root / "cache"), "--data-root", str(root / "up")]  # fmt: skip
    log = open(root / "server.log", "w")  # noqa: SIM115 - the process holds it until stopped
    proc = subprocess.Popen(
        cmd, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True
    )
    api = f"http://127.0.0.1:{port}"
    print(f"api: serve on :{port} (pid {proc.pid})", flush=True)
    if not wait_http(f"{api}/health", 90):
        print(
            f"the local API did not come up (see {root / 'server.log'}); the live shots will be skipped",
            flush=True,
        )
    return proc, api


def api_up(api: str) -> str | None:
    """None when the API answers /health; else why not."""
    try:
        with urllib.request.urlopen(f"{api.rstrip('/')}/health", timeout=5) as r:
            body = json.loads(r.read())
            return None if body.get("status") == "ok" else f"/health said {body}"
    except Exception as e:  # noqa: BLE001 - reported in shots.json
        return f"{api} is unreachable ({type(e).__name__}: {e})"


def local_file(rel: str) -> Path:
    """`rel` in this checkout, else in the main checkout (a git worktree has no data/ and no model)."""
    here = ROOT / rel
    if here.exists():
        return here
    try:
        common = subprocess.run(
            ["git", "rev-parse", "--git-common-dir"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=True,
        )
        main = (ROOT / common.stdout.strip()).resolve().parent / rel
        if main.exists():
            return main
    except (OSError, subprocess.CalledProcessError):
        pass
    return here


# --- reading the shots back off the video ----------------------------------------------------------


def probe_fps(video: Path) -> float:
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate",
                        "-of", "csv=p=0", str(video)], capture_output=True, text=True, check=True)  # fmt: skip
    num, _, den = r.stdout.strip().partition("/")
    return float(num) / float(den or 1)


def probe_width(video: Path) -> int:
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width",
                        "-of", "csv=p=0", str(video)], capture_output=True, text=True, check=True)  # fmt: skip
    return int(r.stdout.strip().split(",")[0])


def read_sync(video: Path) -> list[tuple[float, float]]:
    """The (start, end) in video seconds of every coloured run of the sync mark, in order."""
    import numpy as np

    k = probe_width(video) / SIZE["width"]  # 2 for the 4K master
    x, y, n = (round(v * k) for v in SYNC_BOX)
    c = round(4 * k)  # the middle of the mark: clear of the codec's edge bleed
    crop = f"crop={c}:{c}:{x + (n - c) // 2}:{y + (n - c) // 2}"
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(video), "-vf", crop, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                         capture_output=True, check=True).stdout  # fmt: skip
    px = (
        np.frombuffer(raw, np.uint8).reshape(-1, c * c, 3).mean(axis=1)
    )  # one mean colour per frame
    # white too: a blank page before the first paint is not a shot (it is nearer magenta than black)
    ref = np.array([[0, 0, 0], [255, 0, 255], [0, 255, 0], [255, 255, 255]], float)
    labels = np.argmin(
        ((px[:, None, :] - ref[None]) ** 2).sum(-1), axis=1
    )  # 0 black, 1 magenta, 2 green, 3 white
    fps = probe_fps(video)
    runs: list[tuple[int, int, int]] = []  # label, first frame, last frame
    for i, lab in enumerate(labels):
        if runs and runs[-1][0] == lab:
            runs[-1] = (lab, runs[-1][1], i)
        else:
            runs.append((int(lab), i, i))
    # a stray frame or two of the wrong colour (encoder noise) is not a shot
    return [
        (round(a / fps, 3), round((b + 1) / fps, 3))
        for lab, a, b in runs
        if lab in (1, 2) and b - a >= 2
    ]


def align(
    shots: list[Shot], video: Path, total_wall: float, cap: FrameCapture | None = None
) -> str:
    """Rewrites the shots' start/end from wall time to video time. Returns how: "mark" (read off the
    video), "clock" (the mark didn't read cleanly: the shots' wall-clock times against the frames' own
    capture times) or "scaled" (neither: wall times scaled to the video's length)."""
    marked = [s for s in shots if s.extra.get("marked")]
    for s in shots:
        s.extra["wall_start_s"], s.extra["wall_end_s"] = s.start_s, s.end_s
    try:
        runs = read_sync(video)
    except (OSError, subprocess.CalledProcessError, ValueError) as e:
        print(f"could not read the sync mark: {e}", flush=True)
        runs = []
    if len(runs) == len(marked):
        for s, (a, b) in zip(marked, runs, strict=True):
            s.start_s, s.end_s = a, b
        how = "mark"
    elif cap is not None and cap.ts and all("epoch_start" in s.extra for s in marked):
        print(
            f"sync mark: {len(runs)} runs for {len(marked)} shots; using the frames' clock",
            flush=True,
        )
        for s in marked:
            s.start_s = cap.video_time(s.extra["epoch_start"])
            s.end_s = cap.video_time(s.extra["epoch_end"])
        how = "clock"
    else:
        print(
            f"sync mark: {len(runs)} runs for {len(marked)} shots; scaling wall times instead",
            flush=True,
        )
        dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(video)],
                                   capture_output=True, text=True, check=True).stdout)  # fmt: skip
        k = dur / total_wall if total_wall else 1.0
        for s in marked:
            s.start_s, s.end_s = round((s.start_s or 0) * k, 3), round((s.end_s or 0) * k, 3)
        how = "scaled"
    # a shot skipped before it ran sits, zero-length, where the next one starts
    t = 0.0
    for s in shots:
        if s.extra.get("marked"):
            t = s.end_s or t
        else:
            s.start_s = s.end_s = t
    return how


# --- the director ----------------------------------------------------------------------------------


@dataclass
class Shot:
    id: str
    target_s: float
    start_s: float | None = None
    end_s: float | None = None
    status: str = "pending"  # ok | skipped | failed
    note: str = ""
    mode: str = "demo"
    extra: dict = field(default_factory=dict)


class Skip(Exception):
    """This shot's route or element isn't there (yet): skip it and say why."""


def ease(t: float) -> float:
    return 4 * t**3 if t < 0.5 else 1 - (-2 * t + 2) ** 3 / 2  # ease-in-out cubic


class Director:
    def __init__(self, page, base: str, out: Path, snaps: bool = True):
        self.page = page
        self.base = base
        self.out = out
        self.snaps = snaps
        self.t0 = time.monotonic()
        self.shots: list[Shot] = []
        self.x, self.y = SIZE["width"] / 2, SIZE["height"] / 2
        self.marked = 0
        self.color = "#000"
        self.current: Shot | None = None
        self.only: set[str] | None = None  # --shots: record just these
        self.landing = "/"  # where the call shot opens (--landing)

    def now(self) -> float:
        return round(time.monotonic() - self.t0, 3)

    def sync(self, color: str) -> None:
        try:
            self.page.evaluate("c => window.__demoSync && window.__demoSync(c)", color)
        except Exception:  # noqa: BLE001, S110 - mid-navigation: the init script sets it on the new page
            pass

    # pacing and the pointer
    def pause(self, s: float) -> None:
        """Waits in Playwright (not time.sleep), so the screencast's frames keep arriving and being acked."""
        if s > 0:
            self.page.wait_for_timeout(s * 1000)

    def move(self, x: float, y: float, duration: float = 0.7) -> None:
        """An eased move along a cubic curve that takes `duration` of wall time however slow the page is
        (each mouse event is a round trip to a busy renderer, so the step count adapts instead of the
        length): ease-in-out cubic in time, a cubic Bezier in space bowed slightly, like a hand."""
        x0, y0 = self.x, self.y
        dist = math.hypot(x - x0, y - y0)
        if dist < 2:
            return
        bow = min(40.0, dist * 0.08)
        nx, ny = (
            (y0 - y) / dist * bow,
            (x - x0) / dist * bow,
        )  # the normal, always bowing upward-ish
        if ny > 0:
            nx, ny = -nx, -ny
        c1 = (x0 + (x - x0) / 3 + nx, y0 + (y - y0) / 3 + ny)
        c2 = (x0 + 2 * (x - x0) / 3 + nx, y0 + 2 * (y - y0) / 3 + ny)
        start = time.monotonic()
        while True:
            k = min(1.0, (time.monotonic() - start) / duration)
            e = ease(k)
            u = 1 - e
            px = u**3 * x0 + 3 * u * u * e * c1[0] + 3 * u * e * e * c2[0] + e**3 * x
            py = u**3 * y0 + 3 * u * u * e * c1[1] + 3 * u * e * e * c2[1] + e**3 * y
            self.page.mouse.move(px, py)
            if k >= 1.0:
                break
            self.pause(1 / 60)
        self.x, self.y = x, y

    def to(
        self, locator, duration: float = 0.7, dx: float = 0.5, dy: float = 0.5
    ) -> tuple[float, float]:
        try:
            # an element that keeps re-rendering (a playing map's controls) never counts as stable
            locator.scroll_into_view_if_needed(timeout=2000)
        except Exception:  # noqa: BLE001, S110 - it is usually on screen already; the box decides
            pass
        box = locator.bounding_box(timeout=5000)
        if box is None:
            raise RuntimeError("element has no box")
        x, y = box["x"] + box["width"] * dx, box["y"] + box["height"] * dy
        self.move(x, y, duration)
        return x, y

    def click(self, locator, duration: float = 0.7, settle: float = 0.3) -> None:
        """Move, settle 300 ms, press, settle at least 300 ms (Visual language: a deliberate pointer)."""
        self.to(locator, duration)
        self.pause(0.3)
        if self.current is not None:  # where the clicks are: captions.py can push in on them
            self.current.extra.setdefault("clicks", []).append(
                [round(self.now() - (self.current.start_s or 0), 2), round(self.x), round(self.y)]
            )
        self.page.mouse.down()
        self.pause(0.08)
        self.page.mouse.up()
        self.pause(max(0.3, settle))

    def type(self, locator, text: str, per_key: float = 0.055) -> None:
        self.click(locator, 0.6, 0.15)
        locator.press_sequentially(text, delay=per_key * 1000)

    def key(self, k: str, after: float = 0.8) -> None:
        self.page.keyboard.press(k)
        self.pause(after)

    def goto(self, url: str) -> None:
        self.page.goto(url, wait_until="networkidle")
        self.sync(self.color)  # a new document: put the current mark back

    def hash(self, h: str, settle: float = 1.0) -> None:
        self.page.evaluate("h => { window.location.hash = h; }", h)
        self.pause(settle)

    def first(self, *locators, timeout: float = 4.0):
        """The first of these locators that shows up within `timeout` seconds, else None."""
        end = time.monotonic() + timeout
        while True:
            for loc in locators:
                try:
                    if loc.count() > 0 and loc.first.is_visible():
                        return loc.first
                except Exception:  # noqa: BLE001, S110 - a selector that does not parse after a redesign
                    pass
            if time.monotonic() >= end:
                return None
            self.pause(0.15)

    # one shot
    def shot(
        self,
        sid: str,
        target_s: float,
        fn: Callable[[], None],
        *,
        mode: str = "demo",
        skip: str | None = None,
    ) -> Shot:
        s = Shot(sid, target_s, mode=mode)
        if self.only is not None and sid not in self.only:
            return s  # not asked for: not in shots.json at all
        self.shots.append(s)
        s.start_s = self.now()
        if skip:
            s.status, s.note, s.end_s = "skipped", skip, s.start_s
            print(f"  skip {sid}: {skip}", flush=True)
            return s
        self.pause(0.4)  # settle: the last shot's motion and any re-render finish off the clock
        self.color = SYNC_COLORS[self.marked % 2]
        self.sync(self.color)
        s.start_s = self.now()
        s.extra["marked"] = True
        s.extra["epoch_start"] = time.time()
        self.marked += 1
        self.current = s
        try:
            fn()
            # hold the last frame to the target length
            left = target_s - (self.now() - s.start_s)
            if left > 0:
                self.pause(left)
            s.status = "ok"
        except Skip as e:
            s.status, s.note = "skipped", str(e)
        except Exception as e:  # noqa: BLE001 - one broken shot must not lose the recording
            s.status, s.note = "failed", f"{type(e).__name__}: {str(e).splitlines()[0][:300]}"
        s.end_s = self.now()
        s.extra["epoch_end"] = time.time()
        self.current = None
        self.color = "#000"
        self.sync(self.color)
        self.pause(0.25)  # a few black-mark frames between shots
        if s.status == "skipped":
            s.end_s = s.start_s if s.end_s - s.start_s < 0.5 else s.end_s
        if self.snaps and s.status == "ok":
            try:
                self.page.screenshot(
                    path=str(self.out / "snaps" / f"{len(self.shots):02d}_{sid}.png")
                )
            except Exception:  # noqa: BLE001, S110 - a snap is a convenience
                pass
        took = (s.end_s or 0) - (s.start_s or 0)
        print(
            f"  {s.status:7} {sid:16} {took:6.1f} s (target {target_s:.0f} s){f'  {s.note}' if s.note else ''}",
            flush=True,
        )
        return s


# --- the demo shots: the story on the one console --------------------------------------------------


def demo_shots(d: Director) -> None:
    """Shot list v2: the seven-beat story of PR #200 ("Follow the search", t0-t6), one shot per moment the
    video shows, played through the story's own coach marks on the one console. No API needed: the demo
    mission is fixtures plus the demo cache, and it already holds drone two's lost link and drone three's
    relay of Team Two."""
    p = d.page

    def mark():
        """The coach mark's card (the story is on): "The story, N of M"."""
        return p.get_by_role("dialog", name=re.compile(r"^The story"))

    def mark_next(timeout: float = 6.0):
        b = d.first(
            mark().get_by_role("button", name=re.compile(r"^(Next|Done)$")), timeout=timeout
        )
        if b is None:
            raise RuntimeError("no Next on the coach mark")
        d.click(b)

    def wait_mark(text: str, timeout: float = 10.0):
        """Waits for the coach mark that says `text` (a regex): the clock has run into its checkpoint."""
        m = d.first(mark().filter(has_text=re.compile(text)), timeout=timeout)
        if m is None:
            raise RuntimeError(f"no coach mark saying /{text}/")
        return m

    def views(name: str):
        return p.get_by_role("navigation", name="Mission views").first.get_by_role(
            "button", name=re.compile(rf"^{name}")
        )

    def mapfig():
        return p.locator("figure[aria-label='Live map']").first

    def drone_on_map(i: str):
        return p.locator(f"figure[aria-label='Live map'] [data-drone-target='{i}']").first

    def team_on_map(i: str):
        return p.locator(f"figure[aria-label='Live map'] [data-team-target='{i}']").first

    def card(cid: str):
        return p.locator(f'[data-candidate="{cid}"]').first

    def status():
        return p.locator('[aria-label="Mission status"]').first

    def timeline():
        return p.locator('[data-tour="timeline"]').first

    def call():
        """t0: the landing's pitch bar, Follow the search, the first coach mark: the status line and base
        camp, the teams staged at the trailhead lot."""
        d.goto(d.base + d.landing)
        pitch = d.first(
            p.get_by_role("region", name="Sightline"),
            p.locator('section[aria-label="Sightline"]'),
            timeout=10,
        )
        if pitch is not None:
            d.pause(1.0)
            line = d.first(pitch.get_by_role("heading"), pitch.locator("div").first, timeout=2)
            if line is not None:
                d.to(line, 1.1, 0.25, 0.5)
            d.pause(1.0)
            follow = pitch.get_by_role("button", name=re.compile(r"^Follow the search"))
            d.click(follow, 1.0, settle=0.2)
        elif mark().count() == 0:
            raise RuntimeError("no pitch bar and no coach mark at t0")
        wait_mark(r"Last seen|teams at base", 6)
        d.pause(0.8)
        d.to(status(), 1.1, 0.12, 0.5)  # Elapsed, daylight, flyable
        d.pause(1.6)
        d.to(status(), 1.0, 0.36, 0.5)  # Out 0 people, Subject not found
        d.pause(1.4)
        camp = d.first(
            team_on_map("T1"), timeout=2
        )  # the teams wait at base camp, the trailhead lot
        if camp is not None:
            d.to(camp, 1.1)
            d.pause(1.8)

    def photos():
        """t1: drone one flies the survey from base, 500 photos land and the map changes under its legs;
        then the candidates already waiting in Needs you."""
        mark_next()
        d.move(
            SIZE["width"] * 0.47, SIZE["height"] * 0.42, 1.2
        )  # the map: the clock runs 6 s to t1
        wait_mark(r"flies the survey|photos land", 9)
        d.pause(2.5)
        mark_next()
        wait_mark(r"ranks each photo", 4)
        needs = d.first(
            p.locator('[data-tour="review"]'), p.locator('[data-tour="needs"]'), timeout=2
        )
        if needs is not None:
            d.to(needs, 1.1, 0.5, 0.3)
        d.pause(2.5)

    def confirm():
        """t2: Person, Person on the first two; Not a person on the grey bag; the low-scoring card's second
        look opened, Person, and the pin lands on the map."""
        mark_next()
        wait_mark(r"plainly people", 5)
        d.pause(1.0)
        for cid in ("f0336-d01", "f0127-d01"):
            c = card(cid)
            if c.count() == 0:
                raise RuntimeError(f"no candidate {cid} at t2")
            d.to(c.locator("img").first, 0.9)
            d.pause(0.6)
            d.click(c.get_by_role("button", name="Person", exact=True), 0.6)
            d.pause(0.5)
        d.pause(0.8)
        mark_next()
        wait_mark(r"grey bag", 4)
        bag = card("f0452-d01")  # storyCopy.ts STORY_NOT_A_PERSON
        if bag.count() == 0:
            raise RuntimeError("no grey-bag candidate f0452-d01 at t2")
        d.to(bag.locator("img").first, 1.0)
        d.pause(1.2)
        d.click(bag.get_by_role("button", name="Not a person", exact=True), 0.7)
        d.pause(1.0)
        mark_next()
        wait_mark(r"second look caught it", 4)
        # the card whose second look rescued it (this flight's f0273-d02 since PR #201); any card with
        # second-look images if the scenario names another
        rec = d.first(
            card(SECOND_LOOK),
            p.locator("[data-candidate]").filter(
                has=p.get_by_role("button", name=re.compile(r"Show the second look"))
            ),
            timeout=3,
        )
        if rec is None:
            raise RuntimeError(f"no second-look card ({SECOND_LOOK}) at t2")
        d.to(rec.locator("img").first, 1.0)
        d.pause(1.0)
        chips = d.first(rec.get_by_label("Models"), timeout=1)
        if chips is not None:  # OpenCV 5 zoom native · Nemotron-3.5-Super-VL
            d.to(chips, 0.8)
            d.pause(1.4)
        d.click(rec.get_by_role("button", name=re.compile(r"Show the second look")))
        d.pause(2.2)
        d.click(rec.get_by_role("button", name="Person", exact=True))
        d.pause(1.0)
        d.to(mapfig(), 1.1, 0.5, 0.45)  # the pin, and the map brightens there
        d.pause(1.8)

    def trace():
        """The Trace on that chain: the tool call, the model call, the verdict, the proposal, the approval."""
        d.click(views("Trace"))
        d.pause(1.0)
        chain = d.first(
            p.locator(f'article[aria-label^="Chain {SECOND_LOOK}"]'),
            p.locator('article[aria-label^="Chain"]'),
            timeout=5,
        )
        if chain is None:
            raise RuntimeError("no chain in the Trace")
        d.to(chain, 0.8, 0.1, 0.05)
        d.pause(0.5)
        steps = chain.locator("li[aria-label]")
        for i in range(min(steps.count(), 6)):
            d.to(steps.nth(i), 0.45, 0.25, 0.5)
            d.pause(0.45)
        model = d.first(chain.locator("li[aria-label^='Model'] button[aria-expanded]"), timeout=1)
        if model is not None:
            d.click(model, 0.6)
            d.pause(1.5)

    def next_():
        """t3: the radio clue on the timeline, confirmed, the map moves toward it; the agent's proposal in
        Needs you with its reason; Approve, and the clock runs on."""
        d.hash("#m/demo?t=3", 1.4)
        wait_mark(r"on the radio|clue comes in", 6)
        radio_in = d.first(timeline().locator('li[data-kind="radio"]'), timeout=2)
        if radio_in is not None:
            d.to(radio_in, 1.1, 0.3, 0.5)  # the call
            d.pause(1.6)
        clue = d.first(timeline().locator('li[data-kind="clue"]'), timeout=2)
        if clue is not None:
            d.to(clue, 0.8, 0.3, 0.3)  # the clue it became, confirmed
            d.pause(1.4)
        # the map has moved toward it: the heat south-west of the last known point (not "Show on map",
        # which zooms the map in and leaves its popup open for the rest of the story)
        d.to(mapfig(), 1.1, 0.47, 0.55)
        d.pause(2.0)
        mark_next()
        wait_mark(r"agent proposes", 4)
        prop = d.first(
            p.locator("[data-story-proposal]"),
            p.locator("[data-proposal]").filter(has_text="Assign sector"),
            timeout=4,
        )
        if prop is None:
            raise RuntimeError("no story proposal at t3")
        d.to(prop, 1.0, 0.4, 0.35)  # the reason names the clue
        d.pause(2.6)
        d.click(prop.get_by_role("button", name=re.compile(r"^Approve")).first, 0.9, settle=0.4)

    def run():
        """t4: the clock runs on (6 s): teams out, the drones fly their legs; drone two loses its link,
        drone three relays Team Two (the drone cards in Resources)."""
        d.move(SIZE["width"] * 0.5, SIZE["height"] * 0.45, 1.2)
        wait_mark(r"loses its link|relays", 10)
        d.pause(0.6)
        for i in ("D2", "D3"):
            c = d.first(p.locator(f'[data-drone="{i}"]'), timeout=2)
            if c is not None:
                d.to(c, 1.0, 0.4, 0.5)
                d.pause(1.8)
        t2 = d.first(team_on_map("T2"), timeout=2)
        if t2 is not None:
            d.to(t2, 1.1)
            d.pause(1.8)

    def fleet():
        """The fleet beat at t4, longer (the Nebius cut): each marker's tooltip, drone two flying its leg
        without a link, drone three carrying Team Two's position, the lines on the timeline."""
        for who in (drone_on_map("D2"), drone_on_map("D3"), team_on_map("T2")):
            mk = d.first(who, timeout=1)
            if mk is not None:
                d.to(mk, 0.9)
                d.pause(2.0)
        line = d.first(timeline().locator("li", has_text=re.compile(r"heard via D\d")), timeout=1)
        if line is not None:
            d.to(line, 1.0, 0.2, 0.5)
            d.pause(1.6)

    def walk():
        """t4, the second mark: the story's team walks its sector (the fixture's first assignment)."""
        mark_next()
        wait_mark(r"walks", 4)
        t1 = d.first(team_on_map(facts().get("story_team_id", "T1")), timeout=2)
        if t1 is not None:
            d.to(t1, 1.2)
        d.pause(2.5)

    def radio():
        """The radio, one turn: the timeline on Radio; the clock runs to t5 and the finding team's call lands, then
        the desk's reply (voiced in Magpie by narrate.py, in-world)."""
        tab = d.first(
            timeline().get_by_role("group", name="Show").get_by_role("button", name="Radio"),
            timeout=2,
        )
        if tab is None:
            raise RuntimeError("no Radio filter on the timeline")
        d.click(tab, 0.9)
        d.pause(0.8)
        mark_next()  # the clock runs 2.5 s to the find
        wait_mark(r"Subject located|finds the subject", 6)
        call_in = d.first(
            timeline().locator(
                'li[data-kind="radio"]', has_text=facts().get("find_call", "Subject located")[:40]
            ),
            timeout=2,
        )
        reply = d.first(
            timeline().locator(
                'li[data-kind="radio"]', has_text=facts().get("find_reply", "Copy subject")[:40]
            ),
            timeout=2,
        )
        for li in (call_in, reply):
            if li is not None:
                d.to(li, 1.0, 0.3, 0.4)
                d.pause(3.2)

    def find():
        """t5: Found in the status line, the coach mark quoting the call, then the map holds on the find."""
        found = d.first(status().get_by_text(re.compile(r"^Found")), timeout=3)
        if found is None:
            raise RuntimeError("the status line does not say Found at t5")
        d.to(found, 1.0)
        d.pause(1.8)
        t1 = d.first(team_on_map(facts().get("find_team_id", "T1")), timeout=2)
        if t1 is not None:
            d.to(t1, 1.2, 0.5, 0.5)
        d.pause(4.5)  # hold on the map

    def debrief():
        """t6: the after-action report beside the map; then the Debrief's "what breaks first" (its three
        lines are read word for word over this shot)."""
        mark_next()
        report = d.first(p.locator('[aria-label="Mission report"]'), timeout=6)
        if report is None:
            raise RuntimeError("no after-action report at t6")
        d.pause(1.0)
        found = d.first(report.get_by_text(re.compile(r"^Found by")), timeout=1)
        if found is not None:
            d.to(found, 1.0, 0.2, 0.5)
            d.pause(1.6)
        events = d.first(report.get_by_text(re.compile(r"^Key events")), timeout=1)
        if events is not None:
            d.to(events, 1.0, 0.1, 0.5)
            d.pause(1.8)
        lines = p.locator('ol[aria-label="What breaks first"]').first
        if lines.count() == 0:
            raise RuntimeError("no 'What breaks first' in the debrief")
        rail = p.locator('[data-tour="debrief"]').first
        d.to(report if rail.count() == 0 else rail, 0.8, 0.5, 0.6)
        # one smooth scroll of the rail (a wheel step at a time is a round trip each at 4K, ~25 s)
        p.evaluate(SCROLL_TO_JS, 'ol[aria-label="What breaks first"]')
        d.pause(1.8)
        d.pause(0.6)
        items = lines.locator("li")
        for i in range(items.count()):
            d.to(items.nth(i), 0.9, 0.35, 0.5)
            d.pause(2.4)

    # targets: the v2 beat sheet (README, "Shot list v2"); a shot holds its last frame up to its target
    d.shot("call", 14, call)
    d.shot("photos", 22, photos)
    d.shot("confirm", 34, confirm)
    d.shot("trace", 10, trace)
    d.shot("next", 22, next_)
    d.shot("run", 18, run)
    d.shot("fleet", 14, fleet)
    d.shot("walk", 9, walk)
    d.shot("radio", 15, radio)
    d.shot("find", 12, find)
    d.shot("debrief", 26, debrief)


# --- the live shots: the simulated fleet on a local or AWS API ---------------------------------------

OVERRIDE_PATH = "/missions/{mission_id}/conditions/override"


def recall_guard(api: str, openapi: Callable[[str], dict] | None = None) -> str | None:
    """None when the API has the conditions override (``POST /conditions/override``); else why not."""

    def fetch(url: str) -> dict:
        with urllib.request.urlopen(url, timeout=5) as r:
            return json.loads(r.read())

    try:
        paths = (openapi or fetch)(f"{api.rstrip('/')}/openapi.json").get("paths", {})
    except Exception as e:  # noqa: BLE001 - reported in shots.json
        return f"no API schema at {api} ({type(e).__name__})"
    if OVERRIDE_PATH not in paths:
        return "the API has no conditions override yet (POST /conditions/override not merged)"
    return None


LIVE_SHOTS = (("live_link", 18), ("recall", 32))


def live_shots(d: Director, api: str, mission: str | None) -> None:
    """A fresh mission with the creek scenario's three simulated drones in the air (``scripts/recall_demo.py``'s
    steps, set up off camera), then on camera:

    - ``live_link``: the console's Fleet controls degrade D2's link (the ring on the map turns), and Team Two
      loses its signal (the scenario's own link event, given early) so the drones near it relay its position;
    - ``recall``: Fleet controls set gusts of 50 km/h (a demo override, labelled so), the conditions say no
      flying, the agent's recall cards arrive quoting the fact and the Mavic 3E's 43 km/h limit, each is
      approved, and the drones turn home.

    recall_demo's sim runs in one loop without the event stream, so a link change asked for at the console
    (``POST /fleet/link``, a request) is handed to the sim by this script, as the per-process fleet's feed
    would; the sim then reports it back and the map shows it."""
    p = d.page
    skip = api_up(api) or recall_guard(api)
    if skip is None and not local_file("data/heridal/yolo_full/val").exists():
        skip = "no HERIDAL val photos for the fleet sim"
    if skip:
        for sid, t in LIVE_SHOTS:
            d.shot(sid, t, lambda: None, mode="live", skip=skip)
        return
    sys.path.insert(0, str(ROOT / "scripts"))
    from recall_demo import Recall

    lines: list[str] = []
    run = Recall(api, lambda s: lines.append(s), time_scale=15.0)
    try:
        try:  # mission, conditions, fleet joins, opening legs approved, drones flying
            mid = run.setup(mission)
        except Exception as e:  # noqa: BLE001 - one broken shot must not lose the recording
            for sid, t in LIVE_SHOTS:
                d.shot(
                    sid, t, lambda: None, mode="live", skip=f"setup failed: {type(e).__name__}: {e}"
                )
            return

        def mapfig():
            return p.locator("figure[aria-label='Live map']").first

        def link():
            d.hash(f"#m/{mid}/map", 3.0)
            m = d.first(mapfig(), timeout=6)
            if m is not None:
                d.to(m, 1.2, 0.5, 0.5)
                d.pause(1.5)  # the drones on their legs
            controls = d.first(
                p.get_by_role("region", name="Fleet controls"),
                p.locator('section[aria-label="Fleet controls"]'),
                timeout=4,
            )
            if controls is None:
                raise Skip("no Fleet controls on the live console")
            degrade = controls.get_by_role("button", name=re.compile(r"^Degrade link"))
            d.to(degrade, 1.0)
            d.pause(0.8)
            d.click(degrade)
            drone = (degrade.text_content() or "D2").split()[-1]
            run.sim.set_link(
                drone, "degraded", by="command (demo controls)"
            )  # the request, handed to the sim
            # Team Two loses its signal (the scenario schedules it at 420 s; here it comes early)
            run.sim.set_link("T2", "no_signal", by="fleet sim (scenario)")
            d.pause(1.5)
            mk = d.first(
                p.locator(f"figure[aria-label='Live map'] [aria-label^='Drone {drone[-1]}']"),
                timeout=3,
            )
            if mk is not None:
                d.to(mk, 1.2)
                d.pause(2.0)
            # the relay: a drone within the relay radius of Team Two carries its position
            end = time.monotonic() + 8
            while not run.sim.gcs.relays and time.monotonic() < end:
                d.pause(0.3)
            team = d.first(
                p.locator("figure[aria-label='Live map'] [aria-label^='Team Two']"), timeout=2
            )
            if team is not None:
                d.to(team, 1.2)
            d.pause(2.5)
            info["relays"] = len(run.sim.gcs.relays)

        info: dict = {}
        shot = d.shot("live_link", 18, link, mode="live")
        shot.extra.update(mission=mid, **info)

        def recall():
            gusts = d.first(
                p.get_by_role("button", name=re.compile(r"^Set gusts .*demo override")), timeout=3
            )
            if gusts is not None:
                d.to(gusts, 1.0)
                d.pause(0.8)
                d.click(gusts)
            else:  # no Fleet controls on this build: the same call the button makes
                run.gusts()
            d.pause(1.5)
            status = d.first(p.get_by_text(re.compile(r"^Not flyable")), timeout=4)
            if status is not None:  # the conditions line says no flying
                d.to(status, 1.0)
                d.pause(1.5)
            recall = p.locator('[aria-label^="Proposal "]', has_text=re.compile(r"\bRecall\b"))
            first = d.first(recall, timeout=15)
            if first is None:
                raise Skip("no recall proposal arrived within 15 s")
            d.to(first, 1.0)
            why = d.first(first.get_by_label("Why recall"), timeout=1)
            if why is not None:
                d.to(why, 0.8)
            d.pause(3.0)  # read the quoted fact and its source
            for _ in range(len(run.state()["fleet"]["drones"])):
                c = d.first(recall, timeout=2)
                if c is None:
                    break
                d.to(c, 0.6)  # new cards can push it down the inbox
                d.click(c.get_by_role("button", name=re.compile(r"^Approve")))
                d.pause(1.2)
            # any a click missed (the inbox moved under the pointer): the same approval, off camera
            left = [
                x
                for x in run.state()["proposals"]
                if x["status"] == "pending" and "home" in x["target"]
            ]
            run.approve(left)
            d.to(mapfig(), 1.2, 0.5, 0.5)
            d.pause(5.0)  # the drones turn home

        shot = d.shot("recall", 32, recall, mode="live")
        shot.extra["mission"] = mid
        shot.extra["timeline"] = lines[-14:]
    finally:
        run.close()


# --- main ------------------------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--out", type=Path, help="run folder (default runs/video/<timestamp>)")
    ap.add_argument(
        "--server",
        choices=("preview", "dev"),
        default="preview",
        help="vite preview of a build (default) or the dev server",
    )
    ap.add_argument("--live", action="store_true", help="also record a live mission (needs --api)")
    ap.add_argument("--api", help="mission API base URL, e.g. http://127.0.0.1:8000")
    ap.add_argument(
        "--serve-local",
        action="store_true",
        help="with --live: start a local mission API for the run (fake LLM and Tavily, radio in text) and stop it after",
    )
    ap.add_argument(
        "--mission", help="live mission id to put the simulated fleet on (default: a new one)"
    )
    ap.add_argument("--headed", action="store_true", help="show the browser (debugging)")
    ap.add_argument(
        "--no-clock", action="store_true", help="don't pin the page clock to the fixture's now"
    )
    ap.add_argument(
        "--keep-dist", action="store_true", help="keep the built site in the run folder"
    )
    ap.add_argument("--scale", type=float, default=2.0,
                    help="device scale: the frames are 1920x1080 times this (default 2: 3840x2160)")  # fmt: skip
    ap.add_argument("--fps", choices=("auto", "60", "30"), default="auto",
                    help="the master's frame rate; auto: 60 when the capture keeps up while the page moves, else 30")  # fmt: skip
    ap.add_argument("--quality", type=int, default=95, help="the screencast's JPEG quality (default 95)")  # fmt: skip
    ap.add_argument("--keep-frames", action="store_true", help="keep the captured JPEGs (frames/)")
    ap.add_argument("--shots", help="comma-separated shot ids to record (default: all)")
    ap.add_argument("--landing", default="/", help="where the call shot opens, e.g. '/#m/demo?t=0'")
    args = ap.parse_args(argv)
    if args.live and not (args.api or args.serve_local):
        ap.error("--live needs --api (or --serve-local)")

    from playwright.sync_api import sync_playwright

    out = args.out or ROOT / "runs/video" / datetime.now().strftime("%Y%m%d-%H%M%S")
    out.mkdir(parents=True, exist_ok=True)
    (out / "snaps").mkdir(exist_ok=True)
    log = open(out / "site.log", "w")  # noqa: SIM115 - closed below
    api = args.api.rstrip("/") if args.api else None
    fixed_now = json.loads(FIXTURE.read_text())["now"]
    # a live mission's events carry real times: the page clock is pinned for the demo-only flow only
    # (the demo console reads the fixture's now either way)
    pinned = not args.no_clock and not args.live

    site = server = None
    dist = None
    t_wall = time.monotonic()
    try:
        if args.live and args.serve_local:
            server, api = start_api(out)
        if args.server == "preview":
            dist = build_site(out, api if args.live else None, log)
        site = start_site(args.server, dist, api if args.live else None, log)
        base = f"http://127.0.0.1:{PORT}"
        k = args.scale
        cap_size = (round(SIZE["width"] * k), round(SIZE["height"] * k))
        with sync_playwright() as pw:
            # the forced scale makes the browser's own surface 2x, so the screencast's frames are too
            # (with the context's scale alone they come down at the viewport's 1920x1080)
            browser = pw.chromium.launch(
                headless=not args.headed,
                args=["--hide-scrollbars", "--force-color-profile=srgb", f"--force-device-scale-factor={k:g}"],
            )  # fmt: skip
            ctx = browser.new_context(
                viewport=SIZE, screen=SIZE, device_scale_factor=k,
                reduced_motion="no-preference", color_scheme="dark", timezone_id="America/Vancouver", locale="en-US",
            )  # fmt: skip
            ctx.add_init_script(CURSOR_JS)
            page = ctx.new_page()
            if pinned:
                page.clock.install(time=fixed_now)  # runs on from the fixture's now
            d = Director(page, base, out)
            d.only = set(args.shots.split(",")) if args.shots else None
            d.landing = args.landing
            cap = FrameCapture(page, out / "frames", cap_size, args.quality)
            cap.start()
            print(f"recording at {cap_size[0]}x{cap_size[1]}", flush=True)
            demo_shots(d)
            if args.live:
                live_shots(d, api, args.mission)
            d.pause(1.5)  # a beat on the last frame
            total = d.now()
            cap.stop()
            ctx.close()
            browser.close()
        st = cap.stats()
        fps = int(args.fps) if args.fps != "auto" else (60 if st["moving_fps"] >= 45 else 30)
        got = cap.frame_size() if cap.ts else (0, 0)
        if got != cap_size:
            print(
                f"warning: the frames are {got[0]}x{got[1]}, not {cap_size[0]}x{cap_size[1]}",
                flush=True,
            )
        print(f"capture: {st['frames']} frames in {st['span_s']:.1f} s; while the page moves "
              f"{st['moving_fps']:.1f} fps (p90 {st['moving_p90_fps']:.0f}, over {st['moving_s']:.0f} s of motion); "
              f"master at {fps} fps", flush=True)  # fmt: skip
        name = "master_4k.mp4" if got == (3840, 2160) else f"master_{got[1]}p.mp4"
        t_enc = time.monotonic()
        cap.encode(out / name, fps, log)
        print(f"encoded {name} in {time.monotonic() - t_enc:.0f} s", flush=True)
        cap.save_times(out / "frame_times.json")
        if not args.keep_frames:
            shutil.rmtree(out / "frames", ignore_errors=True)
        sync = align(d.shots, out / name, total, cap)
        duration = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                                         str(out / name)], capture_output=True, text=True, check=True).stdout)  # fmt: skip
        doc = {
            "video": name,
            "size": list(got),
            "viewport": [SIZE["width"], SIZE["height"]],
            "scale": k,
            "fps": fps,
            "capture": {
                **st,
                "quality": args.quality,
                "method": "page.screencast (CDP Page.startScreencast), JPEG",
            },
            "mode": "live" if args.live else "demo",
            "recorded_at": datetime.now(UTC).isoformat(timespec="seconds"),
            "page_clock": fixed_now if pinned else None,
            "server": args.server,
            "api": api,
            "total_s": round(duration, 3),
            "wall_total_s": total,
            "sync": sync,
            "delogo": delogo(got[0] / SIZE["width"] if got[0] else k),
            "shots": [asdict(s) for s in d.shots],
        }
        (out / "shots.json").write_text(json.dumps(doc, indent=2) + "\n")
        mb = (out / name).stat().st_size / 1e6
        print(
            f"\n{out / name}  ({duration:.1f} s of video, {mb:.1f} MB, {mb * 8 / max(duration, 0.1):.1f} Mbit/s; "
            f"shot times read by {sync}; {time.monotonic() - t_wall:.0f} s wall)"
        )
        for s in d.shots:
            print(
                f"  {s.id:14} {s.status:8} {s.start_s:7.1f} → {s.end_s:7.1f}  ({(s.end_s or 0) - (s.start_s or 0):5.1f} s)"
            )
        print(f"{out / 'shots.json'}")
        bad = [s for s in d.shots if s.status == "failed"]
        return 1 if bad else 0
    finally:
        stop(site, "site")
        stop(server, "api")
        log.close()
        if dist is not None and not args.keep_dist:
            shutil.rmtree(dist, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
