"""Results of a batch job read back from its logs (stdin): the JSON between `=== sightline-result
<name>` and `=== sightline-result end` (scripts/nebius_batch_detect.py --print-results) is written to
OUT_DIR/<name>. Used by run_job.sh."""

import json
import pathlib
import sys

MARK = "=== sightline-result "


def main() -> int:
    out = pathlib.Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    name = None
    for line in sys.stdin:
        i = line.find(MARK)
        if i >= 0:
            tag = line[i + len(MARK) :].strip()
            name = None if tag == "end" else tag
        elif name:
            j = line.find("{")  # the CLI may put a timestamp before each log line
            (out / name).write_text(json.dumps(json.loads(line[j:]), indent=1) + "\n")
            name = None
    missing = [f for f in ("detections_raw.json", "job_summary.json") if not (out / f).is_file()]
    if missing:
        print(f"not found in the logs: {missing}", file=sys.stderr)
        return 1
    print((out / "job_summary.json").read_text())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
