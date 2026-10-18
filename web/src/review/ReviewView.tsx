import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { CacheBundle } from "../contract";
import { CACHE_DIR, cacheUrl, useCache } from "../lib/cache";
import { isTyping } from "../lib/keys";
import { prefersReducedMotion } from "../metrics/motion";
import { useSelection } from "../lib/selection";
import { Badge, EmptyState, KeyHint, Label, Panel } from "../shell/components";
import { reviewItems, reviewProgress, type ReviewItem } from "./items";
import { useReview, type Answer } from "./store";

const STATUS: Record<Answer | "unreviewed", { label: string; className: string; dot: string }> = {
  unreviewed: { label: "Unreviewed", className: "text-text-3", dot: "bg-text-3/40" },
  person: { label: "Person", className: "text-ok", dot: "bg-ok" },
  not_person: { label: "Not a person", className: "text-text-2", dot: "bg-text-2" },
  unsure: { label: "Unsure", className: "text-warn", dot: "bg-warn" },
};

const DECISIONS = [
  ["person", "Person", "P", "border-ok/40 text-ok hover:bg-ok/10 hover:border-ok"],
  ["not_person", "Not a person", "N", "border-border text-text hover:bg-surface-strong hover:border-text-2"],
  ["unsure", "Unsure", "U", "border-warn/40 text-warn hover:bg-warn/10 hover:border-warn"],
] as const;

/**
 * The pin as lane B's map draws it for each answer (map/base/layers.ts): an orange ring while
 * unreviewed, filled for a person, amber with "?" when unsure, grey and dashed when not a person.
 */
export function PinMark({ state, size = 14 }: { state: Answer | "unreviewed"; size?: number }) {
  const ring = {
    unreviewed: { stroke: "var(--accent)", width: 2, dash: undefined, fill: "none" },
    person: { stroke: "var(--accent-soft)", width: 3, dash: undefined, fill: "var(--accent)" },
    unsure: { stroke: "var(--warn)", width: 2, dash: undefined, fill: "none" },
    not_person: { stroke: "var(--text-2)", width: 2, dash: "3 3", fill: "none" },
  }[state];
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} aria-hidden="true" className="shrink-0">
      <circle
        cx="10"
        cy="10"
        r="7.5"
        fill={ring.fill}
        fillOpacity={state === "person" ? 0.65 : undefined}
        stroke={ring.stroke}
        strokeWidth={ring.width}
        strokeDasharray={ring.dash}
        strokeOpacity={state === "not_person" ? 0.7 : 0.95}
      />
      {state === "unsure" && (
        <text x="10" y="14" textAnchor="middle" fontSize="11" fontWeight="600" fill="var(--warn)">
          ?
        </text>
      )}
    </svg>
  );
}

/** Four corner brackets over the crop, like a camera viewfinder. */
function Viewfinder() {
  const corner = "absolute size-5 border-accent";
  return (
    <span aria-hidden="true" className="pointer-events-none absolute -inset-2">
      <span className={`${corner} left-0 top-0 rounded-tl-md border-l-2 border-t-2`} />
      <span className={`${corner} right-0 top-0 rounded-tr-md border-r-2 border-t-2`} />
      <span className={`${corner} bottom-0 left-0 rounded-bl-md border-b-2 border-l-2`} />
      <span className={`${corner} bottom-0 right-0 rounded-br-md border-b-2 border-r-2`} />
    </span>
  );
}

function firstUnreviewed(items: ReviewItem[], answers: Record<string, Answer>): ReviewItem | undefined {
  return items.find((item) => answers[item.id] === undefined);
}

/** The next unanswered item after `from`, wrapping round to the start. */
function nextUnreviewed(
  items: ReviewItem[],
  answers: Record<string, Answer>,
  from: number,
): ReviewItem | undefined {
  for (let step = 1; step <= items.length; step++) {
    const item = items[(from + step) % items.length];
    if (item && answers[item.id] === undefined) return item;
  }
  return undefined;
}

