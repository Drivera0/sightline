// The guided search's mark on the real console (driver.js's pattern, hand-rolled: no dependency): a ring
// around the real control a decision is about, and a coach bar along the top of the map that says where to
// act (never a second set of the console's buttons). A mark names its element by a CSS selector,
// or by several in order of preference (the card it is about, else its panel); a selector that starts with
// "group:" rings its first few matches together (two cards, a call and its clue). The old step-through
// story's marks are gone: the walk-through is the guided search (GuideMark, below).

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { isTyping } from "../lib/keys";
import { Button, KeyHint } from "../shell/components";
import { useConsole } from "./consoleStore";

/** A media query, live (false where the browser has no matchMedia: jsdom). */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (on) => {
      const mq = typeof window.matchMedia === "function" ? window.matchMedia(query) : null;
      mq?.addEventListener?.("change", on);
      return () => mq?.removeEventListener?.("change", on);
    },
    () => (typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false),
    () => false,
  );
}

/** The control a mark's element is about: the element itself when it is a button, else the item's main one (Needs you's `data-primary`). */
export function primaryIn(el: HTMLElement | null): HTMLButtonElement | null {
  if (!el) return null;
  if (el instanceof HTMLButtonElement) return el;
  return el.querySelector<HTMLButtonElement>("button[data-primary]") ?? [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) => /^(The subject|Person|Record find|Confirm)\b/.test(b.textContent?.trim() ?? "")) ?? null;
}

/**
 * The control to press first, brought on screen in its scrolling column: the column at its top when the
 * control fits there (so the guide's instruction above it stays in view), else just enough to show it.
 */
export function showControl(btn: HTMLElement) {
  let sc: HTMLElement | null = btn.parentElement;
  while (sc && sc !== document.body && !/(auto|scroll)/.test(getComputedStyle(sc).overflowY)) sc = sc.parentElement;
  if (sc && sc !== document.body && sc.clientHeight > 0) {
    const atTop = btn.getBoundingClientRect().bottom - sc.getBoundingClientRect().top + sc.scrollTop;
    if (atTop <= sc.clientHeight) {
      sc.scrollTop = 0;
      return;
    }
  }
  scrollWithin(btn);
}

/**
 * The element brought into view inside its own scrolling column, never by scrolling the page: a page scroll
 * left a blank band under the console (round 3 of the usability test, after Send all). No column: nothing.
 */
export function scrollWithin(el: HTMLElement, block: "nearest" | "start" = "nearest") {
  let sc: HTMLElement | null = el.parentElement;
  while (sc && sc !== document.body && sc !== document.documentElement && !/(auto|scroll)/.test(getComputedStyle(sc).overflowY)) sc = sc.parentElement;
  if (!sc || sc === document.body || sc === document.documentElement || sc.clientHeight <= 0) return;
  const r = el.getBoundingClientRect();
  const b = sc.getBoundingClientRect();
  if (block === "start" || r.height > b.height || r.top < b.top) sc.scrollTop += r.top - b.top;
  else if (r.bottom > b.bottom) sc.scrollTop += r.bottom - b.bottom;
}

/**
 * Whether something else is drawn over the elements (the Conditions panel, the Trace page, a sheet): none of a
 * few points of their visible box hits them. The ring is never drawn over an overlay.
 */
