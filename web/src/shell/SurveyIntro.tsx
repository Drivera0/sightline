import { useMemo } from "react";
import type { CacheBundle, Detection, Frame } from "../contract";
import { cacheUrl } from "../lib/cache";
import { Label } from "./components";
import { Sourced } from "./Popover";

/** "Mount Seymour, North Vancouver (simulated flight path)" -> "Mount Seymour, North Vancouver". */
export function placeName(areaName: string): string {
  return areaName.replace(/\s+\([^()]+\)\s*$/, "");
}

/**
 * Median width of the candidate boxes, in pixels, or null when there are none. Shows how small a
 * person is in these photos, measured from the detections rather than asserted.
 */
export function medianPersonPx(cache: Pick<CacheBundle, "detections">): number | null {
  const widths = Object.values(cache.detections.frames)
    .flat()
    .filter((d) => d.conf >= cache.detections.candidate_threshold)
    .map((d) => d.box_px[2] - d.box_px[0])
    .sort((x, y) => x - y);
  if (widths.length === 0) return null;
  const mid = Math.floor(widths.length / 2);
  return Math.round(widths.length % 2 ? (widths[mid] as number) : ((widths[mid - 1] as number) + (widths[mid] as number)) / 2);
}

/** A full HERIDAL photo, in pixels (the dataset's 4000×3000 camera frames; the survey cuts them up). */
export const FULL_PHOTO_PX = { w: 4000, h: 3000 } as const;

export interface IntroCopy {
  headline: string;
  /** Where the photos come from, said up front: real HERIDAL photos, cut into sections. */
  provenance: string;
  /** What is in them and what Sightline does with them. */
  body: string;
}

/**
 * The Survey hero's words, from the cache: how many photos, that they are sections of real
 * HERIDAL photos from Croatia, whether the flight path is simulated, and whether there is anything
 * to rank (on the real-GPS survey every photo has a person).
 */
export function introCopy(cache: Pick<CacheBundle, "manifest" | "survey" | "metrics">): IntroCopy {
  const n = cache.manifest.n_frames;
  const place = placeName(cache.survey.area.name);
  const first = cache.survey.frames[0];
  const w = first?.width_px ?? FULL_PHOTO_PX.w;
  const h = first?.height_px ?? FULL_PHOTO_PX.h;
  const isSection = w < FULL_PHOTO_PX.w || h < FULL_PHOTO_PX.h;
  const perPhoto = Math.round((FULL_PHOTO_PX.w / w) * (FULL_PHOTO_PX.h / h));
  // One noun on screen: "photos". Where they are sections of bigger photos, the provenance says so.
  const shortPlace = place.split(",")[0] ?? place;
  const headline = cache.survey.simulated_path
    ? `${n} photos from a simulated drone search over ${shortPlace}`
    : `${n} photos from ${place}, at their recorded positions`;
  const cut = isSection
    ? `, each a ${w}×${h} section of a ${FULL_PHOTO_PX.w}×${FULL_PHOTO_PX.h} original (${perPhoto} per original)`
    : "";
  const provenance = cache.survey.simulated_path
    ? `HERIDAL search-and-rescue photos from Croatia${cut}. Only the flight path over ${place} is simulated.`
    : `HERIDAL search-and-rescue photos from Croatia${cut}, placed at their recorded EXIF positions.`;
  const { n_positive: k, n_frames: nRanked } = cache.metrics.ranking;
  const body =
    k >= nRanked
      ? "Every photo in this survey contains a person, so there is nothing to rank: it shows the detector's pins and the search map on real positions."
      : "Somewhere in them are a few people, each a speck a few dozen pixels wide. Sightline's detector reads every photo, puts the likeliest people first, and keeps a live map of where else to look.";
  return { headline, provenance, body };
}

function Fact({ value, label, source }: { value: string; label: string; source: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dd className="font-mono text-headline text-text sm:text-display">
        <Sourced source={source}>{value}</Sourced>
      </dd>
      <dt className="text-small text-text-2">{label}</dt>
    </div>
  );
}

/** Seconds for one loop of each wall column: slow and slightly different, so nothing lines up. */
const WALL_SECONDS = [95, 80, 110, 88, 102, 84];
const WALL_COLUMNS = 6;
const WALL_PER_COLUMN = 9;

interface WallTileData {
  frame: Frame;
  hit: Detection | undefined;
}

/**
 * The photo wall behind the survey hero: every photo with a candidate (so the wall shows a few
 * orange boxes drifting past) topped up with photos spread over the flight, dealt into columns.
 */
export function wallColumns(cache: Pick<CacheBundle, "survey" | "detections">): WallTileData[][] {
  const threshold = cache.detections.candidate_threshold;
  const best = (frame: Frame) =>
    (cache.detections.frames[frame.id] ?? [])
      .filter((d) => d.conf >= threshold)
      .sort((x, y) => y.conf - x.conf)[0];
  const frames = [...cache.survey.frames].sort((x, y) => x.flight_index - y.flight_index);
  const want = WALL_COLUMNS * WALL_PER_COLUMN;
  const hits = frames.filter((f) => best(f) !== undefined);
  const rest = frames.filter((f) => best(f) === undefined);
  const fill = Math.max(0, want - hits.length);
  const spread = rest.filter((_, i) => rest.length <= fill || i % Math.ceil(rest.length / fill) === 0).slice(0, fill);
  const chosen = [...hits, ...spread].sort((x, y) => x.flight_index - y.flight_index).slice(0, want);
  const columns: WallTileData[][] = Array.from({ length: WALL_COLUMNS }, () => []);
  chosen.forEach((frame, i) => columns[i % WALL_COLUMNS]!.push({ frame, hit: best(frame) }));
  return columns.filter((c) => c.length > 0);
}

