// The AI re-check (V3 §3; the engine's "second look"), made to be read at a glance: before it runs, one line says what it does
// (OpenCV 5 re-cuts the spot from the full-resolution photo, then Nemotron VL reads it) and one button
// runs it; while it runs, its two steps; done, the verdict first in large words ("Likely a person"), its
// details, the detector's crop beside the OpenCV 5 image the model saw, then each step with what it said
// (the detector score from OpenCV 5 cv2.dnn and the review line, each OpenCV 5 re-look tool, the VL
// model's answer and its reason) and the time it took. Only the record's own facts: no score is invented
// for a step that did not make one. One state per candidate, shared by the review rail and the large
// review frame. A candidate the agent did not give a second look has the button off, and says why.
// Built by lane A.
import { create } from "zustand";
import type { Verdict } from "../contract";
import { relookName, toolName, type ReviewCard } from "./LiveReview";
import { TERMS, thresholdNote } from "../command/terms";

type Run = { stage: "running"; started: number; ms: number } | { stage: "done" };

interface SecondLookState {
  runs: Record<string, Run>;
  run: (id: string, ms: number) => void;
  reset: () => void;
}

/** The progress takes the model's own time, within these bounds (ms), so it is seen and never drags. */
export const RUN_MIN_MS = 900;
export const RUN_MAX_MS = 2400;
const timers = new Map<string, number>();

export const useSecondLook = create<SecondLookState>((set, get) => ({
  runs: {},
  run: (id, ms) => {
    if (get().runs[id]) return;
    const t = Math.min(RUN_MAX_MS, Math.max(RUN_MIN_MS, ms || RUN_MIN_MS));
    set((s) => ({ runs: { ...s.runs, [id]: { stage: "running", started: Date.now(), ms: t } } }));
    timers.set(
      id,
      window.setTimeout(() => {
        timers.delete(id);
        set((s) => ({ runs: { ...s.runs, [id]: { stage: "done" } } }));
      }, t),
    );
  },
  reset: () => {
    for (const t of timers.values()) window.clearTimeout(t);
    timers.clear();
    set({ runs: {} });
  },
}));

/** The button's label: what it does. */
export const SECOND_LOOK_LABEL = TERMS.recheckRun;
const DEFAULT_CHIPS = ["OpenCV 5 zoom", "Nemotron VL"];

/** What each OpenCV 5 re-look tool did (sightline/agent/relook.py). */
export const TOOL_WORDS: Record<string, string> = {
  zoom_native: "cut the spot again from the full-resolution photo",
  enhance_contrast: "raised the local contrast (CLAHE), colour kept",
  redetect_region: "ran the detector again around the spot, native and 2× upscaled",
};

/** The verdict as a headline and its details: "Likely a person" · "2 people", "standing", "red jacket". */
export function verdictHead(v: Verdict): { head: string; tone: "found" | "caution" | "muted"; details: string[] } {
  const details: string[] = [];
  if (v.group_size && v.group_size > 1) details.push(`${v.group_size} people`);
  if (v.posture !== "unknown") details.push(v.posture === "lying" ? "lying down" : v.posture);
  if (v.clothing) details.push(v.clothing);
  if (v.object && v.object !== "other") details.push(`looks like a ${v.object}`);
  if (v.person === "yes") return { head: "Likely a person", tone: "found", details };
  if (v.person === "no") return { head: "Probably not a person", tone: "muted", details };
  return { head: "Unclear", tone: "caution", details };
}

/** The steps the second look took, each with what it said: the detector, the OpenCV 5 tools, the VL model. */
export function secondLookSteps(c: Pick<ReviewCard, "conf" | "threshold" | "detector" | "verdict">): { who: string; said: string }[] {
  const v = c.verdict;
  const steps: { who: string; said: string }[] = [];
  const line = c.threshold !== undefined ? (c.conf < c.threshold ? `, under ${c.threshold.toFixed(2)} (${thresholdNote(c.threshold)})` : `, over ${c.threshold.toFixed(2)}, so it was in ${TERMS.review}`) : "";
  steps.push({ who: c.detector ? `${c.detector} detector` : "Detector", said: `score ${c.conf.toFixed(2)}${line}` });
  if (!v) return steps;
  for (const t of v.tools) steps.push({ who: `OpenCV 5 ${toolName(t)}`, said: TOOL_WORDS[t] ?? "a re-check image" });
  const answer = v.person === "yes" ? "yes, a person" : v.person === "no" ? "no person" : "unclear";
  steps.push({ who: v.model.split("/").at(-1) ?? v.model, said: `${answer}: “${v.reason}”` });
  return steps;
}

const TONE_TEXT = { found: "text-found", caution: "text-caution", muted: "text-text-2" } as const;

