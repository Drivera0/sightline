// The Review view: the console's right rail of candidates, most confident first, each with the second
// look's verdict in words and which models made it, and Person / Not a person / Unsure. One list for a
// live mission (answers go to POST /reviews through useMission, LANE_D §5.5 D-Q1), the demo mission (a
// Person pins a sighting on the map) and Try a photo (your own photo's boxes, at the top).

import { useEffect, useRef, useState, type ReactNode } from "react";
import { isTyping } from "../lib/keys";
import type { Detection, Detections, Survey, Verdict } from "../contract";
import { Badge, EmptyState, Label } from "../shell/components";

export type LiveAnswer = "person" | "not_person" | "unsure";

/** "relook/f0003-d01-zoom_native.jpg" → "zoom native": which OpenCV 5 tool made the image. */
export function relookName(rel: string): string {
  const base = rel.split("/").at(-1)?.replace(/\.[a-z]+$/i, "") ?? rel;
  const tool = /^f\d{4}-d\d{2}-(.+)$/.exec(base)?.[1] ?? base;
  return tool.replace(/_/g, " ");
}

/** "Second look: likely a person · lying down · red jacket", or "Second look: unclear". Always words. */
export function verdictWords(v: Verdict | undefined): string | null {
  if (!v) return null;
  if (v.person === "unclear") return "Second look: unclear";
  if (v.person === "no") return "Second look: probably not a person";
  const parts = ["Second look: likely a person"];
  if (v.posture !== "unknown") parts.push(v.posture === "lying" ? "lying down" : v.posture);
  if (v.group_size && v.group_size > 1) parts.push(`${v.group_size} people`);
  if (v.clothing) parts.push(v.clothing);
  return parts.join(" · ");
}

/** The models behind a verdict, as chips: the OpenCV 5 tools it used, then the VL model. */
export function verdictChips(v: Verdict | undefined): string[] {
  if (!v) return [];
  const model = v.model.split("/").at(-1) ?? v.model;
  return [...v.tools.map((t) => `OpenCV 5 ${t.replace(/_/g, " ")}`), model];
}

export function liveReviewItems(detections: Detections | null, promoted: readonly string[]): Detection[] {
  if (!detections) return [];
  return Object.values(detections.frames)
    .flat()
    .filter((d) => d.conf >= detections.candidate_threshold || promoted.includes(d.id))
    .sort((a, b) => b.conf - a.conf || a.id.localeCompare(b.id));
}

const ANSWERS: { id: LiveAnswer; label: string }[] = [
  { id: "person", label: "Person" },
  { id: "not_person", label: "Not a person" },
  { id: "unsure", label: "Unsure" },
];

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
}

