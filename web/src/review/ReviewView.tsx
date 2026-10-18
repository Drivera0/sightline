import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CacheBundle } from "../contract";
import { CACHE_DIR, cacheUrl, useCache } from "../lib/cache";
import { isTyping } from "../lib/keys";
import { useSelection } from "../lib/selection";
import { EmptyState, KeyHint, Label, Panel } from "../shell/components";
import { reviewItems, reviewProgress, type ReviewItem } from "./items";
import { useReview, type Answer } from "./store";

const STATUS: Record<Answer | "unreviewed", { label: string; className: string }> = {
  unreviewed: { label: "Unreviewed", className: "text-text-3" },
  person: { label: "Person", className: "text-ok" },
  not_person: { label: "Not a person", className: "text-text-2" },
  unsure: { label: "Unsure", className: "text-warn" },
};

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

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <p className="font-mono text-small text-text-2">
          {`${progress.reviewed} of ${progress.total} reviewed · ${progress.persons} ${people} confirmed`}
        </p>
        {allDone && <p className="text-small text-ok">All candidates reviewed</p>}
      </div>

      <div
        className={
          "grid min-h-0 flex-1 grid-cols-1 gap-4 " +
          (compact ? "md:grid-cols-[13rem_minmax(0,1fr)]" : "lg:grid-cols-[18rem_1fr_20rem]")
        }
      >
        <Panel className="min-h-0 overflow-y-auto p-3">
          <ul aria-label="Candidates" className="flex flex-col gap-2">
            {items.map((item, index) => {
              const state = answers[item.id] ?? "unreviewed";
              const isCurrent = item.id === current?.id;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    aria-current={isCurrent ? "true" : undefined}
                    onClick={() => goTo(index)}
                    className={
                      "flex w-full items-center gap-3 rounded-sm border p-2 text-left " +
                      (isCurrent ? "border-accent bg-surface-strong" : "border-border hover:bg-surface-strong")
                    }
                  >
                    {item.detection.crop && (
                      <img
                        src={cacheUrl(folder, item.detection.crop)}
                        alt=""
                        className="size-14 rounded-sm"
                      />
                    )}
                    <span className="flex flex-col gap-0.5">
                      <span className="font-mono text-small text-text">
                        {item.frame.id} · {item.detection.conf.toFixed(3)}
                      </span>
                      <span data-testid="status" className={`text-small ${STATUS[state].className}`}>
                        {STATUS[state].label}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Panel>

        {current && (
          <Panel className="flex min-h-0 flex-col items-center gap-4 overflow-y-auto">
            {current.detection.crop && (
              <img
                src={cacheUrl(folder, current.detection.crop)}
                alt={`Crop of detection ${current.id}`}
                width={384}
                height={384}
                className={`${compact ? "size-72" : "size-96"} max-w-full rounded-md border border-border`}
              />
            )}
            <p data-testid="detail" className="font-mono text-small text-text-2">
              Frame {current.frame.id} · Rank {current.frame.rank} · Confidence{" "}
              {current.detection.conf.toFixed(3)}
            </p>
            <div className="flex flex-wrap justify-center gap-3">
              {(
                [
                  ["person", "Person", "P"],
                  ["not_person", "Not a person", "N"],
                  ["unsure", "Unsure", "U"],
                ] as const
              ).map(([value, label, key]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => answer(value)}
                  className="inline-flex items-center gap-2 rounded-full border border-border bg-surface-strong px-4 py-2 text-body hover:border-accent"
                >
                  {label} <KeyHint>{key}</KeyHint>
                </button>
              ))}
            </div>
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
