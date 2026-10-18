import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import type { CacheBundle } from "../contract";
import { cacheUrl } from "../lib/cache";
import { prefersReducedMotion } from "../metrics/motion";
import {
  SPECK_DELAY_MS,
  initialSpeck,
  loupeRegion,
  loupeSide,
  speckLabel,
  speckReducer,
  speckTimeline,
  topCandidate,
  type SpeckPick,
  type SpeckTimeline,
} from "./speck";

/**
 * Wide enough for the card to sit right of the hero text (46rem) without covering it. Below this
 * (tablets, phones) there is no card and nothing plays.
 */
export const SPECK_MEDIA = "(min-width: 1100px)";

/** Once per page visit: going to Rank and back does not play it again (Replay still does). */
let playedThisVisit = false;
/** Tests only: forget that it played. */
export function resetSpeckVisit() {
  playedThisVisit = false;
}

function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
      const list = window.matchMedia(query);
      list.addEventListener?.("change", onChange);
      return () => list.removeEventListener?.("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches,
    () => false,
  );
}

const pct = (v: number, of: number) => `${(v / of) * 100}%`;
const at = (ms: number): CSSProperties => ({ animationDelay: `${ms}ms` });

/** The photo with the scan line, the box, the loupe and the label. `t` is null for the still version. */
function SpeckCard({
  pick,
  dir,
  t,
  hidden,
  onLoad,
}: {
  pick: SpeckPick;
  dir: string;
  t: SpeckTimeline | null;
  /** Mounted but invisible while the photo loads. */
  hidden: boolean;
  onLoad?: () => void;
}) {
  const { frame, detection } = pick;
  const label = speckLabel(pick);
  const [x1, y1, x2, y2] = detection.box_px;
  // The box drawn a little larger than the detection, like the Rank scanner's, so the person shows.
  const pad = Math.max(8, (x2 - x1) * 0.3);
  const bx1 = Math.max(0, x1 - pad);
  const by1 = Math.max(0, y1 - pad);
  const bx2 = Math.min(frame.width_px, x2 + pad);
  const by2 = Math.min(frame.height_px, y2 + pad);
  const cy = (y1 + y2) / 2;
  const side = loupeSide(pick);
  const region = loupeRegion(pick);
  const src = cacheUrl(dir, frame.file);
  const motion = t !== null;

  const anchor: CSSProperties =
    side === "right"
      ? { left: `calc(${pct(bx2, frame.width_px)} + 18px)` }
      : { right: `calc(${pct(frame.width_px - bx1, frame.width_px)} + 18px)` };

  return (
    <figure
      aria-label={`Top candidate in photo ${frame.id}: ${label.text}`}
      className={"relative m-0 " + (hidden ? "invisible" : motion ? "sl-speck-card" : "")}
      style={{
        width: `min(100cqw, 34rem, calc(100cqh * ${frame.width_px / frame.height_px}))`,
        aspectRatio: `${frame.width_px} / ${frame.height_px}`,
        ...(motion ? { animationDelay: `0ms, ${t.settleAt}ms` } : {}),
      }}
    >
      <div aria-hidden="true" className="absolute inset-0 overflow-hidden rounded-lg bg-bg shadow-[0_30px_80px_-24px_rgba(0,0,0,0.95)] ring-1 ring-border">
        <img src={src} alt="" onLoad={onLoad} className="absolute inset-0 h-full w-full object-cover" />
        {motion && (
          <span className="sl-speck-scan pointer-events-none absolute inset-0" style={{ ...at(t.scanAt), animationDuration: `${t.scanMs}ms` }}>
            <span className="sl-scan absolute inset-x-0 bottom-0" style={{ animation: "none" }} />
          </span>
        )}
      </div>
      {/* Above the photo, so the loupe never covers it. */}
      <span aria-hidden="true" className="absolute bottom-[calc(100%+8px)] left-1 font-mono text-label uppercase tracking-label text-text-3">
        Top-ranked candidate · <span className="normal-case">{frame.id}</span>
      </span>

      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        {/* The box: snaps on when the scan passes, its outline drawing itself. */}
        <span
          className={"absolute " + (motion ? "sl-box" : "")}
          style={{
            left: pct(bx1, frame.width_px),
            top: pct(by1, frame.height_px),
            width: pct(bx2 - bx1, frame.width_px),
            height: pct(by2 - by1, frame.height_px),
            ...(motion ? { ...at(t.boxAt), animationDuration: "420ms" } : {}),
          }}
        >
          <svg className="absolute inset-0 h-full w-full overflow-visible drop-shadow-[0_0_10px_color-mix(in_srgb,var(--accent)_70%,transparent)]">
            <rect
              x="0"
              y="0"
              width="100%"
              height="100%"
              rx="4"
              pathLength={1}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="2"
              className={motion ? "sl-draw" : ""}
              style={motion ? { ...at(t.boxAt + 60), animationDuration: "520ms" } : undefined}
            />
          </svg>
        </span>

        {/* A short leader from the box to the loupe. */}
        <span
          className={"absolute h-px w-[18px] bg-accent " + (motion ? "sl-fade" : "")}
          style={{
            top: pct(cy, frame.height_px),
            ...(side === "right"
              ? { left: pct(bx2, frame.width_px) }
              : { right: pct(frame.width_px - bx1, frame.width_px) }),
            ...(motion ? at(t.loupeAt) : {}),
          }}
        />

        {/* The loupe: the box area magnified, so the speck is visibly a person; the label under it. */}
        <div
          className={"absolute flex w-[clamp(148px,38%,196px)] flex-col gap-2 " + (motion ? "sl-pop" : "")}
          style={{
            ...anchor,
            top: `clamp(8px, calc(${pct(cy, frame.height_px)} - 6rem), calc(100% - 16rem))`,
            transformOrigin: side === "right" ? "left center" : "right center",
            ...(motion ? at(t.loupeAt) : {}),
          }}
        >
          <div className="relative aspect-square w-full overflow-hidden rounded-md bg-bg ring-2 ring-accent shadow-[0_18px_40px_-12px_rgba(0,0,0,0.9)]">
            <img
              src={src}
              alt=""
              className="absolute max-w-none"
              style={{
                width: `${(frame.width_px / region.side) * 100}%`,
                left: `${(-region.x / region.side) * 100}%`,
                top: `${(-region.y / region.side) * 100}%`,
              }}
            />
            <span
              className="absolute rounded-[4px] border-[1.5px] border-accent/80"
              style={{
                left: pct(x1 - region.x, region.side),
                top: pct(y1 - region.y, region.side),
                width: pct(x2 - x1, region.side),
                height: pct(y2 - y1, region.side),
              }}
            />
          </div>
          <div
            className={
              "flex w-max flex-col whitespace-nowrap rounded-md bg-bg/85 px-2.5 py-1.5 ring-1 ring-border backdrop-blur " +
              (side === "left" ? "self-end " : "") +
              (motion ? "sl-tag" : "")
            }
            style={motion ? at(t.labelAt) : undefined}
          >
            <span className="flex items-center gap-1.5 text-small font-medium text-text">
              <span className="size-1.5 shrink-0 rounded-full bg-accent" />
              {label.title}
            </span>
            <span className="font-mono text-label text-text-2">{label.size}</span>
          </div>
        </div>
      </div>
    </figure>
  );
}

