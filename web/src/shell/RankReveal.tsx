import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CacheBundle, Detection, Frame } from "../contract";
import { cacheUrl } from "../lib/cache";
import { prefersReducedMotion } from "../metrics/motion";
import { queueCounts, reviewItems, type ReviewItem } from "../review/items";
import { Badge, Label } from "./components";
import { ModelPanel, ScoreStrip } from "./ModelPanel";
import { framesInFlightOrder, scanStops, stopMs } from "./scan";

/** Queue rows shown before "+N more": all of them on wide screens (three columns), fewer below. */
const QUEUE_ROWS = 6;
const QUEUE_ROWS_NARROW = 4;
/** No boxes: one shared empty list, so the memoised detector panel is not re-rendered for nothing. */
const NO_BOXES: Detection[] = [];

function ordinal(n: number): string {
  return n === 1 ? "first" : `#${n}`;
}

/** Eases from the previous value to `target` over `ms` (integer steps); instant under reduced motion. */
function useGlide(target: number, ms: number): number {
  const [value, setValue] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    if (prefersReducedMotion()) {
      from.current = target;
      setValue(target);
      return;
    }
    const start = performance.now();
    const origin = from.current;
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const eased = 1 - (1 - t) ** 3;
      const next = Math.round(origin + (target - origin) * eased);
      from.current = next;
      setValue(next);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);
  return value;
}

/** Slide rows to their new place when the queue re-sorts (FLIP), instead of jumping. */
function useFlip(order: string) {
  const nodes = useRef(new Map<string, HTMLElement>());
  const last = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const next = new Map<string, number>();
    nodes.current.forEach((el, key) => {
      const top = el.getBoundingClientRect().top;
      next.set(key, top);
      const before = last.current.get(key);
      if (before !== undefined && before !== top && !prefersReducedMotion()) {
        el.animate?.([{ transform: `translateY(${before - top}px)` }, { transform: "none" }], {
          duration: 380,
          easing: "cubic-bezier(0.2, 0.7, 0.2, 1)",
        });
      }
    });
    last.current = next;
  }, [order]);
  return useCallback(
    (key: string) => (el: HTMLElement | null) => {
      if (el) nodes.current.set(key, el);
      else nodes.current.delete(key);
    },
    [],
  );
}

/**
 * One box on a photo, in percent of the frame so it stays put at any size. The tag is fixed-size
 * text (not scaled with the photo), above the box, below it near the top edge, and right-aligned
 * near the right edge, so it never leaves the photo.
 */
function BoxOverlay({ frame, detection, kind, threshold }: { frame: Frame; detection: Detection; kind: "hit" | "rejected"; threshold: number }) {
  const [x1, y1, x2, y2] = detection.box_px;
  const pad = Math.max(10, (x2 - x1) * 0.3);
  const left = (Math.max(0, x1 - pad) / frame.width_px) * 100;
  const top = (Math.max(0, y1 - pad) / frame.height_px) * 100;
  const right = (Math.min(frame.width_px, x2 + pad) / frame.width_px) * 100;
  const bottom = (Math.min(frame.height_px, y2 + pad) / frame.height_px) * 100;
  const tagBelow = top < 12;
  const tagRight = left > 68;
  const hit = kind === "hit";
  return (
    <div
      className={"sl-box absolute rounded-[8px] " + (hit ? "border-2 border-accent shadow-[0_0_0_4px_color-mix(in_srgb,var(--accent)_18%,transparent),0_0_28px_color-mix(in_srgb,var(--accent)_45%,transparent)]" : "border border-dashed border-text/70")}
      style={{ left: `${left}%`, top: `${top}%`, width: `${right - left}%`, height: `${bottom - top}%` }}
    >
      <span
        className={
          "sl-tag absolute flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[12px] font-medium leading-none shadow-[0_6px_16px_-6px_rgba(0,0,0,0.8)] " +
          (hit ? "bg-accent text-bg" : "bg-bg/85 text-text-2 ring-1 ring-border backdrop-blur") +
          (tagBelow ? " top-[calc(100%+6px)]" : " bottom-[calc(100%+6px)]") +
          (tagRight ? " right-0" : " left-0")
        }
      >
        {hit ? (
          <>
            <span className="size-1.5 rounded-full bg-bg/70" aria-hidden="true" />
            Person
            <span className="font-mono opacity-80">{detection.conf.toFixed(2)}</span>
          </>
        ) : (
          <>
            <span className="font-mono">{detection.conf.toFixed(2)}</span>
            <span className="text-text-3">below {threshold}</span>
          </>
        )}
      </span>
    </div>
  );
}

