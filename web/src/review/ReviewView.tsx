import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { CacheBundle } from "../contract";
import { CACHE_DIR, cacheUrl, useCache } from "../lib/cache";
import { isTyping } from "../lib/keys";
import { prefersReducedMotion } from "../metrics/motion";
import { useSelection } from "../lib/selection";
import { useMediaQuery } from "../map/heat/panelSlot";
import { EmptyState, KeyHint, Label, Panel } from "../shell/components";
import { itemLabels, queueCounts, reviewItems, reviewProgress, type ReviewItem } from "./items";
import { ResetReview } from "./ResetReview";
import { useReview, type Answer } from "./store";

const STATUS: Record<Answer | "unreviewed", { label: string; className: string; dot: string }> = {
  unreviewed: { label: "Unreviewed", className: "text-text-3", dot: "bg-text-3/40" },
  person: { label: "Person", className: "text-ok", dot: "bg-ok" },
  not_person: { label: "Not a person", className: "text-text-2", dot: "bg-text-2" },
  unsure: { label: "Unsure", className: "text-warn", dot: "bg-warn" },
};

// [answer, label, key, resting tone, selected tone]. Selected: a 16% fill and a 1 px border in the
// answer's colour (10% text for "Not a person"), plus a check, so the state never rests on colour alone.
const DECISIONS = [
  ["person", "Person", "P", "border-ok/40 text-ok hover:bg-ok/10 hover:border-ok", "bg-ok/16 border-ok"],
  ["not_person", "Not a person", "N", "border-border text-text hover:bg-surface-strong hover:border-text-2", "bg-text/10 border-text-2"],
  ["unsure", "Unsure", "U", "border-warn/40 text-warn hover:bg-warn/10 hover:border-warn", "bg-warn/16 border-warn"],
] as const;

function Check() {
  return (
    <svg viewBox="0 0 16 16" className="size-4 shrink-0" aria-hidden="true" data-testid="selected-check">
      <path d="M3.5 8.5 6.5 11.5 12.5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** How long the "Marked ... Undo" toast stays, in ms. */
const TOAST_MS = 5000;
/** How long the "Undone" toast stays, in ms. */
export const UNDONE_MS = 1500;

/** Keyboard focus stays inside an open dialog: Tab and Shift+Tab wrap round its controls. */
export function trapTab(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.key !== "Tab") return;
  const focusables = [
    ...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'),
  ];
  const first = focusables[0];
  const last = focusables.at(-1);
  if (!first || !last) {
    event.preventDefault();
    return;
  }
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !event.currentTarget.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !event.currentTarget.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * The photo at full size, with a caption, a visible Close (Esc) and focus kept inside while it is
 * open; focus goes back where it was on close (the same pattern as the shortcuts overlay).
 */
function FullFrameDialog({ caption, onClose, children }: { caption: string; onClose: () => void; children: ReactNode }) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    return () => previous?.focus?.({ preventScroll: true });
  }, []);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-bg/80 p-4 backdrop-blur-sm sm:p-6" onClick={onClose}>
      <Panel
        role="dialog"
        aria-modal="true"
        aria-label="Full frame"
        aria-describedby="full-frame-caption"
        className="flex max-h-full w-full max-w-4xl flex-col gap-3 p-3 sm:p-4"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={trapTab}
      >
        <div className="flex items-center justify-between gap-3">
          <p id="full-frame-caption" className="font-mono text-small text-text-2">
            {caption}
          </p>
          <button
            ref={closeButton}
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-small text-text-2 transition-colors hover:bg-surface-strong hover:text-text"
          >
            Close <KeyHint>Esc</KeyHint>
          </button>
        </div>
        <div className="min-h-0 overflow-auto">{children}</div>
      </Panel>
    </div>
  );
}

/**
 * The marker as the map draws it for each answer (map/base/pinImages.ts): a check on a green
 * disc for a person, "?" in an amber ring when unsure, a grey cross when not a person, and a
 * neutral ring with a dot while unanswered.
 */
