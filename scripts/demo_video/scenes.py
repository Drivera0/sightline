"""Record the Synthesia screen captures: one clean clip per scene from the current site (README, "Scenes").

    uv run --extra video python scripts/demo_video/scenes.py                      # every scene
    uv run --extra video python scripts/demo_video/scenes.py --scenes s3,n2       # just those
    uv run --extra video python scripts/demo_video/scenes.py --url http://127.0.0.1:5301   # a site already served
    uv run --extra video python scripts/demo_video/scenes.py --publish <folder>   # + copy the finished files there

No narration, no captions, no music: footage only. Builds the site (``VITE_CACHE_DIR=demo``), serves it with
``vite preview`` on port 5301 (started and stopped by PID), and records each scene in a fresh browser context
(one Chromium for the run): whatever a scene needs first (the clock run to its decision, earlier answers) is
done off camera with the screencast stopped, then the capture starts on a calm frame, the pointer moves and
clicks with a 0.6 s pause before each click, and the capture stops on a calm frame. Frames come from
``capture.py`` (CDP screencast, 1920x1080 at device scale 2: 3840x2160), the visible pointer is the recorder's
own (record.py's, without its sync mark). Each scene's own controls are found by role and label.

Writes ``runs/video/scenes-<timestamp>/``: ``<scene>.mp4`` (3840x2160, 30 fps, H.264 CRF 16, yuv420p, BT.709,
no audio, +faststart), ``1080p/<scene>.mp4`` (lanczos, CRF 16), ``contact/<scene>.jpg`` (start, middle and end
frames), ``n2_radio_with_audio.mp4`` (the radio scene with the page's voice clips laid back in at the times
they played), ``architecture_4k.png``, ``scenes.json`` and ``README.txt``.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from capture import FrameCapture
from record import FIXTURE, ROOT, SIZE, WEB, build_site, ease, port_free, stop, wait_http

PORT = 5301
SCALE = 2.0
FPS = 30

# The recorder's pointer (record.py's CURSOR_JS without the sync mark): an SVG arrow drawn on top of the page
# and a ring that eases out on each press. Injected by the recorder only; the site is untouched.
POINTER_JS = r"""
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
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install); else install();
})();
"""

# The getting-started tour is a first visit's: each scene opens as a returning visitor (Tour.tsx TOUR_KEY).
SEED_JS = "try { localStorage.setItem('sightline.tour-seen', '1'); } catch (e) {}"

# Every voice clip the page plays, reported with the recorder's clock (n2's audio track is rebuilt from them).
AUDIO_JS = r"""
(() => {
  const orig = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...a) {
    if (!this.__sceneHooked) {
      this.__sceneHooked = true;
      for (const ev of ["pause", "ended"]) this.addEventListener(ev, () => window.__sceneAudio && window.__sceneAudio(ev, this.currentSrc || this.src));
    }
    window.__sceneAudio && window.__sceneAudio("play", this.currentSrc || this.src);
    return orig.apply(this, a);
  };
})();
"""

# Eases a scroll (the window's, or an element's nearest scrolling ancestor's) over `ms`; returns at once.
SCROLL_JS = r"""
([sel, nth, offset, ms, absolute]) => {
  let sc = null, target = 0;
  const el = sel ? document.querySelectorAll(sel)[nth] : null;
  if (el) {
    sc = el.parentElement;
    while (sc && !(/(auto|scroll)/.test(getComputedStyle(sc).overflowY) && sc.scrollHeight > sc.clientHeight)) sc = sc.parentElement;
  }
  const win = !sc;
  const y0 = win ? window.scrollY : sc.scrollTop;
  if (absolute !== null) target = absolute;
  else if (el) target = win ? window.scrollY + el.getBoundingClientRect().top - offset
                            : sc.scrollTop + el.getBoundingClientRect().top - sc.getBoundingClientRect().top - offset;
  const t0 = performance.now();
  const f = (t) => {
    const k = Math.min(1, (t - t0) / ms);
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    const y = y0 + (target - y0) * e;
    if (win) window.scrollTo(0, y); else sc.scrollTop = y;
    if (k < 1) requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
  return true;
}
"""


class Cam:
    """One scene's page, pointer and capture. Off camera until ``start``; ``pause`` waits inside Playwright
    so the screencast's frames keep arriving (capture.py)."""

    def __init__(self, page, folder: Path):
        self.page = page
        self.folder = folder
        self.cap: FrameCapture | None = None
        self.x, self.y = 1500.0, 900.0
        self.t_start = 0.0
        self.audio: list[tuple[float, str, str]] = []  # (epoch, play|pause|ended, src)

    # capture
    def start(self, hold: float = 1.2) -> None:
        self.page.mouse.move(self.x, self.y)  # the pointer is drawn from the first move
        self.pause(0.3)
        self.cap = FrameCapture(
            self.page,
            self.folder / "frames",
            (round(SIZE["width"] * SCALE), round(SIZE["height"] * SCALE)),
        )
        self.cap.start()
        self.t_start = time.time()
        self.pause(hold)

    def stop(self, hold: float = 1.2) -> None:
        self.pause(hold)
        if self.cap:
            self.cap.stop()

    def pause(self, s: float) -> None:
        if s > 0:
            self.page.wait_for_timeout(s * 1000)

    # the pointer
    def move(self, x: float, y: float, duration: float = 0.8) -> None:
        """record.py's hand-like move: ease-in-out in time, a slightly bowed cubic Bezier in space, a fixed
        wall time however slow the renderer is."""
        x0, y0 = self.x, self.y
        dist = math.hypot(x - x0, y - y0)
        if dist < 2:
            return
        bow = min(40.0, dist * 0.08)
        nx, ny = (y0 - y) / dist * bow, (x - x0) / dist * bow
        if ny > 0:
            nx, ny = -nx, -ny
        c1 = (x0 + (x - x0) / 3 + nx, y0 + (y - y0) / 3 + ny)
        c2 = (x0 + 2 * (x - x0) / 3 + nx, y0 + 2 * (y - y0) / 3 + ny)
        t0 = time.monotonic()
        while True:
            k = min(1.0, (time.monotonic() - t0) / duration)
            e = ease(k)
            u = 1 - e
            px = u**3 * x0 + 3 * u * u * e * c1[0] + 3 * u * e * e * c2[0] + e**3 * x
            py = u**3 * y0 + 3 * u * u * e * c1[1] + 3 * u * e * e * c2[1] + e**3 * y
            self.page.mouse.move(px, py)
            if k >= 1.0:
                break
            self.pause(1 / 60)
        self.x, self.y = x, y

    def to(self, loc, duration: float = 0.8, dx: float = 0.5, dy: float = 0.5, scroll: bool = True):
        if scroll:
            # the DOM's own scrollIntoView, not Playwright's (which waits for the element to be stable: a
            # live map's panels never are, and a 4K software renderer makes each wait seconds long)
            try:
                loc.first.evaluate(
                    "el => { const r = el.getBoundingClientRect(); if (r.top < 0 || r.bottom > innerHeight) el.scrollIntoView({block: 'nearest'}); }",
                    timeout=4000,
                )
            except Exception:  # noqa: BLE001, S110 - mid re-render: the box decides
                pass
        box = loc.bounding_box(timeout=8000)
        if box is None:
            raise RuntimeError("element has no box")
        self.move(box["x"] + box["width"] * dx, box["y"] + box["height"] * dy, duration)
        return box

    def hover(self, loc, hold: float = 1.2, **kw) -> None:
        self.to(loc, **kw)
        self.pause(hold)

    def click(self, loc, before: float = 0.6, after: float = 0.5, **kw) -> None:
        """Move, rest 0.6 s on the target, press, settle."""
        self.to(loc, **kw)
        self.pause(before)
        self.page.mouse.down()
        self.pause(0.08)
        self.page.mouse.up()
        self.pause(after)

    def key(self, k: str, after: float = 0.6) -> None:
        self.page.keyboard.press(k)
        self.pause(after)

    def scroll(
        self,
        sel: str | None = None,
        nth: int = 0,
        offset: float = 90,
        ms: float = 2500,
        to: float | None = None,
    ) -> None:
        """An eased scroll that brings `sel` (the nth match) `offset` px below its scroller's top, or to `to`."""
        self.page.evaluate(SCROLL_JS, [sel, nth, offset, ms, to])
        self.pause(ms / 1000 + 0.15)

    def wait_for(self, loc, timeout: float = 30.0) -> bool:
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            try:
                if loc.count() > 0 and loc.first.is_visible():
                    return True
            except Exception:  # noqa: BLE001, S110 - mid re-render
                pass
            self.pause(0.2)
        return False


# --- the console, by role and label -----------------------------------------------------------------


def coach(p):
    """The guided run's decision bar: "Your call: Step n of m · …" or "Watch this: Next: …"."""
    return p.get_by_role("dialog", name=re.compile(r"^(Your call|Watch this)")).first


def coach_name(p) -> str:
    c = coach(p)
    try:
        return (c.get_attribute("aria-label", timeout=2000) or "") if c.count() else ""
    except Exception:  # noqa: BLE001 - mid re-render
        return ""


def frame(p):
    return p.get_by_role("dialog", name="Review photos", exact=True)


def needs(p):
    return p.get_by_role("region", name="Needs you")


def views(p, name: str):
    return p.get_by_role("navigation", name="Mission views").get_by_role(
        "button", name=name, exact=True
    )


def answer(p, label: str):
    return (
        frame(p)
        .get_by_role("group", name="Answer")
        .get_by_role("button", name=re.compile(rf"^{label}"))
    )


def wait_call(cam: Cam, step: str, timeout: float = 60.0) -> bool:
    """Waits (the clock running) for the decision bar to say `Your call … <step>`."""
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        n = coach_name(cam.page)
        if n.startswith("Your call") and step in n:
            return True
        cam.pause(0.25)
    return False


def advance_to(cam: Cam, target: str, *, think: float = 0.0, maxn: int = 120) -> None:
    """Off camera: takes the AI's pick at every decision and skips the clock ahead until the decision bar
    says `Your call … <target>`. A possible sighting's proposal is approved as it comes (as the AI suggests);
    `think` seconds pass before each decision, so the end screen's measured times read like a person's."""
    p = cam.page
    for _ in range(maxn):
        cam.pause(0.35)
        n = coach_name(p)
        if not n:
            continue
        rf = frame(p)
        modal = rf.count() > 0 and rf.is_visible()
        sight = needs(p).get_by_role(
            "button", name=re.compile(r"^Approve: Send .* to the sighting")
        )
        if not modal and sight.count() and sight.first.is_visible():
            cam.pause(think / 2)
            sight.first.click()
            continue
        if n.startswith("Your call"):
            if target in n:
                return
            cam.pause(think)
            if modal:
                rf.get_by_role("group", name="Answer").locator("[data-ai-pick]").first.click()
            else:
                p.keyboard.press(
                    "a"
                )  # the AI's pick, the console's own control included (guide.ts)
            cam.pause(0.4)
        else:
            sk = coach(p).get_by_role("button", name=re.compile(r"^Skip ahead"))
            if sk.count():
                sk.click()
    raise RuntimeError(f"never reached the decision {target!r} (last: {coach_name(p)!r})")


def skip_ahead(cam: Cam, n: int = 4) -> None:
    """On camera: Skip ahead, a beat at a time (every row on the way landing at once), to the next decision."""
    p = cam.page
    for _ in range(n):
        if coach_name(p).startswith("Your call"):
            return
        sk = coach(p).get_by_role("button", name=re.compile(r"^Skip ahead"))
        if sk.count():
            cam.click(sk, before=0.4, after=1.2)


def open_guided(cam: Cam, base: str, seed: str = "overdue-hiker") -> None:
    cam.page.goto(f"{base}/#m/demo?s={seed}&guide=1", wait_until="networkidle")
    if not cam.wait_for(coach(cam.page), 30):
        raise RuntimeError("the guided run did not open")
    cam.pause(1.5)


def finish_overdue(cam: Cam, base: str) -> None:
    """Off camera: the whole overdue-hiker run the AI's way, at a person's pace, to the end screen."""
    open_guided(cam, base)
    advance_to(cam, "Find", think=6.0)
    cam.pause(4)
    needs(cam.page).get_by_role("button", name=re.compile(r"^Record find")).first.click()
    if not cam.wait_for(cam.page.get_by_role("dialog", name="What you did"), 20):
        raise RuntimeError("no end screen")
    cam.pause(2.0)


# --- the scenes -------------------------------------------------------------------------------------


def s1_home_start(cam: Cam, base: str) -> None:
    p = cam.page
    p.goto(f"{base}/#", wait_until="networkidle")
    cam.pause(2.0)
    cam.x, cam.y = 1240, 760
    cam.start(1.5)
    hero = p.get_by_role("region", name="Sightline", exact=True)
    cam.hover(hero.get_by_role("heading", name="Sightline"), 0.8, dx=0.8)
    cam.hover(p.get_by_role("button", name=re.compile(r"^Built with")), 1.2, dx=0.45)
    cam.scroll('[aria-label="Measured, with sources"]', offset=120, ms=2600)
    cam.move(820, 640, 0.9)
    cam.pause(1.5)
    cam.scroll('[aria-label="What the photo changes"]', offset=70, ms=2600)
    cam.pause(1.6)
    cam.scroll('[aria-label="One chain, step by step"]', offset=60, ms=2000)
    cam.move(1100, 560, 1.0)
    cam.pause(1.6)
    cam.scroll(to=0, ms=2200)
    cam.pause(0.4)
    cam.click(p.get_by_role("button", name="Try the guided simulation"))
    cam.pause(1.8)
    start = p.get_by_role("link", name="Start the simulation: Overdue hiker")
    cam.hover(
        p.get_by_role("listitem", name=re.compile(r"^Overdue hiker"))
        .get_by_role("definition")
        .first,
        1.0,
    )
    cam.click(start)
    if not cam.wait_for(coach(p), 20):
        raise RuntimeError("the console did not open")
    cam.pause(1.5)
    cam.hover(p.get_by_role("region", name="Subject"), 2.2, dx=0.25)
    cam.stop(1.5)


def s2_photos_land(cam: Cam, base: str) -> None:
    p = cam.page
    open_guided(cam, base)
    cam.x, cam.y = 1250, 640
    cam.start(1.2)
    c = coach(p)
    cam.hover(c.get_by_role("paragraph").filter(has_text="AI suggests"), 1.6, dx=0.3)
    cam.click(
        c.get_by_role("group", name="Options").get_by_role("button").first
    )  # The AI's flight lines
    cam.pause(1.0)
    cam.hover(c.get_by_role("group", name="Speed").get_by_role("button", name="1×"), 1.0)
    cam.hover(p.locator("figure[aria-label='Live map']").first, 4.0, dx=0.5, dy=0.42)
    cam.click(views(p, "Photos"))
    cam.hover(p.get_by_role("progressbar", name="Photos placed on the map"), 4.0)
    cam.click(views(p, "Map"))
    cam.hover(p.locator("figure[aria-label='Live map']").first, 1.0, dx=0.55, dy=0.5)
    cam.hover(coach(p).get_by_role("paragraph").last, 1.0, dx=0.4)
    if not wait_call(cam, "Review photos", 60):
        raise RuntimeError("the survey never reached Review photos")
    cam.wait_for(frame(p), 10)
    cam.stop(1.5)


def s3_second_look(cam: Cam, base: str) -> None:
    p = cam.page
    open_guided(cam, base)
    advance_to(cam, "Review photos")
    cam.wait_for(frame(p), 10)
    cam.pause(1.0)
    cam.x, cam.y = 1330, 560
    cam.start(1.2)
    rf = frame(p)
    cam.hover(rf.get_by_label("Looking for"), 1.4, dx=0.3)
    cam.hover(rf.get_by_role("img", name=re.compile(r"^Crop of")), 1.4)
    cam.click(answer(p, "The subject"))
    cam.wait_for(rf.get_by_text("photo 2 of 3"), 8)
    cam.pause(0.8)
    cam.hover(rf.get_by_text(re.compile(r"^AI: ")), 1.2, dx=0.3)
    cam.click(answer(p, "Not a person"))
    cam.wait_for(rf.get_by_text("photo 3 of 3"), 8)
    cam.pause(0.8)
    cam.hover(rf.get_by_text(re.compile(r"^Scored 0\.17")), 1.8, dx=0.3)
    cam.click(rf.get_by_role("button", name="Enlarge the photo"))
    cam.pause(2.4)
    cam.key("Escape", 0.8)  # the enlarged photo closes first (ReviewFrame.tsx)
    cam.click(rf.get_by_role("button", name="Run AI re-check"))
    cam.wait_for(rf.get_by_role("figure", name="OpenCV 5 zoom"), 10)
    cam.pause(0.8)
    look = rf.get_by_role("group", name="AI re-check")
    cam.hover(look.get_by_role("figure", name="detector crop"), 1.4)
    cam.hover(look.get_by_role("figure", name="OpenCV 5 zoom"), 1.8)
    cam.hover(
        look.get_by_role("list", name="What each model said").get_by_role("listitem").last,
        2.2,
        dx=0.35,
    )
    cam.hover(look.get_by_text(re.compile(r"Nebius Token Factory")), 1.8, dx=0.4)
    cam.click(answer(p, "The subject"))
    approve = needs(p).get_by_role("button", name=re.compile(r"^Approve: Send .* to the sighting"))
    if not cam.wait_for(approve, 15):
        raise RuntimeError("no sighting proposal")
    pause_btn = coach(p).get_by_role("button", name=re.compile(r"^Pause"))
    if pause_btn.count():
        cam.click(pause_btn, before=0.4)  # hold the clock while the proposal is read
    card = needs(p).get_by_role("region", name="Approval inbox").first
    cam.hover(card.get_by_role("paragraph").first, 2.2, dx=0.3)
    cam.click(approve.first)
    cam.pause(1.0)
    cam.hover(p.locator("figure[aria-label='Live map']").first, 2.5, dx=0.53, dy=0.5)
    cam.stop(1.5)


def s4_false_alarm(cam: Cam, base: str) -> None:
    """The backpack in Dementia walk-away (the overdue hiker's own run has only the grey bag, which gets no
    AI re-check): the console's free play, its clock run off camera until the photo lands."""
    p = cam.page
    p.goto(f"{base}/#m/demo/map?s=dementia", wait_until="networkidle")
    cam.pause(2.0)
    p.get_by_role("button", name=re.compile(r"^Fly the AI's flight lines")).click()
    clk = p.get_by_role("group", name="Mission clock")
    clk.get_by_role("button", name="4×").click()
    clk.get_by_role("button", name=re.compile(r"^Play")).click()
    bag = p.locator('[data-candidate="f0502-d01"]').first
    if not cam.wait_for(bag, 90):
        raise RuntimeError("the backpack photo never landed")
    clk.get_by_role("button", name=re.compile(r"^Pause")).click()
    clk.get_by_role("button", name="1×").click()
    bag.scroll_into_view_if_needed()
    cam.pause(1.5)
    cam.x, cam.y = 1240, 600
    cam.start(1.2)
    cam.hover(bag, 1.0, dx=0.6, dy=0.3)
    cam.click(bag.get_by_role("button", name=re.compile(r"^Open survey photo")))
    rf = frame(p)
    cam.wait_for(rf, 5)
    cam.pause(0.8)
    cam.hover(rf.get_by_role("figure").first, 0.8)
    cam.click(rf.get_by_role("button", name="Run AI re-check"))
    look = rf.get_by_role("group", name="AI re-check")
    cam.wait_for(look.get_by_role("list", name="What each model said"), 10)
    cam.pause(0.8)
    cam.hover(look.get_by_text(re.compile(r"^Probably not a person|^Not a person")), 1.2, dx=0.3)
    cam.hover(
        look.get_by_role("list", name="What each model said").get_by_role("listitem").last,
        1.8,
        dx=0.35,
    )
    cam.hover(look.get_by_text(re.compile(r"Nebius Token Factory")), 1.0, dx=0.4)
    more = answer(p, "More")
    if more.count():
        cam.click(more)
    cam.click(answer(p, "Object"))
    cam.click(
        rf.get_by_role("group", name="Object type").get_by_role(
            "button", name=re.compile(r"^backpack")
        )
    )
    cam.pause(1.0)
    cam.click(rf.get_by_role("button", name=re.compile(r"^Later")), before=0.5)
    clue = (
        needs(p).get_by_role("article").filter(has_text=re.compile(r"backpack seen in drone photo"))
    )
    if cam.wait_for(clue, 5):
        cam.hover(clue.first, 1.8, dx=0.4)
    cam.stop(1.5)


def s5_teams_find(cam: Cam, base: str) -> None:
    p = cam.page
    open_guided(cam, base)
    advance_to(cam, "Clue", think=1.0)
    cam.pause(1.0)
    cam.x, cam.y = 1300, 700
    cam.start(1.2)
    tl = p.get_by_role("list", name="Timeline entries")
    cam.hover(
        tl.get_by_role("listitem").filter(has_text=re.compile(r"Team One, Sightline\. Copy")).first,
        1.4,
        dx=0.35,
    )
    card = needs(p).get_by_role("article").filter(has_text="possible whistle")
    cam.hover(card, 1.0, dx=0.4, dy=0.35)
    cam.click(card.get_by_role("button", name="Confirm clue"))
    cam.pause(1.0)
    skip_ahead(cam)
    if not wait_call(cam, "Assign", 30):
        raise RuntimeError("no Assign decision")
    cam.pause(0.6)
    send = needs(p).get_by_role("button", name=re.compile(r"^Send (all|the) .*AI's picks"))
    cam.hover(
        needs(p).get_by_role("region", name="Approval inbox").first.get_by_role("paragraph").first,
        1.6,
        dx=0.3,
    )
    cam.click(send.first)
    cam.click(
        coach(p).get_by_role("group", name="Speed").get_by_role("button", name="4×"), before=0.5
    )
    cam.hover(p.locator("figure[aria-label='Live map']").first, 1.0, dx=0.5, dy=0.45)
    skip_ahead(cam)
    if not wait_call(cam, "Link", 40):
        raise RuntimeError("no Link decision")
    cam.pause(0.6)
    cam.click(
        coach(p).get_by_role("group", name="Options").get_by_role("button").first
    )  # let it finish (AI's pick)
    cam.hover(p.locator("figure[aria-label='Live map']").first, 2.0, dx=0.5, dy=0.45)
    skip_ahead(cam)
    if not wait_call(cam, "Find", 60):
        raise RuntimeError("no Find decision")
    cam.pause(0.8)
    report = needs(p).get_by_role("article", name=re.compile(r"reports the subject"))
    cam.hover(report, 1.2, dx=0.4, dy=0.4)
    cam.click(report.get_by_role("button", name=re.compile(r"^Record find")))
    end = p.get_by_role("dialog", name="What you did")
    cam.wait_for(end, 10)
    cam.pause(1.2)
    cam.click(end.get_by_role("button", name="Stay on the console"))
    cam.hover(
        p.get_by_role("status", name="Mission status").get_by_text(re.compile(r"^Found · ")).first,
        1.8,
    )
    cam.stop(1.5)


def s6_you_vs_ai(cam: Cam, base: str) -> None:
    p = cam.page
    finish_overdue(cam, base)
    cam.x, cam.y = 1500, 560
    cam.start(1.2)
    end = p.get_by_role("dialog", name="What you did")
    cam.scroll('[aria-label="Without Sightline vs with Sightline"]', offset=24, ms=2600)
    vs = end.get_by_role("region", name="Without Sightline vs with Sightline")
    cam.hover(vs.get_by_role("paragraph").first, 2.0, dx=0.35, scroll=False)
    cam.hover(vs.get_by_role("table").get_by_role("row").nth(1), 2.0, dx=0.6, scroll=False)
    cam.scroll('[aria-label="Without Sightline vs with Sightline"] table', offset=60, ms=2200)
    cam.hover(vs.get_by_role("table").get_by_role("row").nth(4), 1.6, dx=0.6, scroll=False)
    cam.hover(
        vs.get_by_text(re.compile(r"^Time to find, mission minutes")), 2.4, dx=0.5, scroll=False
    )
    hx = vs.get_by_role("heading", name="How this is worked out")
    cam.page.evaluate(
        "() => { for (const h of document.querySelectorAll('h4')) if (h.textContent.startsWith('How this is worked out')) h.setAttribute('data-scene-anchor', 'how'); }"
    )
    cam.scroll('[data-scene-anchor="how"]', offset=40, ms=3000)
    cam.hover(hx, 2.0, dx=0.2, scroll=False)
    cam.stop(1.5)


def n1_fleet(cam: Cam, base: str) -> None:
    p = cam.page
    open_guided(cam, base)
    advance_to(cam, "Assign", think=0.5)
    cam.pause(1.0)
    cam.x, cam.y = 1500, 620
    cam.start(1.2)
    cam.click(
        needs(p).get_by_role("button", name=re.compile(r"^Send (all|the) .*AI's picks")).first
    )
    cam.click(
        coach(p).get_by_role("group", name="Speed").get_by_role("button", name="2×"), before=0.5
    )
    cam.hover(p.locator("figure[aria-label='Live map']").first, 1.5, dx=0.48, dy=0.5)
    drones = p.get_by_role("list", name="Drones")
    if not wait_call(cam, "Link", 40):
        raise RuntimeError("no Link decision")
    cam.pause(0.6)
    cam.hover(drones.get_by_role("article", name="Drone Drone 2"), 1.5, dx=0.7)
    cam.click(
        coach(p).get_by_role("group", name="Options").get_by_role("button").first
    )  # let it finish
    cam.hover(p.get_by_role("button", name=re.compile(r"^Drone 2 \(simulated\)")).first, 1.8)
    cam.hover(drones, 2.2, dx=0.8, dy=0.3)
    cam.hover(drones, 2.2, dx=0.8, dy=0.85)
    cam.hover(p.get_by_role("list", name="Teams"), 1.8, dx=0.8, dy=0.5)
    cam.stop(1.2)


def n2_radio(cam: Cam, base: str) -> None:
    p = cam.page
    open_guided(cam, base)
    advance_to(cam, "Review photos")
    for label in ("The subject", "Not a person"):
        cam.pause(1.0)
        answer(p, label).click()
    cam.pause(1.0)
    answer(p, "The subject").click()
    approve = needs(p).get_by_role("button", name=re.compile(r"^Approve: Send .* to the sighting"))
    cam.wait_for(approve, 10)
    coach(p).get_by_role("button", name=re.compile(r"^Pause")).click()
    approve.first.click()
    cam.pause(1.5)
    p.get_by_role("region", name="Timeline").get_by_role("group", name="Show").get_by_role(
        "button", name=re.compile(r"^Radio")
    ).click()
    cam.pause(1.0)
    cam.x, cam.y = 1700, 430
    cam.start(1.2)
    cam.click(coach(p).get_by_role("button", name=re.compile(r"^(Play|Resume)")))
    cam.hover(
        p.get_by_role("region", name="Timeline").get_by_role(
            "button", name=re.compile(r"^Radio voices")
        ),
        1.0,
    )
    if not wait_call(cam, "Clue", 40):
        raise RuntimeError("no Clue decision")
    cam.pause(0.5)
    tl = p.get_by_role("list", name="Timeline entries")
    cam.hover(tl.get_by_role("listitem").filter(has_text="Possible whistle").first, 2.5, dx=0.35)
    cam.hover(
        tl.get_by_role("listitem").filter(has_text=re.compile(r"Team One, Sightline\. Copy")).first,
        2.5,
        dx=0.35,
    )
    card = needs(p).get_by_role("article").filter(has_text="possible whistle")
    cam.hover(card, 1.4, dx=0.4, dy=0.35)
    cam.click(card.get_by_role("button", name="Confirm clue"))
    cam.pause(1.0)
    cam.stop(1.5)


def n3_wind_recall(cam: Cam, base: str) -> None:
    """Missing child, Despondent and Dementia walk-away all reach the wind step 87 mission minutes after
    the call; Dementia walk-away is used (its steps: Survey, Clue, Review photos, Assign, Link, Wind, Find)."""
    p = cam.page
    open_guided(cam, base, "dementia")
    advance_to(cam, "Link", think=0.5)
    cam.pause(1.0)
    cam.x, cam.y = 900, 300
    cam.start(1.2)
    pill = p.get_by_role("status", name="Mission status").get_by_role(
        "button", name=re.compile(r"^Drones")
    )
    cam.click(pill.first)
    cond = p.get_by_role("region", name="Conditions", exact=True)
    cam.wait_for(cond, 5)
    cam.pause(0.6)
    cam.hover(cond.get_by_text(re.compile(r"^Drones can fly|^Drones grounded")).first, 1.2, dx=0.4)
    rec = cond.get_by_role("group", name="A recorded live lookup")
    cam.click(rec.locator("summary").first, dx=0.25)
    look = cond.get_by_role("region", name="Recorded conditions lookup")
    cam.wait_for(look, 5)
    cam.hover(look.get_by_text(re.compile(r"^Tavily")).first, 1.6, dx=0.3, scroll=False)
    cam.hover(
        look.get_by_role("group", name="Gusts").get_by_role("definition").nth(1),
        2.0,
        dx=0.3,
        scroll=False,
    )
    cam.click(pill.first, before=0.5)  # W again: the panel closes
    cam.pause(0.6)
    cam.click(
        coach(p).get_by_role("group", name="Options").get_by_role("button").first
    )  # Link: let it finish
    if not wait_call(cam, "Wind", 30):
        raise RuntimeError("no Wind decision")
    cam.pause(0.8)
    cam.hover(pill.first, 0.8)
    card = needs(p).get_by_role("region", name="Approval inbox").first
    cam.hover(card.get_by_role("paragraph").filter(has_text="gust limit").first, 2.0, dx=0.35)
    cam.click(card.get_by_role("button", name=re.compile(r"^Approve: Bring Drone")))
    cam.hover(p.get_by_role("list", name="Drones"), 1.4, dx=0.8, dy=0.4)
    cam.stop(1.5)


def n4_find_summary(cam: Cam, base: str) -> None:
    p = cam.page
    finish_overdue(cam, base)
    p.get_by_role("dialog", name="What you did").get_by_role(
        "button", name="The agent's trace"
    ).click()
    cam.wait_for(p.get_by_role("group", name="Which model did what"), 10)
    cam.pause(1.5)
    cam.x, cam.y = 600, 300
    cam.start(1.2)
    calls = p.get_by_label("Model calls in this mission")
    cam.hover(calls, 1.8, dx=0.3)
    chains = p.get_by_role("article", name=re.compile(r"^Chain .*f0273"))
    chain = (
        chains.first
        if chains.count()
        else p.get_by_role("article", name=re.compile(r"^Chain ")).first
    )
    chain.evaluate("el => el.setAttribute('data-scene-anchor', 'chain')")
    cam.scroll('[data-scene-anchor="chain"]', offset=80, ms=2400)
    steps = chain.locator("li > button[aria-expanded]")
    n = min(steps.count(), 5)
    for i in range(n):
        cam.hover(steps.nth(i), 0.6, dx=0.35, scroll=False)
    model = (
        chain.locator("li").filter(has=p.get_by_text("Model", exact=True)).locator("> button").first
    )
    if model.count():
        cam.click(model, dx=0.35)
        cam.pause(1.4)
    cam.click(views(p, "Map"))
    done = p.get_by_role("region", name="Simulation ended").get_by_role(
        "button", name="What you did"
    )
    cam.click(done)
    end = p.get_by_role("dialog", name="What you did")
    cam.wait_for(end, 5)
    cam.pause(0.8)
    cam.hover(
        end.get_by_role("region", name="Without Sightline vs with Sightline")
        .get_by_role("paragraph")
        .first,
        2.0,
        dx=0.35,
        scroll=False,
    )
    cam.stop(1.5)


@dataclass
class Scene:
    name: str
    target_s: float
    fn: Callable[[Cam, str], None]
    shows: str
    fills: str
    audio: bool = False
    extra: dict = field(default_factory=dict)


SCENES = [
    Scene(
        "s1_home_start",
        30,
        s1_home_start,
        "Home page: title and Built with badges, a slow scroll past the measured stats and Agentic vision, back up, Try the guided simulation, Overdue hiker's Start the simulation; the console opens and the pointer rests on the subject strip.",
        "OpenCV video, scene 4",
    ),
    Scene(
        "s2_photos_land",
        35,
        s2_photos_land,
        "The first decision (Survey): the AI's suggestion, The AI's flight lines; the time-lapse at 1x as drone one photographs the likeliest sectors, the map darkening where it looked, a look at Photos (the placed-photo count) and back; ends as the photo review opens.",
        "OpenCV video, scene 5",
    ),
    Scene(
        "s3_second_look",
        45,
        s3_second_look,
        "Photo review: photo 336 answered The subject (red jacket), the grey bag Not a person, then survey photo 273 at 0.17: the photo enlarged, Run AI re-check (detector crop beside the OpenCV 5 zoom, Nemotron VL's verdict, 'Nebius Token Factory'), The subject; the sighting proposal (send Team Two to C3), Approve; the pins on the map.",
        "OpenCV video, scene 6; Nebius video, scene 5 (reuse)",
    ),
    Scene(
        "s4_false_alarm",
        25,
        s4_false_alarm,
        "A false alarm (Dementia walk-away, the console's free play): the backpack photo 502 at 0.15, Run AI re-check (OpenCV 5 re-detect, Nemotron VL: no person, a backpack), Object... backpack; it leaves the queue as a possible clue for a team to check.",
        "OpenCV video, scene 7",
    ),
    Scene(
        "s5_teams_find",
        30,
        s5_teams_find,
        "Clue: the radio read-back on the timeline, Confirm clue; Assign: Send the free teams to the AI's picks; 2x, then 4x with Skip ahead (Link: let drone two finish); Team Four reports the subject, Record find; the status line reads Found · C2.",
        "OpenCV video, scene 8",
    ),
    Scene(
        "s6_you_vs_ai",
        20,
        s6_you_vs_ai,
        "The end screen: Without Sightline vs with Sightline: the headline, the table, the time-to-find bars, a slow scroll to How this is worked out.",
        "OpenCV video, scene 9",
    ),
    Scene(
        "n1_photos_land",
        25,
        n1_fleet,
        "The fleet: Send the free teams, the three drones take off on their flight lines, drone two loses its link (Let it finish its flight line), the drone rows in Resources (battery, link, flight line, back at base), the team markers moving on the map.",
        "Nebius video, scene 4",
    ),
    Scene(
        "n2_radio",
        25,
        n2_radio,
        "Radio (the timeline on Radio): Play, Team One's whistle call lands with its voice and the desk's read-back; the read-back card in Needs you, Confirm clue. n2_radio_with_audio.mp4 is the same take with the page's voice clips.",
        "Nebius video, scene 6",
        audio=True,
    ),
    Scene(
        "n3_wind_recall",
        25,
        n3_wind_recall,
        "Dementia walk-away: the Conditions panel (W): drones' gust limit, the recorded live lookup (Tavily searches read by Nemotron, the quoted 'gusts 40' and its source); Link; the wind step: gusts 52 km/h over the 43 km/h limit, the AI's recall card, Approve.",
        "Nebius video, scene 7",
    ),
    Scene(
        "n4_find_summary",
        20,
        n4_find_summary,
        "Trace: 'N Nemotron calls on Nebius Token Factory in this mission · X s in all', one chain's steps, a model call opened; then the end screen's headline and Without Sightline vs with Sightline.",
        "Nebius video, scene 8",
    ),
]


# --- encoding and checks ----------------------------------------------------------------------------


def probe(video: Path) -> dict:
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,pix_fmt:format=duration",
                        "-of", "json", str(video)], capture_output=True, text=True, check=True)  # fmt: skip
    d = json.loads(r.stdout)
    v = next(s for s in d["streams"] if s.get("width"))
    num, _, den = v["r_frame_rate"].partition("/")
    return {"duration_s": round(float(d["format"]["duration"]), 2), "size": [v["width"], v["height"]],
            "fps": round(float(num) / float(den or 1), 2), "pix_fmt": v["pix_fmt"], "codec": v["codec_name"],
            "audio": any(s.get("codec_type") == "audio" for s in d["streams"])}  # fmt: skip


