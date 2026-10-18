"""CLI: `python -m sightline.pipeline <command>`.

One command per stage (frames, place, detect, georef, rank, map, metrics, export), plus `run`,
`validate` and `sample`. Stages that need a lane function that does not exist yet use a placeholder
and say so.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Annotated

import click
import typer

from sightline.pipeline.export import CacheValidationError, validate_cache
from sightline.pipeline.lanes import Lanes
from sightline.pipeline.runner import STAGE_ORDER, StageFailed, run_pipeline
from sightline.pipeline.sample import write_sample
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

app = typer.Typer(no_args_is_help=True, add_completion=False)

DataOption = Annotated[Path, typer.Option(help="Folder with survey/ and work/ (and heridal/).")]
NFramesOption = Annotated[int, typer.Option(help="Frames in the survey.")]
NPositiveOption = Annotated[int, typer.Option(help="Frames that contain a person.")]
SeedOption = Annotated[int, typer.Option(help="Seed for every random choice.")]
LayoutOption = Annotated[
    str,
    typer.Option(
        help="Frame layout: 'shuffle' (random crops) or 'blocks' (neighbouring crops of a photo).",
        click_type=click.Choice(["shuffle", "blocks"]),
    ),
]
WeightsOption = Annotated[
    Path | None,
    typer.Option(help="Detector weights for lane A. Without them detect is a placeholder."),
]
ThresholdOption = Annotated[float, typer.Option(help="Candidate threshold for the review queue.")]
ModelNameOption = Annotated[str, typer.Option(help="Model name written to detections.json.")]
TestDirOption = Annotated[
    Path | None,
    typer.Option(help="HERIDAL test split (YOLO format). Default: <data>/heridal/yolo_full/test"),
]
OutOption = Annotated[Path, typer.Option(help="Where the cache is written.")]
SurveyIdOption = Annotated[str, typer.Option(help="survey_id in the cache files.")]
WebOutOption = Annotated[
    Path | None, typer.Option(help="Copy the cache here. Default: web/public/cache/<name of --out>")
]


def make_lanes() -> Lanes:
    """The lane functions the pipeline will use. Tests replace this."""
    return Lanes()


def _context(
    data: Path,
    n_frames: int,
    n_positive: int,
    seed: int,
    weights: Path | None,
    candidate_threshold: float,
    model_name: str,
    test_dir: Path | None,
    layout: str = "shuffle",
) -> Context:
    return Context(
        data=data,
        lanes=make_lanes(),
        n_frames=n_frames,
        n_positive=n_positive,
        seed=seed,
        weights=weights,
        candidate_threshold=candidate_threshold,
        model_name=model_name,
        test_dir=test_dir,
        layout=layout,
    )


def _report_placeholders(ctx: Context) -> None:
    for name, note in ctx.lanes.placeholder_notes().items():
        typer.echo(f"placeholder  {name}: {note}")


def _fail(message: str, code: int = 1) -> typer.Exit:
    typer.echo(message, err=True)
    return typer.Exit(code)


def _register_stage(name: str, function: Callable[[Context], None]) -> None:
    def command(
        data: DataOption = Path("data"),
        n_frames: NFramesOption = 500,
        n_positive: NPositiveOption = 6,
        seed: SeedOption = 7,
        weights: WeightsOption = None,
        candidate_threshold: ThresholdOption = 0.25,
        model_name: ModelNameOption = "yolo11s-heridal-tiled",
        test_dir: TestDirOption = None,
        layout: LayoutOption = "shuffle",
    ) -> None:
        ctx = _context(
            data,
            n_frames,
            n_positive,
            seed,
            weights,
            candidate_threshold,
            model_name,
            test_dir,
            layout,
        )
        try:
            function(ctx)
        except (FileNotFoundError, ValueError) as error:
            raise _fail(f"{name}: {error}") from error
        typer.echo(f"{name}: done")
        _report_placeholders(ctx)

    command.__name__ = name
    command.__doc__ = (function.__doc__ or "").strip().splitlines()[0]
    app.command(name=name)(command)


for _name, _function in (
    ("frames", frames_stage),
    ("place", place_stage),
    ("detect", detect_stage),
    ("georef", georef_stage),
    ("rank", rank_stage),
    ("map", map_stage),
    ("metrics", metrics_stage),
):
    _register_stage(_name, _function)


@app.command()
def export(
    data: DataOption = Path("data"),
    out: OutOption = Path("cache/demo"),
    survey_id: SurveyIdOption = "seymour-demo",
    web_out: WebOutOption = None,
) -> None:
    """Build, validate and write the cache (the `export` stage)."""
    ctx = _context(data, 500, 6, 7, None, 0.25, "", None)
    try:
        export_stage(ctx, out, survey_id=survey_id, web_out=web_out)
    except CacheValidationError as error:
        for line in error.errors:
            typer.echo(line, err=True)
        raise typer.Exit(1) from error
    except (FileNotFoundError, ValueError) as error:
        raise _fail(f"export: {error}") from error
    typer.echo(f"export: wrote {out}")
    _report_placeholders(ctx)


@app.command()
def run(
    data: DataOption = Path("data"),
    stages: Annotated[str, typer.Option(help="'all' or a comma-separated list of stages.")] = "all",
    skip: Annotated[
        str, typer.Option(help="Stages to skip, comma-separated (their files must exist).")
    ] = "",
    out: OutOption = Path("cache/demo"),
    survey_id: SurveyIdOption = "seymour-demo",
    web_out: WebOutOption = None,
    n_frames: NFramesOption = 500,
    n_positive: NPositiveOption = 6,
    seed: SeedOption = 7,
    weights: WeightsOption = None,
    candidate_threshold: ThresholdOption = 0.25,
    model_name: ModelNameOption = "yolo11s-heridal-tiled",
    test_dir: TestDirOption = None,
    layout: LayoutOption = "shuffle",
) -> None:
    """Run the chosen stages in order and write the cache and its manifest."""
    ctx = _context(
        data, n_frames, n_positive, seed, weights, candidate_threshold, model_name, test_dir, layout
    )
    chosen = "all" if stages == "all" else [s.strip() for s in stages.split(",") if s.strip()]
    skipped = [s.strip() for s in skip.split(",") if s.strip()]
    try:
        run_pipeline(
            ctx,
            stages=chosen,
            skip=skipped,
            out=out,
            survey_id=survey_id,
            web_out=web_out if web_out is not None else Path("web/public/cache") / out.name,
            echo=typer.echo,
        )
    except ValueError as error:  # a bad stage name
        raise _fail(str(error), code=2) from error
    except (StageFailed, CacheValidationError) as error:
        raise _fail(str(error)) from error
    _report_placeholders(ctx)
    if "export" in (STAGE_ORDER if chosen == "all" else chosen):
        typer.echo(f"wrote {out}")


@app.command()
def validate(path: Path) -> None:
    """Check a cache folder against contract section 11."""
    errors = validate_cache(path)
    for error in errors:
        typer.echo(error, err=True)
    if errors:
        raise typer.Exit(1)
    typer.echo(f"{path}: valid")


@app.command()
def sample(
    out: Path = Path("cache/sample"),
    web_out: Path = Path("web/public/cache/sample"),
    image: Annotated[
        list[Path] | None, typer.Option(help="Real photo to cut frames from (repeatable).")
    ] = None,
) -> None:
    """Regenerate the sample cache and copy it to the web app."""
    write_sample(out, web_out=web_out, images=image or [])
    typer.echo(f"wrote {out} and {web_out}")


@app.command()
def serve(
    host: Annotated[
        str, typer.Option(help="Interface to listen on. There is no login; keep it local.")
    ] = "127.0.0.1",
    port: Annotated[int, typer.Option(help="Port to listen on.")] = 8000,
    cache_root: Annotated[
        Path, typer.Option(help="Where upload caches are written and served from.")
    ] = Path("cache"),
    data_root: Annotated[
        Path, typer.Option(help="Where uploaded photos and work files are kept.")
    ] = Path("data/uploads"),
    weights: WeightsOption = None,
    candidate_threshold: ThresholdOption = 0.25,
    model_name: ModelNameOption = "yolo11s-heridal-tiled",
) -> None:
    """Run the upload API: POST a zip of JPEGs to /survey, get a cache back."""
    import uvicorn  # imported here so the other commands start without the web server stack

    from sightline.api.app import create_app

    api = create_app(
        cache_root=cache_root,
        data_root=data_root,
        lanes_factory=make_lanes,
        weights=weights,
        candidate_threshold=candidate_threshold,
        model_name=model_name,
    )
    uvicorn.run(api, host=host, port=port)


if __name__ == "__main__":
    app()
