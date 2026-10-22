"""Record the demo flow as one 1920x1080 screen recording, shot by shot (WIN_RESEARCH §8).

    uv run --extra video python scripts/demo_video/record.py                       # demo-only flow
    uv run --extra video python scripts/demo_video/record.py --live --api http://127.0.0.1:8000

Builds the site (``VITE_CACHE_DIR=demo``), serves it with ``vite preview`` on port 5202 (started and
stopped by PID by this script), drives Chromium through the guided demo and the command console with
eased mouse moves and the keyboard, and writes into the run folder:

- ``master.webm``: the recording (Playwright ``recordVideo``, 1920x1080);
- ``shots.json``: every shot's id, target duration and actual start/end in the recording, and whether
  it ran, was skipped (a route or element that isn't there yet, the API down) or failed;
- ``snaps/<shot>.png``: the last frame of each shot, to check a run without watching it.

Deterministic where the app allows: a fixed viewport and scale, a fixed time zone and locale, motion
allowed (``prefers-reduced-motion: no-preference``), and the page clock started at the demo mission's
own ``now`` (its fixture), so the header clock, daylight left and ages read the same on every run.

Shots for parts other workers are still adding (the Trace tab at ``#m/demo/trace``, a drone re-task on
the console) look for their route or element first and are skipped, with the reason in shots.json,
when it isn't there, so the same script works before and after those merge.
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
import threading
import time
import urllib.request
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / "web"
FIXTURE = WEB / "src/command/__fixtures__/demo_mission.json"
PORT = 5202
SIZE = {"width": 1920, "height": 1080}

# A visible pointer: headless Chromium records no cursor, so the page gets one drawn on top (and a ring
# on each click). Injected by the recorder only; the site itself is untouched.
CURSOR_JS = r"""
(() => {
  const install = () => {
    if (document.getElementById("__demo_cursor")) return;
    const c = document.createElement("div");
    c.id = "__demo_cursor";
    c.innerHTML = '<svg width="28" height="28" viewBox="0 0 28 28"><path d="M4 2 L4 22 L9.5 17 L13 25.5 L16.5 24 L13 16 L20.5 16 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, {position: "fixed", left: "0", top: "0", zIndex: "2147483647", pointerEvents: "none",
      transform: "translate(-100px,-100px)", filter: "drop-shadow(0 1px 2px rgba(0,0,0,.5))"});
    document.documentElement.appendChild(c);
    window.addEventListener("mousemove", (e) => { c.style.transform = `translate(${e.clientX - 4}px,${e.clientY - 2}px)`; }, true);
    window.addEventListener("mousedown", (e) => {
      const r = document.createElement("div");
      Object.assign(r.style, {position: "fixed", left: `${e.clientX - 18}px`, top: `${e.clientY - 18}px`, width: "36px", height: "36px",
        borderRadius: "50%", border: "3px solid rgba(255,196,0,.95)", zIndex: "2147483646", pointerEvents: "none",
        transition: "transform .45s ease-out, opacity .45s ease-out"});
      document.documentElement.appendChild(r);
      requestAnimationFrame(() => { r.style.transform = "scale(1.8)"; r.style.opacity = "0"; });
      setTimeout(() => r.remove(), 600);
    }, true);
    // The sync mark: a 12 px square near the bottom-right corner, black between shots and magenta or
    // green (alternating) during one. The recording's own clock drifts from wall time when the renderer is
    // busy, so shot times are read back off the video from this mark, then it is painted out (delogo).
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
SYNC_BOX = (1906, 1066, 12)  # x, y, size of the mark in the 1920x1080 frame
DELOGO = "delogo=x=1903:y=1063:w=16:h=16"  # paints the mark out (captions.py applies it)


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


def val_photos() -> Path:
    """HERIDAL validation photos (never the test split)."""
    return local_file("data/heridal/yolo_full/val/images")


# --- reading the shots back off the video ----------------------------------------------------------


def probe_fps(video: Path) -> float:
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate",
                        "-of", "csv=p=0", str(video)], capture_output=True, text=True, check=True)  # fmt: skip
    num, _, den = r.stdout.strip().partition("/")
    return float(num) / float(den or 1)