/** A photo with the detector's boxes on it: candidates in orange, rejected look-alikes dashed grey. */
function ScanFrame({
  frame,
  hits,
  rejected,
  threshold,
  dir,
  scanMs,
  onLoad,
}: {
  frame: Frame;
  hits: Detection[];
  rejected: Detection[];
  threshold: number;
  dir: string;
  /** Length of the scan-line sweep; 0 for none. */
  scanMs: number;
  /** The photo has loaded (the caption waits for it, so the two never disagree). */
  onLoad?: () => void;
}) {
  return (
    <div className="relative h-full w-full overflow-hidden rounded-md bg-surface-strong">
      <img
        src={cacheUrl(dir, frame.file)}
        alt={`Frame ${frame.id}`}
        onLoad={onLoad}
        className="absolute inset-0 h-full w-full object-cover"
      />
      {rejected.map((d) => (
        <BoxOverlay key={d.id} frame={frame} detection={d} kind="rejected" threshold={threshold} />
      ))}
      {hits.map((d) => (
        <BoxOverlay key={d.id} frame={frame} detection={d} kind="hit" threshold={threshold} />
      ))}
      {scanMs > 0 && (
        <span
          aria-hidden="true"
          className="sl-scan pointer-events-none absolute inset-x-0"
          style={{ animationDuration: `${scanMs}ms` }}
        />
      )}
    </div>
  );
}

/**
 * Step 2: the rank moment, shown as the model working. The scanner runs through the photos in
 * flight order (every photo with a candidate, plus a spread of empty ones); each candidate gets its
 * box and confidence drawn on and drops into the review queue, which re-sorts by confidence as it
 * fills. Then the headline from metrics.ranking. Reduced motion skips straight to the result.
 */