def scale_to(src: Path, dst: Path, w: int, h: int, log) -> None:
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-vf", f"scale={w}:{h}:flags=lanczos", "-an",
                    "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-profile:v", "high", "-pix_fmt", "yuv420p",
                    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
                    "-movflags", "+faststart", str(dst)], check=True, stdout=log, stderr=log)  # fmt: skip


def to_1080(src: Path, dst: Path, log) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-vf", "scale=1920:1080:flags=lanczos", "-an",
                    "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-profile:v", "high", "-pix_fmt", "yuv420p",
                    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
                    "-movflags", "+faststart", str(dst)], check=True, stdout=log, stderr=log)  # fmt: skip


def contact(src: Path, dst: Path, dur: float) -> None:
    """Start, middle and end frames side by side (960 px each)."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix("")
    tmp.mkdir(exist_ok=True)
    for i, t in enumerate((0.4, dur / 2, max(0.0, dur - 0.4))):
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.2f}", "-i", str(src), "-frames:v", "1",
                        "-vf", "scale=960:-2", str(tmp / f"{i}.png")], check=True)  # fmt: skip
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(tmp / "0.png"), "-i", str(tmp / "1.png"), "-i", str(tmp / "2.png"),
                    "-filter_complex", "hstack=inputs=3", "-q:v", "3", str(dst)], check=True)  # fmt: skip
    shutil.rmtree(tmp, ignore_errors=True)


def mux_audio(
    video: Path,
    out: Path,
    events: list[tuple[float, str, str]],
    t0: float,
    dist: Path,
    base: str,
    log,
) -> list[dict]:
    """The page's voice clips laid back under the take at the times they played (each cut where it paused)."""
    plays: list[dict] = []
    for i, (t, kind, src) in enumerate(events):
        if kind != "play" or not src:
            continue
        stop_t = next(
            (u for u, k, s in events[i + 1 :] if s == src and k in ("pause", "ended")), None
        )
        rel = src.split(base, 1)[-1].lstrip("/").split("?")[0]
        f = dist / rel
        if f.exists() and t >= t0:
            plays.append(
                {
                    "file": str(f),
                    "at_s": round(t - t0, 3),
                    "dur_s": round(stop_t - t, 3) if stop_t else None,
                    "src": rel,
                }
            )
    if not plays:
        return plays
    cmd = ["ffmpeg", "-v", "error", "-y", "-i", str(video)]
    parts = []
    for i, pl in enumerate(plays):
        cmd += ["-i", pl["file"]]
        ms = int(pl["at_s"] * 1000)
        trim = f"atrim=0:{pl['dur_s']}," if pl["dur_s"] else ""
        parts.append(f"[{i + 1}:a]{trim}aresample=48000,adelay={ms}|{ms}[a{i}]")
    mix = "".join(f"[a{i}]" for i in range(len(plays)))
    graph = (
        ";".join(parts) + f";{mix}amix=inputs={len(plays)}:normalize=0:duration=longest,apad[aout]"
    )
    cmd += ["-filter_complex", graph, "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
            "-ac", "2", "-shortest", "-movflags", "+faststart", str(out)]  # fmt: skip
    subprocess.run(cmd, check=True, stdout=log, stderr=log)
    return plays


