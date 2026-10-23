"""The demo's distractors (V3 simulation content): real licensed photos of things that look like a
search but are not the missing person (a backpack, a fire ring, a shelter, other hikers), each with
the detector's box and the **live** second look on it, saved as fixtures.

    bash web/scripts/fetch-caches.sh                                        # once: the demo cache
    uv run python scripts/make_distractor_fixture.py --prepare <originals>  # the frames (once)
    uv run --env-file .env python scripts/make_distractor_fixture.py        # the live second looks
    uv run python scripts/make_command_fixtures.py --scenarios              # then: the scenarios

``--prepare`` cuts each source photo (``SOURCES``: Wikimedia Commons, CC BY or public domain; source,
author and licence in ``web/public/cache-extras/distractors/CREDITS.md``) to its frame and writes
``web/public/cache-extras/distractors/<kind>.jpg`` (the originals are not kept in the repository).

Without it, for each kind: a mission (the real ``MissionStore``) on the demo cache's map holding the
frame, placed at a survey photo's pose; the detector (``make_detector``, cv2 backend) on the frame at
0.05, and the box it gives over the object (``object_box``) when its score is in the second look's
band or above, else the object's box placed by hand with the band's floor (0.15) and a note saying so;
then ``loop.handle("detection")``: the verifier's OpenCV re-look tools and the VL model on Token
Factory (``NEBIUS_API_KEY`` from the environment only; never printed or written). The answer is kept
word for word in ``web/src/command/__fixtures__/distractors/<kind>.json`` with the verdict, the model
call's time and tokens, and the detection; the crop the reviewer sees goes beside the frame.
``make_command_fixtures.py`` replays it in each scenario that throws that distractor.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

CACHE = ROOT / "web/public/cache/demo"
EXTRAS = ROOT / "web/public/cache-extras/distractors"
OUT = ROOT / "web/src/command/__fixtures__/distractors"
NEAR_FRAME = (
    "f0245"  # the survey photo whose pose the live run borrows (the verdict reads pixels only)
)
BAND_FLOOR = 0.15  # the second look's band starts here (verify.VERIFY_BAND)
WIDTH = 1000  # frames are 1000 px wide, like the demo flight's

# kind -> the source photo, the cut (x0, y0, x1, y1 in the original's pixels), the object's box in
# the original's pixels, and the credit. Commons pages checked 2026-10-22.
SOURCES: dict[str, dict] = {
    "backpack": {
        "file": "Tent,_sleeping_bag,_and_backpack.jpg",
        "url": "https://upload.wikimedia.org/wikipedia/commons/8/8f/Tent%2C_sleeping_bag%2C_and_backpack.jpg",
        "page": "https://commons.wikimedia.org/wiki/File:Tent,_sleeping_bag,_and_backpack.jpg",
        "cut": (300, 1560, 1960, 2268),  # below the drink bottle's label
        "object_box": (430, 1560, 1840, 2200),
        "credit": "Steve Bittinger, CC BY 2.0, via Wikimedia Commons",
        "view": "ground-level oblique (no licensed aerial photo of a pack was found)",
    },
    "fire ring": {
        "file": "Campfire_scar_08319.JPG",
        "url": "https://upload.wikimedia.org/wikipedia/commons/8/89/Campfire_scar_08319.JPG",
        "page": "https://commons.wikimedia.org/wiki/File:Campfire_scar_08319.JPG",
        "cut": (0, 0, 2358, 1768),
        "object_box": (105, 95, 2180, 1650),
        "credit": "Walter Siegmund, CC BY 2.5, via Wikimedia Commons",
        "view": "close top-down (camera pointing straight down, not drone altitude)",
    },
    "shelter": {
        "file": "Aerial_View_(140435851).jpeg",
        "url": "https://upload.wikimedia.org/wikipedia/commons/c/c9/Aerial_View_%28140435851%29.jpeg",
        "page": "https://commons.wikimedia.org/wiki/File:Aerial_View_(140435851).jpeg",
        "cut": (420, 560, 1100, 1070),  # two tents and a pack; the people at the right are left out
        "object_box": (676, 692, 932, 815),
        "credit": "J Doll, CC BY 3.0, via Wikimedia Commons",
        "view": "steep oblique from a rock outcrop above the camp",
    },
    "hikers": {
        "file": "Eagle_Peak_Search_&_Rescue-_ground_team_searching_bowl_under_west_face_of_Eagle_Peak_(54018097082).jpg",
        "url": "https://upload.wikimedia.org/wikipedia/commons/7/72/Eagle_Peak_Search_%26_Rescue-_ground_team_searching_bowl_under_west_face_of_Eagle_Peak_%2854018097082%29.jpg",
        "page": "https://commons.wikimedia.org/wiki/File:Eagle_Peak_Search_%26_Rescue-_ground_team_searching_bowl_under_west_face_of_Eagle_Peak_(54018097082).jpg",
        "cut": (2600, 2300, 5900, 4775),
        "object_box": (2960, 3000, 3090, 3265),
        "credit": "NPS / Jacob W. Frank, public domain (U.S. federal government work), via Wikimedia Commons",
        "view": "high oblique from well above (helicopter or ridge), two people on a snowfield",
    },
}


def slug(kind: str) -> str:
    return kind.replace(" ", "-")


def scale_of(src: dict) -> float:
    x0, _, x1, _ = src["cut"]
    return WIDTH / (x1 - x0)


def frame_box(src: dict) -> tuple[int, int, int, int]:
    """The object's box in the frame's pixels."""
    s = scale_of(src)
    x0, y0 = src["cut"][:2]
    a, b, c, d = src["object_box"]
    return (round((a - x0) * s), round((b - y0) * s), round((c - x0) * s), round((d - y0) * s))


def prepare(originals: Path) -> int:
    from PIL import Image

    EXTRAS.mkdir(parents=True, exist_ok=True)
    for kind, src in SOURCES.items():
        path = originals / src["file"]
        if not path.is_file():
            alt = originals / f"{slug(kind)}.jpg"
            path = alt if alt.is_file() else path
        im = Image.open(path).convert("RGB").crop(src["cut"])
        h = round(im.height * scale_of(src))
        im = im.resize((WIDTH, h), Image.LANCZOS)
        out = EXTRAS / f"{slug(kind)}.jpg"
        im.save(
            out, quality=82, optimize=True
        )  # PIL writes no EXIF unless given: nothing carried over
        print(
            f"{out.relative_to(ROOT)}: {im.size}, object box {frame_box(src)}, {out.stat().st_size} bytes"
        )
    return 0


def iou(a, b) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union else 0.0


def detection_for(img_bgr, src: dict, detector) -> dict:
    """The detector's best box over the object (centre inside it, or IoU > 0.1)."""
    obj = frame_box(src)
    raw = detector.detect_array(img_bgr, conf=0.05)
    over = []
    for r in raw:
        b = (r.box.x1, r.box.y1, r.box.x2, r.box.y2)
        cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
        if iou(b, obj) > 0.1 or (obj[0] <= cx <= obj[2] and obj[1] <= cy <= obj[3]):
            over.append((float(r.conf), [int(v) for v in b]))
    best = max(over, default=None)
    if best is not None and best[0] >= BAND_FLOOR:
        return {"box_px": best[1], "conf": round(best[0], 3), "by": "detector",
                "note": f"the detector's box ({best[0]:.3f}) over the {src.get('kind', 'object')}"}  # fmt: skip
    seen = (
        f"its best box over it scored {best[0]:.3f}" if best else "it gave no box over it at 0.05"
    )
    return {"box_px": list(obj), "conf": BAND_FLOOR, "by": "hand",
            "note": f"placed by hand for the demo: the detector did not flag it ({seen}); score set to "
                    f"the second look's floor {BAND_FLOOR}"}  # fmt: skip


