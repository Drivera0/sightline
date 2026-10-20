"""Benchmark the Nemotron VL verifier on HERIDAL person crops vs hard negatives.

Usage:
    uv run python scripts/bench_verifier.py                  # 20 pos + 20 neg, both prompts
    uv run python scripts/bench_verifier.py -n 40 --no-think # bigger run, thinking off
    uv run python scripts/bench_verifier.py --crop 192       # tighter crops (all classes)
    uv run python scripts/bench_verifier.py --negatives hard # only detector false alarms

All crops are the same size. Negatives come from two places, both checked against
the labels so no labelled person is within 1.5 crop-widths:
  - neg_*  : random empty ground from the same split as the people (--split, default val)
  - hneg_* : centre of mined hard-negative patches (what the detector fired on)

Writes per-crop results to runs/bench_verifier/<timestamp>.csv and keeps the crops
it used in runs/bench_verifier/crops/ so you can look at the mistakes.
"""

from __future__ import annotations

import argparse
import base64
import csv
import glob
import io
import os
import random
import re
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI
from PIL import Image

PROMPTS = {
    "basic": ("Is there a person in this aerial image? Answer with only `person` or `not_person`."),
    "strict": (
        "This is a crop from a drone photo taken during a search-and-rescue mission. "
        "Decide whether a real human is visible. Rocks, logs, stumps, shadows, bushes, "
        "bags, and clothing lying on the ground are NOT people. If you are unsure, "
        "answer `not_person`. Reply on one line in the form: "
        "`<person|not_person> <confidence 0-100>`"
    ),
}

OUT_DIR = Path("runs/bench_verifier")


@dataclass
class Crop:
    path: Path
    label: str  # "person" or "not_person"
    source: str


def split_labels(split: str) -> list[str]:
    """Label files of one yolo_full split; no fallback to another split."""
    labels = sorted(glob.glob(f"data/heridal/yolo_full/{split}/labels/*.txt"))
    if not labels:
        raise SystemExit(f"no labels in data/heridal/yolo_full/{split}/labels")
    return labels


def make_person_crops(n: int, size: int, rng: random.Random, split: str) -> list[Crop]:
    """Crop `size` px squares around labelled people in one yolo_full split."""
    labels = split_labels(split)
    rng.shuffle(labels)
    crops: list[Crop] = []
    out = OUT_DIR / "crops"
    out.mkdir(parents=True, exist_ok=True)
    for lbl in labels:
        rows = [r.split() for r in Path(lbl).read_text().splitlines() if r.strip()]
        if not rows:
            continue
        base = lbl.replace("/labels/", "/images/").rsplit(".", 1)[0]
        img = next((base + e for e in (".jpg", ".JPG", ".png") if os.path.exists(base + e)), None)
        if not img:
            continue
        _, cx, cy, _w, _h = map(float, rng.choice(rows)[:5])
        im = Image.open(img).convert("RGB")
        W, H = im.size
        # small jitter so the person is not always dead centre, like a real detection box
        x = cx * W + rng.uniform(-size * 0.15, size * 0.15)
        y = cy * H + rng.uniform(-size * 0.15, size * 0.15)
        half = size // 2
        box = (int(x - half), int(y - half), int(x + half), int(y + half))
        p = out / f"pos_{len(crops):03d}_{Path(img).stem}.jpg"
        im.crop(box).save(p, quality=95)
        crops.append(Crop(p, "person", img))
        if len(crops) >= n:
            break
    return crops


def make_negative_crops(n: int, size: int, rng: random.Random, split: str) -> list[Crop]:
    """Same-size crops from photos of the same split, at spots with no labelled person.

    A crop is kept only if no labelled person centre lies within `size` px of it,
    so a person at the crop edge can't leak in.
    """
    labels = split_labels(split)
    rng.shuffle(labels)
    out = OUT_DIR / "crops"
    out.mkdir(parents=True, exist_ok=True)
    crops: list[Crop] = []
    half = size // 2
    for lbl in labels:
        base = lbl.replace("/labels/", "/images/").rsplit(".", 1)[0]
        img = next((base + e for e in (".jpg", ".JPG", ".png") if os.path.exists(base + e)), None)
        if not img:
            continue
        im = Image.open(img).convert("RGB")
        W, H = im.size
        people = [
            (float(r.split()[1]) * W, float(r.split()[2]) * H)
            for r in Path(lbl).read_text().splitlines()
            if r.strip()
        ]
        for _ in range(50):  # try a few random spots in this photo
            x = rng.uniform(half, W - half)
            y = rng.uniform(half, H - half)
            if all((px - x) ** 2 + (py - y) ** 2 > (1.5 * size) ** 2 for px, py in people):
                p = out / f"neg_{len(crops):03d}_{Path(img).stem}_{int(x)}_{int(y)}.jpg"
                im.crop((int(x - half), int(y - half), int(x + half), int(y + half))).save(
                    p, quality=95
                )
                crops.append(Crop(p, "not_person", img))
                break
        if len(crops) >= n:
            break
    return crops


