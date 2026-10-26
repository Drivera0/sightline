// The Review view: the console's right rail of candidates, most confident first, each with the second
// look's verdict in words and which models made it, and the answers (answers.tsx: Person, Not a person,
// Not the subject, Object with its type, Unsure). One list for a
// live mission (answers go to POST /reviews through useMission, LANE_D §5.5 D-Q1), the demo mission (a
// Person pins a sighting on the map) and Try a photo (your own photo's boxes, at the top).

import { useEffect, useRef, useState, type ReactNode } from "react";
import { isTyping } from "../lib/keys";
import { useSelection } from "../lib/selection";

/** Put a candidate in focus: the map outlines its photo and pulses its pin (V3 §2). */
export function focusCandidate(id: string | null): void {
  try {
    useSelection.getState().selectDetection(id);
  } catch {
    /* a photo dropped in this browser has no survey id */
  }
}
import type { Detection, Detections, Survey, Verdict } from "../contract";
import { Badge, EmptyState } from "../shell/components";
import { SecondLook } from "./SecondLook";
import { answerForKey, ObjectPicker, REVIEW_ANSWERS, usePickerKeys, type LiveAnswer, type ObjectKind } from "./answers";
import { TERMS, thresholdNote } from "../command/terms";

/** While the large review frame is open it owns P/N/U and J/K; the rail's own keys stand down. */
export const reviewKeys = { frameOpen: false };

export type { LiveAnswer, ObjectKind } from "./answers";

/** How a candidate is answered: the answer, and with "object" its type. */
export type OnAnswer = (id: string, answer: LiveAnswer, object?: ObjectKind) => void;

/** Each OpenCV 5 re-check tool's short name ("zoom_native" → "zoom"). */
const TOOL_NAMES: Record<string, string> = { zoom_native: "zoom", enhance_contrast: "contrast", redetect_region: "re-detect" };
export const toolName = (t: string) => TOOL_NAMES[t] ?? t.replace(/_/g, " ");

/** "relook/f0003-d01-zoom_native.jpg" → "zoom": which OpenCV 5 tool made the image. */
export function relookName(rel: string): string {
  const base = rel.split("/").at(-1)?.replace(/\.[a-z]+$/i, "") ?? rel;
  const tool = /^f\d{4}-d\d{2}-(.+)$/.exec(base)?.[1] ?? base;
  return toolName(tool);
}

/** "AI re-check: likely a person · lying down · red jacket", or "AI re-check: unclear". Always words. */
export function verdictWords(v: Verdict | undefined): string | null {
  if (!v) return null;
  const thing = v.object && v.object !== "other" ? ` · looks like a ${v.object}` : "";
  if (v.person === "unclear") return `${TERMS.recheck}: unclear${thing}`;
  if (v.person === "no") return `${TERMS.recheck}: probably not a person${thing}`;
  const parts = [`${TERMS.recheck}: likely a person`];
  if (v.posture !== "unknown") parts.push(v.posture === "lying" ? "lying down" : v.posture);
  if (v.group_size && v.group_size > 1) parts.push(`${v.group_size} people`);
  if (v.clothing) parts.push(v.clothing);
  return parts.join(" · ");
}

/** The models behind a verdict, as chips: the OpenCV 5 tools it used, then the VL model. */
export function verdictChips(v: Verdict | undefined): string[] {
  if (!v) return [];
  const model = v.model.split("/").at(-1) ?? v.model;
  return [...v.tools.map((t) => `OpenCV 5 ${toolName(t)}`), model];
}

/** "Survey photo f0336" → "Survey photo 336": the photo's number, not its id (the id is on hover and in the Trace). */
export const photoName = (frame: string) => frame.replace(/\bf0*(\d+)\b/, "$1").replace(/, below the [\d.]+ review threshold/, "");

export function liveReviewItems(detections: Detections | null, promoted: readonly string[]): Detection[] {
  if (!detections) return [];
  return Object.values(detections.frames)
    .flat()
    .filter((d) => d.conf >= detections.candidate_threshold || promoted.includes(d.id))
    .sort((a, b) => b.conf - a.conf || a.id.localeCompare(b.id));
}