/**
 * "Find the speck": about 1.7 s after the Survey page opens, the top-ranked candidate's photo comes
 * forward from the wall into a card right of the hero text, the scan line passes over it, the box
 * snaps onto the person and a loupe shows them up close, with the score and box size from the
 * cache. Then the card goes back into the wall and a quiet Replay stays. Once per page visit; still
 * (no animation) for reduced motion; nothing on narrow screens or without a candidate; quiet while
 * the guided tour runs.
 */
export function SpeckReveal({
  cache,
  dir,
  quiet = false,
}: {
  cache: Pick<CacheBundle, "survey" | "detections">;
  dir: string;
  /** Something else has the stage (the guided tour): stop, and don't start. */
  quiet?: boolean;
}) {
  const pick = useMemo(() => topCandidate(cache), [cache]);
  const timeline = useMemo(() => (pick ? speckTimeline(pick) : null), [pick]);
  const wide = useMediaQuery(SPECK_MEDIA);
  const [status, dispatch] = useReducer(speckReducer, undefined, () =>
    initialSpeck({ reducedMotion: prefersReducedMotion(), played: playedThisVisit }),
  );
  const [run, setRun] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const mountedAt = useRef(typeof performance === "undefined" ? 0 : performance.now());

  useEffect(() => {
    if (quiet) dispatch({ type: "quiet" });
  }, [quiet]);

  // First play: once the photo is in and the page has had a moment.
  useEffect(() => {
    if (status !== "waiting" || !loaded || !wide || quiet || !pick) return;
    const wait = Math.max(0, SPECK_DELAY_MS - (performance.now() - mountedAt.current));
    const id = window.setTimeout(() => dispatch({ type: "start" }), wait);
    return () => window.clearTimeout(id);
  }, [status, loaded, wide, quiet, pick]);

  useEffect(() => {
    if (status === "playing") playedThisVisit = true;
  }, [status]);

  useEffect(() => {
    if (status !== "playing" || !timeline) return;
    const id = window.setTimeout(() => dispatch({ type: "ended" }), timeline.endAt);
    return () => window.clearTimeout(id);
  }, [status, timeline, run]);

  if (!pick || !timeline || !wide) return null;

  const replay = () => {
    setRun((r) => r + 1);
    dispatch({ type: "replay" });
  };

  return (
    <>
      <div
        className="pointer-events-none absolute inset-y-0 left-[46rem] right-0 hidden items-center justify-center p-8 pr-10 min-[1100px]:flex"
        style={{ containerType: "size" }}
        data-testid="speck"
        data-status={status}
      >
        {status === "waiting" && <SpeckCard pick={pick} dir={dir} t={null} hidden onLoad={() => setLoaded(true)} />}
        {status === "playing" && <SpeckCard key={run} pick={pick} dir={dir} t={timeline} hidden={false} />}
        {status === "still" && <SpeckCard pick={pick} dir={dir} t={null} hidden={false} />}
      </div>
      {(status === "playing" || status === "rest") && !quiet && (
        <button
          type="button"
          onClick={status === "playing" ? () => dispatch({ type: "ended" }) : replay}
          aria-label={status === "playing" ? "Skip the detection preview" : "Replay the detection preview"}
          className="sl-fade absolute bottom-4 right-4 hidden h-8 items-center gap-1.5 rounded-full border border-border bg-bg/70 px-3 text-small text-text-3 backdrop-blur transition-colors hover:border-text-2 hover:text-text min-[1100px]:inline-flex"
        >
          {status === "playing" ? (
            "Skip"
          ) : (
            <>
              <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden="true">
                <path d="M3.5 8a4.5 4.5 0 1 0 1.4-3.3M3.5 2.5v2.6h2.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Replay
            </>
          )}
        </button>
      )}
    </>
  );
}
