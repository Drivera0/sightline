// The guided search's mark on the real console (driver.js's pattern, hand-rolled: no dependency): a ring
// around the real control a decision is about, and a coach bar along the top of the map that says where to
// act (never a second set of the console's buttons). A mark names its element by a CSS selector,
// or by several in order of preference (the card it is about, else its panel); a selector that starts with
// "group:" rings its first few matches together (two cards, a call and its clue). The old step-through
// story's marks are gone: the walk-through is the guided search (GuideMark, below).

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { isTyping } from "../lib/keys";
import { Button, KeyHint } from "../shell/components";

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** The part of an element on screen: cut to every scrolling box it sits in (a rail) and to the window. */
function visibleRect(el: HTMLElement): Box {
  const r = el.getBoundingClientRect();
  let [top, left, bottom, right] = [r.top, r.left, r.bottom, r.right];
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === "auto" || o === "scroll" || o === "hidden") {
      const q = p.getBoundingClientRect();
      [top, left, bottom, right] = [Math.max(top, q.top), Math.max(left, q.left), Math.min(bottom, q.bottom), Math.min(right, q.right)];
    }
  }
  [top, left, bottom, right] = [Math.max(top, 0), Math.max(left, 0), Math.min(bottom, window.innerHeight), Math.min(right, window.innerWidth)];
  return { top, left, width: right - left, height: bottom - top };
}

const CARD_W = 320;
const GAP = 12;

/** What a mark should never cover when it can help it: the status line over the map and the scrubber. */
export const KEEP_VISIBLE = ['[aria-label="Mission status"]', '[data-tour="scrubber"]'] as const;

const overlaps = (a: Box, b: Box) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;

/**
 * Where the card goes: beside the target where there is room (its top, its bottom or its middle level with
 * the target's), else under or over it; phones: along the bottom. Of those, the first that covers none of
 * `avoid` (the status line, the scrubber); when every one does, the first.
 */
export function placeCard(target: Box | null, vw: number, vh: number, cardH = 180, avoid: readonly Box[] = []): { top: number; left: number } | null {
  if (vw < 640 || !target) return null;
  const clampTop = (y: number) => Math.max(GAP, Math.min(y, vh - cardH - GAP));
  const levels = [target.top, target.top + target.height - cardH, target.top + (target.height - cardH) / 2].map(clampTop);
  const spots: { top: number; left: number }[] = [];
  if (target.left >= CARD_W + 2 * GAP) for (const top of levels) spots.push({ top, left: target.left - CARD_W - GAP });
  if (vw - (target.left + target.width) >= CARD_W + 2 * GAP) for (const top of levels) spots.push({ top, left: target.left + target.width + GAP });
  const left = Math.max(GAP, Math.min(target.left, vw - CARD_W - GAP));
  if (vh - (target.top + target.height) >= cardH + 2 * GAP) spots.push({ top: target.top + target.height + GAP, left });
  spots.push({ top: clampTop(target.top - cardH - GAP), left });
  const free = spots.find((s) => !avoid.some((a) => overlaps({ ...s, width: CARD_W, height: cardH }, a)));
  return free ?? spots[0]!;
}

/** One selector, or several in order of preference. */
export type Target = string | readonly string[];

/** "group:<selector>": the first few matches, ringed as one. */
export const GROUP = "group:";
const GROUP_MAX = 3;

/**
 * The elements a mark points at: of the selectors in order, the first that matches something on screen (a
 * phone and a desktop can each have their own), else the first that matches anything. One element, or for
 * a "group:" selector its first few on screen.
 */
export function findTargets(target: Target): HTMLElement[] {
  const list = typeof target === "string" ? [target] : target;
  let hidden: HTMLElement[] = [];
  for (const raw of list) {
    const group = raw.startsWith(GROUP);
    let all: HTMLElement[] = [];
    try {
      all = [...document.querySelectorAll<HTMLElement>(group ? raw.slice(GROUP.length) : raw)];
    } catch {
      continue; // a selector this browser cannot read (:has on an old engine): the next one
    }
    const shown = all.filter((el) => el.getClientRects().length > 0);
    if (shown.length) return group ? shown.slice(0, GROUP_MAX) : [shown[0]!];
    if (!hidden.length && all[0]) hidden = [all[0]];
  }
  return hidden;
}