def read_sync(video: Path) -> list[tuple[float, float]]:
    """The (start, end) in video seconds of every coloured run of the sync mark, in order."""
    import numpy as np

    x, y, n = SYNC_BOX
    c = 4  # the middle 4x4 of the mark: clear of the codec's edge bleed
    crop = f"crop={c}:{c}:{x + (n - c) // 2}:{y + (n - c) // 2}"
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(video), "-vf", crop, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                         capture_output=True, check=True).stdout  # fmt: skip
    px = (
        np.frombuffer(raw, np.uint8).reshape(-1, c * c, 3).mean(axis=1)
    )  # one mean colour per frame
    ref = np.array([[0, 0, 0], [255, 0, 255], [0, 255, 0]], float)
    labels = np.argmin(
        ((px[:, None, :] - ref[None]) ** 2).sum(-1), axis=1
    )  # 0 black, 1 magenta, 2 green
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
        if lab != 0 and b - a >= 2
    ]


def align(shots: list[Shot], video: Path, total_wall: float) -> str:
    """Rewrites the shots' start/end from wall time to video time. Returns how: "mark" (read off the
    video) or "scaled" (the mark didn't read cleanly: wall times scaled to the video's length)."""
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

    def now(self) -> float:
        return round(time.monotonic() - self.t0, 3)

    def sync(self, color: str) -> None:
        try:
            self.page.evaluate("c => window.__demoSync && window.__demoSync(c)", color)
        except Exception:  # noqa: BLE001, S110 - mid-navigation: the init script sets it on the new page
            pass

    # pacing and the pointer
    def pause(self, s: float) -> None:
        time.sleep(s)

    def move(self, x: float, y: float, duration: float = 0.7) -> None:
        """An eased move that takes `duration` of wall time however slow the page is (each mouse event is
        a round trip to a busy renderer, so the step count adapts instead of the length)."""
        x0, y0 = self.x, self.y
        dist = math.hypot(x - x0, y - y0)
        if dist < 2:
            return
        start = time.monotonic()
        while True:
            k = min(1.0, (time.monotonic() - start) / duration)
            e = ease(k)
            bow = math.sin(math.pi * e) * min(40.0, dist * 0.08)  # a slight arc, like a hand
            self.page.mouse.move(x0 + (x - x0) * e, y0 + (y - y0) * e - bow)
            if k >= 1.0:
                break
            time.sleep(1 / 60)
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

    def click(self, locator, duration: float = 0.7, settle: float = 0.35) -> None:
        self.to(locator, duration)
        self.pause(0.15)
        self.page.mouse.down()
        self.pause(0.08)
        self.page.mouse.up()
        self.pause(settle)

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
            time.sleep(0.15)

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
        self.shots.append(s)
        s.start_s = self.now()
        if skip:
            s.status, s.note, s.end_s = "skipped", skip, s.start_s
            print(f"  skip {sid}: {skip}", flush=True)
            return s
        self.color = SYNC_COLORS[self.marked % 2]
        self.sync(self.color)
        s.start_s = self.now()
        s.extra["marked"] = True
        self.marked += 1
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


# --- the demo-only shots ---------------------------------------------------------------------------