def architecture(out: Path, width: int = 3840) -> dict:
    """docs/architecture/sightline-architecture.html's first figure (the system, the vector source of
    system.png) rendered at `width` px."""
    from playwright.sync_api import sync_playwright

    html = ROOT / "docs/architecture/sightline-architecture.html"
    with sync_playwright() as pw:
        b = pw.chromium.launch(args=["--force-color-profile=srgb"])
        pg = b.new_page(viewport={"width": 1400, "height": 900}, device_scale_factor=1)
        pg.goto(html.as_uri(), wait_until="networkidle")
        pg.wait_for_timeout(800)
        svg = pg.locator("svg").first
        w = svg.bounding_box()["width"]
        pg.close()
        k = width / w
        pg = b.new_page(viewport={"width": 1400, "height": 900}, device_scale_factor=k)
        pg.goto(html.as_uri(), wait_until="networkidle")
        pg.wait_for_timeout(800)
        pg.locator("svg").first.screenshot(path=str(out))
        b.close()
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", str(out)],
                       capture_output=True, text=True, check=True)  # fmt: skip
    w2, h2 = (int(v) for v in r.stdout.strip().split(",")[:2])
    return {
        "size": [w2, h2],
        "scale": round(k, 3),
        "source": "docs/architecture/sightline-architecture.html (figure 1, SVG)",
    }