/** The first element a mark points at (see findTargets). */
export function findTarget(target: Target): HTMLElement | null {
  return findTargets(target)[0] ?? null;
}

/** A card (not a whole panel) that its scrolling panel cuts off. */
function clipped(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  if (r.height <= 0 || r.height > 320) return false;
  const v = visibleRect(el);
  return v.height < r.height - 1 && v.top >= 0 && v.top + v.height <= window.innerHeight;
}

/** The box around several boxes. */
function union(boxes: readonly Box[]): Box | null {
  const real = boxes.filter((b) => b.width > 0 && b.height > 0);
  if (!real.length) return null;
  const top = Math.min(...real.map((b) => b.top));
  const left = Math.min(...real.map((b) => b.left));
  const bottom = Math.max(...real.map((b) => b.top + b.height));
  const right = Math.max(...real.map((b) => b.left + b.width));
  return { top, left, width: right - left, height: bottom - top };
}

/** Where a mark's target is on screen, followed as it renders late, moves or scrolls; and what to keep clear of. */
function useTargetBox(target: Target): { box: Box | null; avoid: Box[]; view: { w: number; h: number }; anchor: { current: Target } } {
  const [box, setBox] = useState<Box | null>(null);
  const [avoid, setAvoid] = useState<Box[]>([]);
  const anchor = useRef(target);
  anchor.current = target;
  // the target as a value, so a new array with the same selectors does not restart the measuring
  const targetKey = typeof target === "string" ? target : target.join("\n");
  const [view, setView] = useState({ w: typeof window === "undefined" ? 1440 : window.innerWidth, h: typeof window === "undefined" ? 900 : window.innerHeight });

  // follow the target: it may render late (a rail switching views) or move (the rails scroll)
  useLayoutEffect(() => {
    let frame = 0;
    // scrolled to once per element: a target that renders late (the phone's photo strip once the
    // photos load) takes over from the one found first
    let scrolled: HTMLElement | null = null;
    // On a phone the panels stack, and the ones above the target keep loading for a moment (photos,
    // proposals): for a short while the target is kept where it was put, until the visitor scrolls.
    let want = 0;
    let settleUntil = 0;
    let moved = false;
    // On a desktop the panels scroll on their own (Needs you, the timeline, Resources): where a mark scrolled
    // one, it goes back when the mark moves on (unless the visitor has scrolled since), so the next moment's
    // newest entries are on top again.
    const saved = new Map<HTMLElement, number>();
    let wheeled = false;
    const remember = (el: HTMLElement) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const o = getComputedStyle(p).overflowY;
        if ((o === "auto" || o === "scroll") && !saved.has(p)) saved.set(p, p.scrollTop);
      }
    };
    const scrollTo = (els: readonly HTMLElement[], phone: boolean) => {
      const el = els[0]!;
      if (!phone) for (const x of els) remember(x);
      // a group: its last one in view first, then its first, so both ends are on screen where they fit
      if (!phone && els.length > 1) els.at(-1)!.scrollIntoView({ block: "nearest", inline: "nearest" });
      // on a phone the card sits along the bottom: bring the target to the top
      el.scrollIntoView({ block: phone ? "start" : "nearest", inline: "nearest" });
      want = el.getBoundingClientRect().top;
    };
    const measure = () => {
      const els = findTargets(anchor.current);
      const el = els[0] ?? null;
      const phone = window.innerWidth < 640;
      if (el && el !== scrolled && typeof el.scrollIntoView === "function") {
        scrollTo(els, phone);
        scrolled = el;
        settleUntil = performance.now() + 3000;
      } else if (el && phone && !moved && performance.now() < settleUntil && Math.abs(el.getBoundingClientRect().top - want) > 8) {
        scrollTo(els, phone);
      } else if (el && !phone && !wheeled && els.some(clipped)) {
        // the panel reordered under the mark (teams go out, drones sort by battery): bring the cards back in view
        scrollTo(els, phone);
      }
      const r = union(els.map(visibleRect));
      setBox((b) => {
        if (!r || r.width <= 0 || r.height <= 0) return null;
        const next = { top: r.top, left: r.left, width: r.width, height: r.height };
        return b && b.top === next.top && b.left === next.left && b.width === next.width && b.height === next.height ? b : next;
      });
      setView((v) => (v.w === window.innerWidth && v.h === window.innerHeight ? v : { w: window.innerWidth, h: window.innerHeight }));
      const keep = KEEP_VISIBLE.map((s) => findTarget(s))
        .filter((x): x is HTMLElement => x !== null && x !== el && !x.contains(el) && !el?.contains(x))
        .map((x) => x.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0)
        .map((r) => ({ top: r.top, left: r.left, width: r.width, height: r.height }));
      setAvoid((a) => (JSON.stringify(a) === JSON.stringify(keep) ? a : keep));
    };
    measure();
    const id = window.setInterval(measure, 250);
    const on = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const user = (e: Event) => {
      moved = true;
      if (e.type !== "pointerdown") wheeled = true;
    };
    window.addEventListener("resize", on);
    window.addEventListener("scroll", on, true);
    for (const k of ["wheel", "touchmove", "pointerdown"] as const) window.addEventListener(k, user, { passive: true });
    return () => {
      window.clearInterval(id);
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", on);
      window.removeEventListener("scroll", on, true);
      for (const k of ["wheel", "touchmove", "pointerdown"] as const) window.removeEventListener(k, user);
      if (!wheeled) for (const [p, top] of saved) p.scrollTop = top;
    };
  }, [targetKey]);
  return { box, avoid, view, anchor };
}

