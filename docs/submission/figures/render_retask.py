"""Render N4 (clue-retasks-the-nearest-drone.png): the demo console 100 ms after the map first draws, while
Drone 1's cancelled leg L001 is still fading out (CANCEL_FADE_MS is 1500 ms). Playwright's fake clock holds
time still while the map loads, so the moment is repeatable. Start the demo site first (README.md here).

python render_retask.py OUTDIR   (a Python with playwright and Chromium; then quantize to 256 colours to
stay under 500 KB)
"""

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
SEEN = "try{localStorage.setItem('sightline.consoleHint','seen')}catch(e){}"
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 1920, "height": 1080}, device_scale_factor=1)
    ctx.add_init_script(SEEN)
    page = ctx.new_page()
    page.clock.install()
    page.goto("http://localhost:5201/#m/demo/command")
    for _ in range(2):
        page.clock.run_for(50)
        page.wait_for_timeout(150)  # real time for the tiles and the map's first draw
    page.screenshot(path=str(out / "clue-retasks-the-nearest-drone.png"))
    b.close()