function FrameWithBox({
  src,
  alt,
  box,
  testId,
  width = 1000,
  height = 750,
}: {
  src: string;
  alt: string;
  box: number[];
  testId: string;
  /** The photo's pixel size, so the box lands where the detector put it (not every survey is 1000x750). */
  width?: number;
  height?: number;
}) {
  const [x1, y1, x2, y2] = box as [number, number, number, number];
  // At least ~8% of the photo across, so a 15 px person is still findable in a thumbnail.
  const pad = Math.max(width * 0.04, (x2 - x1) * 0.6);
  const maskId = `ring-${useId().replace(/:/g, "")}`;
  const ring = { x: x1 - pad, y: y1 - pad, width: x2 - x1 + 2 * pad, height: y2 - y1 + 2 * pad, rx: pad };
  return (
    <div className="relative w-full overflow-hidden rounded-sm">
      <img src={src} alt={alt} className="block w-full" />
      <svg viewBox={`0 0 ${width} ${height}`} className="absolute inset-0 h-full w-full" aria-hidden="true">
        {/* A soft ring so the box is easy to find in a small photo, then the box itself. */}
        {/* Dim everything outside the ring, so the eye lands on the candidate. */}
        <mask id={maskId}>
          <rect width={width} height={height} fill="white" />
          <rect {...ring} fill="black" />
        </mask>
        <rect width={width} height={height} fill="black" fillOpacity={0.4} mask={`url(#${maskId})`} />
        <rect {...ring} fill="none" stroke="black" strokeOpacity={0.45} strokeWidth={Math.max(4, width / 200)} />
        <rect {...ring} fill="none" stroke="var(--accent)" strokeWidth={Math.max(2, width / 450)} />
        <rect
          data-testid={testId}
          x={x1}
          y={y1}
          width={x2 - x1}
          height={y2 - y1}
          fill="none"
          stroke="var(--accent)"
          strokeOpacity={0.85}
          strokeWidth={Math.max(1.5, width / 700)}
        />
      </svg>
    </div>
  );
}

