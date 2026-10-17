from __future__ import annotations

from pathlib import Path

from PIL import Image

from sightline.ml.crops import make_crop
from sightline.ml.types import Box


def _image(tmp_path: Path, w: int = 1000, h: int = 750) -> Path:
    im = Image.new("RGB", (w, h), (0, 200, 0))
    im.putpixel((0, 0), (255, 0, 0))
    p = tmp_path / "f0001.jpg"
    im.save(p, quality=95)
    return p


def test_corner_box_gives_256_crop(tmp_path: Path) -> None:
    img = _image(tmp_path)
    out = tmp_path / "crops" / "f0001-d01.jpg"
    make_crop(img, Box(0, 0, 20, 20), out)
    with Image.open(out) as c:
        assert c.size == (256, 256)
        # top-left of the window is outside the image → black padding; centre is image content
        assert c.getpixel((10, 10)) == (0, 0, 0)
        r, g, _b = c.getpixel((200, 200))
        assert g > 150 and r < 60


def test_box_at_far_corner(tmp_path: Path) -> None:
    img = _image(tmp_path)
    out = tmp_path / "c.jpg"
    make_crop(img, Box(980, 730, 1000, 750), out)
    with Image.open(out) as c:
        assert c.size == (256, 256)
        assert c.getpixel((250, 250)) == (0, 0, 0)


def test_interior_box_has_no_padding(tmp_path: Path) -> None:
    img = _image(tmp_path)
    out = tmp_path / "c.jpg"
    make_crop(img, Box(500, 300, 560, 360), out)
    with Image.open(out) as c:
        for xy in ((2, 2), (253, 2), (2, 253), (253, 253), (128, 128)):
            assert c.getpixel(xy)[1] > 150