/** One candidate: crop, score, verdict in words with its model chips, the three answers. */
function Card({ c, rank, answer, current, onAnswer }: { c: ReviewCard; rank: number; answer: LiveAnswer | undefined; current: boolean; onAnswer: (a: LiveAnswer) => void }) {
  const [shown, setShown] = useState(false);
  const el = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (current) el.current?.scrollIntoView?.({ block: "nearest" });
  }, [current]);
  return (
    <li ref={el} aria-label={`Candidate ${c.id}`} aria-current={current || undefined} data-candidate={c.id} className={`flex flex-col gap-2 rounded-lg border bg-surface-solid p-2.5 ${current ? "border-border" : "border-line"}`}>
      <div className="flex gap-3">
        <img loading="lazy" decoding="async" width={80} height={80} src={c.crop} alt={`Crop of ${c.id}`} className="size-20 shrink-0 rounded-sm object-cover" />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-small text-text-3">#{rank}</span>
            <span className="text-small text-text">{c.conf.toFixed(2)}</span>
            <span className="truncate font-mono text-caption text-text-3">{c.id}</span>
            {c.promoted && <Badge kind="info">Promoted</Badge>}
          </span>
          <Label className="truncate normal-case tracking-normal">{c.frame}</Label>
          {c.words && <p className="text-small text-text-2">{c.words}</p>}
          {c.chips && c.chips.length > 0 && (
            <span className="flex flex-wrap gap-1" aria-label="Models">
              {c.chips.map((m) => (
                <span key={m} className="rounded-full border border-line bg-surface-strong px-2 py-px text-caption text-text-2">
                  {m}
                </span>
              ))}
            </span>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {ANSWERS.map((a) => (
          <button
            key={a.id}
            type="button"
            aria-pressed={answer === a.id}
            onClick={() => onAnswer(a.id)}
            className={`sl-tap rounded-full border px-3 py-0.5 text-small ${answer === a.id ? (a.id === "person" ? "border-ok bg-ok/10 text-text" : "border-accent text-text") : "border-border text-text-2 hover:text-text"}`}
          >
            {a.label}
          </button>
        ))}
      </div>
      {(c.relook?.length ?? 0) > 0 && (
        // the OpenCV 5 re-look images the second look saw (D-Q1), on demand: they are larger files
        <div className="flex flex-col gap-1">
          <button type="button" className="self-start text-small text-accent-soft underline" aria-expanded={shown} onClick={() => setShown(!shown)}>
            {shown ? "Hide the second look's images" : `Show the second look's images (${c.relook!.length})`}
          </button>
          {shown && (
            <div className="grid grid-cols-2 gap-1">
              {c.relook!.map((r) => (
                <figure key={r.url} className="flex flex-col gap-0.5">
                  <img loading="lazy" decoding="async" src={r.url} alt={`Re-look image ${r.name}`} className="aspect-square w-full rounded-sm object-cover" />
                  <figcaption className="text-caption text-text-3">{relookName(r.name)}</figcaption>
                </figure>
              ))}
            </div>
          )}
        </div>
      )}
      {c.note && <p className="text-caption text-text-3">{c.note}</p>}
    </li>
  );
}

export function ReviewRail({
  cards,
  answers,
  onAnswer,
  top,
  empty = "Candidates appear here as photos are processed.",
}: {
  cards: readonly ReviewCard[];
  answers: Readonly<Record<string, LiveAnswer>>;
  onAnswer: (id: string, answer: LiveAnswer) => void;
  /** Above the queue: your own photo from Try a photo. */
  top?: ReactNode;
  empty?: string;
}) {
  const done = cards.filter((c) => answers[c.id]).length;
  // J/K (or the arrows) move through the queue, P/N/U answer the current candidate (LANE_D §9.2)
  const [cur, setCur] = useState(0);
  const at = Math.min(cur, Math.max(0, cards.length - 1));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey || cards.length === 0) return;
      const k = e.key.toLowerCase();
      const id = cards[at]?.id;
      if (k === "j" || e.key === "ArrowDown") setCur(Math.min(at + 1, cards.length - 1));
      else if (k === "k" || e.key === "ArrowUp") setCur(Math.max(at - 1, 0));
      else if (id && (k === "p" || k === "n" || k === "u")) {
        onAnswer(id, k === "p" ? "person" : k === "n" ? "not_person" : "unsure");
        setCur(Math.min(at + 1, cards.length - 1));
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cards, at, onAnswer]);
  return (
    <section aria-label="Review" data-tour="review" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between px-1">
        <span className="text-caption font-medium text-text-2">
          Review queue <span className="font-normal text-text-3">· what the detector flagged, for you to confirm</span>
        </span>
        {cards.length > 0 && (
          <span className="text-caption text-text-3">
            {done} of {cards.length} answered
          </span>
        )}
      </div>
      {top}
      {cards.length === 0 ? (
        <EmptyState title="No candidates yet">{empty}</EmptyState>
      ) : (
        <ol className="flex flex-col gap-2">
          {cards.map((c, i) => (
            <Card key={c.id} c={c} rank={i + 1} answer={answers[c.id]} current={i === at} onAnswer={(a) => onAnswer(c.id, a)} />
          ))}
        </ol>
      )}
    </section>
  );
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
  onAnswer: (detectionId: string, answer: LiveAnswer) => void;
  top?: ReactNode;
}) {
  const [answers, setAnswers] = useState<Record<string, LiveAnswer>>({});
  const latest = new Map<string, Verdict>();
  for (const v of verdicts) latest.set(v.detection_id, v);
  const frameName = (id: string) => survey?.frames.find((f) => f.id === id.slice(0, 5))?.source.image ?? id.slice(0, 5);
  const cards: ReviewCard[] = liveReviewItems(detections, promoted).map((d) => {
    const v = latest.get(d.id);
    return {
      id: d.id,
      conf: d.conf,
      crop: imageUrl(d.crop ?? `crops/nearmiss/${d.id}.jpg`),
      frame: frameName(d.id),
      words: verdictWords(v),
      chips: verdictChips(v),
      relook: v?.relook_crops.map((rel) => ({ url: imageUrl(rel), name: rel })),
      promoted: promoted.includes(d.id),
    };
  });
  return (
    <ReviewRail
      cards={cards}
      answers={answers}
      top={top}
      onAnswer={(id, a) => {
        setAnswers((x) => ({ ...x, [id]: a }));
        onAnswer(id, a);
      }}
    />
  );
}