// ---- The guided search's coach bar (guide.ts): "Your call" or "Watch this", never both ----

export interface GuideOption {
  key: string;
  id: string;
  label: string;
  effect: string;
  costMin: number;
  agent?: boolean;
  /** The console's own control that does it (guide.ts Option.on): no button here, the key still works. */
  on?: string;
}

/** The coach bar's width on the map: room for the legend on the left. */
export const barWidth = (mapWidth: number) => Math.max(320, Math.min(560, mapWidth - 240));

/**
 * The guided search's coach bar, docked at the top of the Needs you column (never over the map; a bottom sheet on a phone), with the step strip on top. It
 * holds no button the console already has. "Your call": the step ("Step 2 of 6 ·
 * Triage"), one line saying where to act, the agent's reason, an amber ring and "Do this first" on the
 * real control (the card's Approve, Confirm on the read-back, the photo's answers), the clock paused;
 * buttons only for the choices the console has no control for (a serpentine survey, a relay drone), with
 * what each costs. The keys work either way: A the agent's option, 1–4 an option, M a sector on the map.
 * "Watch this": the time-lapse to the next decision, the mission clock large, the row that just landed,
 * Pause (Space), the speed and Skip ahead (→). "Watch instead" plays the agent's line; T takes over. Esc
 * closes overlays only: Leave asks to confirm first.
 */