export interface ReviewCard {
  id: string;
  conf: number;
  /** The crop's address. */
  crop: string;
  /** The photo it is in. */
  frame: string;
  words: string | null;
  /** Which models made the second look ("OpenCV 5 zoom native", "Nemotron-3.5-Super-VL"). */
  chips?: string[];
  /** The second look's images, loaded on demand. */
  relook?: { url: string; name: string }[];
  promoted?: boolean;
  /** A line under the card (where it came from, what an answer does). */
  note?: string;
  /** How long the second look took (ms), when it ran. */
  ms?: number;
  /** A distractor frame (`fixture.distractors`): a ground-level photo of an object among the aerial ones. */
  distractor?: boolean;
  /** What the second look thinks the thing is, when not a person (the object picker marks it). */
  object?: ObjectKind | null;
  /** The whole photo, its size in pixels and the candidate's box in it (the review frame shows them). */
  photo?: string;
  size?: [number, number];
  box?: [number, number, number, number];
  /** The second look's own record, when it ran: each model's answer, shown step by step. */
  verdict?: Verdict;
  /** The review queue's line on the detector score (a near miss is under it). */
  threshold?: number;
  /** What made the score: DETECTOR_CV2 for the pipeline's detector, another name for another path; unset: not said. */
  detector?: string;
}

/** The pipeline's detector: YOLO11s trained on HERIDAL, run by OpenCV 5's DNN module (sightline/ml/backend.py, cv2 by default). */
export const DETECTOR_CV2 = "OpenCV 5 · cv2.dnn";
/** Try a photo and dropped photos: the same weights in the browser. */
export const DETECTOR_BROWSER = "ONNX Runtime Web";

/** The detector score with what made it: "OpenCV 5 · cv2.dnn 0.17" as one chip. */
/** `brand`: say what made the score (the large frame, the home page); a small card shows the number only. */
export function DetectorScore({ c, className = "", brand = true }: { c: Pick<ReviewCard, "conf" | "detector" | "threshold">; className?: string; brand?: boolean }) {
  const cv = c.detector === DETECTOR_CV2;
  const title = cv
    ? `Detector score from YOLO11s (trained on HERIDAL) run by OpenCV 5 cv2.dnn${c.threshold !== undefined ? `; ${thresholdNote(c.threshold)}` : ""}`
    : c.detector
      ? `Detector score from the same weights in ${c.detector}`
      : "Detector score";
  return (
    <span title={title} aria-label={`${c.detector ? `${c.detector} ` : ""}detector score ${c.conf.toFixed(2)}`} className={`inline-flex items-center overflow-hidden rounded-full border text-caption ${cv ? "border-border" : "border-line"} ${className}`}>
      {c.detector && brand && <span className={`px-2 py-px ${cv ? "bg-surface-strong font-medium text-text" : "text-text-2"}`}>{c.detector}</span>}
      {!brand && <span className="pl-2 text-text-3">score</span>}
      <span className="sl-num px-2 py-px font-medium text-text">{c.conf.toFixed(2)}</span>
    </span>
  );
}

/** What the "object photo" badge says on hover: why a ground-level photo is among the aerial ones. */
export const OBJECT_PHOTO_TITLE = "An object photo: a ground-level picture of a thing a lost person might leave, placed among the drone's aerial photos";

/** The badge on a distractor frame's photo. */
export function ObjectPhotoBadge({ className = "" }: { className?: string }) {
  return (
    <span title={OBJECT_PHOTO_TITLE} className={`inline-flex items-center rounded-full border border-[color-mix(in_srgb,var(--clue)_55%,transparent)] bg-bg/85 px-2 py-px text-caption text-text ${className}`}>
      object photo
    </span>
  );
}