def demo_shots(d: Director) -> None:

    p = d.page

    def step_bar(label: str):
        return p.get_by_role("navigation", name="Demo steps").get_by_role(
            "button", name=re.compile(label)
        )

    def go_step(label: str, key: str, *ctas):
        """The step's own primary button if there is one, else the step bar, else its number key."""
        b = d.first(*ctas, timeout=2.5) if ctas else None
        if b is None:
            b = d.first(step_bar(label), timeout=1.5)
        if b is not None:
            d.click(b)
        else:
            d.key(key)

    def front():
        d.goto(d.base + "/")
        d.pause(2.0)
        btn = d.first(
            p.get_by_role("button", name=re.compile("Watch a demo search", re.IGNORECASE)),
            p.get_by_role("link", name=re.compile("Watch a demo", re.IGNORECASE)),
            timeout=8,
        )
        if btn is None:
            raise RuntimeError("no 'Watch a demo search' on the front door")
        d.to(btn, 1.2)
        d.pause(1.2)
        d.click(btn)

    def survey():
        p.wait_for_load_state("networkidle")
        d.pause(1.5)
        # look over the survey: the map and its photos
        d.move(SIZE["width"] * 0.42, SIZE["height"] * 0.48, 1.4)
        d.pause(2.5)
        d.move(SIZE["width"] * 0.60, SIZE["height"] * 0.40, 1.4)
        d.pause(2.0)

    def rank():
        go_step("Rank", "2", p.get_by_role("button", name=re.compile(r"^Start: rank")))
        # the scan plays; the CTA appears when it's done
        d.pause(1.0)
        d.move(SIZE["width"] * 0.5, SIZE["height"] * 0.55, 1.2)
        d.first(p.get_by_role("button", name=re.compile(r"Start review")), timeout=12)

    def review():
        go_step("Review", "3", p.get_by_role("button", name=re.compile(r"Start review")))
        d.pause(2.5)
        for k in ("p", "n", "p"):  # three candidates, answered with the keyboard
            d.key(k, 2.6)
        d.pause(1.0)

    def search():
        go_step(
            "Search next", "4", p.get_by_role("button", name=re.compile(r"See where to search"))
        )
        d.pause(2.0)
        play = d.first(
            p.locator('[data-testid="mount-heat"] button[aria-label="Play"]'),
            p.get_by_role("button", name="Play"),
            timeout=3,
        )
        if play is not None:
            try:
                d.click(play)
            except Exception as e:  # noqa: BLE001 - the replay is a nice-to-have; the map is the shot
                print(f"    (search: no replay: {type(e).__name__})", flush=True)
        d.pause(3.0)
        d.move(SIZE["width"] * 0.45, SIZE["height"] * 0.5, 1.5)

    def operate():
        go_step("Command", "5", p.get_by_role("button", name=re.compile(r"Run the search")))
        d.pause(2.0)
        d.move(SIZE["width"] * 0.5, SIZE["height"] * 0.6, 1.2)

    def console():
        d.hash("#m/demo/command", 2.5)
        card = d.first(
            p.locator('[aria-label="Task board"] [aria-label^="Sector "]'),
            p.locator('[aria-label^="Sector "]'),
            timeout=8,
        )
        if card is None:
            raise RuntimeError("no task cards on the console")
        d.to(card, 1.2)
        d.pause(2.0)
        cards = p.locator('[aria-label="Task board"] [aria-label^="Sector "]')
        if cards.count() > 2:
            d.to(cards.nth(2), 1.0)
            d.pause(1.5)
        team = d.first(p.locator('[aria-label="Teams"] button'), timeout=1)
        if team is not None:
            d.click(team)  # selecting a team flies the map to it
            d.pause(2.0)

    def approvals():
        tab = d.first(
            p.get_by_role("navigation", name="Mission views").get_by_role(
                "button", name=re.compile(r"^Approvals")
            ),
            timeout=3,
        )
        if tab is not None:
            d.click(tab)
            d.pause(1.5)
        card = d.first(p.locator('[aria-label^="Proposal "]'), timeout=5)
        if card is None:
            raise RuntimeError("no pending proposal in the inbox")
        reason = d.first(card.locator("button[aria-expanded]"), timeout=1)
        if reason is not None:
            d.click(reason)
            d.pause(2.0)
        approve = card.get_by_role("button", name=re.compile(r"^Approve"))
        d.to(approve, 0.9)
        d.pause(1.0)
        d.click(approve)
        d.pause(1.5)
        decided = d.first(p.locator("summary", has_text=re.compile(r"^Decided")), timeout=2)
        if decided is not None:
            d.click(decided)
            d.pause(2.5)

    def clue():
        tab = d.first(
            p.get_by_role("navigation", name="Mission views").get_by_role(
                "button", name=re.compile(r"^Command")
            ),
            timeout=2,
        )
        if tab is not None and tab.get_attribute("aria-pressed") != "true":
            d.click(tab)
            d.pause(2.0)
        add = d.first(p.get_by_role("button", name=re.compile(r"Add clue")), timeout=5)
        if add is None:
            raise RuntimeError("no 'Add clue' button")
        d.click(add)
        form = p.get_by_role("form", name="Add clue")
        d.type(form.get_by_label("What"), "blue backpack by the creek")
        d.pause(0.6)
        form.get_by_label("Where").select_option("latlon")
        d.pause(0.8)
        pick = d.first(form.get_by_role("button", name=re.compile("Pick on map")), timeout=2)
        mapfig = d.first(
            p.locator("figure[aria-label='Live map'] canvas"),
            p.locator("figure[aria-label='Live map']"),
            timeout=3,
        )
        if pick is not None and mapfig is not None:
            d.click(pick)
            d.pause(0.8)
            d.to(mapfig, 1.4, 0.42, 0.58)
            d.pause(0.4)
            d.page.mouse.down()
            d.pause(0.08)
            d.page.mouse.up()
            d.pause(1.0)
        lat = form.get_by_label("Latitude")
        if not lat.input_value():  # the pick didn't land: type a point inside the demo area
            raise RuntimeError("the map pick gave no position")
        form.get_by_label("Reliability").select_option("high")
        d.pause(0.6)
        d.click(form.get_by_role("button", name=re.compile(r"^Add$")))
        d.pause(3.0)
        d.move(SIZE["width"] * 0.5, SIZE["height"] * 0.45, 1.2)

    def fleet_guard() -> str | None:
        retask = p.locator(
            '[aria-label^="Proposal "]', has_text=re.compile(r"re-?task", re.IGNORECASE)
        )
        if retask.count() == 0:
            return "no drone re-task proposal on the demo console yet (fleet on the demo mission not merged)"
        return None

    def fleet():
        card = p.locator(
            '[aria-label^="Proposal "]', has_text=re.compile(r"re-?task", re.IGNORECASE)
        ).first
        d.to(card, 1.0)
        d.pause(2.5)
        d.click(card.get_by_role("button", name=re.compile(r"^Approve")))
        d.pause(4.0)  # the drone turns on the map

    def trace_guard() -> str | None:
        d.hash("#m/demo/command", 0.8)
        views = p.get_by_role("navigation", name="Mission views")
        if views.get_by_role("button", name=re.compile(r"^Trace")).count() == 0:
            return "no Trace tab on the demo mission yet (#m/demo/trace not merged)"
        return None

    def trace():
        d.hash("#m/demo/trace", 2.0)
        rows = d.first(p.get_by_role("row"), p.locator("li"), timeout=3)
        if rows is not None:
            d.to(rows, 1.2)
        d.pause(2.0)
        p.mouse.wheel(0, 500)
        d.pause(3.0)

    def feed():
        tab = d.first(
            p.get_by_role("navigation", name="Mission views").get_by_role(
                "button", name=re.compile(r"^Feed")
            ),
            timeout=2,
        )
        if tab is not None:
            d.click(tab)
        else:
            d.hash("#m/demo/feed")
        d.pause(2.5)
        p.mouse.wheel(0, 400)
        d.pause(2.5)

    # targets: the §8 OpenCV outline's lengths, scaled to what each screen has to show
    d.shot("front", 7, front)
    d.shot("survey", 9, survey)
    d.shot("rank", 12, rank)
    d.shot("review", 14, review)
    d.shot("search", 12, search)
    d.shot("operate", 7, operate)
    d.shot("console", 12, console)
    d.shot("approvals", 14, approvals)
    d.shot("clue", 18, clue)
    d.shot("fleet", 12, fleet, skip=fleet_guard())
    d.shot("trace", 14, trace, skip=trace_guard())
    d.shot("feed", 8, feed)


