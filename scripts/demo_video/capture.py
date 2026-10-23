"""Frame capture for record.py: Playwright's ``page.screencast`` (CDP ``Page.startScreencast``) at full
resolution, encoded by our own ffmpeg (README.md, "Capture").

Playwright's ``recordVideo`` encodes VP8 at a fixed ~1 Mbit/s and scales the viewport to fit 800x800
(microsoft/playwright#31424), so it is not used. Instead Chromium renders the 1920x1080 viewport at device
scale 2 and sends every new frame as a 3840x2160 JPEG with its own timestamp; a writer thread puts the
frames on disk as they come (the page's main loop only queues them), and after the recording ffmpeg makes a
constant-frame-rate master from those timestamps (the concat demuxer, each frame held until the next):
H.264 CRF 16, yuv420p, BT.709 tags. Encoding after the recording, not during it, leaves every core to the
renderer, which is what limits the frame rate on a machine without a GPU.

Chromium sends a frame only when the page changes, so a still page costs nothing and the frame rate that
matters is the rate while something moves; ``stats`` measures it.
"""

from __future__ import annotations

import itertools
import json
import queue
import shutil
import statistics
import subprocess
import threading
import time
from pathlib import Path

# the master's encode: near-transparent for UI text, tagged BT.709 (the JPEGs are full-range BT.601, so
# the matrix and range are converted, not just labelled)
MASTER_X264 = ["-c:v", "libx264", "-preset", "medium", "-crf", "16", "-profile:v", "high", "-pix_fmt", "yuv420p",
               "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"]  # fmt: skip
TO_BT709 = "scale=in_range=full:in_color_matrix=bt601:out_range=tv:out_color_matrix=bt709:flags=accurate_rnd+full_chroma_int"


class FrameCapture:
    """Streams the page's frames to ``folder`` while it runs; ``encode`` makes the video afterwards.

    The page's sync Playwright loop delivers the frames, so the director must wait with
    ``page.wait_for_timeout`` (never ``time.sleep``) or Chromium stops sending them until it is acked."""

    def __init__(self, page, folder: Path, size: tuple[int, int], quality: int = 95):
        self.page = page
        self.dir = folder
        self.size = size
        self.quality = quality
        self.ts: list[float] = []  # each frame's capture time, epoch seconds (Chromium's clock)
        self.t_start = self.t_end = 0.0
        self._q: queue.Queue = queue.Queue()
        self._writer = threading.Thread(target=self._write, daemon=True)

    def _write(self) -> None:
        while (item := self._q.get()) is not None:
            i, data = item
            (self.dir / f"{i:06d}.jpg").write_bytes(data)

    def _on_frame(self, frame: dict) -> None:
        t = float(frame["timestamp"])
        t = t / 1000 if t > 1e11 else t  # Playwright gives milliseconds since the epoch
        if self.ts and t <= self.ts[-1]:
            return  # a repeat (the last frame resent to a new client)
        self._q.put((len(self.ts), frame["data"]))
        self.ts.append(t)

    def start(self) -> None:
        if self.dir.exists():
            shutil.rmtree(self.dir)
        self.dir.mkdir(parents=True)
        self._writer.start()
        self.t_start = time.time()
        w, h = self.size
        # fps > 30 lets Chromium keep 10 frames in flight instead of 5 (Playwright's crPage)
        self.page.screencast.start(
            on_frame=self._on_frame, size={"width": w, "height": h}, quality=self.quality, fps=60
        )

    def stop(self) -> None:
        self.t_end = time.time()
        try:
            self.page.screencast.stop()
        finally:
            self._q.put(None)
            self._writer.join()

    def video_time(self, epoch: float) -> float:
        """Seconds into the video for a wall-clock time (both clocks are this machine's)."""
        return round(epoch - self.ts[0], 3) if self.ts else 0.0

    def frame_size(self) -> tuple[int, int]:
        r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0",
                            str(self.dir / "000000.jpg")], capture_output=True, text=True, check=True)  # fmt: skip
        w, h = r.stdout.strip().split(",")[:2]
        return int(w), int(h)

    def stats(self) -> dict:
        """The capture's frame rate. A still page sends no frames, so the overall rate says little; the
        rate that shows on screen is the one while the page moves: one over the median gap between
        consecutive frames less than 0.25 s apart (``moving_fps``; ``moving_p90_fps`` from the 10th
        percentile gap), over ``moving_s`` seconds of motion."""
        ts = self.ts
        if len(ts) < 2:
            return {"frames": len(ts), "span_s": 0.0, "mean_fps": 0.0, "moving_fps": 0.0,
                    "moving_p90_fps": 0.0, "moving_s": 0.0}  # fmt: skip
        span = ts[-1] - ts[0]
        gaps = sorted(b - a for a, b in itertools.pairwise(ts) if 0 < b - a < 0.25)
        med = statistics.median(gaps) if gaps else 0.0
        fast = gaps[int(0.1 * len(gaps))] if gaps else 0.0
        return {
            "frames": len(ts),
            "span_s": round(span, 2),
            "mean_fps": round(len(ts) / span, 1) if span else 0.0,
            "moving_fps": round(1 / med, 1) if med else 0.0,
            "moving_p90_fps": round(1 / fast, 1) if fast else 0.0,
            "moving_s": round(sum(gaps), 1),
        }

    def save_times(self, path: Path) -> None:
        """The frames' capture times (seconds from the first), to check the rate after the fact."""
        t0 = self.ts[0] if self.ts else 0.0
        path.write_text(json.dumps([round(t - t0, 4) for t in self.ts]) + "\n")

    def encode(self, out: Path, fps: int, log=None) -> None:
        """A constant-frame-rate H.264 master from the frames on disk, each held until the next (and the
        last until ``stop``)."""
        if not self.ts:
            raise RuntimeError("the screencast sent no frames")
        lines = ["ffconcat version 1.0"]
        ends = [*self.ts[1:], max(self.t_end, self.ts[-1] + 1 / fps)]
        for i, (a, b) in enumerate(zip(self.ts, ends, strict=True)):
            lines += [f"file '{i:06d}.jpg'", f"duration {max(b - a, 0.001):.6f}"]
        lines.append(
            f"file '{len(self.ts) - 1:06d}.jpg'"
        )  # the concat demuxer drops the last duration
        listing = self.dir / "frames.ffconcat"
        listing.write_text("\n".join(lines) + "\n")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(listing),
                        "-vf", f"fps={fps},{TO_BT709},format=yuv420p", "-an", *MASTER_X264, "-r", str(fps),
                        "-movflags", "+faststart", str(out)],
                       check=True, stdout=log, stderr=log)  # fmt: skip