/** One candidate: crop, score, verdict in words with its model chips, the answers (Object opens its type picker). */
function Card({ c, rank, answer, current, picking, onPicking, onAnswer, onPick }: { c: ReviewCard; rank: number; answer: LiveAnswer | undefined; current: boolean; picking: boolean; onPicking: (on: boolean) => void; onAnswer: (a: LiveAnswer, object?: ObjectKind) => void; onPick?: () => void }) {
  const el = useRef<HTMLLIElement>(null);
  // J/K bring the current candidate into view; the first one does not pull its rail (Needs you) down on arrival
  const was = useRef(current);
  useEffect(() => {
    if (current && !was.current) el.current?.scrollIntoView?.({ block: "nearest" });
    was.current = current;
  }, [current]);
  return (
    <li ref={el} aria-label={`Photo to review ${c.id}`} aria-current={current || undefined} data-candidate={c.id} onClick={onPick} className={`sl-slide-in flex flex-col gap-2 rounded-lg border bg-surface-solid p-2.5 ${current ? "border-border" : "border-line"}`}>
      <div className="flex gap-3">
        <img loading="lazy" decoding="async" width={80} height={80} src={c.crop} alt={`Crop of ${c.id}`} className="size-20 shrink-0 rounded-sm object-cover" />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-small text-text-3">#{rank}</span>
            <DetectorScore c={c} brand={false} />
            {c.promoted && <Badge kind="info">{TERMS.recheckFlagged}</Badge>}
            {c.distractor && <ObjectPhotoBadge />}
          </span>
          <span className="truncate text-caption text-text-2" title={c.id}>{photoName(c.frame)}</span>
        </div>
      </div>
      <SecondLook c={c} />
      <div className="flex flex-wrap gap-1.5">
        {REVIEW_ANSWERS.map((a) => (
          <button
            key={a.id}
            type="button"
            aria-pressed={answer === a.id || (a.id === "object" && picking)}
            title={`${a.title} (${a.key})`}
            onClick={() => (a.id === "object" ? onPicking(!picking) : onAnswer(a.id))}
            className={`sl-tap rounded-full border px-3 py-0.5 text-small ${answer === a.id || (a.id === "object" && picking) ? (a.id === "person" ? "border-ok bg-ok/10 text-text" : a.id === "object" ? "border-[var(--clue)] text-text" : "border-accent text-text") : "border-border text-text-2 hover:text-text"}`}
          >
            {a.label}
          </button>
        ))}
      </div>
      {picking && <ObjectPicker suggested={c.object} onPick={(o) => onAnswer("object", o)} onCancel={() => onPicking(false)} />}
      {c.note && <p className="text-caption text-text-3">{c.note}</p>}
    </li>
  );
}