# --- the live shots --------------------------------------------------------------------------------


class Replay:
    """`python -m sightline.client replay` in a subprocess: real-GPS val photos at drone pace."""

    def __init__(self, api: str, mission: str | None, limit: int, pace: float, out: Path):
        self.mission = mission
        self.lines: list[str] = []
        cmd = [sys.executable, "-m", "sightline.client", "replay", "--api", api, "--pace", str(pace),
               "--limit", str(limit), "--photos", str(val_photos())]  # fmt: skip
        if mission:
            cmd += ["--mission", mission]
        self.log = open(out / "replay.log", "w")  # noqa: SIM115 - closed in stop()
        self.proc = subprocess.Popen(
            cmd,
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
        )
        print(f"replay: pid {self.proc.pid}, {limit} photos every {pace} s", flush=True)
        self.ready = threading.Event()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            self.log.write(line)
            self.log.flush()
            self.lines.append(line.rstrip())
            m = re.match(r"mission ([0-9a-f]{8}):", line)
            if m and not self.mission:
                self.mission = m.group(1)
            if self.mission:
                self.ready.set()
        self.ready.set()

    def stop(self) -> None:
        stop(self.proc, "replay")
        self.log.close()


def live_shots(
    d: Director, api: str, mission: str | None, limit: int, pace: float
) -> Replay | None:
    p = d.page
    down = api_up(api)
    ids = [
        ("live_upload", 12),
        ("live_photos", 20),
        ("live_review", 16),
        ("live_console", 14),
        ("live_radio", 10),
    ]
    if down:
        for sid, t in ids:
            d.shot(sid, t, lambda: None, mode="live", skip=f"API down: {down}")
        return None
    replay = Replay(api, mission, limit, pace, d.out)
    replay.ready.wait(30)
    mid = replay.mission
    if not mid:
        for sid, t in ids:
            d.shot(
                sid,
                t,
                lambda: None,
                mode="live",
                skip=f"replay gave no mission id: {replay.lines[-3:]}",
            )
        return replay

    def views(name: str):
        return p.get_by_role("navigation", name="Mission views").get_by_role(
            "button", name=re.compile(rf"^{name}")
        )

    def upload():
        d.hash(f"#m/{mid}/photos", 2.0)
        code = d.first(p.locator("code"), timeout=5)
        if code is not None:
            d.to(code, 1.2, 0.3)
            d.pause(2.5)
            copy = d.first(p.get_by_role("button", name="Copy"), timeout=1)
            if copy is not None:
                d.click(copy)

    def photos():
        d.move(SIZE["width"] * 0.3, SIZE["height"] * 0.25, 1.2)  # the counters tick as photos land
        d.pause(6.0)
        d.move(SIZE["width"] * 0.55, SIZE["height"] * 0.25, 1.2)

    def review():
        go = p.get_by_role("button", name="Go to review")
        b = (
            d.first(go, timeout=3)
            if go.count() and go.first.is_enabled()
            else d.first(views("Review"), timeout=3)
        )
        if b is not None:
            d.click(b)
        else:
            d.hash(f"#m/{mid}/review")
        d.pause(2.5)
        for _ in range(3):
            d.key("j", 2.5)

    def console():
        b = d.first(views("Command"), timeout=2)
        if b is not None:
            d.click(b)
        else:
            d.hash(f"#m/{mid}/command")
        d.pause(2.0)
        m = d.first(p.locator("figure[aria-label='Live map']"), timeout=4)
        if m is not None:
            d.to(m, 1.4, 0.5, 0.5)
            p.mouse.wheel(0, -300)

    def radio():
        b = d.first(views("Radio"), timeout=2)
        if b is not None:
            d.click(b)
        else:
            d.hash(f"#m/{mid}/radio")
        d.pause(3.0)

    shot = d.shot("live_upload", 12, upload, mode="live")
    shot.extra["mission"] = mid
    d.shot("live_photos", 20, photos, mode="live")
    d.shot("live_review", 16, review, mode="live")
    d.shot("live_console", 14, console, mode="live")
    d.shot("live_radio", 10, radio, mode="live")
    return replay


