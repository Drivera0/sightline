"""CLI: `python -m sightline.pipeline <command>`. Only `sample` and `validate` exist so far."""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import typer

from sightline.pipeline.export import validate_cache
from sightline.pipeline.sample import write_sample

app = typer.Typer(no_args_is_help=True, add_completion=False)


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
def validate(path: Path) -> None:
    """Check a cache folder against contract section 11."""
    errors = validate_cache(path)
    for error in errors:
        typer.echo(error, err=True)
    if errors:
        raise typer.Exit(1)
    typer.echo(f"{path}: valid")


if __name__ == "__main__":
    app()
