// The first-minute orientation (the owner, 2026-10-26: "make it clear how to use it"): on a visitor's first
// run (guided or free) three short steps point at the console's three working regions: Resources, the map
// and Needs you. Skippable at any step (Esc, Skip), remembered in this browser (localStorage, wrapped:
// private mode shows it again next visit). While it is up the mission clock waits (consoleStore
// `confirming`) and no console key acts. A ring on the region and a card beside it; on a phone the card
// sits along the bottom and a region on screen is ringed (one further down is named, not scrolled to). Built by lane A.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "../shell/components";
import { placeCard } from "./CoachMark";
import { useConsole } from "./consoleStore";

export const TOUR_KEY = "sightline.tour-seen";

export const TOUR_STEPS = [
  {
    target: "#console-resources",
    title: "Resources: your teams and drones",
    body: "Each card is a ground team or a drone: where it is, when it last checked in by radio, and its one action (Assign to a sector, Fly over a sector).",
  },
  {
    target: "#console-map",
    title: "The map: where the person likely is",
    body: "Hotter is likelier. Each sector shows its share of the probability, and the map shifts as clues come in and sectors are searched.",
  },
  {
    target: "#console-needs",
    title: "Needs you: every decision waits here",
    body: "AI suggestions, photos to review and clues to confirm. The AI proposes; nothing it suggests happens until you decide here.",
  },
] as const;

/** Whether this browser has seen the tour (no storage: not seen). */
export function tourSeen(): boolean {
  try {
    return globalThis.localStorage?.getItem(TOUR_KEY) === "1";
  } catch {
    return false;
  }
}

function markSeen(): void {
  try {
    globalThis.localStorage?.setItem(TOUR_KEY, "1");
  } catch {
    /* private mode: shown again next visit */
  }
}

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** The tour, when this browser has not seen it (`force`: always, for its own test). */
export function Tour({ force = false }: { force?: boolean }) {
  // the test run of the whole app drives the console with keys: the tour is for people (its own test forces it)
  const [open, setOpen] = useState(() => force || (import.meta.env.MODE !== "test" && !tourSeen()));
  const [i, setI] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const [view, setView] = useState({ w: typeof window === "undefined" ? 1440 : window.innerWidth, h: typeof window === "undefined" ? 900 : window.innerHeight });
  const card = useRef<HTMLDivElement>(null);
  const step = TOUR_STEPS[i]!;
  const last = i === TOUR_STEPS.length - 1;

  const close = () => {
    markSeen();
    setOpen(false);
    // a phone stacks the regions: back to the top of the console when the tour ends
    if (typeof window !== "undefined" && window.innerWidth < 640) window.scrollTo?.({ top: 0 });
  };

  // the clock waits while the tour is up
  useEffect(() => {
    if (!open) return undefined;
    useConsole.getState().setConfirming(true);
    return () => useConsole.getState().setConfirming(false);
  }, [open]);

  // the region: on a phone scrolled into view; followed as the page lays out
  useLayoutEffect(() => {
    if (!open) return undefined;
    const measure = () => {
      const r = document.querySelector<HTMLElement>(step.target)?.getBoundingClientRect();
      // ringed where it shows (a phone stacks the regions: one below the screen is named, not scrolled to)
      const shows = r && r.width > 0 && r.bottom > 0 && r.top < window.innerHeight;
      setBox(shows ? { top: Math.max(0, r.top), left: r.left, width: r.width, height: Math.min(r.bottom, window.innerHeight) - Math.max(0, r.top) } : null);
      setView((v) => (v.w === window.innerWidth && v.h === window.innerHeight ? v : { w: window.innerWidth, h: window.innerHeight }));
    };
    measure();
    const id = window.setInterval(measure, 300);
    window.addEventListener("resize", measure);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("resize", measure);
    };
  }, [open, step.target]);

  useEffect(() => {
    if (open) card.current?.focus({ preventScroll: true });
  }, [open, i]);

  // its own keys; no console key acts while it is up (Tab still moves between its buttons)
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Tab") return;
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight") setI((x) => Math.min(TOUR_STEPS.length - 1, x + 1));
      else if (e.key === "ArrowLeft") setI((x) => Math.max(0, x - 1));
      else if (e.key === "Enter" || e.key === " ") {
        // a focused button clicks itself
        if (!(e.target instanceof HTMLButtonElement)) {
          if (last) close();
          else setI((x) => x + 1);
        } else return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, last]);

  if (!open) return null;
  const phone = view.w < 640;
  const H = 190;
  const spot = !phone && box ? placeCard(box, view.w, view.h, H) : null;
  return createPortal(
    <div className="fixed inset-0 z-[70]" data-tour-overlay>
      {/* the rest of the console dimmed; the region the step is about shows through the ring */}
      <div className={`absolute inset-0 ${box ? "" : "bg-bg/40"}`} aria-hidden />
      {box && (
        <div
          aria-hidden
          data-tour-ring
          className="pointer-events-none fixed rounded-lg border-2 border-accent shadow-[0_0_0_9999px_rgba(0,0,0,0.25)]"
          style={{ top: box.top - 3, left: box.left - 3, width: box.width + 6, height: box.height + 6 }}
        />
      )}
      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        tabIndex={-1}
        data-tour-card
        className={`fixed flex flex-col gap-2 rounded-lg border border-accent/60 bg-surface-solid px-4 py-3 shadow-[var(--shadow-pop)] ${phone ? "inset-x-3 bottom-[calc(4rem+env(safe-area-inset-bottom))]" : "w-80"}`}
        style={spot ? { top: spot.top, left: spot.left } : phone ? undefined : { top: 96, left: Math.max(12, view.w / 2 - 160) }}
      >
        <span className="text-caption text-text-3">
          Getting started · {i + 1} of {TOUR_STEPS.length}
        </span>
        <h2 id="tour-title" className="text-body font-medium text-text">
          {step.title}
        </h2>
        <p id="tour-body" className="text-small text-text-2">
          {step.body}
        </p>
        <span className="mt-1 flex flex-wrap items-center gap-2">
          <button type="button" onClick={close} className="sl-tap mr-auto text-small text-text-3 hover:text-text">
            Skip the tour
          </button>
          {i > 0 && (
            <Button variant="ghost" className="h-8! px-3!" onClick={() => setI(i - 1)}>
              Back
            </Button>
          )}
          <Button variant="primary" className="h-8! px-3!" onClick={() => (last ? close() : setI(i + 1))}>
            {last ? "Start" : "Next"}
          </Button>
        </span>
      </div>
    </div>,
    document.body,
  );
}