export function ReviewRail({
  cards,
  answers,
  onAnswer,
  top,
  empty = "Photos to review appear here as the drones' photos are processed.",
}: {
  cards: readonly ReviewCard[];
  answers: Readonly<Record<string, LiveAnswer>>;
  onAnswer: OnAnswer;
  /** Above the queue: your own photo from Try a photo. */
  top?: ReactNode;
  empty?: string;
}) {
  const done = cards.filter((c) => answers[c.id]).length;
  // J/K (or the arrows) move through the queue, P/N/U answer the current candidate (LANE_D §9.2)
  const [cur, setCur] = useState(0);
  const at = Math.min(cur, Math.max(0, cards.length - 1));
  // the candidate whose object type picker is open (Object, or O on the current one)
  const [picking, setPicking] = useState<string | null>(null);
  const answer = (id: string, a: LiveAnswer, object?: ObjectKind) => {
    setPicking(null);
    if (object) onAnswer(id, a, object);
    else onAnswer(id, a);
  };
  usePickerKeys(picking !== null && !reviewKeys.frameOpen, (o) => picking && answer(picking, "object", o), () => setPicking(null));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (reviewKeys.frameOpen || isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey || cards.length === 0) return;
      const k = e.key.toLowerCase();
      const id = cards[at]?.id;
      if (k === "j" || e.key === "ArrowDown") {
        setCur(Math.min(at + 1, cards.length - 1));
        focusCandidate(cards[Math.min(at + 1, cards.length - 1)]?.id ?? null);
      } else if (k === "k" || e.key === "ArrowUp") {
        setCur(Math.max(at - 1, 0));
        focusCandidate(cards[Math.max(at - 1, 0)]?.id ?? null);
      }
      else if (id && answerForKey(k) === "object") setPicking(id);
      else if (id && answerForKey(k)) {
        answer(id, answerForKey(k)!);
        setCur(Math.min(at + 1, cards.length - 1));
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cards, at, onAnswer]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section aria-label="Review" data-tour="review" className="flex flex-col gap-2">
      {/* the same head as Needs you's other groups: a dot, the name, the count */}
      <div className="flex items-baseline gap-1.5 px-1 pt-1">
        <span aria-hidden className="size-2 shrink-0 self-center rounded-full bg-text-2" />
        <span className="text-caption font-medium text-text-2">{TERMS.review}</span>
        {cards.length > 0 && <span className="sl-num text-caption text-text-3">{cards.length - done}</span>}
        {cards.length > 0 && (
          <span className="ml-auto text-caption text-text-3">
            {done} of {cards.length} answered
          </span>
        )}
      </div>
      {top}
      {cards.length === 0 ? (
        <EmptyState title="No photos to review yet">{empty}</EmptyState>
      ) : (
        <ol className="flex flex-col gap-2">
          {cards.map((c, i) => (
            <Card
              key={c.id}
              c={c}
              rank={i + 1}
              answer={answers[c.id]}
              current={i === at}
              picking={picking === c.id}
              onPicking={(on) => setPicking(on ? c.id : null)}
              onAnswer={(a, o) => answer(c.id, a, o)}
              onPick={() => {
                setCur(i);
                focusCandidate(c.id);
              }}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

/** A live mission's candidates as review cards: the crop, the photo and the box, the second look when it ran. */
export function liveCards(
  detections: Detections | null,
  survey: Survey | null,
  verdicts: readonly Verdict[],
  promoted: readonly string[],
  imageUrl: (rel: string) => string,
): ReviewCard[] {
  const latest = new Map<string, Verdict>();
  for (const v of verdicts) latest.set(v.detection_id, v);
  return liveReviewItems(detections, promoted).map((d) => {
    const v = latest.get(d.id);
    const f = survey?.frames.find((x) => x.id === d.id.slice(0, 5));
    return {
      id: d.id,
      conf: d.conf,
      crop: imageUrl(d.crop ?? `crops/nearmiss/${d.id}.jpg`),
      frame: f?.source.image ?? d.id.slice(0, 5),
      words: verdictWords(v),
      chips: verdictChips(v),
      relook: v?.relook_crops.map((rel) => ({ url: imageUrl(rel), name: rel })),
      promoted: promoted.includes(d.id),
      ms: v?.ms,
      verdict: v,
      threshold: detections?.candidate_threshold,
      detector: DETECTOR_CV2,
      object: v?.object ?? null,
      ...(f ? { photo: imageUrl(f.file), size: [f.width_px, f.height_px] as [number, number], box: d.box_px } : {}),
    };
  });
}

/** A live mission's queue: its candidates and approved promotions, with the second look's verdicts. */
export function LiveReview({
  detections,
  survey,
  verdicts,
  promoted,
  imageUrl,
  onAnswer,
  top,
}: {
  detections: Detections | null;
  survey: Survey | null;
  verdicts: readonly Verdict[];
  promoted: readonly string[];
  imageUrl: (rel: string) => string;
  onAnswer: OnAnswer;
  top?: ReactNode;
}) {
  const [answers, setAnswers] = useState<Record<string, LiveAnswer>>({});
  const cards = liveCards(detections, survey, verdicts, promoted, imageUrl);
  return (
    <ReviewRail
      cards={cards}
      answers={answers}
      top={top}
      onAnswer={(id, a, o) => {
        setAnswers((x) => ({ ...x, [id]: a }));
        if (o) onAnswer(id, a, o);
        else onAnswer(id, a);
      }}
    />
  );
}
