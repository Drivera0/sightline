import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CacheBundle } from "../contract";
import { CACHE_DIR, cacheUrl, useCache } from "../lib/cache";
import { isTyping } from "../lib/keys";
import { prefersReducedMotion } from "../metrics/motion";
import { useSelection } from "../lib/selection";
import { EmptyState, KeyHint, Label, Panel } from "../shell/components";
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

function FrameWithBox({ src, alt, box, testId }: { src: string; alt: string; box: number[]; testId: string }) {
  const [x1, y1, x2, y2] = box as [number, number, number, number];
  return (
    <div className="relative w-full">
      <img src={src} alt={alt} className="block w-full rounded-sm" />
      <svg viewBox="0 0 1000 750" className="absolute inset-0 h-full w-full" aria-hidden="true">
        <rect
          data-testid={testId}
          x={x1}
          y={y1}
          width={x2 - x1}
          height={y2 - y1}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={4}
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
                        {item.frame.id} · {item.detection.conf.toFixed(3)}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span aria-hidden="true" className={`size-1.5 rounded-full transition-colors ${STATUS[state].dot}`} />
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

        {current && (
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
            />
          </Panel>
        </div>
      )}
    </div>
  );
}