export function RankReveal({
  cache,
  dir,
  onStart,
}: {
  cache: CacheBundle;
  dir: string;
  onStart: () => void;
}) {
  const { survey, metrics } = cache;
  const items = useMemo(() => reviewItems(cache), [cache]);
  // A photo can hold two boxes: Review counts boxes, so say both here too.
  const counts = queueCounts(items);
  const stops = useMemo(() => scanStops(cache), [cache]);
  const nFrames = survey.frames.length;
  const inFlightOrder = useMemo(() => framesInFlightOrder(cache), [cache]);
  const flaggedPositions = useMemo(() => {
    const flagged = new Set<number>();
    inFlightOrder.forEach((f, i) => {
      if (f.n_candidates > 0) flagged.add(i);
    });
    return flagged;
  }, [inFlightOrder]);
  const positionOf = useMemo(() => new Map(inFlightOrder.map((f, i) => [f.id, i] as const)), [inFlightOrder]);

  // stop = index into `stops` while scanning; stops.length means done.
  const [stop, setStop] = useState(() => (prefersReducedMotion() ? stops.length : 0));
  const done = stop >= stops.length;
  const current = stops[Math.min(stop, stops.length - 1)];

  useEffect(() => {
    if (done || !current) return;
    const timer = window.setTimeout(() => setStop((s) => s + 1), stopMs(current));
    return () => window.clearTimeout(timer);
  }, [stop, done, current]);

  // Warm the browser cache so the scanner never waits on a photo.
  useEffect(() => {
    for (const s of stops) new Image().src = cacheUrl(dir, s.frame.file);
  }, [stops, dir]);

  // Focus "Start review" when the result is in, without scrolling the queue away from #1.
  const startButton = useRef<HTMLButtonElement>(null);
  const queueColumn = useRef<HTMLDivElement>(null);
  const [showModel, setShowModel] = useState(false);
  useEffect(() => {
    if (!done) return;
    startButton.current?.focus({ preventScroll: true });
    queueColumn.current?.scrollTo?.({ top: 0 });
  }, [done]);

  const scannedTo = useGlide(done ? nFrames - 1 : (current?.position ?? 0), done ? 900 : 650);
  const previous = !done && stop > 0 ? stops[stop - 1] : undefined;
  const found: ReviewItem[] = done
    ? items
    : items.filter((item) => (positionOf.get(item.frame.id) ?? Infinity) <= scannedTo);
  const flaggedSoFar = [...flaggedPositions].filter((p) => p <= scannedTo).length;
  const shown = found.slice(0, QUEUE_ROWS);
  const flip = useFlip(shown.map((i) => i.id).join("|"));

  const ranking = metrics.ranking;
  const firstHit = ranking.ranked.frames_to_first_hit;
  const lead = items[0];
  const source = `Demo survey, ${ranking.n_frames} frames (metrics.ranking)`;
  const viewer = done ? (lead ? { frame: lead.frame, hits: [lead.detection], rejected: [] } : undefined) : current;
  const threshold = cache.detections.candidate_threshold;
  const aspect = viewer ? viewer.frame.width_px / viewer.frame.height_px : 4 / 3;
  // The caption follows the photo on screen: it changes when the new photo has loaded, not before.
  const [loaded, setLoaded] = useState<typeof viewer>(undefined);
  const caption = done || !loaded ? viewer : loaded;

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-4 overflow-y-auto lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)] lg:overflow-visible">
      {/* The scanner. */}
      <div className="flex min-h-0 flex-col gap-3 rounded-lg border border-border bg-surface p-4">
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2">
            <span aria-hidden="true" className={"size-2 rounded-full " + (done ? "bg-ok" : "sl-blink bg-accent")} />
            <Label>{done ? "Every photo scored" : "Detector scanning photos in flight order"}</Label>
          </span>
          <span className="whitespace-nowrap font-mono text-small text-text-2">
            <span className="text-text">{scannedTo + 1}</span> / {nFrames} ·{" "}
            <span className="text-accent-soft">{flaggedSoFar} flagged</span>
          </span>
        </div>

        <div className="flex min-h-0 flex-1 items-center justify-center">
          <div
            className={
              "relative max-h-full w-full rounded-md " +
              (viewer && viewer.hits.length > 0 ? "sl-glow" : "")
            }
            key={viewer && viewer.hits.length > 0 ? `glow-${viewer.frame.id}` : "viewer"}
            style={{ aspectRatio: aspect, maxWidth: `calc((100vh - 15rem) * ${aspect})` }}
          >
            {previous && (
              <div className="absolute inset-0" aria-hidden="true">
                <ScanFrame frame={previous.frame} hits={[]} rejected={[]} threshold={threshold} dir={dir} scanMs={0} />
              </div>
            )}
            {viewer && (
              <div key={done ? "done" : viewer.frame.id} className="sl-xfade absolute inset-0">
                <ScanFrame
                  frame={viewer.frame}
                  hits={viewer.hits}
                  rejected={viewer.rejected}
                  threshold={threshold}
                  dir={dir}
                  scanMs={done || !current ? 0 : Math.min(900, stopMs(current))}
                  onLoad={() => setLoaded(viewer)}
                />
              </div>
            )}
            <div className="pointer-events-none absolute inset-x-3 bottom-3 flex items-center justify-between gap-3 font-mono text-label">
              <span className="rounded-full bg-bg/75 px-2.5 py-1 text-text-2 backdrop-blur">
                {caption?.frame.id} · photo {(caption ? (positionOf.get(caption.frame.id) ?? 0) : 0) + 1}
              </span>
              {caption && caption.hits.length > 0 ? (
                <span className="rounded-full bg-accent px-2.5 py-1 text-bg">Flagged for review</span>
              ) : caption && caption.rejected.length > 0 ? (
                <span className="rounded-full bg-bg/80 px-2.5 py-1 text-text-2 backdrop-blur">
                  Looked closer, scored below {threshold}: not flagged
                </span>
              ) : (
                <span className="rounded-full bg-bg/75 px-2.5 py-1 text-text-3 backdrop-blur">Nothing flagged</span>
              )}
            </div>
          </div>
        </div>

        {/* The detector's scores for this photo, under it. */}
        <ScoreStrip
          cache={cache}
          boxes={viewer ? (cache.detections.frames[viewer.frame.id] ?? NO_BOXES) : NO_BOXES}
          done={done}
          className="hidden lg:flex"
        />

        {/* The whole flight as a barcode: one bar per photo, flagged ones tall and orange. */}
        <div className="flex h-7 items-end gap-px" aria-hidden="true">
          {Array.from({ length: nFrames }, (_, i) => {
            const scanned = i <= scannedTo;
            const flagged = flaggedPositions.has(i);
            return (
              <span
                key={i}
                className={
                  "flex-1 rounded-[1px] transition-[height,background-color] duration-300 " +
                  (!scanned ? "h-1.5 bg-surface-strong" : flagged ? "h-full bg-accent" : "h-2.5 bg-text-3/50")
                }
              />
            );
          })}
        </div>
      </div>

      {/* The queue, building as the detector finds candidates, then the answer; the detector's
          architecture waits behind a disclosure below it. */}
      <div ref={queueColumn} className="flex min-h-0 flex-col gap-4 lg:overflow-y-auto">
        <div className="flex flex-col gap-4">
          {done ? (
            <div className="sl-rise flex flex-col gap-2">
              <Label>Ranked review queue</Label>
              <h2 className="text-headline font-semibold" title={source}>
                {firstHit === 1 ? "Person in the first photo you see" : `First person at photo ${ordinal(firstHit)}`}
              </h2>
              <p className="text-body text-text-2" title={source}>
                <span data-testid="rank-counts">
                  {counts.photos} of {nFrames} photos flagged for review · {counts.boxes} {counts.boxes === 1 ? "box" : "boxes"}
                </span>
                . In random order you would expect to
                look at about{" "}
                <span className="font-mono text-text">{Math.round(ranking.expected_first_hit_random_order)}</span>{" "}
                before the first person.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <Label>Ranked review queue</Label>
              <h2 className="text-headline font-semibold text-text-2">Most likely people first</h2>
              <p className="text-body text-text-3">Each candidate is placed by the detector&apos;s confidence.</p>
            </div>
          )}

          <ol className="flex flex-col gap-1.5" aria-label="Ranked candidates">
            {shown.map((item, i) => (
              <li
                key={item.id}
                ref={flip(item.id)}
                className={
                  "sl-pop items-center gap-3 rounded-sm border p-2 transition-colors duration-300 " +
                  (i >= QUEUE_ROWS_NARROW ? "hidden lg:flex " : "flex ") +
                  (i === 0 ? "border-accent/60 bg-accent/10" : "border-border bg-surface")
                }
              >
                <span className="w-5 text-right font-mono text-small text-text-3">{i + 1}</span>
                {item.detection.crop && (
                  <img
                    src={cacheUrl(dir, item.detection.crop)}
                    alt={`Candidate ${i + 1}, frame ${item.frame.id}`}
                    className="size-12 rounded-[8px] object-cover"
                  />
                )}
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="font-mono text-small text-text">{item.frame.id}</span>
                  <span className="h-1 w-full overflow-hidden rounded-full bg-surface-strong">
                    <span
                      className="block h-full rounded-full bg-accent"
                      style={{ width: `${Math.round(item.detection.conf * 100)}%` }}
                    />
                  </span>
                </span>
                <span className="font-mono text-small text-accent-soft">{item.detection.conf.toFixed(2)}</span>
              </li>
            ))}
            {found.length > QUEUE_ROWS_NARROW && (
              <li className="px-2 font-mono text-label text-text-3 lg:hidden">
                + {found.length - QUEUE_ROWS_NARROW} more in the queue
              </li>
            )}
            {found.length > QUEUE_ROWS && (
              <li className="hidden px-2 font-mono text-label text-text-3 lg:block">
                + {found.length - QUEUE_ROWS} more in the queue
              </li>
            )}
            {found.length === 0 && <li className="px-2 text-small text-text-3">Waiting for the first candidate…</li>}
          </ol>

          <div className="flex flex-wrap items-center gap-3">
            {done ? (
              <>
                <button
                  ref={startButton}
                  type="button"
                  onClick={onStart}
                  className="sl-rise inline-flex h-12 items-center gap-2 rounded-full bg-accent px-6 text-body font-medium text-bg transition-[filter] hover:brightness-110"
                >
                  Start review <span aria-hidden="true">→</span>
                </button>
                {stops.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setStop(0)}
                    className="rounded-full px-4 py-3 text-small text-text-2 transition-colors hover:bg-surface-strong hover:text-text"
                  >
                    Replay scan
                  </button>
                )}
              </>
            ) : (
              <button
                type="button"
                onClick={() => setStop(stops.length)}
                className="rounded-full border border-border px-4 py-2 text-small text-text-2 transition-colors hover:text-text"
              >
                Skip animation
              </button>
            )}
            {cache.detections.model === "SAMPLE" && <Badge kind="placeholder">Sample data</Badge>}
          </div>
        </div>

        <div className="flex flex-col gap-3 border-t border-border pt-3">
          <button
            type="button"
            aria-expanded={showModel}
            onClick={() => setShowModel((v) => !v)}
            className="group inline-flex w-fit items-center gap-3 rounded-full border border-border bg-surface py-2 pl-2 pr-4 text-left transition-colors hover:border-accent/60 hover:bg-surface-strong"
          >
            <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent-soft" aria-hidden="true">
              <svg viewBox="0 0 16 16" className="size-4">
                <path d="M2 4h3v8H2zM6.5 2.5h3v11h-3zM11 5.5h3v5h-3z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
              </svg>
            </span>
            <span className="flex flex-col">
              <span className="text-body font-medium text-text">How the detector works</span>
              <span className="text-small text-text-3">Every layer of the model, and what it sees in this photo</span>
            </span>
            <span aria-hidden="true" className={"ml-1 text-text-2 transition-transform group-hover:text-accent-soft " + (showModel ? "rotate-90" : "")}>
              ›
            </span>
          </button>
          {showModel && (
            <ModelPanel
              cache={cache}
              dir={dir}
              frame={viewer?.frame}
              boxes={viewer ? (cache.detections.frames[viewer.frame.id] ?? NO_BOXES) : NO_BOXES}
              pulseKey={done ? "done" : `${stop}-${viewer?.frame.id ?? ""}`}
              stopMs={current ? stopMs(current) : 0}
              done={done}
            />
          )}
        </div>
      </div>
    </div>
  );
}