function WallTile({ tile, dir }: { tile: WallTileData; dir: string }) {
  const { frame, hit } = tile;
  const box = hit?.box_px;
  return (
    <div className="relative aspect-[4/3] w-full shrink-0 overflow-hidden rounded-md bg-surface-strong">
      <img src={cacheUrl(dir, frame.file)} alt="" loading="lazy" className="h-full w-full object-cover opacity-70" />
      {box && (
        <span
          className="absolute rounded-[5px] border-[1.5px] border-accent shadow-[0_0_16px_color-mix(in_srgb,var(--accent)_55%,transparent)]"
          style={{
            left: `${((box[0] - 14) / frame.width_px) * 100}%`,
            top: `${((box[1] - 14) / frame.height_px) * 100}%`,
            width: `${((box[2] - box[0] + 28) / frame.width_px) * 100}%`,
            height: `${((box[3] - box[1] + 28) / frame.height_px) * 100}%`,
          }}
        >
          <span className="absolute -top-5 left-0 rounded-full bg-accent px-1.5 py-px font-mono text-[10px] leading-tight text-bg">
            {hit.conf.toFixed(2)}
          </span>
        </span>
      )}
    </div>
  );
}

/** Step 1: the job. A wall of the real photos, the size of the job, and one action. */
export function SurveyIntro({
  cache,
  dir,
  onRank,
  onTour,
}: {
  cache: CacheBundle;
  dir: string;
  onRank: () => void;
  /** Starts the guided tour, for a viewer who doesn't know the keys. */
  onTour?: () => void;
}) {
  const { survey, manifest, metrics } = cache;
  const human = metrics.baseline_human;
  const columns = useMemo(() => wallColumns(cache), [cache]);
  const personPx = medianPersonPx(cache);
  const copy = introCopy(cache);
  return (
    <div className="relative flex h-full min-h-0 items-center overflow-hidden rounded-lg border border-border">
      {/* The real photos, on a slow scrolling wall: what a searcher would have to go through. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -right-[12%] -top-[30%] flex h-[160%] w-[78%] rotate-[-9deg] gap-3">
          {columns.map((column, c) => (
            <div key={c} className="relative min-w-0 flex-1 overflow-hidden">
              <div
                className={"sl-wall flex flex-col gap-3 " + (c % 2 ? "sl-wall-down" : "")}
                style={{ animationDuration: `${WALL_SECONDS[c % WALL_SECONDS.length]}s` }}
              >
                {/* Twice, so the loop is seamless at -50%. */}
                {[...column, ...column].map((tile, i) => (
                  <WallTile key={`${tile.frame.id}-${i}`} tile={tile} dir={dir} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="absolute inset-0 bg-gradient-to-r from-bg from-30% via-bg/80 via-55% to-bg/10" aria-hidden="true" />

      <div className="relative flex max-h-full w-full max-w-[46rem] flex-col gap-6 overflow-y-auto p-6 sm:p-10 xl:p-14">
        <Label className="sl-rise">Search and rescue · drone survey</Label>
        <h2 className="sl-rise text-headline font-semibold tracking-[-0.02em] sm:text-display" style={{ animationDelay: "80ms" }}>
          {copy.headline}
        </h2>
        <p className="sl-rise max-w-[38rem] text-body text-text-2 sm:text-lead" style={{ animationDelay: "160ms" }}>
          {copy.body} <span className="text-text-3">{copy.provenance}</span>
        </p>

        <dl className="sl-rise grid max-w-[38rem] grid-cols-3 gap-6" style={{ animationDelay: "220ms" }}>
          <Fact value={String(manifest.n_frames)} label="photos to check" source="manifest.n_frames" />
          {personPx !== null && (
            <Fact
              value={`${personPx} px`}
              label={`a person, in a ${survey.frames[0]?.width_px ?? ""} px wide photo`}
              source="Median width of the candidate boxes (detections.json)"
            />
          )}
          <Fact
            value={`${Math.round((1 - human.recall) * 100)}%`}
            label="of people missed by eye"
            source={`Human recall ${Math.round(human.recall * 100)}% (${human.source})`}
          />
        </dl>

        <div className="sl-rise flex flex-wrap items-center gap-3" style={{ animationDelay: "300ms" }}>
          <button
            type="button"
            onClick={onRank}
            autoFocus
            className="group inline-flex h-12 items-center gap-2 rounded-full bg-accent px-6 text-body font-medium text-bg shadow-[0_0_32px_-8px_var(--accent)] transition-[filter] hover:brightness-110"
          >
            Start: rank {manifest.n_frames} photos
            <svg viewBox="0 0 16 16" className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true">
              <path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {onTour && (
            <button
              type="button"
              onClick={onTour}
              className="group inline-flex h-12 items-center gap-2.5 rounded-full border border-border bg-surface px-5 text-body text-text backdrop-blur transition-colors hover:border-text-2 hover:bg-surface-strong"
            >
              <span className="inline-flex size-5 items-center justify-center rounded-full bg-accent/20 text-accent-soft" aria-hidden="true">
                <svg viewBox="0 0 16 16" className="size-2.5">
                  <path d="M5 3.5v9l7-4.5z" fill="currentColor" />
                </svg>
              </span>
              Watch 60-second tour
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
