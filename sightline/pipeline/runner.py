"""`run`: the eight stages in order, with timings, skips and the manifest (LANE_D section 6.2)."""

from __future__ import annotations

import subprocess
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

from sightline.contract import Manifest, StageResult, Stages, dump_json
from sightline.pipeline.stages import (
    Context,
    detect_stage,
    export_stage,
    frames_stage,
    georef_stage,
    map_stage,
    metrics_stage,
    place_stage,
    rank_stage,
)

STAGE_ORDER = ("frames", "place", "detect", "georef", "rank", "map", "metrics", "export")
_STAGE_FUNCTIONS: dict[str, Callable[[Context], None]] = {
    "frames": frames_stage,
    "place": place_stage,
    "detect": detect_stage,
    "georef": georef_stage,
    "rank": rank_stage,
    "map": map_stage,
    "metrics": metrics_stage,
}


class StageFailed(RuntimeError):
    def __init__(self, stage: str, cause: BaseException) -> None:
        self.stage = stage
        super().__init__(f"stage `{stage}` failed: {cause}")


@dataclass(frozen=True)
class StageRun:
    stage: str
    seconds: float
    skipped: bool = False


def current_git_sha(cwd: Path | None = None) -> str | None:
    """Short hash of HEAD, or None when `cwd` is not in a Git repository."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=cwd,
            capture_output=True,
            text=True,
            check=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    return result.stdout.strip() or None


def _check_names(names: Sequence[str], what: str) -> None:
    unknown = [n for n in names if n not in STAGE_ORDER]
    if unknown:
        raise ValueError(
            f"unknown {what} {', '.join(unknown)}; valid stages: {', '.join(STAGE_ORDER)}"
        )


def run_pipeline(
    ctx: Context,
    stages: Sequence[str] | str = "all",
    skip: Sequence[str] = (),
    out: Path = Path("cache/demo"),
    survey_id: str = "seymour-demo",
    web_out: Path | None = None,
    git_sha: str | None = None,
    echo: Callable[[str], None] = lambda line: None,
    clock: Callable[[], float] = time.perf_counter,
) -> list[StageRun]:
    """Run the chosen stages in pipeline order. A stage in `skip` is not run: it is recorded as
    {ok: true, seconds: 0.0} and named in the manifest notes (its files must already exist).

    The manifest is written by the `export` stage, so it only exists when `export` ran. A failing
    stage stops the run with `StageFailed`.
    """
    chosen = list(STAGE_ORDER) if stages == "all" else list(stages)
    _check_names(chosen, "stage")
    _check_names(skip, "skipped stage")
    git_sha = git_sha or current_git_sha()

    results: list[StageRun] = []
    notes: list[str] = []
    for stage in STAGE_ORDER:
        if stage not in chosen:
            continue
        if stage in skip:
            results.append(StageRun(stage, 0.0, skipped=True))
            notes.append(f"{stage} skipped: used the files already in the work folder.")
            echo(f"{stage}: skipped")
            continue
        started = clock()
        try:
            if stage == "export":
                _export(ctx, results, notes, out, survey_id, web_out, git_sha)
            else:
                _STAGE_FUNCTIONS[stage](ctx)
        except StageFailed:
            raise
        except Exception as error:
            raise StageFailed(stage, error) from error
        seconds = clock() - started
        results.append(StageRun(stage, seconds))
        echo(f"{stage}: done in {seconds:.1f} s")
        if stage == "export":
            _record_export_time(seconds, out, web_out)
    return results


def _export(
    ctx: Context,
    results: list[StageRun],
    notes: list[str],
    out: Path,
    survey_id: str,
    web_out: Path | None,
    git_sha: str | None,
) -> None:
    done = {r.stage: r.seconds for r in results}
    not_run = [s for s in STAGE_ORDER[:-1] if s not in done]
    extra = list(notes)
    if not_run:
        extra.append(f"Stages not run in this invocation: {', '.join(not_run)}.")
    export_stage(
        ctx,
        out,
        survey_id=survey_id,
        web_out=web_out,
        stages=Stages(**{s: StageResult(ok=True, seconds=done.get(s, 0.0)) for s in STAGE_ORDER}),
        git_sha=git_sha,
        extra_notes=extra,
    )


def _record_export_time(seconds: float, out: Path, web_out: Path | None) -> None:
    """The manifest is written before `export` finishes, so add the time it took afterwards."""
    for folder in (out, web_out):
        if folder is None:
            continue
        path = folder / "manifest.json"
        manifest = Manifest.model_validate_json(path.read_text())
        manifest.stages.export = StageResult(ok=True, seconds=seconds)
        path.write_text(dump_json(manifest))
