// The guided search's mark on the real console (driver.js's pattern, hand-rolled: no dependency): a ring
// around the region a decision is about and a card beside it. A mark names its element by a CSS selector,
// or by several in order of preference (the card it is about, else its panel); a selector that starts with
// "group:" rings its first few matches together (two cards, a call and its clue). The old step-through
// story's marks are gone: the walk-through is the guided search (GuideMark, below).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
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

// ---- The guided search's mark (guide.ts): "Your call" or "Watch this", never both ----

export interface GuideOption {
  key: string;
  id: string;
  label: string;
  effect: string;
  costMin: number;
  agent?: boolean;
}

/**
 * The guided search's card on the console. "Your call": an amber ring that pulses on the region the
 * decision is about, the clock paused, the options with what each costs before the commit (keys 1–4, A
 * the agent's, M a sector on the map). "Watch this": no ring, a thin progress bar, the clock running
 * (Space pauses). "Watch instead" plays the agent's line; T takes over at the next decision. Esc leaves.
 */
export function GuideMark({
  mode,
  heading,
  text,
  target,
  agentSays,
  image,
  options = [],
  onPick,
  onMap,
  progress,
  status,
  watching,
  onWatch,
  onTakeOver,
  paused,
  onPause,
  onExit,
}: {
  mode: "call" | "watch";
  /** "Decision 2 of 6 · Triage, 1 of 3". */
  heading: string;
  text: string;
  target: Target;
  agentSays?: string;
  image?: { src: string; alt: string };
  options?: readonly GuideOption[];
  onPick?: (id: string) => void;
  /** M: pick on the map. */
  onMap?: () => void;
  /** Watch this: 0..1 of the way to the next decision. */
  progress?: number;
  /** One line under the options ("Agent's choice: …"). */
  status?: string;
  watching: boolean;
  onWatch: () => void;
  onTakeOver: () => void;
  paused: boolean;
  onPause: () => void;
  onExit: () => void;
}) {
  const { box, avoid, view } = useTargetBox(target);
  const card = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const call = mode === "call";

  // focus moves to the decision
  useEffect(() => {
    if (call) (first.current ?? card.current)?.focus({ preventScroll: true });
  }, [call, text]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      if (k === "Escape") onExit();
      else if (k === "T" && watching) onTakeOver();
      else if (k === " " && !(e.target instanceof HTMLButtonElement)) onPause();
      else if (call && !watching && k === "A" && options.some((o) => o.agent)) onPick?.(options.find((o) => o.agent)!.id);
      else if (call && !watching && k === "M" && onMap) onMap();
      else if (call && !watching && options.some((o) => o.key === k && k !== "M")) onPick?.(options.find((o) => o.key === k)!.id);
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    // capture: the review queue's own keys (P/N/U) and the view keys (1–6) wait while a decision is open
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [call, watching, options, onPick, onMap, onExit, onTakeOver, onPause]);

  const at = placeCard(box, view.w, view.h, card.current?.offsetHeight ?? 220, avoid);
  return (
    <>
      {box && call && (
        <div
          aria-hidden
          data-guide-ring
          className="sl-ring pointer-events-none fixed z-40 rounded-lg border-2 border-caution shadow-[0_0_0_9999px_rgba(10,11,13,0.35)] motion-safe:animate-pulse"
          style={{ top: box.top - 4, left: box.left - 4, width: box.width + 8, height: box.height + 8 }}
        />
      )}
      <div
        ref={card}
        role="dialog"
        aria-modal="false"
        aria-label={call ? `Your call: ${heading}` : `Watch this: ${heading}`}
        data-guide-mark={mode}
        tabIndex={-1}
        className={`sl-mark fixed z-50 flex flex-col gap-2.5 rounded-lg border bg-surface-solid p-4 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.9)] ${call ? "border-caution/70" : "border-border"} ${at ? "" : "inset-x-3 bottom-3 max-h-[60vh] overflow-y-auto sm:right-auto sm:left-1/2 sm:w-96 sm:-translate-x-1/2 lg:bottom-6"}`}
        style={at ? { top: at.top, left: at.left, width: CARD_W } : undefined}
      >
        <span className="flex items-center gap-2 text-caption">
          <span className={`sl-pill ${call ? "" : "opacity-80"}`} data-tone={call ? "caution" : "neutral"}>
            {call ? "Your call" : "Watch this"}
          </span>
          <span className="truncate text-text-3">{heading}</span>
        </span>
        {image && <img src={image.src} alt={image.alt} className="max-h-48 w-full rounded-md bg-surface-strong object-contain" />}
        {agentSays && <p className="text-small text-text-2">{agentSays}</p>}
        <p className="text-body text-text">{text}</p>
        {call && options.length > 0 && (
          <div className="flex flex-col gap-1.5" role="group" aria-label="Options">
            {options.map((o, i) => (
              <button
                key={o.id}
                ref={i === 0 ? first : undefined}
                type="button"
                disabled={watching}
                onClick={() => (o.key === "M" ? onMap?.() : onPick?.(o.id))}
                className={`sl-tap flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-left disabled:opacity-60 ${o.agent ? "border-accent/60 hover:border-accent" : "border-border hover:border-text-3"}`}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-small text-text">
                    {o.label}
                    {o.costMin ? <span className="text-caution"> · +{o.costMin} min</span> : null}
                    {o.agent ? <span className="text-accent-soft"> · agent</span> : null}
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
        {!call && progress !== undefined && (
          <span aria-hidden className="h-0.5 w-full overflow-hidden rounded-full bg-surface-strong">
            <span className="block h-full bg-text-3" style={{ width: `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%` }} />
          </span>
        )}
        {status && <p className="text-small text-accent-soft">{status}</p>}
        <div className="flex flex-wrap items-center gap-2">
          {watching ? (
            <Button variant="secondary" onClick={onTakeOver}>
              Take over <KeyHint>T</KeyHint>
            </Button>
          ) : (
            <Button variant="ghost" onClick={onWatch}>
              Watch instead
            </Button>
          )}
          {!call && (
            <Button variant="ghost" onClick={onPause}>
              {paused ? "Resume" : "Pause"} <KeyHint>Space</KeyHint>
            </Button>
          )}
          <button type="button" onClick={onExit} className="sl-tap ml-auto text-small text-text-3 hover:text-text">
            Leave <KeyHint>Esc</KeyHint>
          </button>
        </div>
      </div>
    </>
  );
}
