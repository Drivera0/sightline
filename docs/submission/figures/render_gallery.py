"""Render the six Devpost gallery images (1920x1080 PNG) from the one-console site, each at its checkpoint.

python render_gallery.py OUTDIR [SITE [NAME-PREFIX ...]]   (a Python with playwright, Pillow and Chromium; SITE defaults to
http://localhost:5191/, the dev server started as README.md here says; t1 needs the dev server, it sets the
story's clock through /src/command/story.ts)

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
W, H = 1920, 1280  # 3:2, the ratio Devpost shows gallery images at
HIDE_CURSOR = "*, *::before, *::after { cursor: none !important; caret-color: transparent !important; }"


def esc(page: Page) -> None:
    """Put the story's coach mark away; the console stays at that checkpoint's mission time and view."""
    page.keyboard.press("Escape")


def t1_mid_leg(page: Page) -> None:
    """The console 60 % into the clock's run into t1 (14:00 PDT): the photos still landing, the map lowering
    under the first leg, Needs You filling. The story shows this on its way into t1; the clock is set from
    the story's own store (the dev server serves it at /src/command/story.ts), with the coach marks off."""
    esc(page)
    page.evaluate(
        """async () => {
          const { useStory } = await import('/src/command/story.ts');
          useStory.setState({ t: 1, progress: 0.6, playing: false, tour: false });
        }"""
    )
    page.wait_for_timeout(2500)  # the map's frames and the queue catch up with the clock


def t2_card(page: Page) -> None:
    esc(page)
    # Needs you leads with the AI suggestion: this flight's 0.17 candidate (f0273-d02), the detector's crop
    # and the AI re-check zoom side by side; open its whole reason (Nemotron VL's verdict)
    more = page.get_by_role("button", name="Show the whole reason")
    if more.count():
        more.first.click()


def trace_chain(page: Page) -> None:
    # this flight's second look (f0273-d02) in the demo mission's own trace: Nemotron VL's live answer
    chain = page.get_by_role("article", name="Chain f0273-d02 · v0002 · relook-f0273-d02 · p001")
    chain.locator("li[aria-label^=Model] button").first.click()
    chain.evaluate("(e) => e.scrollIntoView({ block: 'start' })")


def t4_conditions(page: Page) -> None:
    esc(page)
    # the Resources list down to the three drones (Drone 2's link lost, Drone 3 relaying), then W
    page.evaluate(
        """() => {
          const r = document.querySelector('section[aria-label=Resources]');
          const d2 = [...r.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent.trim() === 'Drone 2');
          let card = d2; while (card.parentElement && card.parentElement.getBoundingClientRect().height < 200) card = card.parentElement;
          card.scrollIntoView({ block: 'end' });
        }"""
    )
    page.keyboard.press("w")


def t6_report(page: Page) -> None:
    esc(page)
    # The after-action report (the find, the areas searched at their POD) and "What breaks first" don't fit
    # the panel with what is between them, so this frame leaves out the key events, the per-sector POD
    # table, the flight lines, the export
    # buttons, the resources line, the measured results above "What breaks first" and its one-line intro
    # (all in the app, between the two).
    page.evaluate(
        """() => {
          const d = document.querySelector('section[aria-label=Debrief]');
          for (const name of ['Key events', "Every sector's final POD", 'Drone flight lines', 'Resources and traffic']) {
            const s = d.querySelector(`section[aria-label="${name}"]`);
            if (s) s.style.display = 'none';
          }
          const measured = [...d.querySelectorAll('h2')].find((e) => e.textContent.startsWith('The detector and the map'));
          if (measured) measured.style.display = 'none';
          const results = d.querySelector('section[aria-label=Results]');
          const breaks = [...results.querySelectorAll('h3')].find((e) => e.textContent.startsWith('What breaks first'));
          for (const c of results.children) if (!c.contains(breaks)) c.style.display = 'none';
          if (breaks.nextElementSibling?.tagName === 'P') breaks.nextElementSibling.style.display = 'none';
          const print = [...d.querySelectorAll('button')].find((e) => e.textContent.trim() === 'Print');
          if (print) print.parentElement.style.display = 'none';  // Report, the team, ICS 204/214/309, CalTopo, Print
          // scroll only the Debrief's own column to its top; the page itself stays put
          let col = d; while (col && col.scrollHeight <= col.clientHeight + 1) col = col.parentElement;
          if (col && col !== document.scrollingElement && col !== document.body) col.scrollTop = 0;
          window.scrollTo(0, 0);
        }"""
    )


# (file, address, step after load)
JOBS = [
    ("console-t0-the-call-pitch-bar.png", "#m/demo?t=0", None),
    ("photos-land-t1-each-photo-ranked-and-placed.png", "#m/demo?t=1", t1_mid_leg),
    ("second-look-t2-a-017-candidate-this-flight-opencv5-zoom-nemotron-vl.png", "#m/demo?t=2", t2_card),
    ("trace-which-model-did-what-second-look.png", "#m/demo/trace?t=2", trace_chain),
    ("run-t4-fleet-flying-b4-pod-60-conditions.png", "#m/demo?t=4", t4_conditions),
    ("debrief-t6-after-action-report-what-breaks-first.png", "#m/demo?t=6", t6_report),
]
ONLY = sys.argv[3:]  # optional: render only the files whose names start with these


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
        if ONLY and not any(name.startswith(o) for o in ONLY):
            continue
        ctx = browser.new_context(viewport={"width": W, "height": H}, device_scale_factor=1)
        page = ctx.new_page()
        page.goto(SITE + address)
        page.add_style_tag(content=HIDE_CURSOR)
        page.wait_for_selector(".maplibregl-canvas", state="attached", timeout=15000)
        page.wait_for_timeout(4000)  # tiles, the photos and the fixtures
        page.mouse.move(W - 1, H - 1)  # no hover state anywhere
        if step:
            step(page)
            page.mouse.move(W - 1, H - 1)
        page.wait_for_timeout(SETTLE)
        page.screenshot(path=str(out / name))
        ctx.close()
        squeeze(out / name)
        print(f"{name}  {(out / name).stat().st_size / 1e6:.2f} MB")
    browser.close()
