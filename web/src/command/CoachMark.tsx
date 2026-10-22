// A coach mark on the real console (driver.js's pattern, hand-rolled: no dependency): a ring around one
// element and one sentence beside it, Next and Back, skippable. Space pauses the mission clock, the arrow
// keys step, Esc leaves the story and keeps the console at this mission time.

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

/** The first element matching `selector` that is on screen (a phone and a desktop can each have their own). */
function findTarget(selector: string): HTMLElement | null {
  const all = [...document.querySelectorAll<HTMLElement>(selector)];
  return all.find((el) => el.getClientRects().length > 0) ?? all[0] ?? null;
}

/** Give focus back to the mark's anchor (made focusable from code if it is not), without scrolling. */
function focusAnchor(selector: string) {
  const el = findTarget(selector);
  if (!el) return;
  if (el.tabIndex < 0 && !el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
}

export function CoachMark({
  text,
  target,
  index,
  count,
  gate,
  onNext,
  onBack,
  onExit,
  onToggleClock,
  last = false,
}: {
  text: string;
  /** A CSS selector on the console. */
  target: string;
  /** 1-based. */
  index: number;
  count: number;
  /** The mark waits for an action on the console (in words: "Approve it on the card"); Skip moves on. */
  gate?: string;
  onNext: () => void;
  onBack?: () => void;
  onExit: () => void;
  onToggleClock: () => void;
  last?: boolean;
}) {
  const [box, setBox] = useState<Box | null>(null);
  const [avoid, setAvoid] = useState<Box[]>([]);
  const anchor = useRef(target);
  anchor.current = target;
  const [view, setView] = useState({ w: typeof window === "undefined" ? 1440 : window.innerWidth, h: typeof window === "undefined" ? 900 : window.innerHeight });
  const card = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);

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
    const scrollTo = (el: HTMLElement, phone: boolean) => {
      // on a phone the card sits along the bottom: bring the target to the top
      el.scrollIntoView({ block: phone ? "start" : "nearest", inline: "nearest" });
      want = el.getBoundingClientRect().top;
    };
    const measure = () => {
      const el = findTarget(target);
      const phone = window.innerWidth < 640;
      if (el && el !== scrolled && typeof el.scrollIntoView === "function") {
        scrollTo(el, phone);
        scrolled = el;
        settleUntil = performance.now() + 3000;
      } else if (el && phone && !moved && performance.now() < settleUntil && Math.abs(el.getBoundingClientRect().top - want) > 8) {
        scrollTo(el, phone);
      }
      const r = el ? visibleRect(el) : null;
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
    const user = () => {
      moved = true;
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
    };
  }, [target]);

  useEffect(() => {
    (primary.current ?? card.current)?.focus({ preventScroll: true });
  }, [text]);

  // When the story ends (Esc, Exit, Done), focus goes back to the panel the last mark pointed at, unless
  // the visitor has already put it somewhere else (a view button, the map).
  useEffect(
    () => () => {
      const now = document.activeElement;
      if (!now || now === document.body) focusAnchor(anchor.current);
    },
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Escape") onExit();
      else if (e.key === "ArrowRight" && !gate) onNext();
      else if (e.key === "ArrowLeft") onBack?.();
      else if (e.key === " " && !(e.target instanceof HTMLButtonElement)) onToggleClock();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [gate, onNext, onBack, onExit, onToggleClock]);

  const at = placeCard(box, view.w, view.h, card.current?.offsetHeight ?? 180, avoid);
  return (
    <>
      {box && (
        <div
          aria-hidden
          className="sl-ring pointer-events-none fixed z-40 rounded-lg border-2 border-accent shadow-[0_0_0_9999px_rgba(10,11,13,0.35)]"
          style={{ top: box.top - 4, left: box.left - 4, width: box.width + 8, height: box.height + 8 }}
        />
      )}
      <div
        ref={card}
        role="dialog"
        aria-modal="false"
        aria-label={`The story, ${index} of ${count}`}
        tabIndex={-1}
        key={text}
        className={`sl-mark fixed z-50 flex flex-col gap-3 rounded-lg border border-accent/60 bg-surface-solid p-4 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.9)] ${at ? "" : "inset-x-3 bottom-[4.5rem] sm:right-auto sm:left-1/2 sm:w-80 sm:-translate-x-1/2 lg:bottom-6"}`}
        style={at ? { top: at.top, left: at.left, width: CARD_W } : undefined}
      >
        <span className="flex items-center gap-1.5" aria-hidden>
          {Array.from({ length: count }, (_, i) => (
            <span key={i} className={`h-1 rounded-full ${i + 1 === index ? "w-5 bg-accent" : i + 1 < index ? "w-2 bg-accent/50" : "w-2 bg-surface-strong"}`} />
          ))}
        </span>
        <p className="text-body text-text" aria-live="polite">
          {text}
        </p>
        {gate && <p className="text-small text-accent-soft">{gate}</p>}
        <div className="flex flex-wrap items-center gap-2">
          {gate ? (
            <Button ref={primary} variant="ghost" onClick={onNext}>
              Skip
            </Button>
          ) : (
            <Button ref={primary} variant="primary" onClick={onNext}>
              {last ? "Done" : "Next"}
            </Button>
          )}
          {onBack && (
            <Button variant="ghost" onClick={onBack}>
              Back
            </Button>
          )}
          <button type="button" onClick={onExit} className="sl-tap ml-auto text-small text-text-3 hover:text-text">
            Exit the story <KeyHint>Esc</KeyHint>
          </button>
        </div>
      </div>
    </>
  );
}
