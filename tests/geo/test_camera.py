"""Acceptance tests for Lane B camera calculations."""

from __future__ import annotations

import pytest

from sightline.geo.camera import gsd, hfov_from_f35


def test_dji_fov_and_gsd_match_documented_example() -> None:
    hfov_deg = hfov_from_f35(20.0, 4000, 3000)

    assert hfov_deg == pytest.approx(81.74, abs=0.1)
    assert gsd(51.9, hfov_deg, 4000) == pytest.approx(0.0225, abs=0.0005)


@pytest.mark.parametrize(
    ("args", "message"),
    [
        ((0.0, 1000, 750), "f35_mm"),
        ((20.0, 0, 750), "dimensions"),
    ],
)
def test_hfov_rejects_invalid_inputs(
    args: tuple[float, int, int], message: str
) -> None:
    with pytest.raises(ValueError, match=message):
        hfov_from_f35(*args)