def make_hard_negative_crops(n: int, size: int, rng: random.Random) -> list[Crop]:
    """Centre crops of mined hard negatives, skipping any patch with a labelled person.

    Hard-negative patches are 1024 px and centred on the false detection, so a
    centre crop of `size` px is the bit the detector actually fired on.
    """
    paths = sorted(glob.glob("data/heridal/hard_negatives_v2/images/*"))
    rng.shuffle(paths)
    out = OUT_DIR / "crops"
    out.mkdir(parents=True, exist_ok=True)
    crops: list[Crop] = []
    for src in paths:
        m = re.search(r"(train|val|test)_(.+)_hn_(\d+)_(\d+)", Path(src).stem)
        if not m:
            continue
        split, stem, x0, y0 = m.group(1), m.group(2), int(m.group(3)), int(m.group(4))
        lbl = f"data/heridal/yolo_full/{split}/labels/{split}_{stem}.txt"
        img = lbl.replace("/labels/", "/images/").replace(".txt", ".jpg")
        if not (os.path.exists(lbl) and os.path.exists(img)):
            continue
        patch = Image.open(src).convert("RGB")
        w, h = patch.size
        W, H = Image.open(img).size
        cx, cy = w / 2, h / 2
        half = size // 2
        near = False
        for r in Path(lbl).read_text().splitlines():
            if not r.strip():
                continue
            px, py = float(r.split()[1]) * W - x0, float(r.split()[2]) * H - y0
            if (px - cx) ** 2 + (py - cy) ** 2 < (1.5 * size) ** 2:
                near = True
                break
        if near:
            continue
        p = out / f"hneg_{len(crops):03d}_{Path(src).stem}.jpg"
        patch.crop((int(cx - half), int(cy - half), int(cx + half), int(cy + half))).save(
            p, quality=95
        )
        crops.append(Crop(p, "not_person", src))
        if len(crops) >= n:
            break
    return crops


def b64_jpeg(path: Path) -> str:
    buf = io.BytesIO()
    Image.open(path).convert("RGB").save(buf, format="JPEG", quality=95)
    return base64.b64encode(buf.getvalue()).decode()


def parse(text: str | None) -> tuple[str, int | None]:
    t = (text or "").strip().lower()
    if "not_person" in t or "not person" in t or t.startswith("no"):
        pred = "not_person"
    elif "person" in t or t.startswith("yes"):
        pred = "person"
    else:
        pred = "unparsed"
    m = re.search(r"\b(\d{1,3})\b", t)
    conf = int(m.group(1)) if m and int(m.group(1)) <= 100 else None
    return pred, conf


def ask(client: OpenAI, model: str, prompt: str, crop: Crop, no_think: bool) -> dict:
    extra = {"chat_template_kwargs": {"enable_thinking": False}} if no_think else None
    t0 = time.perf_counter()
    try:
        r = client.chat.completions.create(
            model=model,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:image/jpeg;base64,{b64_jpeg(crop.path)}"},
                        },
                    ],
                }
            ],
            max_tokens=1024,
            temperature=0,
            extra_body=extra,
        )
        text = r.choices[0].message.content
        usage = r.usage.total_tokens if r.usage else None
        err = ""
    except Exception as e:  # noqa: BLE001 - keep going; record the failure
        text, usage, err = None, None, f"{type(e).__name__}: {e}"[:200]
    secs = time.perf_counter() - t0
    pred, conf = parse(text)
    return {
        "crop": str(crop.path),
        "source": crop.source,
        "label": crop.label,
        "pred": pred,
        "conf": conf,
        "secs": round(secs, 2),
        "tokens": usage,
        "answer": (text or "").strip().replace("\n", " ")[:200],
        "error": err,
    }


