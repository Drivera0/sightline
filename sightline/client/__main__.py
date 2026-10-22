"""``python -m sightline.client replay|watch`` (LANE_B §4): see ``sightline/client/__init__.py``.
``conditions --gust 50`` is the demo's conditions override (``POST /conditions/override``)."""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import httpx
import typer

from sightline.client import REPLAY_NAME, VAL_PHOTOS, Watcher, real_gps_photos, replay

app = typer.Typer(add_completion=False, help="Send drone photos to a Sightline API.")
TIMEOUT = httpx.Timeout(60.0, connect=10.0)


@app.command("replay")
def replay_cmd(
    api: Annotated[str, typer.Option(help="API base URL")],
    source: Annotated[
        str, typer.Option(help="real-gps: HERIDAL photos at their recorded GPS")
    ] = "real-gps",
    photos: Annotated[Path, typer.Option(help="folder of validation photos")] = VAL_PHOTOS,
    pace: Annotated[float, typer.Option(help="seconds between photos")] = 2.0,
    name: Annotated[str, typer.Option()] = REPLAY_NAME,
    mission: Annotated[str | None, typer.Option(help="resume this mission")] = None,
    limit: Annotated[int | None, typer.Option()] = None,
) -> None:
    """A real flight through the live API at drone pace (the demo)."""
    if source != "real-gps":
        raise typer.BadParameter("the only source is real-gps", param_hint="--source")
    with httpx.Client(base_url=api, timeout=TIMEOUT) as http:
        mid = replay(
            http, real_gps_photos(photos), pace=pace, mission_id=mission, name=name, limit=limit
        )
    typer.echo(f"done: mission {mid}")


@app.command("watch")
def watch_cmd(
    folder: Path,
    api: Annotated[str, typer.Option(help="API base URL")],
    mission: Annotated[str | None, typer.Option()] = None,
    name: Annotated[str | None, typer.Option(help="a new mission's name")] = None,
    interval: Annotated[float, typer.Option()] = 2.0,
    batch: Annotated[int, typer.Option(max=10)] = 10,
) -> None:
    """Upload photos as they land in FOLDER (the command-post laptop)."""
    if not folder.is_dir():
        raise typer.BadParameter(f"{folder} is not a folder", param_hint="FOLDER")
    with httpx.Client(base_url=api, timeout=TIMEOUT) as http:
        try:
            Watcher(http, folder, mission_id=mission, name=name, batch=batch).run(interval)
        except ValueError as e:
            raise typer.BadParameter(str(e)) from e
        except KeyboardInterrupt:
            typer.echo("stopped")


@app.command("conditions")
def conditions_cmd(
    api: Annotated[str, typer.Option(help="API base URL")],
    mission: Annotated[str, typer.Option()],
    gust: Annotated[float | None, typer.Option(help="km/h: a demo override (labelled so)")] = None,
    wind: Annotated[float | None, typer.Option(help="km/h, with --gust")] = None,
    real: Annotated[bool, typer.Option(help="look the real conditions up again (Tavily)")] = False,
) -> None:
    """Demo only: ``--gust 50`` puts in a conditions record labelled "override (demo)" (the agent
    recalls flying drones when it is over their limit); ``--real`` refreshes from Tavily."""
    from sightline.client import _call

    if (gust is None) == (not real):
        raise typer.BadParameter("give --gust KMH or --real")
    with httpx.Client(base_url=api, timeout=TIMEOUT) as http:
        if real:
            c = _call(http, "POST", f"/missions/{mission}/conditions/refresh").json()
        else:
            body = {"gust_kmh": gust, "wind_kmh": wind, "by": "demo (CLI)"}
            c = _call(http, "POST", f"/missions/{mission}/conditions/override", json=body).json()
    typer.echo(f"{c['sources']}: flyable {c['flyable']}: {c['flyability_reason']}")


if __name__ == "__main__":
    app()
