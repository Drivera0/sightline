import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CacheBundle, Detection, Frame } from "../contract";
import { cacheUrl } from "../lib/cache";
import { prefersReducedMotion } from "../metrics/motion";
import { reviewItems, type ReviewItem } from "../review/items";
import { Badge, Label } from "./components";
import { CLEAR_MS, HIT_MS, framesInFlightOrder, scanStops } from "./scan";

/** Queue rows shown before "+N more". */
const QUEUE_ROWS = 6;

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

/** A photo with its candidate boxes drawn on, each labelled with the detector's confidence. */
function ScanFrame({
  frame,
  hits,
  dir,
  scanMs,
}: {
  frame: Frame;
  hits: Detection[];
  dir: string;
  /** Length of the scan-line sweep; 0 for none. */
  scanMs: number;
}) {
  const w = frame.width_px;
  const h = frame.height_px;
  return (
    <div className="relative h-full w-full overflow-hidden rounded-md bg-surface-strong">
      <img src={cacheUrl(dir, frame.file)} alt={`Frame ${frame.id}`} className="absolute inset-0 h-full w-full object-cover" />
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid slice" className="absolute inset-0 h-full w-full" aria-hidden="true">
        {hits.map((d) => {
          const [x1, y1, x2, y2] = d.box_px;
          const pad = Math.max(8, (x2 - x1) * 0.25);
          // The tag sits above the box, or below it when the person is near the top edge.
          const tagH = w / 32;
          const tagY = y1 - pad - tagH - 4 >= 0 ? y1 - pad - tagH - 4 : y2 + pad + 4;
          return (
            <g key={d.id}>
              <rect
                className="sl-draw"
                pathLength={1}
                x={x1 - pad}
                y={y1 - pad}
                width={x2 - x1 + 2 * pad}
                height={y2 - y1 + 2 * pad}
                rx={6}
                fill="none"
                stroke="var(--accent)"
                strokeWidth={Math.max(3, w / 300)}
              />
              <g className="sl-fade" style={{ animationDelay: "450ms" }}>
                <rect x={x1 - pad} y={tagY} width={w / 7.5} height={tagH} rx={4} fill="var(--accent)" />
                <text
                  x={x1 - pad + w / 120}
                  y={tagY + tagH * 0.72}
                  fill="var(--bg)"
                  fontSize={w / 48}
                  fontFamily="var(--mono)"
                >
                  person {d.conf.toFixed(2)}
                </text>
              </g>
            </g>
          );
        })}
      </svg>
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
    const timer = window.setTimeout(() => setStop((s) => s + 1), current.hits.length > 0 ? HIT_MS : CLEAR_MS);
    return () => window.clearTimeout(timer);
  }, [stop, done, current]);

  // Warm the browser cache so the scanner never waits on a photo.
  useEffect(() => {
    for (const s of stops) new Image().src = cacheUrl(dir, s.frame.file);
  }, [stops, dir]);

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
  const viewer = done ? (lead ? { frame: lead.frame, hits: [lead.detection] } : undefined) : current;

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
      {/* The scanner. */}
      <div className="flex min-h-0 flex-col gap-3 rounded-lg border border-border bg-surface p-4">
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2">
            <span aria-hidden="true" className={"size-2 rounded-full " + (done ? "bg-ok" : "sl-blink bg-accent")} />
            <Label>{done ? "Every photo scored" : "Detector scanning photos in flight order"}</Label>
          </span>
          <span className="font-mono text-small text-text-2">
            <span className="text-text">{scannedTo + 1}</span> / {nFrames} ·{" "}
            <span className="text-accent-soft">{flaggedSoFar} flagged</span>
          </span>
        </div>

        <div className="flex min-h-0 flex-1 items-center justify-center">
          <div
            className={
              "relative aspect-[4/3] max-h-full w-full overflow-hidden rounded-md " +
              (viewer && viewer.hits.length > 0 ? "sl-glow" : "")
            }
            key={viewer && viewer.hits.length > 0 ? `glow-${viewer.frame.id}` : "viewer"}
            style={{ maxWidth: "calc((100vh - 15rem) * 4 / 3)" }}
          >
            {previous && (
              <div className="absolute inset-0" aria-hidden="true">
                <ScanFrame frame={previous.frame} hits={[]} dir={dir} scanMs={0} />
              </div>
            )}
            {viewer && (
              <div key={done ? "done" : viewer.frame.id} className="sl-xfade absolute inset-0">
                <ScanFrame
                  frame={viewer.frame}
                  hits={viewer.hits}
                  dir={dir}
                  scanMs={done || !current ? 0 : current.hits.length > 0 ? HIT_MS * 0.6 : CLEAR_MS}
                />
              </div>
            )}
            <div className="pointer-events-none absolute inset-x-3 bottom-3 flex items-center justify-between gap-3 font-mono text-label">
              <span className="rounded-full bg-bg/75 px-2.5 py-1 text-text-2 backdrop-blur">
                {viewer?.frame.id} · photo {(viewer ? (positionOf.get(viewer.frame.id) ?? 0) : 0) + 1}
              </span>
              {viewer && viewer.hits.length > 0 ? (
                <span className="rounded-full bg-accent px-2.5 py-1 text-bg">
                  Candidate · {Math.max(...viewer.hits.map((d) => d.conf)).toFixed(2)}
                </span>
              ) : (
                <span className="rounded-full bg-bg/75 px-2.5 py-1 text-text-3 backdrop-blur">No person found</span>
              )}
            </div>
          </div>
        </div>

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

      {/* The queue, building as the detector finds candidates, then the answer. */}
      <div className="flex min-h-0 flex-col gap-4">
        {done ? (
          <div className="sl-rise flex flex-col gap-2">
            <Label>Ranked review queue</Label>
            <h2 className="text-[34px] font-semibold leading-[1.08]" title={source}>
              {firstHit === 1 ? "Person in the first photo you see" : `First person at photo ${ordinal(firstHit)}`}
            </h2>
            <p className="text-body text-text-2" title={source}>
              {flaggedPositions.size} of {nFrames} photos flagged for review. In random order you would expect to
              look at about{" "}
              <span className="font-mono text-text">{Math.round(ranking.expected_first_hit_random_order)}</span>{" "}
              before the first person.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Label>Ranked review queue</Label>
            <h2 className="text-[34px] font-semibold leading-[1.08] text-text-2">Most likely people first</h2>
            <p className="text-body text-text-3">Each candidate is placed by the detector&apos;s confidence.</p>
          </div>
        )}

        <ol className="flex flex-col gap-1.5" aria-label="Ranked candidates">
          {shown.map((item, i) => (
            <li
              key={item.id}
              ref={flip(item.id)}
              className={
                "sl-pop flex items-center gap-3 rounded-sm border p-2 transition-colors duration-300 " +
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
          {found.length > QUEUE_ROWS && (
            <li className="px-2 font-mono text-label text-text-3">+ {found.length - QUEUE_ROWS} more in the queue</li>
          )}
          {found.length === 0 && <li className="px-2 text-small text-text-3">Waiting for the first candidate…</li>}
        </ol>

        <div className="mt-auto flex flex-wrap items-center gap-3">
          {done ? (
            <>
              <button
                type="button"
                onClick={onStart}
                autoFocus
                className="sl-rise rounded-full bg-accent px-6 py-3 text-body font-medium text-bg transition-transform hover:scale-[1.03]"
              >
                Start review
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
              Skip to the result
            </button>
          )}
          {cache.detections.model === "SAMPLE" && <Badge kind="placeholder">Sample data</Badge>}
        </div>
      </div>
    </div>
  );
}