export function GuideMark({
  mode,
  heading,
  text,
  target,
  why,
  options = [],
  answers,
  onPick,
  onMap,
  status,
  watching,
  onWatch,
  onTakeOver,
  paused,
  onPause,
  onExit,
  clock,
  caption,
  progress,
  speed = 1,
  speeds = [1, 2, 4],
  onSpeed,
  onSkip,
  strip,
}: {
  mode: "call" | "watch";
  /** "Step 2 of 6 · Triage, 1 of 3". */
  heading: string;
  /** Your call: where and how to act. Watch this: what leads to the next decision. */
  text: string;
  target: Target;
  /** The agent's reason, in one line. */
  why?: string;
  options?: readonly GuideOption[];
  /** What each of the card's answers does (triage), folded under the line. */
  answers?: readonly { key: string; label: string; effect: string; costMin: number }[];
  onPick?: (id: string) => void;
  /** M: pick on the map. */
  onMap?: () => void;
  /** One line under the rest ("Agent's choice: …"). */
  status?: string;
  watching: boolean;
  onWatch: () => void;
  onTakeOver: () => void;
  paused: boolean;
  onPause: () => void;
  onExit: () => void;
  /** Watch this: the mission clock as it reads ("14:05"), the row that just landed, 0..1 of the way. */
  clock?: string;
  caption?: string | null;
  progress?: number;
  speed?: number;
  speeds?: readonly number[];
  onSpeed?: (speed: number) => void;
  onSkip?: () => void;
  /** The step strip (Scrubber.tsx GuideStrip), on top of the bar. */
  strip?: ReactNode;
}) {
  const call = mode === "call";
  const { box, view } = useTargetBox(call ? target : []);

  const card = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const own = options.filter((o) => !o.on);
  const agent = options.find((o) => o.agent);

  // the agent's choice is on the console (the card's Approve, Confirm): that is the one to do first
  const onConsole = own.length === 0 || !!agent?.on;
  // focus moves to the decision: the real control's, else the bar's first button
  useEffect(() => {
    if (!call) return;
    if (first.current && !onConsole) return first.current.focus({ preventScroll: true });
    const el = findTarget(target);
    // the item's main button (Needs you's `data-primary`: "Send Team One to C2", "Confirm clue"), else Person
    const btn = el ? (el instanceof HTMLButtonElement ? el : el.querySelector<HTMLButtonElement>("button[data-primary]") ?? [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) => /^(Person|Record find|Confirm)\b/.test(b.textContent?.trim() ?? ""))) : null;
    (btn ?? card.current)?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call, text]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      // Esc closes overlays only (theirs to handle); leaving the run is the Leave button, with a confirm
      if (k === "T" && watching) onTakeOver();
      else if (k === " " && !call && !(e.target instanceof HTMLButtonElement)) onPause();
      else if (k === "ArrowRight" && !call && onSkip) onSkip();
      else if (call && !watching && k === "A" && agent) onPick?.(agent.id);
      else if (call && !watching && k === "M" && onMap) onMap();
      else if (call && !watching && options.some((o) => o.key === k && k !== "M")) onPick?.(options.find((o) => o.key === k)!.id);
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    // capture: the view keys (1–6) wait while a decision is open; the review card's own keys (P/N/S/O/U) pass
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [call, watching, options, agent, onPick, onMap, onTakeOver, onPause, onSkip]);

  // Leave asks first: a stray click must not throw the run away
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (!leaving) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setLeaving(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [leaving]);


  // the ring's "do this first", unless the decision is in the bar itself (the survey on the map)
  const tag = call && box && onConsole;
  return (
    <>
      {box && call && (
        <div
          aria-hidden
          data-guide-ring
          className="sl-ring pointer-events-none fixed z-40 rounded-lg border-2 border-caution motion-safe:animate-pulse"
          style={{ top: box.top - 4, left: box.left - 4, width: box.width + 8, height: box.height + 8 }}
        />
      )}
      {tag && box && (
        <span aria-hidden data-guide-tag className="pointer-events-none fixed z-40 rounded-full bg-caution px-2 py-0.5 text-caption font-medium text-bg shadow" style={{ top: Math.max(4, box.top - 14), right: Math.max(4, view.w - box.left - box.width) }}>
          Do this first
        </span>
      )}
      <div
        ref={card}
        role="dialog"
        aria-modal="false"
        aria-label={call ? `Your call: ${heading}` : `Watch this: ${heading}`}
        data-guide-mark={mode}
        tabIndex={-1}
        className={`sl-mark flex flex-col gap-2 rounded-lg border bg-surface-solid px-3.5 py-2.5 max-sm:fixed max-sm:inset-x-3 max-sm:bottom-3 max-sm:z-[45] max-sm:max-h-[55vh] max-sm:overflow-y-auto max-sm:shadow-[0_24px_60px_-12px_rgba(0,0,0,0.9)] ${call ? "border-caution/70" : "border-border"}`}
      >
        {strip && <div className="flex justify-center">{strip}</div>}
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption">
          <span className={`sl-pill ${call ? "" : "opacity-80"}`} data-tone={call ? "caution" : "neutral"}>
            {call ? "Your call" : "Watch this"}
          </span>
          <span className="min-w-0 flex-1 text-text-2">{heading}</span>
          {watching ? (
            <button type="button" onClick={onTakeOver} className="sl-tap shrink-0 text-small text-text hover:underline">
              Take over <KeyHint>T</KeyHint>
            </button>
          ) : (
            <button type="button" onClick={onWatch} className="sl-tap shrink-0 text-small text-text-2 hover:text-text">
              Watch instead
            </button>
          )}
          <button type="button" onClick={() => setLeaving(true)} aria-expanded={leaving} className="sl-tap shrink-0 text-small text-text-3 hover:text-text">
            Leave
          </button>
        </span>
        {leaving && (
          <div role="alertdialog" aria-label="Leave the simulation?" className="flex flex-wrap items-center gap-2 rounded-md border border-alert/60 bg-[color-mix(in_srgb,var(--alert)_8%,transparent)] px-3 py-2">
            <span className="min-w-0 flex-1 text-small text-text">Leave the simulation? Your decisions so far will be lost, and you go back to the scenarios.</span>
            <Button variant="secondary" className="h-8! px-3!" onClick={() => setLeaving(false)} autoFocus>
              Stay
            </Button>
            <Button variant="ghost" className="h-8! px-3!" onClick={onExit}>
              Leave
            </Button>
          </div>
        )}
        {call ? (
          <>
            <p className="text-body font-medium text-text">{text}</p>
            {why && (
              <p className="text-small text-text-2">
                <span className="text-accent-soft">AI suggests: </span>
                {why}
              </p>
            )}
            {own.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Options">
                {onConsole && <span className="w-full text-caption text-text-3">Or, instead:</span>}
                {own.map((o, i) => (
                  <button
                    key={o.id}
                    ref={i === 0 ? first : undefined}
                    type="button"
                    disabled={watching}
                    title={o.effect}
                    onClick={() => (o.key === "M" ? onMap?.() : onPick?.(o.id))}
                    className={`sl-tap flex min-w-0 flex-1 basis-48 items-start gap-2 rounded-md border px-2.5 py-1.5 text-left disabled:opacity-60 ${o.agent ? "border-accent/60 hover:border-accent" : "border-border hover:border-text-3"}`}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-small text-text">
                        {o.label}
                        {o.costMin ? <span className="text-caution"> · +{o.costMin} min</span> : null}
                        {o.agent ? <span className="text-accent-soft"> · AI's pick</span> : null}
                      </span>
                      <span className="text-caption text-text-3">{o.effect}</span>
                    </span>
                    <span className="flex shrink-0 gap-1 max-sm:hidden">
                      {o.agent && <KeyHint>A</KeyHint>}
                      <KeyHint>{o.key}</KeyHint>
                    </span>
                  </button>
                ))}
              </div>
            )}
            {answers && answers.length > 0 && (
              <details className="text-caption text-text-3">
                <summary className="sl-tap cursor-pointer text-text-2 hover:text-text">What each answer does</summary>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {answers.map((a) => (
                    <li key={a.key}>
                      <span className="text-text-2">{a.label}</span> <KeyHint>{a.key}</KeyHint>: {a.effect}
                      {a.costMin ? <span className="text-caution"> · +{a.costMin} min</span> : null}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        ) : (
          <>
            <p className="flex items-baseline gap-3">
              {clock && <span className="font-mono text-title text-text tabular-nums" aria-label={`Mission clock ${clock}`}>{clock}</span>}
              <span className="min-w-0 flex-1 text-body text-text" data-guide-caption>
                {caption ?? text}
              </span>
            </p>
            {progress !== undefined && (
              <span aria-hidden className="h-1 w-full overflow-hidden rounded-full bg-surface-strong">
                <span className="block h-full bg-text-3 transition-[width] duration-100" style={{ width: `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%` }} />
              </span>
            )}
            <span className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" className="h-8! px-3!" onClick={onPause}>
                {paused ? "Resume" : "Pause"} <KeyHint>Space</KeyHint>
              </Button>
              {onSpeed && (
                <span role="group" aria-label="Speed" className="flex items-center gap-0.5 rounded-full border border-line p-0.5">
                  {speeds.map((s) => (
                    <button key={s} type="button" aria-pressed={s === speed} onClick={() => onSpeed(s)} className={`sl-tap rounded-full px-2.5 py-0.5 text-caption ${s === speed ? "bg-surface-strong text-text" : "text-text-2 hover:text-text"}`}>
                      {s}×
                    </button>
                  ))}
                </span>
              )}
              {onSkip && (
                <Button variant="ghost" className="ml-auto h-8! px-3!" onClick={onSkip}>
                  Skip ahead <KeyHint>→</KeyHint>
                </Button>
              )}
            </span>
          </>
        )}
        {status && <p className="text-small text-accent-soft">{status}</p>}
      </div>
    </>
  );
}