def run(kinds: list[str], onnx: Path | None) -> int:
    import cv2

    from sightline.agent import loop
    from sightline.agent.llm import NO_THINKING, token_factory_client
    from sightline.contract import (
        CONTRACT_VERSION,
        Detection,
        Frame,
        LatLon,
        MapBase,
        MapFile,
        Survey,
    )
    from sightline.mission import MissionStore
    from sightline.ml.backend import make_detector

    detector = make_detector(backend="cv2", onnx=onnx)
    client = token_factory_client(extra_body=NO_THINKING)
    m = MapFile.model_validate_json((CACHE / "map.json").read_text())
    survey = Survey.model_validate_json((CACHE / "survey.json").read_text())
    near = next(f for f in survey.frames if f.id == NEAR_FRAME)
    OUT.mkdir(parents=True, exist_ok=True)
    for kind in kinds:
        src = {**SOURCES[kind], "kind": kind}
        img_path = EXTRAS / f"{slug(kind)}.jpg"
        data = img_path.read_bytes()
        img = cv2.imdecode(__import__("numpy").frombuffer(data, "uint8"), cv2.IMREAD_COLOR)
        det_info = detection_for(img, src, detector)
        tmp = Path(tempfile.mkdtemp(prefix="distractor-"))
        store = MissionStore(tmp / "missions")
        lkp = LatLon.model_validate(survey.area.lkp.model_dump())
        mid = store.create(f"Distractor: {kind} (demo)", "Mount Seymour", lkp, "demo").mission_id
        store.put_map_base(mid, MapBase(contract_version=CONTRACT_VERSION, grid=m.grid, lkp=m.lkp,
                                        params=m.params, prior=m.prior, canopy=m.canopy))  # fmt: skip
        frame = Frame.model_validate({**near.model_dump(), "id": "f0001", "file": "frames/f0001.jpg",
                                      "flight_index": 0, "width_px": img.shape[1], "height_px": img.shape[0],
                                      "source": {"image": f"distractor:{slug(kind)}", "x0": 0, "y0": 0},
                                      "score": 0.0, "rank": 1, "n_candidates": 0})  # fmt: skip
        store.append_frame(mid, frame, data)
        store.set_frames(mid, [frame])
        crops = {}
        crop_rel = None
        if (
            det_info["conf"] >= loop.CANDIDATE_THRESHOLD
        ):  # a candidate: the review crop, as D cuts it
            from sightline.agent.relook import zoom_native

            x1, y1, x2, y2 = det_info["box_px"]
            crop_rel = "crops/f0001-d01.jpg"
            crop = zoom_native(img, tuple(det_info["box_px"]), out_px=256,
                               context=128 / max(1, max(x2 - x1, y2 - y1)))  # fmt: skip
            crops[crop_rel] = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 88])[
                1
            ].tobytes()
        det = Detection(id="f0001-d01", box_px=tuple(det_info["box_px"]), conf=det_info["conf"],
                        crop=crop_rel, lat=near.pose.lat, lon=near.pose.lon, radius_m=10.0)  # fmt: skip
        store.append_detections(mid, "f0001", [det], crops)
        proposals = loop.handle("detection", store, mid, det.id, client=client, detector=detector)
        verdict = next(v for v in store.state(mid)["verdicts"] if v.detection_id == det.id)
        entries = store.trace_entries(mid)
        calls = [e for e in entries if e.kind == "model_call"]
        last = calls[-1]
        review_crop = f"{slug(kind)}-crop.jpg"
        crop_src = crop_rel or f"relook/{det.id}-crop.jpg"
        (EXTRAS / review_crop).write_bytes(store.read_file(mid, crop_src))
        doc = {
            "note": "Written by scripts/make_distractor_fixture.py: the real second look on a licensed "
            "photo placed in the demo flight as a distractor, with the live VL model; the answer is "
            "kept word for word. Not the missing person.",
            "kind": kind,
            "image": f"{slug(kind)}.jpg",
            "crop": review_crop,
            "size_px": [int(img.shape[1]), int(img.shape[0])],
            "detection": det_info,
            "verdict": verdict.model_dump(mode="json")
            | {"detection_id": "<frame>-d01", "id": "<verdict>"},
            "answer": last.output["text"] if last.output else None,
            "model_call": {k: getattr(last, k) for k in ("model", "ms", "tokens_in", "tokens_out")},
            "model_calls": len(calls),
            "tools": verdict.tools,
            "proposals": [p.kind for p in proposals],
            "credit": src["credit"],
            "source": src["page"],
            "view": src["view"],
        }
        (OUT / f"{slug(kind)}.json").write_text(
            json.dumps(doc, indent=1, ensure_ascii=False) + "\n"
        )
        shutil.rmtree(tmp, ignore_errors=True)
        print(f"{kind}: detector {det_info['by']} {det_info['conf']}; person {verdict.person}, "
              f"object {verdict.object}; {verdict.reason}")  # fmt: skip
        print(f"  answer, as the model gave it: {doc['answer']}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--prepare", type=Path, help="cut the frames from the originals in this folder")
    ap.add_argument(
        "--kind", action="append", choices=list(SOURCES), help="only this kind (repeatable)"
    )
    ap.add_argument("--onnx", type=Path, default=None, help="the detector (cv2 backend)")
    args = ap.parse_args(argv)
    if args.prepare:
        return prepare(args.prepare)
    if not (CACHE / "map.json").is_file():
        print(f"no {CACHE}/map.json: run `bash web/scripts/fetch-caches.sh` first")
        return 1
    return run(args.kind or list(SOURCES), args.onnx)


if __name__ == "__main__":
    raise SystemExit(main())