# --- the recall shot (the Tavily moment) -------------------------------------------------------------

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


def recall_shot(d: Director, api: str) -> None:
    """Gusts → no-fly → recall on a fresh live mission with the simulated fleet in the air
    (``scripts/recall_demo.py``'s steps; set up before the shot, off camera): the console's Fleet
    controls set gusts of 50 km/h as a demo override, the agent's recall cards arrive quoting it, a
    person approves them, and the drones turn home on the map."""
    p = d.page
    skip = api_up(api) or recall_guard(api)
    if skip is None and not local_file("data/heridal/yolo_full/val").exists():
        skip = "no HERIDAL val photos for the fleet sim"
    if skip:
        d.shot("recall", 25, lambda: None, mode="live", skip=skip)
        return
    sys.path.insert(0, str(ROOT / "scripts"))
    from recall_demo import Recall

    lines: list[str] = []
    run = Recall(api, lambda s: lines.append(s), time_scale=15.0)
    try:
        try:  # mission, conditions, fleet joins, opening legs approved, drones flying
            mid = run.setup()
        except Exception as e:  # noqa: BLE001 - one broken shot must not lose the recording
            d.shot(
                "recall",
                25,
                lambda: None,
                mode="live",
                skip=f"setup failed: {type(e).__name__}: {e}",
            )
            return

        def shoot():
            d.hash(f"#m/{mid}/command", 3.0)
            m = d.first(p.locator("figure[aria-label='Live map']"), timeout=6)
            if m is not None:
                d.to(m, 1.2, 0.5, 0.5)
                d.pause(2.0)  # the drones on their legs
            gusts = d.first(
                p.get_by_role("button", name=re.compile(r"^Set gusts .*demo override")), timeout=3
            )
            if gusts is not None:
                d.to(gusts, 1.0)
                d.pause(0.8)
                d.click(gusts)
            else:  # no Fleet controls on this build: the same call the button makes
                run.gusts()
            recall = p.locator('[aria-label^="Proposal "]', has_text=re.compile(r"\bRecall\b"))
            card = d.first(recall, timeout=15)
            if card is None:
                raise Skip("no recall proposal arrived within 15 s")
            d.to(card, 1.0)
            why = d.first(card.get_by_label("Why recall"), timeout=1)
            if why is not None:
                d.to(why, 0.8)
            d.pause(3.0)  # read the quoted fact and its source
            for _ in range(len(run.state()["fleet"]["drones"])):
                card = d.first(recall, timeout=2)
                if card is None:
                    break
                d.to(card, 0.6)  # new cards (team assignments) can push it down the inbox
                d.click(card.get_by_role("button", name=re.compile(r"^Approve")))
                d.pause(1.2)
            # any a click missed (the inbox moved under the pointer): the same approval, off camera
            left = [
                x
                for x in run.state()["proposals"]
                if x["status"] == "pending" and "home" in x["target"]
            ]
            run.approve(left)
            if m is not None:
                d.to(m, 1.2, 0.5, 0.5)
            d.pause(5.0)  # the drones turn home

        shot = d.shot("recall", 25, shoot, mode="live")
        shot.extra["mission"] = mid
        shot.extra["timeline"] = lines[-12:]
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
        "--mission", help="live mission id to resume (default: the replay starts a new one)"
    )
    ap.add_argument("--replay-limit", type=int, default=12, help="photos the replay sends")
    ap.add_argument("--replay-pace", type=float, default=2.0, help="seconds between photos")
    ap.add_argument("--headed", action="store_true", help="show the browser (debugging)")
    ap.add_argument(
        "--no-clock", action="store_true", help="don't pin the page clock to the fixture's now"
    )
    ap.add_argument(
        "--keep-dist", action="store_true", help="keep the built site in the run folder"
    )
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

    site = replay = server = None
    dist = None
    t_wall = time.monotonic()
    try:
        if args.live and args.serve_local:
            server, api = start_api(out)
        if args.server == "preview":
            dist = build_site(out, api if args.live else None, log)
        site = start_site(args.server, dist, api if args.live else None, log)
        base = f"http://127.0.0.1:{PORT}"
        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                headless=not args.headed, args=["--hide-scrollbars", "--force-color-profile=srgb"]
            )
            ctx = browser.new_context(
                viewport=SIZE, screen=SIZE, device_scale_factor=1, record_video_dir=str(out / "raw"), record_video_size=SIZE,
                reduced_motion="no-preference", color_scheme="dark", timezone_id="America/Vancouver", locale="en-US",
            )  # fmt: skip
            ctx.add_init_script(CURSOR_JS)
            page = ctx.new_page()
            if pinned:
                page.clock.install(time=fixed_now)  # runs on from the fixture's now
            d = Director(page, base, out)
            print("recording", flush=True)
            demo_shots(d)
            if args.live:
                replay = live_shots(d, api, args.mission, args.replay_limit, args.replay_pace)
                recall_shot(d, api)
            d.pause(1.5)  # a beat on the last frame
            total = d.now()
            video = page.video
            ctx.close()  # finishes the video file
            raw = Path(video.path())
            browser.close()
        shutil.move(raw, out / "master.webm")
        shutil.rmtree(out / "raw", ignore_errors=True)
        sync = align(d.shots, out / "master.webm", total)
        duration = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                                         str(out / "master.webm")], capture_output=True, text=True, check=True).stdout)  # fmt: skip
        doc = {
            "video": "master.webm",
            "size": [SIZE["width"], SIZE["height"]],
            "mode": "live" if args.live else "demo",
            "recorded_at": datetime.now(UTC).isoformat(timespec="seconds"),
            "page_clock": fixed_now if pinned else None,
            "server": args.server,
            "api": api,
            "total_s": round(duration, 3),
            "wall_total_s": total,
            "sync": sync,
            "delogo": DELOGO,
            "shots": [asdict(s) for s in d.shots],
        }
        (out / "shots.json").write_text(json.dumps(doc, indent=2) + "\n")
        print(
            f"\n{out / 'master.webm'}  ({duration:.1f} s of video, shot times read by {sync}; {time.monotonic() - t_wall:.0f} s wall)"
        )
        for s in d.shots:
            print(
                f"  {s.id:14} {s.status:8} {s.start_s:7.1f} → {s.end_s:7.1f}  ({(s.end_s or 0) - (s.start_s or 0):5.1f} s)"
            )
        print(f"{out / 'shots.json'}")
        bad = [s for s in d.shots if s.status == "failed"]
        return 1 if bad else 0
    finally:
        if replay is not None:
            replay.stop()
        stop(site, "site")
        stop(server, "api")
        log.close()
        if dist is not None and not args.keep_dist:
            shutil.rmtree(dist, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