export function covered(els: readonly HTMLElement[]): boolean {
  if (typeof document.elementFromPoint !== "function") return false;
  const inset = (n: number) => Math.min(10, n / 2);
  // each element's visible part: its middle and two inner corners must be its own (part of it under a panel
  // is enough to hide the ring: half a ring over the Conditions panel is what the usability test saw)
  return els.some((el) => {
    const b = visibleRect(el);
    if (b.width <= 0 || b.height <= 0) return false;
    const pts: [number, number][] = [
      [b.left + b.width / 2, b.top + b.height / 2],
      [b.left + inset(b.width), b.top + inset(b.height)],
      [b.left + b.width - inset(b.width), b.top + b.height - inset(b.height)],
    ];
    return pts.some(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return !hit || !els.some((e) => e === hit || e.contains(hit));
    });
  });
}

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
      if (!phone && els.length > 1) scrollWithin(els.at(-1)!);
      // on a phone the card sits along the bottom: bring the target to the top (a desktop: in its column only)
      if (phone) el.scrollIntoView({ block: "start", inline: "nearest" });
      else scrollWithin(el);
      // and the control itself ("Do this first"), when the item is taller than its panel
      if (!phone) showControl(primaryIn(el) ?? el);
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
      // never drawn over an overlay (the Conditions panel, the Trace page, Photos, the Debrief, a sheet)
      const hidden = !r || covered(els);
      setBox((b) => {
        if (!r || r.width <= 0 || r.height <= 0 || hidden) return null;
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
  onRestart,
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
  /** Restart this search from the call (asks first). */
  onRestart?: () => void;
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
  const own = options.filter((o) => !o.on);
  const agent = options.find((o) => o.agent);

  // the agent's choice is on the console (the card's Approve, Confirm): that is the one to do first
  const onConsole = own.length === 0 || !!agent?.on;
  // A desktop: the bar shares one scroll column with Needs you (CommandView), the step's item under the
  // instruction; on a short screen (under 800 px) the other choices go after Needs you, so the control to
  // press first is on screen at 1280 × 720 too, and a link in the bar scrolls to them. A phone: the bar is
  // a bottom sheet over the tabs; while the review frame is open it folds to one line (tap to open it), so
  // the answers stay in reach.
  const desk = useMedia("(min-width: 1024px)");
  const short = useMedia("(max-height: 800px)");
  const phone = useMedia("(max-width: 639.98px)");
  const split = desk && short && call && onConsole && own.length > 0;
  const more = useRef<HTMLDivElement>(null);
  // the column scrolled past the instruction (to the step's item): the instruction stays on one line at the
  // column's top, over the panel (no room taken, so nothing moves when it shows)
  const said = useRef<HTMLParagraphElement>(null);
  const [past, setPast] = useState(false);
  useEffect(() => {
    const col = desk && call ? card.current?.closest<HTMLElement>("[data-guided]") : null;
    if (!col) {
      setPast(false);
      return undefined;
    }
    const on = () => {
      const t = said.current;
      setPast(!!t && t.getClientRects().length > 0 && t.getBoundingClientRect().top < col.getBoundingClientRect().top - 2);
    };
    on();
    col.addEventListener("scroll", on, { passive: true });
    const id = window.setInterval(on, 400);
    return () => {
      col.removeEventListener("scroll", on);
      window.clearInterval(id);
    };
  }, [desk, call, text]);
  const reviewOpen = useConsole((s) => s.review.open);
  const [unfolded, setUnfolded] = useState(false);
  useEffect(() => setUnfolded(false), [reviewOpen, heading]);
  const folded = phone && reviewOpen && !unfolded;

  // Leave asks first: a stray click must not throw the run away. The confirm sits above every sheet, the
  // mission clock waits while it is open, and no review frame opens over it (consoleStore `confirming`).
  const [leaving, setLeaving] = useState<false | "leave" | "restart">(false);
  useEffect(() => {
    if (!leaving) return undefined;
    useConsole.getState().setConfirming(true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setLeaving(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      useConsole.getState().setConfirming(false);
    };
  }, [leaving]);

  // focus moves to the bar itself (a dialog, read out with its heading), never onto a decision button: Space
  // is Pause and Enter on a focused button stays the visitor's own act (round 3 of the usability test: Space
  // on a focused "Record find" logged the find). The ring and the scroll show the control to press.
  useEffect(() => {
    if (!call) return;
    const a = document.activeElement;
    if (a && a !== document.body && isTyping(a)) return;
    card.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call, text]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (leaving || isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      // Esc closes overlays only (theirs to handle); leaving the run is the Leave button, with a confirm
      if (k === "T" && watching) onTakeOver();
      else if (k === " ") {
        // Space is Pause, everywhere in the run: never the click of whatever button has focus
        if (!call && !e.repeat) onPause();
      }
      else if (k === "ArrowRight" && !call && onSkip) onSkip();
      else if (call && !watching && k === "A" && agent) onPick?.(agent.id);
      else if (call && !watching && k === "M" && onMap) onMap();
      else if (call && !watching && options.some((o) => o.key === k && k !== "M")) onPick?.(options.find((o) => o.key === k)!.id);
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    // a button clicks on Space's keyup: that one is swallowed too
    const onUp = (e: KeyboardEvent) => {
      if (leaving || e.key !== " " || isTyping(e.target)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    // capture: the view keys (1–6) wait while a decision is open; the review card's own keys (P/N/S/O/U) pass
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onUp, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onUp, true);
    };
  }, [leaving, call, watching, options, agent, onPick, onMap, onTakeOver, onPause, onSkip]);

  const optionButtons = own.map((o) => (
    <button
      key={o.id}
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
        <span data-guide-effect className="text-caption text-text-3">
          {o.effect}
        </span>
      </span>
      <span className="flex shrink-0 gap-1 max-sm:hidden">
        {o.agent && <KeyHint>A</KeyHint>}
        <KeyHint>{o.key}</KeyHint>
      </span>
    </button>
  ));
  const choices =
    own.length > 0 ? (
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={split ? "Other choices" : "Options"}>
        {onConsole && <span className="w-full text-caption text-text-3">{split ? "Or, instead of the item in Needs you:" : "Or, instead:"}</span>}
        {optionButtons}
      </div>
    ) : null;

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
      {folded && (
        <button
          type="button"
          data-guide-chip
          aria-expanded={false}
          onClick={() => setUnfolded(true)}
          className="sl-tap fixed inset-x-3 bottom-[calc(3.75rem+env(safe-area-inset-bottom))] z-[45] flex items-center gap-2 rounded-full border border-caution/70 bg-surface-solid px-3 py-1.5 text-left text-small shadow-[0_12px_30px_-8px_rgba(0,0,0,0.8)]"
        >
          <span className="sl-pill shrink-0" data-tone={call ? "caution" : "neutral"}>
            {call ? "Your call" : "Watch this"}
          </span>
          <span className="min-w-0 flex-1 truncate text-text-2" title={heading}>
            {heading}
          </span>
          <span className="shrink-0 text-caption text-text-3">Show the guide</span>
        </button>
      )}
      <div
        ref={card}
        role="dialog"
        aria-modal="false"
        aria-label={call ? `Your call: ${heading}` : `Watch this: ${heading}`}
        data-guide-mark={mode}
        hidden={folded}
        tabIndex={-1}
        className={`sl-mark flex flex-col gap-2 rounded-lg border bg-surface-solid px-3.5 py-2.5 lg:order-0 max-sm:fixed max-sm:inset-x-3 max-sm:bottom-[calc(3.75rem+env(safe-area-inset-bottom))] max-sm:z-[45] max-sm:max-h-[50vh] max-sm:overflow-y-auto max-sm:shadow-[0_24px_60px_-12px_rgba(0,0,0,0.9)] ${call ? "border-caution/70" : "border-border"}`}
      >
        {strip && (
          <div data-guide-strip className="flex justify-center">
            {strip}
          </div>
        )}
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption">
          <span className={`sl-pill ${call ? "" : "opacity-80"}`} data-tone={call ? "caution" : "neutral"}>
            {call ? "Your call" : "Watch this"}
          </span>
          <span className="min-w-0 flex-1 text-text-2">{heading}</span>
          {phone && reviewOpen && (
            <button type="button" onClick={() => setUnfolded(false)} className="sl-tap shrink-0 text-small text-text-2 hover:text-text">
              Hide
            </button>
          )}
          {watching ? (
            <button type="button" onClick={onTakeOver} className="sl-tap shrink-0 text-small text-text hover:underline">
              Take over <KeyHint>T</KeyHint>
            </button>
          ) : (
            <button type="button" onClick={onWatch} className="sl-tap shrink-0 text-small text-text-2 hover:text-text">
              Watch instead
            </button>
          )}
          {onRestart && (
            <button type="button" onClick={() => setLeaving("restart")} aria-expanded={leaving === "restart"} aria-haspopup="dialog" className="sl-tap shrink-0 text-small text-text-3 hover:text-text">
              Restart
            </button>
          )}
          <button type="button" onClick={() => setLeaving("leave")} aria-expanded={leaving === "leave"} aria-haspopup="dialog" className="sl-tap shrink-0 text-small text-text-3 hover:text-text">
            Leave
          </button>
        </span>
        {call ? (
          <>
            <p ref={said} className="text-body font-medium text-text">
              {text}
            </p>
            {why && (
              <p data-guide-why className="text-small text-text-2" title={/^AI: /.test(why) ? why : `AI suggests: ${why}`} data-ai-pick={/^AI: /.test(why) ? "" : undefined}>
                {/* a photo's pick says its own head ("AI: likely the subject — …") */}
                {/^AI: /.test(why) ? (
                  <>
                    <span className="text-accent-soft">AI: </span>
                    {why.slice(4)}
                  </>
                ) : (
                  <>
                    <span className="text-accent-soft">AI suggests: </span>
                    {why}
                  </>
                )}
              </p>
            )}
            {split ? (
              <button type="button" onClick={() => more.current?.scrollIntoView?.({ block: "nearest" })} className="sl-tap self-start text-caption text-text-2 underline underline-offset-2 hover:text-text">
                Or, instead: {own.length === 1 ? "1 other choice" : `${own.length} other choices`}, under Needs you
              </button>
            ) : (
              choices
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
      {desk && call && (
        <div className="pointer-events-none sticky top-0 z-20 h-0 lg:order-1">
          {past && (
            <button
              type="button"
              data-guide-pinned
              title={text}
              onClick={() => card.current?.scrollIntoView({ block: "start" })}
              className="sl-tap pointer-events-auto absolute inset-x-0 top-0 flex items-center gap-2 rounded-md border border-caution/70 bg-surface-solid px-2.5 py-1 text-left text-small shadow-[var(--shadow-pop)]"
            >
              <span className="sl-pill shrink-0" data-tone="caution">
                Your call
              </span>
              <span className="min-w-0 flex-1 truncate text-text">{text}</span>
            </button>
          )}
        </div>
      )}
      {split && choices && (
        // after the step's item in the column (CommandView: the bar, Needs you, then this)
        <div ref={more} data-guide-more className="sl-mark rounded-lg border border-caution/40 bg-surface-solid px-3.5 py-2 lg:order-2">
          {choices}
        </div>
      )}
      {leaving === "restart" && onRestart ? (
        <RestartConfirm
          onStay={() => setLeaving(false)}
          onRestart={() => {
            setLeaving(false);
            onRestart();
          }}
        />
      ) : (
        leaving && <LeaveConfirm onStay={() => setLeaving(false)} onLeave={onExit} />
      )}
    </>
  );
}

/** The restart confirm's words (the guided run's bar and free play's clock bar alike). */
export const RESTART_ASK = "Restart this search from the call? Your decisions so far will be lost.";

/**
 * Restart this search? Above every sheet, in document.body (inside free play's clock bar it was drawn on top
 * but its buttons took no clicks: the bar's stacking context held it); the mission clock waits while it is open (consoleStore
 * `confirming`), and Esc stays.
 */
export function RestartConfirm({ onStay, onRestart }: { onStay: () => void; onRestart: () => void }) {
  const stay = useRef(onStay);
  stay.current = onStay;
  useEffect(() => {
    useConsole.getState().setConfirming(true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      stay.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      useConsole.getState().setConfirming(false);
    };
  }, []);
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-bg/70 p-4 backdrop-blur-[2px]" onClick={onStay}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label="Restart this search?"
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-md flex-col gap-3 rounded-lg border border-caution/60 bg-surface-solid px-4 py-3 shadow-[var(--shadow-pop)]"
      >
        <p className="text-body text-text">{RESTART_ASK}</p>
        <p className="text-caption text-text-3">The mission clock waits while you decide.</p>
        <span className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" className="h-9! px-4!" onClick={onStay} autoFocus>
            Stay
          </Button>
          <Button variant="ghost" className="h-9! px-4!" onClick={onRestart}>
            Restart
          </Button>
        </span>
      </div>
    </div>,
    document.body,
  );
}

/** Leave the simulation? Above every sheet and modal (the review frame, the shortcuts list), in document.body. */
function LeaveConfirm({ onStay, onLeave }: { onStay: () => void; onLeave: () => void }) {
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-bg/70 p-4 backdrop-blur-[2px]" onClick={onStay}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label="Leave the simulation?"
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-md flex-col gap-3 rounded-lg border border-alert/60 bg-surface-solid px-4 py-3 shadow-[var(--shadow-pop)]"
      >
        <p className="text-body text-text">Leave the simulation? Your decisions so far will be lost, and you go back to the scenarios.</p>
        <p className="text-caption text-text-3">The mission clock waits while you decide.</p>
        <span className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" className="h-9! px-4!" onClick={onStay} autoFocus>
            Stay
          </Button>
          <Button variant="ghost" className="h-9! px-4!" onClick={onLeave}>
            Leave
          </Button>
        </span>
      </div>
    </div>,
    document.body,
  );
}