def summarize(name: str, rows: list[dict]) -> None:
    pos = [r for r in rows if r["label"] == "person"]
    neg = [r for r in rows if r["label"] == "not_person"]
    tp = sum(r["pred"] == "person" for r in pos)
    fn = len(pos) - tp
    fp = sum(r["pred"] == "person" for r in neg)
    tn = len(neg) - fp
    bad = sum(1 for r in rows if r["pred"] == "unparsed" or r["error"])
    errs = [r["error"] for r in rows if r["error"]]
    acc = (tp + tn) / len(rows) if rows else 0
    recall = tp / len(pos) if pos else 0
    fpr = fp / len(neg) if neg else 0
    secs = sorted(r["secs"] for r in rows)
    toks = [r["tokens"] for r in rows if r["tokens"]]
    print(f"\n== {name} ==")
    print(f"  accuracy        {acc:6.1%}   ({tp + tn}/{len(rows)})")
    print(f"  recall (people) {recall:6.1%}   missed {fn} of {len(pos)} people")
    print(f"  false-pos rate  {fpr:6.1%}   said 'person' on {fp} of {len(neg)} negatives")
    for kind, prefix in (("empty ground", "neg_"), ("hard negatives", "hneg_")):
        sub = [r for r in neg if Path(r["crop"]).name.startswith(prefix)]
        if sub:
            k = sum(r["pred"] == "person" for r in sub)
            print(f"    on {kind:<14} {k / len(sub):6.1%}   ({k}/{len(sub)})")
    print(f"  unparsed/errors {bad}")
    if errs:
        print(f"  first error:    {errs[0]}")
    if secs:
        print(f"  latency         median {secs[len(secs) // 2]:.1f}s   max {secs[-1]:.1f}s")
    if toks:
        print(f"  tokens / crop   avg {sum(toks) / len(toks):.0f}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("-n", type=int, default=20, help="crops per class")
    ap.add_argument("--crop", type=int, default=256, help="person crop size in px")
    ap.add_argument("--prompts", nargs="+", default=list(PROMPTS), choices=list(PROMPTS))
    ap.add_argument("--no-think", action="store_true", help="disable Nemotron thinking")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument(
        "--split",
        choices=["train", "val", "test"],
        default="val",
        help="yolo_full split for person and empty-ground crops (val; keep test for final reporting)",
    )
    ap.add_argument(
        "--negatives",
        choices=["random", "hard", "both"],
        default="both",
        help="random empty ground, mined hard negatives (centre-cropped), or both",
    )
    args = ap.parse_args()

    load_dotenv()
    client = OpenAI(api_key=os.environ["NEBIUS_API_KEY"], base_url=os.environ["NEBIUS_BASE_URL"])
    model = os.environ.get("NEMOTRON_VERIFIER_MODEL", "nvidia/Nemotron-3.5-Super-VL")

    rng = random.Random(args.seed)
    out = OUT_DIR / "crops"
    if out.exists():
        for old in out.glob("*.jpg"):
            old.unlink()
    crops = make_person_crops(args.n, args.crop, rng, args.split)
    if args.negatives in ("random", "both"):
        crops += make_negative_crops(args.n, args.crop, rng, args.split)
    if args.negatives in ("hard", "both"):
        crops += make_hard_negative_crops(args.n, args.crop, rng)
    print(f"model {model} | {len(crops)} crops | thinking {'off' if args.no_think else 'on'}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_csv = OUT_DIR / f"{time.strftime('%Y%m%d-%H%M%S')}.csv"
    all_rows = []
    for name in args.prompts:
        with ThreadPoolExecutor(args.workers) as pool:
            rows = list(
                pool.map(
                    lambda c, name=name: ask(client, model, PROMPTS[name], c, args.no_think), crops
                )
            )
        for r in rows:
            r["prompt"] = name
        summarize(name, rows)
        all_rows += rows

    with open(out_csv, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(all_rows[0].keys()))
        w.writeheader()
        w.writerows(all_rows)
    print(f"\nper-crop results: {out_csv}")
    print("mistakes:")
    for r in all_rows:
        if r["pred"] != r["label"]:
            print(
                f'  [{r["prompt"]}] {r["label"]:>10} -> {r["pred"]:<10} {r["crop"]}  "{r["answer"][:60]}"'
            )


if __name__ == "__main__":
    main()