export function SecondLook({ c, large = false }: { c: ReviewCard; large?: boolean }) {
  const run = useSecondLook((s) => s.runs[c.id]);
  const available = !!c.words;
  const chips = c.chips?.length ? c.chips : DEFAULT_CHIPS;
  const images = c.relook ?? [];
  const v = c.verdict;
  const head = v ? verdictHead(v) : null;
  // a card in the rail with no re-check: nothing (the large frame keeps the button, off, and says why)
  if (!available && !large) return null;
  return (
    <div role="group" aria-label={TERMS.recheck} className="flex flex-col gap-1.5 rounded-md border border-proposal/40 bg-proposal/5 p-2">
      <p className="flex flex-wrap items-center gap-1.5 text-caption">
        <span className="font-medium text-proposal">{TERMS.recheck}</span>
        {/* the OpenCV 5 chips: on the large frame and the result, not on a small card before it runs */}
        {(large || run?.stage === "done") && <span className="flex flex-wrap gap-1" aria-label="Models">
          {chips.map((m) => (
            <span key={m} className={`rounded-full border px-2 py-px text-caption ${m.startsWith("OpenCV") ? "border-border bg-surface-strong font-medium text-text" : "border-line bg-surface-strong text-text-2"}`}>
              {m}
            </span>
          ))}
        </span>}
      </p>
      {run?.stage !== "done" && (
        <>
          {available && run?.stage !== "running" && <p className="text-caption text-text-2">OpenCV 5 cuts the spot again from the full-resolution photo, then Nemotron VL looks at it and says whether it is a person.</p>}
          <button
            type="button"
            disabled={!available || run?.stage === "running"}
            aria-busy={run?.stage === "running" || undefined}
            onClick={(e) => {
              e.stopPropagation();
              useSecondLook.getState().run(c.id, c.ms ?? 0);
            }}
            title={available ? undefined : `The AI re-check runs on near misses, photos just under the review threshold${c.threshold !== undefined ? ` (${thresholdNote(c.threshold)})` : ""}; this one has none.`}
            className="sl-tap inline-flex h-8 items-center gap-1.5 self-start rounded-full border border-proposal bg-proposal/15 px-3 text-small font-medium text-text hover:bg-proposal/25 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {run?.stage === "running" ? "Looking again…" : SECOND_LOOK_LABEL}
          </button>
        </>
      )}
      {!available && <p className="text-caption text-text-3">No AI re-check on this one: it runs only on near misses, photos just under the review threshold{c.threshold !== undefined ? ` (${thresholdNote(c.threshold)})` : ""}.</p>}
      {run?.stage === "running" && (
        <div aria-label="AI re-check running" className="flex flex-col gap-1">
          <span className="relative h-1 overflow-hidden rounded-full bg-surface-strong">
            <span className="sl-progress absolute inset-y-0 left-0 rounded-full bg-proposal" style={{ animationDuration: `${run.ms}ms` }} />
          </span>
          <span className="text-caption text-text-3">OpenCV 5 cuts the spot from the full-resolution photo, then Nemotron VL looks at it…</span>
        </div>
      )}
      {run?.stage === "done" && (
        <div aria-label="AI re-check result" className="sl-slide-in flex flex-col gap-2">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className={`${large ? "text-title" : "text-body"} font-semibold ${head ? TONE_TEXT[head.tone] : "text-text"}`}>{head ? head.head : (c.words ?? "")}</span>
            <span className="ml-auto text-caption text-text-3">{TERMS.recheck} done{c.ms ? ` in ${(c.ms / 1000).toFixed(1)} s` : ""}</span>
          </p>
          {head && head.details.length > 0 && <p className="text-small text-text">{head.details.join(" · ")}</p>}
          {(images.length > 0 || c.crop) && (
            <div className="grid grid-cols-2 gap-1.5">
              {c.crop && (
                <figure className="flex flex-col gap-0.5">
                  <img loading="lazy" decoding="async" src={c.crop} alt={`Detector crop of ${c.id}`} className="aspect-square w-full rounded-sm object-cover" />
                  <figcaption className="text-caption text-text-3">detector crop</figcaption>
                </figure>
              )}
              {images.map((r) => (
                <figure key={r.url + r.name} className="flex flex-col gap-0.5">
                  <img loading="lazy" decoding="async" src={r.url} alt={`Re-look image ${r.name}`} className="aspect-square w-full rounded-sm object-cover" />
                  <figcaption className="text-caption text-text-3">OpenCV 5 {relookName(r.name)}</figcaption>
                </figure>
              ))}
            </div>
          )}
          {v ? (
            <ol aria-label="What each model said" className="flex flex-col gap-1 border-t border-proposal/20 pt-1.5 text-caption">
              {secondLookSteps(c).map((s, i) => (
                <li key={s.who + i} className="flex gap-1.5">
                  <span className="sl-num shrink-0 text-text-3">{i + 1}</span>
                  <span className="min-w-0">
                    <span className="font-medium text-text">{s.who}</span> <span className="text-text-2">{s.said}</span>
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            c.words && <p className="text-small text-text">{c.words}</p>
          )}
        </div>
      )}
    </div>
  );
}