export function PinMark({ state, size = 14 }: { state: Answer | "unreviewed"; size?: number }) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} aria-hidden="true" className="shrink-0">
      {state === "person" && (
        <>
          <circle cx="10" cy="10" r="8" fill="var(--ok)" stroke="var(--text)" strokeWidth="1.5" />
          <path d="M6.4 10.3 8.9 12.8 13.8 7.6" fill="none" stroke="var(--bg)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {state === "unsure" && (
        <>
          <circle cx="10" cy="10" r="7.5" fill="var(--bg)" stroke="var(--warn)" strokeWidth="1.75" />
          <text x="10" y="14" textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--warn)">
            ?
          </text>
        </>
      )}
      {state === "not_person" && (
        <path d="M6.5 6.5 13.5 13.5M13.5 6.5 6.5 13.5" stroke="var(--text-2)" strokeWidth="1.75" strokeLinecap="round" />
      )}
      {state === "unreviewed" && (
        <>
          <circle cx="10" cy="10" r="7.5" fill="none" stroke="var(--text-2)" strokeWidth="1.5" strokeOpacity="0.8" />
          <circle cx="10" cy="10" r="2.75" fill="var(--text-2)" />
        </>
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
  const labels = useMemo(() => itemLabels(items), [items]);
  const counts = queueCounts(items);
  const optionPrefix = `cand-${useId().replace(/:/g, "")}`;

  const answers = useReview((s) => s.answers);
  const bind = useReview((s) => s.bind);
  const selectedDetectionId = useSelection((s) => s.selectedDetectionId);

  const [cursorId, setCursorId] = useState<string | null>(null);
  const [fullFrame, setFullFrame] = useState(false);
  const selectedByQueue = useRef<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  // After an answer, focus moves here: never left on the answer button, where the next Enter would
  // re-click it and record the same answer for the next candidate.
  const candidateRef = useRef<HTMLDivElement>(null);
  const queueRef = useRef<HTMLDivElement>(null);
  // Phones: the three answers sit in a bar fixed to the bottom of the screen, always in reach.
  const phoneBar = useMediaQuery("(max-width: 767px)", false) && compact;
  // The last decision, shown as a short-lived toast; `n` re-keys it so each answer animates.
  const [lastDecision, setLastDecision] = useState<{ label: string; value: Answer; n: number } | null>(null);
  // "Undone", briefly, after an undo (a count, so a second undo shows it again).
  const [undone, setUndone] = useState(0);

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

  // Keep the current candidate visible in the queue as the cursor moves. Only the queue scrolls:
  // scrollIntoView would also scroll the page (on a phone it jumped past the candidate on load).
  useEffect(() => {
    const list = queueRef.current;
    const row = current ? rowRefs.current.get(current.id) : undefined;
    if (!list || !row || typeof list.scrollTo !== "function") return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    const pad = 8;
    let to: number | null = null;
    if (top - pad < list.scrollTop) to = top - pad;
    else if (bottom + pad > list.scrollTop + list.clientHeight) to = bottom + pad - list.clientHeight;
    if (to !== null) list.scrollTo({ top: Math.max(0, to), behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [current]);

  const select = useCallback((id: string) => {
    selectedByQueue.current = id;
    useSelection.getState().selectDetection(id);
  }, []);

  // The map follows the candidate under review: after an answer, an undo, J/K or a click.
  const currentId = current?.id;
  useEffect(() => {
    if (currentId && useSelection.getState().selectedDetectionId !== currentId) select(currentId);
  }, [currentId, select]);

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
      setLastDecision((d) => ({ label: labels.get(current.id) ?? current.frame.id, value, n: (d?.n ?? 0) + 1 }));
      setUndone(0);
      if (value === "person") select(current.id);
      const next = nextUnreviewed(items, { ...answers, [current.id]: value }, currentIndex);
      setCursorId((next ?? current).id);
      candidateRef.current?.focus({ preventScroll: true });
    },
    [current, items, answers, currentIndex, select, labels],
  );

  const undo = useCallback(() => {
    const last = useReview.getState().history.at(-1);
    useReview.getState().undo();
    setLastDecision(null);
    if (last) {
      setCursorId(last.detectionId);
      setUndone((n) => n + 1);
    }
  }, []);

  useEffect(() => {
    if (!undone) return;
    const timer = window.setTimeout(() => setUndone(0), UNDONE_MS);
    return () => window.clearTimeout(timer);
  }, [undone]);

  // The toast holds long enough to reach its Undo, then goes.
  useEffect(() => {
    if (!lastDecision) return;
    const timer = window.setTimeout(() => setLastDecision(null), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [lastDecision]);

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
      const target = event.target as HTMLElement | null;
      const onControl = target?.closest?.("button, a") != null;
      // Enter on an answer button would answer again: swallow it (focus normally moves off it anyway).
      if (event.key === "Enter" && target?.closest?.("[data-answer]")) {
        event.preventDefault();
        return;
      }
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
  const threshold = cache.detections.candidate_threshold;

  const percent = Math.round((progress.reviewed / progress.total) * 100);
  const answerGrid = current ? (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)] gap-2">
      {DECISIONS.map(([value, label, key, tone, selectedTone]) => {
        const selected = answers[current.id] === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => answer(value)}
            data-answer={value}
            aria-pressed={selected}
            className={
              "inline-flex h-12 items-center justify-center gap-2 whitespace-nowrap rounded-full border px-2 text-body md:px-3 transition-[background-color,border-color,transform] duration-150 active:scale-[0.97] " +
              tone +
              (selected ? " " + selectedTone : "")
            }
          >
            {selected && <Check />}
            {label}
            <span className="hidden md:contents">
              <KeyHint>{key}</KeyHint>
            </span>
          </button>
        );
      })}
    </div>
  ) : null;
  const secondary =
    "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-small text-text-2 transition-colors hover:bg-surface-strong hover:text-text";
  // Previous / Next: 36 px round icon buttons, 44 px where the pointer is a finger.
  const stepButton =
    "inline-flex size-9 items-center justify-center rounded-full border border-border text-title leading-none text-text-2 transition-colors hover:border-text-2 hover:bg-surface-strong hover:text-text disabled:pointer-events-none disabled:opacity-40 [@media(pointer:coarse)]:size-11";
  const currentLabel = current ? (labels.get(current.id) ?? current.frame.id) : "";

  const toast = lastDecision ? (
    <p
      key={`marked-${lastDecision.n}`}
      role="status"
      className="sl-toast-in absolute left-1/2 top-12 z-10 inline-flex -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-full border border-border bg-bg/90 py-1 pl-4 pr-1 text-small text-text-2 backdrop-blur"
    >
      Marked <span className="font-mono text-text">{lastDecision.label}</span> ·{" "}
      <span className={STATUS[lastDecision.value].className}>{STATUS[lastDecision.value].label}</span>
      <span aria-hidden="true" className="mx-1 text-text-3">
        —
      </span>
      <button
        type="button"
        onClick={undo}
        className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-accent-soft hover:bg-surface-strong hover:text-text"
      >
        Undo <KeyHint>Z</KeyHint>
      </button>
    </p>
  ) : undone ? (
    <p
      key={`undone-${undone}`}
      role="status"
      className="sl-toast-in absolute left-1/2 top-12 z-10 inline-flex -translate-x-1/2 items-center whitespace-nowrap rounded-full border border-border bg-bg/90 px-4 py-1.5 text-small text-text"
    >
      Undone
    </p>
  ) : null;

  const focusAnswers = () => document.querySelector<HTMLButtonElement>('[data-answer="person"]')?.focus();

  return (
    <div className={"flex flex-col gap-4 lg:h-full lg:min-h-0" + (phoneBar ? " pb-24" : "")}>
      {current && (
        <a
          href="#answer"
          onClick={(event) => {
            event.preventDefault();
            focusAnswers();
          }}
          className="sr-only rounded-full bg-accent px-4 py-2 text-small font-medium text-bg focus:not-sr-only focus:absolute focus:z-50"
        >
          Skip to answer
        </a>
      )}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 font-mono text-small text-text-2">
            <p data-testid="queue-counts" className="text-text-3">
              {`${counts.photos} ${counts.photos === 1 ? "photo" : "photos"} · ${counts.boxes} ${counts.boxes === 1 ? "box" : "boxes"}`}
            </p>
            <span aria-hidden="true" className="text-text-3">
              ·
            </span>
            <p>{`${progress.reviewed} of ${progress.total} reviewed · ${progress.persons} ${people} confirmed`}</p>
          </div>
          <div className="flex items-center gap-3">
            {allDone && <p className="sl-fade text-small text-ok">All candidates reviewed</p>}
            <ResetReview />
          </div>
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
          "grid flex-1 grid-cols-1 gap-4 lg:min-h-0 " +
          (compact ? "md:grid-cols-[14rem_minmax(0,1fr)] lg:grid-cols-[12rem_minmax(0,1fr)] 2xl:grid-cols-[14rem_minmax(0,1fr)]" : "lg:grid-cols-[18rem_1fr_20rem]")
        }
      >
        <Panel ref={queueRef} className="relative max-h-64 overflow-y-auto overflow-x-hidden p-2 md:max-h-[70vh] lg:max-h-none lg:min-h-0">
          {/* One tab stop: the arrow keys (and J/K) move through the candidates. */}
          <ul
            role="listbox"
            aria-label="Candidates"
            tabIndex={0}
            aria-activedescendant={current ? `${optionPrefix}-${current.id}` : undefined}
            onKeyDown={(event) => {
              if (event.key === "Home") goTo(0);
              else if (event.key === "End") goTo(items.length - 1);
              else return;
              event.preventDefault();
            }}
            className="flex flex-col gap-1 rounded-sm focus-visible:outline-offset-[-2px]"
          >
            {items.map((item, index) => {
              const state = answers[item.id] ?? "unreviewed";
              const isCurrent = item.id === current?.id;
              const answered = state !== "unreviewed" && !isCurrent;
              return (
                <li
                  key={item.id}
                  id={`${optionPrefix}-${item.id}`}
                  role="option"
                  aria-selected={isCurrent}
                  ref={(el) => {
                    if (el) rowRefs.current.set(item.id, el);
                    else rowRefs.current.delete(item.id);
                  }}
                  onClick={() => goTo(index)}
                  className={
                    "relative flex w-full cursor-pointer items-center gap-3 rounded-sm p-2 text-left transition-[background-color] duration-200 " +
                    (isCurrent ? "bg-accent/10 ring-1 ring-accent/60" : "hover:bg-surface-strong")
                  }
                >
                  <span
                    aria-hidden="true"
                    className={
                      "absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent transition-transform duration-200 " +
                      (isCurrent ? "scale-y-100" : "scale-y-0")
                    }
                  />
                  {item.detection.crop && (
                    <img
                      src={cacheUrl(folder, item.detection.crop)}
                      alt=""
                      loading="lazy"
                      // Answered rows recede through the picture and a softer number; their text keeps 4.5:1.
                      className={"size-11 shrink-0 rounded-[8px] object-cover transition-opacity " + (answered ? "opacity-50" : "")}
                    />
                  )}
                  <span className="flex min-w-0 flex-col">
                    <span
                      className={"whitespace-nowrap text-body " + (answered ? "text-text-2" : "text-text")}
                      title={`Detector score ${item.detection.conf.toFixed(3)}`}
                    >
                      #{index + 1} <span className="text-text-3">·</span>{" "}
                      <span className="font-mono">{item.detection.conf.toFixed(2)}</span>
                    </span>
                    <span className="truncate font-mono text-label text-text-3">{labels.get(item.id)}</span>
                    <span className="mt-0.5 flex items-center gap-1.5">
                      <PinMark state={state} size={12} />
                      <span data-testid="status" className={`whitespace-nowrap text-label ${STATUS[state].className}`}>
                        {STATUS[state].label}
                      </span>
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </Panel>

        {current && compact && (
          <Panel
            ref={candidateRef}
            tabIndex={-1}
            aria-label={`Candidate ${currentIndex + 1} of ${items.length}`}
            data-testid="candidate-panel"
            className="relative order-first flex flex-col gap-3 overflow-hidden p-4 outline-none md:order-none lg:min-h-0"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="flex min-w-0 items-baseline gap-2">
                <Label className="whitespace-nowrap">
                  Candidate {currentIndex + 1} of {items.length}
                </Label>
                <span data-testid="candidate-label" className="truncate font-mono text-label text-text-2">
                  {currentLabel}
                </span>
              </span>
              <span className={`inline-flex shrink-0 items-center gap-1.5 text-label ${STATUS[answers[current.id] ?? "unreviewed"].className}`}>
                <PinMark state={answers[current.id] ?? "unreviewed"} size={12} />
                {STATUS[answers[current.id] ?? "unreviewed"].label}
              </span>
            </div>

            {/* The crop: about min(36vh, 280 px); on wide screens it gives way so nothing below is cut off (theme.css). */}
            <div className="sl-crop-slot flex items-center justify-center p-2">
              {current.detection.crop && (
                <div key={current.id} className="sl-pop sl-crop relative aspect-square">
                  <img
                    src={cacheUrl(folder, current.detection.crop)}
                    alt={`Crop of detection ${current.id}`}
                    className="h-full w-full rounded-md object-cover shadow-[0_24px_60px_-24px_rgba(0,0,0,0.9)]"
                  />
                  <Viewfinder />
                </div>
              )}
            </div>

            {/* The facts a searcher weighs, on one line under the crop. */}
            <p
              data-testid="evidence"
              className="flex flex-wrap items-baseline justify-center gap-x-1.5 text-center font-mono text-label text-text-2"
            >
              <span className="whitespace-nowrap" title={`Detector score ${current.detection.conf.toFixed(3)}; flagged from ${threshold.toFixed(2)}`}>
                score <span className="text-text">{current.detection.conf.toFixed(2)}</span>
              </span>
              <span aria-hidden="true" className="text-text-3">·</span>
              <span className="whitespace-nowrap">
                photo rank <span className="text-text">#{current.frame.rank}</span>
                <span className="text-text-3">/{cache.survey.frames.length}</span>
              </span>
              <span aria-hidden="true" className="text-text-3">·</span>
              <span className="whitespace-nowrap">
                {current.detection.lat.toFixed(5)}, {current.detection.lon.toFixed(5)}
              </span>
              {/* The radius stays labelled simulated here too; the flight path is labelled once, in the bar. */}
              <span className="whitespace-nowrap text-accent-soft">±{current.detection.radius_m} m radius · simulated</span>
            </p>

            <section aria-label="Review keys" className="flex flex-col gap-2">
              {phoneBar
                ? createPortal(
                    <div
                      role="group"
                      aria-label="Answer"
                      data-testid="phone-answer-bar"
                      className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-bg/90 px-4 pt-3 backdrop-blur-[16px]"
                      style={{ paddingBottom: "calc(12px + env(safe-area-inset-bottom))" }}
                    >
                      {answerGrid}
                    </div>,
                    document.body,
                  )
                : answerGrid}
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-0.5">
                  <button type="button" onClick={undo} className={secondary}>
                    Undo <KeyHint>Z</KeyHint>
                  </button>
                  <button type="button" onClick={() => setFullFrame(true)} className={secondary}>
                    Full frame <KeyHint>Enter</KeyHint>
                  </button>
                  <button type="button" onClick={showOnMap} className={secondary}>
                    Show on map <KeyHint>M</KeyHint>
                  </button>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => goTo(currentIndex - 1)}
                    disabled={currentIndex <= 0}
                    aria-label="Previous candidate"
                    title="Previous candidate (K)"
                    className={stepButton}
                  >
                    <span aria-hidden="true">‹</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => goTo(currentIndex + 1)}
                    disabled={currentIndex >= items.length - 1}
                    aria-label="Next candidate"
                    title="Next candidate (J)"
                    className={stepButton}
                  >
                    <span aria-hidden="true">›</span>
                  </button>
                </div>
              </div>
            </section>

            {/* Where it sits in the photo: fills whatever height is left, and steps aside when there is none. */}
            <div className="sl-fit">
              <div
                className="sl-fit-item flex flex-col gap-1.5"
                style={{ "--sl-ar": `${current.frame.width_px / current.frame.height_px}` } as CSSProperties}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <Label>Where in the photo</Label>
                  <span className="font-mono text-label text-text-3">Photo {current.frame.id}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setFullFrame(true)}
                  className="group relative block overflow-hidden rounded-md ring-1 ring-border transition-shadow hover:ring-accent/70 focus-visible:ring-accent"
                  title="Open the full frame (Enter)"
                  aria-label={`Open the full frame of photo ${current.frame.id}`}
                >
                  <FrameWithBox
                    src={cacheUrl(folder, current.frame.file)}
                    alt={`Frame ${current.frame.id} with the candidate boxed`}
                    box={current.detection.box_px}
                    testId="frame-context-box"
                    width={current.frame.width_px}
                    height={current.frame.height_px}
                  />
                </button>
              </div>
              {/* The key for the map beside this panel: each answer changes how the pin is drawn. */}
              <div className="sl-fit-alt h-full flex-col justify-end gap-2">
                <Label>On the map</Label>
                <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-small text-text-2">
                  {(
                    [
                      ["unreviewed", "Not answered"],
                      ["person", "Person, pinned"],
                      ["unsure", "Unsure"],
                      ["not_person", "Not a person"],
                    ] as const
                  ).map(([state, text]) => (
                    <li key={state} className="flex items-center gap-2 whitespace-nowrap">
                      <PinMark state={state} size={16} />
                      {text}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {toast}
          </Panel>
        )}

        {current && !compact && (
          <Panel
            ref={candidateRef}
            tabIndex={-1}
            aria-label={`Candidate ${currentIndex + 1} of ${items.length}`}
            data-testid="candidate-panel"
            className="relative flex min-h-0 flex-col gap-5 overflow-y-auto outline-none"
          >
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
                    className="size-96 max-w-full rounded-md object-cover shadow-[0_24px_60px_-24px_rgba(0,0,0,0.9)]"
                  />
                  <Viewfinder />
                </div>
              )}
              <p data-testid="detail" className="font-mono text-small text-text-3">
                Frame {currentLabel} · Rank {current.frame.rank} · Confidence {current.detection.conf.toFixed(3)}
              </p>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {DECISIONS.map(([value, label, key, tone, selectedTone]) => {
                const selected = answers[current.id] === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => answer(value)}
                    data-answer={value}
                    aria-pressed={selected}
                    className={
                      "inline-flex h-12 items-center justify-center gap-2 whitespace-nowrap rounded-full border px-2 text-body md:px-3 transition-[background-color,border-color,transform] duration-150 active:scale-[0.97] " +
                      tone +
                      (selected ? " " + selectedTone : "")
                    }
                  >
                    {selected && <Check />}
                    {label} <KeyHint>{key}</KeyHint>
                  </button>
                );
              })}
            </div>

            {toast}
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
        <FullFrameDialog caption={`${currentLabel} · photo rank #${current.frame.rank}`} onClose={() => setFullFrame(false)}>
          <FrameWithBox
            src={cacheUrl(folder, current.frame.file)}
            alt={`Full frame ${current.frame.id}`}
            box={current.detection.box_px}
            testId="frame-box-large"
            width={current.frame.width_px}
            height={current.frame.height_px}
          />
        </FullFrameDialog>
      )}
    </div>
  );
}