def readme(run: Path, done: dict, arch: dict | None) -> str:
    lines = [
        "Sightline: screen captures for Synthesia",
        f"Recorded {datetime.now().strftime('%Y-%m-%d %H:%M')} from main at {git_head()} (the production build, VITE_CACHE_DIR=demo),",
        "by scripts/demo_video/scenes.py. Dark theme (the site's default), 1920x1080 viewport at device scale 2.",
        "No narration, no captions, no music. Every file starts and ends on a held frame of about a second.",
        "",
        "4K: H.264 High, 3840x2160, 30 fps, yuv420p, CRF 16, BT.709, no audio, +faststart.",
        "1080p/: the same clips scaled to 1920x1080 (lanczos, CRF 16).",
        "",
    ]
    for s in SCENES:
        d = done.get(s.name)
        if not d or "duration_s" not in d:
            continue
        lines += [f"{s.name}.mp4  ({d['duration_s']:.1f} s; {d['size'][0]}x{d['size'][1]}, {d['fps']:g} fps; target {s.target_s:.0f} s)",
                  f"  Fills: {s.fills}", f"  Shows: {s.shows}"]  # fmt: skip
        if d.get("upscaled_from"):
            w0, h0 = d["upscaled_from"]
            lines.append(
                f"  Note: recorded at {w0}x{h0} (device scale {w0 / 1920:g}) and upscaled to 3840x2160 (lanczos): at scale 2 the"
            )
            lines.append(
                "  end screen's blurred backdrop drops this machine's software renderer to about 1 fps."
            )
        if d.get("audio_file"):
            lines.append(
                f"  Also: {d['audio_file']} ({d['audio_duration_s']:.1f} s): the same take with the page's voice clips (AAC 48 kHz)."
            )
        lines.append("")
    if arch:
        lines += [f"architecture_4k.png  ({arch['size'][0]}x{arch['size'][1]})",
                  "  The system diagram rendered from its vector source (docs/architecture/sightline-architecture.html,",
                  "  the SVG behind docs/architecture/system.png) at 3840 px wide: not upscaled.", ""]  # fmt: skip
    lines += [
        "Synthesia scene map",
        "  OpenCV video: scene 4 = s1_home_start, 5 = s2_photos_land, 6 = s3_second_look, 7 = s4_false_alarm,",
        "                8 = s5_teams_find, 9 = s6_you_vs_ai.",
        "  Nebius video: scene 4 = n1_photos_land, 5 = s3_second_look (reuse), 6 = n2_radio, 7 = n3_wind_recall,",
        "                8 = n4_find_summary.",
        "",
        "Notes",
        "  s4 is Dementia walk-away on the console (free play): the overdue hiker's guided run has the grey bag",
        "  (photo 452) as its not-a-person card, and that card offers no AI re-check; the backpack with a re-check",
        "  is in the Dementia and Despondent scenarios' flights.",
        "  n3 is Dementia walk-away's guided run: the overdue hiker has no wind step; the other three scenarios",
        "  reach it at the same mission time.",
        "  The guided runs' earlier decisions (the AI's pick each time) were made off camera where a scene starts",
        "  mid-run; the end screens' measured times come from those.",
    ]
    return "\n".join(lines) + "\n"


