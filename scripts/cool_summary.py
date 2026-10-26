"""Tables for docs/report/COOL_GRAVITON.md from the files scripts/cool_bench.sh writes.

    python scripts/cool_summary.py docs/evidence/cool [--price 0.544] [--cool-price 0.04]

Prints Markdown: the detector (single-process s/photo and ms/slice, the 4-process throughput,
CPU use, scores), the cost of 500 photos at the on-demand price, and the imgproc calls with the
pip-to-COOL ratio. Only reads; nothing is re-measured.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ENVS = ("cool", "pip", "pip5")


def _time_file(path: Path) -> dict[str, float]:
    out: dict[str, float] = {}
    if not path.exists():
        return out
    text = path.read_text(encoding="utf-8")
    if m := re.search(r"Percent of CPU this job got: (\d+)%", text):
        out["cpu_pct"] = float(m.group(1))
    if m := re.search(r"Maximum resident set size \(kbytes\): (\d+)", text):
        out["max_rss_mb"] = int(m.group(1)) / 1024
    if m := re.search(r"Elapsed \(wall clock\) time.*: (?:(\d+):)?(\d+):([\d.]+)", text):
        h, mnt, s = m.groups()
        out["elapsed_s"] = int(h or 0) * 3600 + int(mnt) * 60 + float(s)
    return out


def _reproduce(path: Path) -> dict[str, object]:
    out: dict[str, object] = {}
    if not path.exists():
        return out
    text = path.read_text(encoding="utf-8")
    if m := re.search(r"detection ([\d.]+) s per photo of wall time", text):
        out["wall_s_per_photo"] = float(m.group(1))
    if m := re.search(r"VOC  P=([\d.]+) R=([\d.]+) AP50=([\d.]+)", text):
        out["voc"] = tuple(float(x) for x in m.groups())
    if m := re.search(r"(\d+) workers x (\d+) threads", text):
        out["layout"] = f"{m.group(1)} x {m.group(2)}"
    out["verdict"] = (
        "MATCH" if "MATCH: cv2.dnn" in text else ("MISMATCH" if "MISMATCH" in text else "?")
    )
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("dir", type=Path)
    ap.add_argument("--price", type=float, default=0.544, help="instance $/h (c6g.4xlarge)")
    ap.add_argument("--cool-price", type=float, default=0.04, help="COOL software $/h")
    args = ap.parse_args(argv)
    d = args.dir

    print(
        "| Env | OpenCV | s/photo, 1 process | ms/slice forward | s/photo, 4 processes "
        "| CPU % | VOC P / R / AP50 | published check | $ / 500 photos |"
    )
    print("|---|---|---|---|---|---|---|---|---|")
    for env in ENVS:
        bench_path = d / f"bench-{env}.json"
        if not bench_path.exists():
            continue
        b = json.loads(bench_path.read_text(encoding="utf-8"))
        r = _reproduce(d / f"reproduce-{env}.log")
        t = _time_file(d / f"time-reproduce-{env}.txt")
        s, f = b["seconds_per_photo"], b["ms_per_slice_forward"]
        wall = r.get("wall_s_per_photo")
        price = args.price + (args.cool_price if env == "cool" else 0.0)
        cost = f"${500 * wall / 3600 * price:.3f}" if isinstance(wall, float) else "?"
        voc = r.get("voc") or (b["voc"]["precision"], b["voc"]["recall"], b["voc"]["ap50"])
        print(
            f"| {env} | {b['opencv']} | {s[0]:.3f} ± {s[1]:.3f} | {f[0]:.1f} ± {f[1]:.1f} "
            f"| {wall if wall is not None else '?'} ({r.get('layout', '?')}) "
            f"| {t.get('cpu_pct', '?')} | {' / '.join(f'{x:.3f}' for x in voc)} "
            f"| {r.get('verdict', '?')} | {cost} |"
        )

    ip = {e: d / f"imgproc-{e}.json" for e in ENVS}
    ip = {e: json.loads(p.read_text(encoding="utf-8")) for e, p in ip.items() if p.exists()}
    if "cool" in ip and "pip" in ip:
        print()
        print(
            "| Call | COOL ms | pip ms | pip / COOL | pip5 ms | COOL 1 thread | pip 1 thread "
            "| pip / COOL, 1 thread | same pixels (COOL, pip) |"
        )
        print("|---|---|---|---|---|---|---|---|---|")
        for name in ip["cool"]["ops"]:
            c, p = ip["cool"]["ops"][name], ip["pip"]["ops"][name]
            p5 = ip.get("pip5", {}).get("ops", {}).get(name)
            cm, pm = c["default_threads"]["median_ms"], p["default_threads"]["median_ms"]
            c1, p1 = c["one_thread"]["median_ms"], p["one_thread"]["median_ms"]
            same = ip["cool"]["sha256_first_photo"].get(name) == ip["pip"][
                "sha256_first_photo"
            ].get(name)
            p5m = f"{p5['default_threads']['median_ms']:.3f}" if p5 else "?"
            print(
                f"| `{name}` | {cm:.3f} | {pm:.3f} | {pm / cm:.2f}x | {p5m} | {c1:.3f} | "
                f"{p1:.3f} | {p1 / c1:.2f}x | {'yes' if same else 'no'} |"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
