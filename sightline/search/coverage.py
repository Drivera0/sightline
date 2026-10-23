"""Where the photos have looked (contract §15, v1.3): a per-cell flag beside the probability.

The probability is defined over the whole mission grid (the prior around the last known point,
clues raising the cells around them, photos lowering what they cover by their POD); a cell no photo
has looked at keeps its prior and clue weight and stays in the probability classes. This flag only
lets the map draw a veil over ground no photo has seen yet.
"""

from __future__ import annotations

from typing import Any

import numpy as np


def photographed(live: Any) -> np.ndarray:
    """1 where a photo has measured the cell (its canopy is known), else 0, row-major."""
    return np.array([0 if c is None else 1 for c in live.canopy()], dtype=np.int8)


def runs(a: np.ndarray) -> list[list[int]]:
    """Run-length pairs ``[value, count]``."""
    out: list[list[int]] = []
    for v in a.tolist():
        if out and out[-1][0] == v:
            out[-1][1] += 1
        else:
            out.append([int(v), 1])
    return out


def photographed_runs(live: Any) -> dict:
    flag = photographed(live)
    return {
        "cells": int(flag.size),
        "photographed_cells": int(flag.sum()),
        "photographed": runs(flag),
    }