def git_head() -> str:
    try:
        return subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return "?"


def serve(dist: Path, log) -> subprocess.Popen:
    if not port_free(PORT):
        raise SystemExit(
            f"port {PORT} is taken: stop whatever runs there, or pass --url (this script never kills a process it didn't start)"
        )
    vite = WEB / "node_modules/.bin/vite"
    proc = subprocess.Popen([str(vite), "preview", "--port", str(PORT), "--strictPort", "--outDir", str(dist)], cwd=WEB,
                            env=dict(os.environ, VITE_CACHE_DIR="demo"), stdout=log, stderr=subprocess.STDOUT, start_new_session=True)  # fmt: skip
    print(f"site: vite preview on :{PORT} (pid {proc.pid})", flush=True)
    if not wait_http(f"http://127.0.0.1:{PORT}/", 60):
        stop(proc, "site")
        raise SystemExit(f"the site did not come up on :{PORT}")
    return proc


def main() -> int:
    global SCALE
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument(
        "--scenes", help="comma-separated scene names or prefixes (s1,n2,...); default: all"
    )
    ap.add_argument(
        "--url", help="record against a site already served there (no build, no server)"
    )
    ap.add_argument(
        "--dist", type=Path, help="with --url: that site's build folder (for n2's voice clips)"
    )
    ap.add_argument(
        "--out", type=Path, help="the run folder (default runs/video/scenes-<timestamp>)"
    )
    ap.add_argument(
        "--publish",
        type=Path,
        help="copy the finished files here (4K at the top, 1080p/ beside them)",
    )
    ap.add_argument("--no-arch", action="store_true", help="skip architecture_4k.png")
    ap.add_argument(
        "--scale",
        type=float,
        default=SCALE,
        help="device scale (2: 3840x2160; 1 for a quick dry run)",
    )
    ap.add_argument("--headed", action="store_true")
    args = ap.parse_args()
    SCALE = args.scale

    from playwright.sync_api import sync_playwright

    want = [w.strip() for w in args.scenes.split(",")] if args.scenes else None
    scenes = [s for s in SCENES if not want or any(s.name.startswith(w) for w in want)]
    run = args.out or ROOT / "runs/video" / f"scenes-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    run.mkdir(parents=True, exist_ok=True)
    log = open(run / "log.txt", "a")  # noqa: SIM115 - closed below
    doc_path = run / "scenes.json"
    done: dict = json.loads(doc_path.read_text())["scenes"] if doc_path.exists() else {}
    fixed_now = json.loads(FIXTURE.read_text())["now"]
    site = None
    try:
        if args.url:
            base, dist = args.url.rstrip("/"), args.dist or run / "dist"
        else:
            dist = build_site(run, None, log)
            site = serve(dist, log)
            base = f"http://127.0.0.1:{PORT}"
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=not args.headed, args=["--hide-scrollbars", "--force-color-profile=srgb",
                                         f"--force-device-scale-factor={SCALE:g}", "--autoplay-policy=no-user-gesture-required"])  # fmt: skip
            for s in scenes:
                print(f"scene {s.name} (target {s.target_s:.0f} s) …", flush=True)
                ctx = browser.new_context(viewport=SIZE, screen=SIZE, device_scale_factor=SCALE, reduced_motion="no-preference",
                                          color_scheme="dark", timezone_id="America/Vancouver", locale="en-US")  # fmt: skip
                ctx.add_init_script(SEED_JS)
                ctx.add_init_script(POINTER_JS)
                ctx.add_init_script(AUDIO_JS)
                page = ctx.new_page()
                page.clock.install(time=fixed_now)
                folder = run / "work" / s.name
                folder.mkdir(parents=True, exist_ok=True)
                cam = Cam(page, folder)
                page.expose_binding(
                    "__sceneAudio",
                    lambda _src, kind, url, cam=cam: cam.audio.append((time.time(), kind, url)),
                )
                errors: list[str] = []
                page.on("pageerror", lambda e, errors=errors: errors.append(str(e)[:300]))
                status, note = "ok", ""
                t_wall = time.monotonic()
                try:
                    s.fn(cam, base)
                except Exception as e:  # noqa: BLE001 - keep what was recorded, say why
                    status, note = "failed", f"{type(e).__name__}: {str(e).splitlines()[0][:300]}"
                    try:
                        page.screenshot(path=str(run / f"{s.name}_failed.png"))
                    except Exception:  # noqa: BLE001, S110
                        pass
                    if cam.cap and cam.cap.t_end == 0:
                        cam.stop(0.5)
                finally:
                    ctx.close()
                if not cam.cap or not cam.cap.ts:
                    print(f"  {status}: nothing recorded {note}", flush=True)
                    done[s.name] = {"status": status, "note": note}
                    continue
                st = cam.cap.stats()
                out = run / f"{s.name}.mp4"
                cam.cap.encode(out, FPS, log)
                native = probe(out)["size"]
                if native != [
                    3840,
                    2160,
                ]:  # --scale under 2: the 4K file is a lanczos upscale, and says so
                    nat = run / f"{s.name}_{native[1]}p_native.mp4"
                    out.replace(nat)
                    scale_to(nat, out, 3840, 2160, log)
                to_1080(out if native[1] > 1080 else nat, run / "1080p" / f"{s.name}.mp4", log)
                info = probe(out)
                if native != [3840, 2160]:
                    info["upscaled_from"] = native
                contact(
                    run / "1080p" / f"{s.name}.mp4",
                    run / "contact" / f"{s.name}.jpg",
                    info["duration_s"],
                )
                info.update(status=status, note=note, capture=st, page_errors=errors, wall_s=round(time.monotonic() - t_wall, 1),
                            target_s=s.target_s)  # fmt: skip
                if s.audio:
                    aud = run / f"{s.name}_with_audio.mp4"
                    plays = mux_audio(out, aud, cam.audio, cam.cap.ts[0], dist, base, log)
                    info["voice_clips"] = plays
                    if plays:
                        info["audio_file"] = aud.name
                        info["audio_duration_s"] = probe(aud)["duration_s"]
                shutil.rmtree(folder / "frames", ignore_errors=True)
                done[s.name] = info
                doc_path.write_text(
                    json.dumps({"run": str(run), "head": git_head(), "scenes": done}, indent=2)
                    + "\n"
                )
                print(f"  {status} {info['duration_s']:.1f} s, {info['size'][0]}x{info['size'][1]} @ {info['fps']:g} fps, "
                      f"moving {st['moving_fps']} fps {note}", flush=True)  # fmt: skip
            browser.close()
        arch = None
        if not args.no_arch:
            arch = architecture(run / "architecture_4k.png")
            print(f"architecture_4k.png {arch['size']}", flush=True)
        (run / "README.txt").write_text(readme(run, done, arch))
        doc_path.write_text(
            json.dumps(
                {"run": str(run), "head": git_head(), "scenes": done, "architecture": arch},
                indent=2,
            )
            + "\n"
        )
        if args.publish:
            pub = args.publish
            (pub / "1080p").mkdir(parents=True, exist_ok=True)
            for name, d in done.items():
                if d.get("status") != "ok":
                    continue
                shutil.copy2(run / f"{name}.mp4", pub / f"{name}.mp4")
                shutil.copy2(run / "1080p" / f"{name}.mp4", pub / "1080p" / f"{name}.mp4")
                if d.get("audio_file"):
                    shutil.copy2(run / d["audio_file"], pub / d["audio_file"])
            for f in ("architecture_4k.png", "README.txt"):
                if (run / f).exists():
                    shutil.copy2(run / f, pub / f)
            print(f"published to {pub}", flush=True)
        print(run, flush=True)
        return 1 if any(d.get("status") != "ok" for d in done.values()) else 0
    finally:
        stop(site, "site")
        log.close()


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(1))
    sys.exit(main())
