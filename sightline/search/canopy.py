"""Per-pixel tree-canopy / deep-shadow classifier (LANE_C_SEARCH §3.3).

A pixel is canopy when it is green *and* textured (tree crowns), or when it is
in deep shadow. Grass is green but smooth, so texture separates it from trees.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

DEFAULT_EXG_THR = 0.04
DEFAULT_STD_THR = 12.0
DEFAULT_SHADOW_THR = 60
STD_WINDOW_PX = 7

# ITU-R BT.601 luma weights for the greyscale used by the texture test.
_GREY_WEIGHTS = np.array([0.299, 0.587, 0.114], dtype=np.float64)


@dataclass(frozen=True)
class CanopyFeatures:
    """Per-pixel features that the thresholds compare against (all H×W)."""

    exg: np.ndarray  # excess green 2g - r - b on normalised colour, float64
    local_std: np.ndarray  # greyscale std in a 7×7 window, 0-255 scale, float64
    max_channel: np.ndarray  # max(R, G, B), uint8


def canopy_features(rgb: np.ndarray) -> CanopyFeatures:
    """Compute the threshold-free features once, so many thresholds can be tried cheaply."""
    _validate_rgb(rgb)
    channels = rgb.astype(np.float64)
    total = channels.sum(axis=2)
    safe_total = np.where(total > 0, total, 1.0)
    # Black pixels (total 0) get r = g = b = 0, so ExG = 0.
    normalised = np.where(total[..., None] > 0, channels / safe_total[..., None], 0.0)
    exg = 2.0 * normalised[..., 1] - normalised[..., 0] - normalised[..., 2]

    grey = channels @ _GREY_WEIGHTS
    window = (STD_WINDOW_PX, STD_WINDOW_PX)
    # Box mean with mirrored borders (same as scipy.ndimage.uniform_filter mode="reflect").
    mean = cv2.blur(grey, window, borderType=cv2.BORDER_REFLECT)
    mean_sq = cv2.blur(grey * grey, window, borderType=cv2.BORDER_REFLECT)
    local_std = np.sqrt(np.clip(mean_sq - mean * mean, 0.0, None))

    return CanopyFeatures(exg=exg, local_std=local_std, max_channel=rgb.max(axis=2))


def mask_from_features(
    features: CanopyFeatures,
    exg_thr: float = DEFAULT_EXG_THR,
    std_thr: float = DEFAULT_STD_THR,
    shadow_thr: int = DEFAULT_SHADOW_THR,
) -> np.ndarray:
    """Apply the three thresholds to precomputed features; returns bool H×W."""
    green = features.exg > exg_thr
    textured = features.local_std > std_thr
    shadow = features.max_channel < shadow_thr
    return (green & textured) | shadow


def canopy_mask(
    rgb: np.ndarray,
    exg_thr: float = DEFAULT_EXG_THR,
    std_thr: float = DEFAULT_STD_THR,
    shadow_thr: int = DEFAULT_SHADOW_THR,
) -> np.ndarray:
    """Classify each pixel of a uint8 H×W×3 RGB image as canopy (True) or open (False)."""
    return mask_from_features(canopy_features(rgb), exg_thr, std_thr, shadow_thr)


def canopy_fraction(
    rgb: np.ndarray,
    mask: np.ndarray | None = None,
    **thr: float,
) -> float:
    """Fraction of canopy pixels in the whole image, or inside ``mask`` (bool H×W).

    ``thr`` passes ``exg_thr``, ``std_thr`` and ``shadow_thr`` through to ``canopy_mask``.
    Raises ``ValueError`` if ``mask`` has the wrong shape or selects no pixels: the
    contract forbids NaN, so the caller must skip cells with no pixels in the frame.
    """
    canopy = canopy_mask(rgb, **thr)
    if mask is None:
        return float(canopy.mean())
    if mask.shape != canopy.shape:
        raise ValueError(f"mask shape {mask.shape} does not match image shape {canopy.shape}")
    selected = mask.astype(bool)
    if not selected.any():
        raise ValueError("mask selects no pixels; canopy fraction is undefined")
    return float(canopy[selected].mean())


def _validate_rgb(rgb: np.ndarray) -> None:
    if rgb.ndim != 3 or rgb.shape[2] != 3:
        raise ValueError(f"expected an H×W×3 RGB image, got shape {rgb.shape}")
    if rgb.dtype != np.uint8:
        raise ValueError(f"expected a uint8 image, got {rgb.dtype}")
