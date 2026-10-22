"""Render the six Devpost gallery images (1920x1080 PNG) from the one-console site, each at its checkpoint.

python render_gallery.py OUTDIR [SITE]   (a Python with playwright, Pillow and Chromium; SITE defaults to
http://localhost:5191/, the dev server started as README.md here says)

Each image opens its canonical address (no redirects), waits for the map, does its one step (Esc to put the
coach mark away, a click, a key), lets the page settle 400 ms, and is saved with the cursor hidden. A PNG over
1.5 MB is squeezed with pngquant when it is installed, else with Pillow's palette quantizer.
"""

import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image
from playwright.sync_api import Page, sync_playwright

out = Path(sys.argv[1])
SITE = sys.argv[2] if len(sys.argv) > 2 else "http://localhost:5191/"
out.mkdir(parents=True, exist_ok=True)
LIMIT = 1_500_000
SETTLE = 400
HIDE_CURSOR = "*, *::before, *::after { cursor: none !important; caret-color: transparent !important; }"


def esc(page: Page) -> None:
    """Put the story's coach mark away; the console stays at that checkpoint's mission time and view."""
    page.keyboard.press("Escape")


def t2_card(page: Page) -> None:
    esc(page)
    page.get_by_role("button", name="Show the second look's images").click()
    # back to the top of the queue: #1 and #2 above, #3 with its second look's images open
    page.evaluate("() => document.querySelectorAll('.overflow-y-auto').forEach((e) => { e.scrollTop = 0; })")


def trace_chain(page: Page) -> None:
    # the recorded av-chain run (Nemotron VL on a val photo), below the demo mission's own trace
    chain = page.get_by_role("article", name="Chain f0001-d01 · v0001 · p001")
    chain.locator("li[aria-label^=Model] button").first.click()
    chain.evaluate("(e) => e.scrollIntoView({ block: 'start' })")


def t4_conditions(page: Page) -> None:
    esc(page)
    page.keyboard.press("w")


def t5_debrief(page: Page) -> None:
    esc(page)
    # The three numbers and "What breaks first" don't fit one 1080 px screen with "How much looking it saves"
    # between them, so that part is left out of this frame (it is in the app, between the two).
    page.evaluate(
        """() => {
          const h = [...document.querySelectorAll('section[aria-label=Debrief] h3')]
            .find((e) => e.textContent.startsWith('How much looking'));
          if (h) h.closest('section').style.display = 'none';
          const glance = [...document.querySelectorAll('section[aria-label=Debrief] h3')]
            .find((e) => e.textContent.startsWith('At a glance'));
          glance.nextElementSibling.scrollIntoView({ block: 'start' });  // "The three numbers that matter…"
        }"""
    )


# (file, address, step after load)
JOBS = [
    ("console-t0-the-call-pitch-bar.png", "#m/demo?t=0", None),
    ("photos-land-t1-each-photo-ranked-and-placed.png", "#m/demo?t=1", esc),
    ("second-look-t2-a-018-candidate-opencv5-zoom-nemotron-vl.png", "#m/demo?t=2", t2_card),
    ("trace-which-model-did-what-second-look.png", "#m/demo/trace?t=2", trace_chain),
    ("run-t4-fleet-flying-b4-pod-60-conditions.png", "#m/demo?t=4", t4_conditions),
    ("debrief-t5-three-numbers-what-breaks-first.png", "#m/demo?t=5", t5_debrief),
]


def squeeze(path: Path) -> None:
    if path.stat().st_size <= LIMIT:
        return
    if shutil.which("pngquant"):
        subprocess.run(["pngquant", "--force", "--skip-if-larger", "--quality=70-95", "--output", str(path), str(path)], check=False)
    if path.stat().st_size > LIMIT:
        Image.open(path).convert("RGB").quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(path, optimize=True)


with sync_playwright() as p:
    browser = p.chromium.launch()
    for name, address, step in JOBS:
        ctx = browser.new_context(viewport={"width": 1920, "height": 1080}, device_scale_factor=1)
        page = ctx.new_page()
        page.goto(SITE + address)
        page.add_style_tag(content=HIDE_CURSOR)
        page.wait_for_selector(".maplibregl-canvas", state="attached", timeout=15000)
        page.wait_for_timeout(4000)  # tiles, the photos and the fixtures
        page.mouse.move(1919, 1079)  # no hover state anywhere
        if step:
            step(page)
            page.mouse.move(1919, 1079)
        page.wait_for_timeout(SETTLE)
        page.screenshot(path=str(out / name))
        ctx.close()
        squeeze(out / name)
        print(f"{name}  {(out / name).stat().st_size / 1e6:.2f} MB")
    browser.close()