export function ReviewView({
  cache,
  dir,
  onShowMap,
  compact = false,
}: {
  cache: CacheBundle;
  dir?: string;
  onShowMap: () => void;
  /** Two columns (queue + crop) so the review fits beside the map; the full frame stays on Enter. */
  compact?: boolean;
}) {
  const loadedDir = useCache((s) => s.dir);
  const folder = dir ?? loadedDir ?? CACHE_DIR;
  const items = useMemo(() => reviewItems(cache), [cache]);

  const answers = useReview((s) => s.answers);
  const bind = useReview((s) => s.bind);
  const selectedDetectionId = useSelection((s) => s.selectedDetectionId);

  const [cursorId, setCursorId] = useState<string | null>(null);
  const [fullFrame, setFullFrame] = useState(false);
  const selectedByQueue = useRef<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  // The last decision, shown as a short-lived toast; `n` re-keys it so each answer animates.
  const [lastDecision, setLastDecision] = useState<{ frameId: string; value: Answer; n: number } | null>(null);

  useEffect(() => bind(cache.survey.survey_id), [bind, cache.survey.survey_id]);

  // Until the reviewer moves, the cursor sits on the first candidate nobody has answered.
  const current = items.find((i) => i.id === cursorId) ?? firstUnreviewed(items, answers) ?? items[0];
  const currentIndex = current ? items.indexOf(current) : -1;

  // The queue follows a selection made elsewhere (a click on a map pin), but not its own.
  useEffect(() => {
    if (selectedDetectionId && selectedDetectionId !== selectedByQueue.current) {
      if (items.some((i) => i.id === selectedDetectionId)) setCursorId(selectedDetectionId);
    }
    selectedByQueue.current = selectedDetectionId;
  }, [selectedDetectionId, items]);

  // Keep the current candidate visible in the queue as the cursor moves.
  useEffect(() => {
    if (!current) return;
    rowRefs.current.get(current.id)?.scrollIntoView?.({
      block: "nearest",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, [current]);

  const select = useCallback((id: string) => {
    selectedByQueue.current = id;
    useSelection.getState().selectDetection(id);
  }, []);

  const goTo = useCallback(
    (index: number) => {
      const item = items[Math.min(Math.max(index, 0), items.length - 1)];
      if (!item) return;
      setCursorId(item.id);
      select(item.id);
    },
    [items, select],
  );

  const answer = useCallback(
    (value: Answer) => {
      if (!current) return;
      useReview.getState().answer(current.id, value);
      setLastDecision((d) => ({ frameId: current.frame.id, value, n: (d?.n ?? 0) + 1 }));
      if (value === "person") select(current.id);
      const next = nextUnreviewed(items, { ...answers, [current.id]: value }, currentIndex);
      setCursorId((next ?? current).id);
    },
    [current, items, answers, currentIndex, select],
  );

  const undo = useCallback(() => {
    const last = useReview.getState().history.at(-1);
    useReview.getState().undo();
    if (last) setCursorId(last.detectionId);
  }, []);

  const showOnMap = useCallback(() => {
    if (!current) return;
    select(current.id);
    onShowMap();
  }, [current, select, onShowMap]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
      if (fullFrame) {
        if (event.key === "Escape") setFullFrame(false);
        return;
      }
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      const onControl = (event.target as HTMLElement | null)?.closest?.("button, a") != null;
      if (key === "j" || key === "ArrowDown") goTo(currentIndex + 1);
      else if (key === "k" || key === "ArrowUp") goTo(currentIndex - 1);
      else if (key === "p") answer("person");
      else if (key === "n") answer("not_person");
      else if (key === "u") answer("unsure");
      else if (key === "z") undo();
      else if (key === "m") showOnMap();
      else if (key === "Enter" && !onControl && current) setFullFrame(true);
      else return;
      event.preventDefault();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fullFrame, goTo, currentIndex, answer, undo, showOnMap, current]);

  if (items.length === 0) {
    return (
      <Panel className="h-full">
        <EmptyState title="No candidates to review">
          No detection reached the candidate threshold ({cache.detections.candidate_threshold}).
        </EmptyState>
      </Panel>
    );
  }

  const progress = reviewProgress(items, answers);
  const allDone = progress.reviewed === progress.total;
  const people = progress.persons === 1 ? "person" : "people";

  const percent = Math.round((progress.reviewed / progress.total) * 100);
  const secondary =
    "inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-small text-text-2 transition-colors hover:bg-surface-strong hover:text-text";

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4">
          <p className="font-mono text-small text-text-2">
            {`${progress.reviewed} of ${progress.total} reviewed · ${progress.persons} ${people} confirmed`}
          </p>
          {allDone && <p className="sl-fade text-small text-ok">All candidates reviewed</p>}
        </div>
        <div
          className="h-1 overflow-hidden rounded-full bg-surface-strong"
          role="progressbar"
          aria-label="Review progress"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.reviewed}
        >
          <div
            className={"h-full rounded-full transition-[width] duration-500 ease-out " + (allDone ? "bg-ok" : "bg-accent")}
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      <div
        className={
          "grid min-h-0 flex-1 grid-cols-1 gap-3 " +
          (compact ? "md:grid-cols-[16.5rem_minmax(0,1fr)]" : "lg:grid-cols-[18rem_1fr_20rem]")
        }
      >
        <Panel className="min-h-0 overflow-y-auto p-2">
          <ul aria-label="Candidates" className="flex flex-col gap-1">
            {items.map((item, index) => {
              const state = answers[item.id] ?? "unreviewed";
              const isCurrent = item.id === current?.id;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    ref={(el) => {
                      if (el) rowRefs.current.set(item.id, el);
                      else rowRefs.current.delete(item.id);
                    }}
                    aria-current={isCurrent ? "true" : undefined}
                    onClick={() => goTo(index)}
                    className={
                      "relative flex w-full items-center gap-3 rounded-sm p-2 text-left transition-[background-color,opacity] duration-200 " +
                      (isCurrent ? "bg-accent/10 ring-1 ring-accent/60" : "hover:bg-surface-strong") +
                      (state !== "unreviewed" && !isCurrent ? " opacity-60" : "")
                    }
                  >
                    <span
                      aria-hidden="true"
                      className={
                        "absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent transition-transform duration-200 " +
                        (isCurrent ? "scale-y-100" : "scale-y-0")
                      }
                    />
                    <span className="w-5 shrink-0 text-right font-mono text-label text-text-3">{index + 1}</span>
                    {item.detection.crop && (
                      <img
                        src={cacheUrl(folder, item.detection.crop)}
                        alt=""
                        loading="lazy"
                        className="size-11 shrink-0 rounded-[8px] object-cover"
                      />
                    )}
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate font-mono text-small text-text">
                        {item.frame.id} <span className="text-text-3">· {item.detection.conf.toFixed(3)}</span>
                      </span>
                      <span className="flex items-center gap-1.5">
                        <PinMark state={state} size={12} />
                        <span data-testid="status" className={`text-label ${STATUS[state].className}`}>
                          {STATUS[state].label}
                        </span>
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Panel>

        {current && compact && (
          <Panel className="relative flex min-h-0 flex-col gap-4 overflow-hidden">
            <div className="flex items-center justify-between gap-3">
              <Label>
                Candidate {currentIndex + 1} of {items.length}
              </Label>
              <span className={`inline-flex items-center gap-1.5 text-label ${STATUS[answers[current.id] ?? "unreviewed"].className}`}>
                <PinMark state={answers[current.id] ?? "unreviewed"} size={12} />
                {STATUS[answers[current.id] ?? "unreviewed"].label}
              </span>
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_18rem] gap-6">
              {/* The crop, as large as the panel allows up to 1.5x its 256 px (any larger just blurs). */}
              <div className="flex min-h-0 min-w-0 items-center justify-center p-2">
                {current.detection.crop && (
                  <div key={current.id} className="sl-pop relative aspect-square max-h-full w-full max-w-[24rem]">
                    <img
                      src={cacheUrl(folder, current.detection.crop)}
                      alt={`Crop of detection ${current.id}`}
                      className="h-full w-full rounded-md object-cover shadow-[0_24px_60px_-24px_rgba(0,0,0,0.9)]"
                    />
                    <Viewfinder />
                  </div>
                )}
              </div>

              {/* Where it sits, and the facts a searcher weighs. */}
              <div className="flex min-h-0 flex-col gap-5 overflow-y-auto">
                <div className="flex flex-col gap-2">
                  <div className="flex items-baseline justify-between">
                    <Label>Where in the photo</Label>
                    <span className="font-mono text-label text-text-3">Photo {current.frame.id}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setFullFrame(true)}
                    className="group relative block overflow-hidden rounded-md ring-1 ring-border transition-shadow hover:ring-accent/70 focus-visible:ring-accent"
                    title="Open the full frame (Enter)"
                  >
                    <FrameWithBox
                      src={cacheUrl(folder, current.frame.file)}
                      alt={`Frame ${current.frame.id} with the candidate boxed`}
                      box={current.detection.box_px}
                      testId="frame-context-box"
                      width={current.frame.width_px}
                      height={current.frame.height_px}
                    />
                    <span className="absolute bottom-2 right-2 inline-flex items-center gap-1.5 rounded-full bg-bg/80 px-2.5 py-1 text-label text-text-2 backdrop-blur transition-colors group-hover:text-text">
                      Full frame <KeyHint>Enter</KeyHint>
                    </span>
                  </button>
                </div>

                <dl className="flex flex-col divide-y divide-border border-y border-border">
                  <div className="flex flex-col gap-2.5 py-3">
                    <div className="flex items-baseline justify-between">
                      <dt>
                        <Label>Detector score</Label>
                      </dt>
                      <dd className="font-mono text-title leading-none text-text">{current.detection.conf.toFixed(2)}</dd>
                    </div>
                    <div className="relative h-2 rounded-full bg-surface-strong">
                      <span
                        className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-300"
                        style={{ width: `${Math.round(current.detection.conf * 100)}%` }}
                      />
                      <span
                        aria-hidden="true"
                        className="absolute -inset-y-1 w-0.5 rounded-full bg-text"
                        style={{ left: `${cache.detections.candidate_threshold * 100}%` }}
                      />
                    </div>
                    <div className="relative h-4 text-label text-text-3">
                      <span
                        className="absolute -translate-x-1/2 whitespace-nowrap font-mono"
                        style={{ left: `${cache.detections.candidate_threshold * 100}%` }}
                      >
                        flagged from {cache.detections.candidate_threshold.toFixed(2)}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-baseline justify-between py-3">
                    <dt>
                      <Label>Photo rank</Label>
                    </dt>
                    <dd className="font-mono text-body text-text">
                      #{current.frame.rank}
                      <span className="text-text-3"> of {cache.survey.frames.length} photos</span>
                    </dd>
                  </div>
                  <div className="flex flex-col gap-2 py-3">
                    <dt>
                      <Label>Estimated position</Label>
                    </dt>
                    <dd className="font-mono text-body text-text">
                      {current.detection.lat.toFixed(5)}, {current.detection.lon.toFixed(5)}
                    </dd>
                    <dd className="flex flex-wrap gap-1.5">
                      {/* Both stay labelled simulated: the 10 m radius always, the flight path when it is. */}
                      <Badge kind="simulated">±{current.detection.radius_m} m radius · simulated</Badge>
                      {cache.survey.simulated_path && <Badge kind="simulated">Simulated flight path</Badge>}
                    </dd>
                  </div>
                </dl>

                {/* The key for the map beside this panel: each answer changes how the pin is drawn. */}
                <div className="flex flex-col gap-2">
                  <Label>On the map</Label>
                  <ul className="grid grid-cols-2 gap-x-3 gap-y-2 text-small text-text-2">
                    {(
                      [
                        ["unreviewed", "Not answered"],
                        ["person", "Person, pinned"],
                        ["unsure", "Unsure"],
                        ["not_person", "Not a person"],
                      ] as const
                    ).map(([state, text]) => (
                      <li key={state} className="flex items-center gap-2">
                        <PinMark state={state} size={16} />
                        {text}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>

            <section aria-label="Review keys" className="flex flex-col gap-2">
              <div className="grid grid-cols-3 gap-2">
                {DECISIONS.map(([value, label, key, tone]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => answer(value)}
                    aria-pressed={answers[current.id] === value}
                    className={
                      "inline-flex h-12 items-center justify-center gap-2.5 rounded-full border text-title transition-[background-color,border-color,transform] duration-150 active:scale-[0.97] " +
                      tone +
                      (answers[current.id] === value ? " bg-surface-strong" : "")
                    }
                  >
                    <PinMark state={value} size={16} />
                    {label} <KeyHint>{key}</KeyHint>
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center justify-center gap-1 text-small text-text-3">
                <button type="button" onClick={undo} className={secondary}>
                  Undo <KeyHint>Z</KeyHint>
                </button>
                <button type="button" onClick={() => setFullFrame(true)} className={secondary}>
                  Full frame <KeyHint>Enter</KeyHint>
                </button>
                <button type="button" onClick={showOnMap} className={secondary}>
                  Where to search next <KeyHint>M</KeyHint>
                </button>
                <span className="inline-flex items-center gap-1.5 px-3">
                  Next <KeyHint>J</KeyHint>
                </span>
                <span className="inline-flex items-center gap-1.5 px-3">
                  Previous <KeyHint>K</KeyHint>
                </span>
              </div>
            </section>

            {lastDecision && (
              <p
                key={lastDecision.n}
                role="status"
                className="sl-toast pointer-events-none absolute left-1/2 top-12 rounded-full border border-border bg-bg/90 px-4 py-1.5 text-small text-text-2 backdrop-blur"
              >
                {lastDecision.frameId} marked{" "}
                <span className={STATUS[lastDecision.value].className}>
                  {STATUS[lastDecision.value].label.toLowerCase()}
                </span>
              </p>
            )}
          </Panel>
        )}

        {current && !compact && (
          <Panel className="relative flex min-h-0 flex-col gap-5 overflow-y-auto">
            <div className="flex items-center justify-between gap-3">
              <Label>
                Candidate {currentIndex + 1} of {items.length}
              </Label>
              <div className="flex items-center gap-2" title="Detector confidence">
                <span className="h-1 w-20 overflow-hidden rounded-full bg-surface-strong">
                  <span
                    className="block h-full rounded-full bg-accent-soft transition-[width] duration-300"
                    style={{ width: `${Math.round(current.detection.conf * 100)}%` }}
                  />
                </span>
                <span className="font-mono text-label text-text-2">{current.detection.conf.toFixed(2)}</span>
              </div>
            </div>

            <div className="flex flex-1 flex-col items-center justify-center gap-4">
              {current.detection.crop && (
                <div key={current.id} className="sl-pop relative">
                  <img
                    src={cacheUrl(folder, current.detection.crop)}
                    alt={`Crop of detection ${current.id}`}
                    width={384}
                    height={384}
                    className={`${compact ? "size-72" : "size-96"} max-w-full rounded-md object-cover shadow-[0_24px_60px_-24px_rgba(0,0,0,0.9)]`}
                  />
                  <Viewfinder />
                </div>
              )}
              <p data-testid="detail" className="font-mono text-small text-text-3">
                Frame {current.frame.id} · Rank {current.frame.rank} · Confidence{" "}
                {current.detection.conf.toFixed(3)}
              </p>
            </div>

            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-3 gap-2">
                {DECISIONS.map(([value, label, key, tone]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => answer(value)}
                    aria-pressed={answers[current.id] === value}
                    className={
                      "inline-flex items-center justify-center gap-2 rounded-full border px-3 py-2.5 text-body transition-[background-color,border-color,transform] duration-150 active:scale-[0.97] " +
                      tone +
                      (answers[current.id] === value ? " bg-surface-strong" : "")
                    }
                  >
                    {label} <KeyHint>{key}</KeyHint>
                  </button>
                ))}
              </div>
              {compact && (
                <div className="flex flex-wrap items-center justify-center gap-1">
                  <button type="button" onClick={undo} className={secondary}>
                    Undo <KeyHint>Z</KeyHint>
                  </button>
                  <button type="button" onClick={() => setFullFrame(true)} className={secondary}>
                    Full frame <KeyHint>Enter</KeyHint>
                  </button>
                  <button type="button" onClick={showOnMap} className={secondary}>
                    Where to search next <KeyHint>M</KeyHint>
                  </button>
                </div>
              )}
            </div>

            {lastDecision && (
              <p
                key={lastDecision.n}
                role="status"
                className="sl-toast pointer-events-none absolute left-1/2 top-12 rounded-full border border-border bg-bg/90 px-4 py-1.5 text-small text-text-2 backdrop-blur"
              >
                {lastDecision.frameId} marked{" "}
                <span className={STATUS[lastDecision.value].className}>
                  {STATUS[lastDecision.value].label.toLowerCase()}
                </span>
              </p>
            )}
          </Panel>
        )}

        {current && !compact && (
          <Panel className="flex flex-col gap-3 overflow-y-auto">
            <Label>Frame {current.frame.id}</Label>
            <FrameWithBox
              src={cacheUrl(folder, current.frame.file)}
              alt={`Frame ${current.frame.id}`}
              box={current.detection.box_px}
              testId="frame-box"
              width={current.frame.width_px}
              height={current.frame.height_px}
            />
            <div className="flex flex-wrap gap-2 text-small text-text-2">
              <button type="button" onClick={undo} className="inline-flex items-center gap-2 hover:text-text">
                Undo <KeyHint>Z</KeyHint>
              </button>
              <button
                type="button"
                onClick={() => setFullFrame(true)}
                className="inline-flex items-center gap-2 hover:text-text"
              >
                Full frame <KeyHint>Enter</KeyHint>
              </button>
              <button type="button" onClick={showOnMap} className="inline-flex items-center gap-2 hover:text-text">
                Show on map <KeyHint>M</KeyHint>
              </button>
            </div>
          </Panel>
        )}
      </div>

      {fullFrame && current && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-bg/80 p-6 backdrop-blur-sm"
          onClick={() => setFullFrame(false)}
        >
          <Panel
            role="dialog"
            aria-modal="true"
            aria-label="Full frame"
            className="w-full max-w-4xl"
            onClick={(event) => event.stopPropagation()}
          >
            <FrameWithBox
              src={cacheUrl(folder, current.frame.file)}
              alt={`Full frame ${current.frame.id}`}
              box={current.detection.box_px}
              testId="frame-box-large"
              width={current.frame.width_px}
              height={current.frame.height_px}
            />
          </Panel>
        </div>
      )}
    </div>
  );
}
