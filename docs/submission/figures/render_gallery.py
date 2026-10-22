"""Render the Devpost gallery at 1920x1080 from the demo site (http://localhost:5201) and repo images.
See README.md here: start the site first (VITE_CACHE_DIR=demo npx vite --port 5201 from web/).

python render_gallery.py REPO OUTDIR   (a Python with playwright and Chromium)
"""

import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

repo, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
SITE = "http://localhost:5201/"
SEEN = "try{localStorage.setItem('sightline.consoleHint','seen')}catch(e){}"
# lane B's real B3 card fixture (the sector of caltopo-import.png), rendered first by the dev page
CARD = Path(tempfile.mkdtemp()) / "card-B3.png"

PAGE = """<!doctype html><html><head><meta charset=utf-8><style>
html,body{{margin:0;width:1920px;height:1080px;background:#0a0b0d;display:flex;align-items:center;justify-content:center;gap:40px;font-family:system-ui}}
img{{max-height:1000px;max-width:{w}px;border-radius:12px;border:1px solid rgba(255,255,255,.12)}}
</style></head><body>{imgs}</body></html>"""


def compose(name: str, images: list[Path], w: int) -> Path:
    html = Path(tempfile.mkdtemp()) / f"{name}.html"
    html.write_text(PAGE.format(w=w, imgs="".join(f'<img src="{p.as_uri()}">' for p in images)))
    return html


JOBS = [
    # (file, url or composed html, wait ms, js after load)
    ("command-view-detections-task-board-approval-inbox.png", SITE + "#m/demo/command", 6000, None),
    (
        "trace-which-model-did-what-second-look.png",
        SITE + "#m/demo/trace",
        3000,
        "document.querySelectorAll('li[aria-label^=Model] button')[0].click(); window.scrollTo(0, 240)",
    ),
    (
        "approval-inbox-every-proposal-carries-its-reason.png",
        SITE + "#m/demo/approvals",
        3000,
        None,
    ),
    (
        "conditions-tavily-quotes-sources-flyability.png",
        SITE + "#m/demo/command",
        6000,
        "window.dispatchEvent(new KeyboardEvent('keydown', {key: 'w'}))",
    ),
    ("front-door-the-product-first.png", SITE + "#", 2500, None),
    ("results-detector-vs-human-baseline.png", SITE + "#results", 6000, None),
    (
        "assignment-card-gpx-kml-opened-in-caltopo.png",
        compose(
            "card",
            [
                CARD,
                repo / "docs/architecture/screens/caltopo-import.png",
            ],
            900,
        ).as_uri(),
        800,
        None,
    ),
    (
        "architecture-photos-cv2dnn-map-agent-approval-on-aws.png",
        compose("arch", [repo / "docs/architecture/live.png"], 1840).as_uri(),
        800,
        None,
    ),
]

with sync_playwright() as p:
    b = p.chromium.launch()
    card = b.new_page(viewport={"width": 1000, "height": 900})
    card.goto(SITE + "command.html?card=B3")
    card.wait_for_timeout(2000)
    card.screenshot(path=str(CARD), full_page=True)
    card.close()
    for name, url, wait, js in JOBS:
        ctx = b.new_context(viewport={"width": 1920, "height": 1080}, device_scale_factor=1)
        ctx.add_init_script(SEEN)
        page = ctx.new_page()
        page.goto(url)
        page.wait_for_timeout(wait)
        if js:
            page.evaluate(js)
            page.wait_for_timeout(1000)
        page.screenshot(path=str(out / name))
        ctx.close()
        print(name)
    b.close()
