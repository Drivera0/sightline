"""In-process types shared by lane A code (see docs/LANE_A_ML.md §5).

These are plain frozen dataclasses, not contract models: nothing here is written
to the cache directly.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Box:
    """Axis-aligned pixel box, origin top-left, ``x2 > x1`` and ``y2 > y1``."""

    x1: int
    y1: int
    x2: int
    y2: int

    def __post_init__(self) -> None:
        if self.x2 <= self.x1 or self.y2 <= self.y1:
            raise ValueError(f"degenerate box: {self}")

    @property
    def width_px(self) -> int:
        return self.x2 - self.x1

    @property
    def height_px(self) -> int:
        return self.y2 - self.y1

    @property
    def area_px(self) -> int:
        return self.width_px * self.height_px

    @property
    def center(self) -> tuple[float, float]:
        return ((self.x1 + self.x2) / 2, (self.y1 + self.y2) / 2)

    def clipped(self, x1: int, y1: int, x2: int, y2: int) -> Box | None:
        """Intersection with the window ``[x1, x2) × [y1, y2)``, or ``None`` if empty."""
        nx1, ny1 = max(self.x1, x1), max(self.y1, y1)
        nx2, ny2 = min(self.x2, x2), min(self.y2, y2)
        if nx2 <= nx1 or ny2 <= ny1:
            return None
        return Box(nx1, ny1, nx2, ny2)

    def shifted(self, dx: int, dy: int) -> Box:
        return Box(self.x1 + dx, self.y1 + dy, self.x2 + dx, self.y2 + dy)


@dataclass(frozen=True)
class LabeledImage:
    """One image with its ground-truth person boxes (pixels)."""

    path: Path
    width: int
    height: int
    boxes: list[Box]


@dataclass(frozen=True)
class RawDetection:
    """What the detector returns and D's pipeline consumes."""

    box: Box
    conf: float
