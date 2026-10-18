import { useEffect, useRef, useState } from "react";
import { KeyHint } from "./components";
import { clockRuns, type TourEvent, type TourState, type TourStop } from "./tour";

/** True while the tour itself is pressing a key, so that press doesn't count as the viewer's input. */
let tourIsTyping = false;

/** Press a key on the page on the tour's behalf (the queue's own shortcut), without ending the tour. */
export function pressForTour(key: string): void {
  tourIsTyping = true;
  try {
    window.dispatchEvent(new KeyboardEvent("keydown", { key }));
  } finally {
    tourIsTyping = false;
  }
}

/**
 * Milliseconds the current stop has been showing, held while paused and reset for each new stop
 * (`stopKey`). Ticks on animation frames so the progress bar moves smoothly.
 */
function useStopClock(stopKey: string, running: boolean): number {
  // Keyed by stop, so the first render of a new stop never sees the previous stop's time.
  const [clock, setClock] = useState({ key: stopKey, ms: 0 });
  const banked = useRef({ key: stopKey, ms: 0 });
  useEffect(() => {
    if (!running) return;
    if (banked.current.key !== stopKey) banked.current = { key: stopKey, ms: 0 };
    const start = performance.now() - banked.current.ms;
    let frame = 0;
    const tick = (now: number) => {
      banked.current = { key: stopKey, ms: now - start };
      setClock(banked.current);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [running, stopKey]);
  return clock.key === stopKey ? clock.ms : 0;
}

/**
 * The tour's caption card: what this step shows and why it matters, a progress bar per stop, and
 * the controls (Back, Pause/Play, Next, Exit). Any input outside the card, a key press, a click,
 * a scroll or a touch, ends the tour and leaves the viewer where they are; Esc skips it.
 */
export function TourOverlay({
  stops,
  state,
  run,
  dispatch,
  onAction,
}: {
  stops: readonly TourStop[];
  state: TourState;
  /** Changes on every start, so a replay restarts the clock even on the same stop. */
  run: number;
  dispatch: (event: TourEvent) => void;
  onAction: (stop: TourStop) => void;
}) {
  const stop = stops[state.index];
  const card = useRef<HTMLDivElement>(null);
  const stopKey = `${run}:${state.index}`;
  const running = clockRuns(state);
  const elapsed = useStopClock(stopKey, running);
  const fired = useRef<string | null>(null);

  // Time-driven: the stop's action once, then move on when its time is up.
  useEffect(() => {
    if (!stop || !running) return;
    if (stop.action && fired.current !== stopKey && elapsed >= (stop.actionAtMs ?? 0)) {
      fired.current = stopKey;
      onAction(stop);
    }
    if (elapsed >= stop.ms) dispatch({ type: "elapsed" });
  }, [elapsed, running, stop, stopKey, dispatch, onAction]);

  // Any input outside the card ends the tour, except the tour's own demo key press.
  useEffect(() => {
    const inside = (target: EventTarget | null) => target instanceof Node && card.current?.contains(target) === true;
    const onKey = (event: KeyboardEvent) => {
      if (tourIsTyping) return;
      if (event.key === "Escape") {
        event.stopImmediatePropagation();
        dispatch({ type: "stop" });
        return;
      }
      if (inside(event.target) && (event.key === "Enter" || event.key === " " || event.key === "Tab")) return;
      if (event.key === "Shift" || event.key === "Tab") return;
      dispatch({ type: "stop" });
    };
    const onPointer = (event: Event) => {
      if (!inside(event.target)) dispatch({ type: "stop" });
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("wheel", onPointer, { capture: true, passive: true });
    window.addEventListener("touchstart", onPointer, { capture: true, passive: true });
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("wheel", onPointer, true);
      window.removeEventListener("touchstart", onPointer, true);
    };
  }, [dispatch]);

  if (!stop) return null;
  const manual = state.status === "manual";
  const done = state.status === "done";
  const isLast = state.index === stops.length - 1;
  const progress = done ? 1 : Math.min(1, elapsed / stop.ms);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-40 flex justify-center px-4 sm:bottom-24 lg:left-auto lg:right-6 lg:px-0">
      <div
        ref={card}
        role="dialog"
        aria-modal="false"
        aria-label="Guided tour"
        className="sl-pop pointer-events-auto w-full max-w-xl rounded-lg lg:w-[28rem] border border-border bg-bg/90 p-5 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.9)] backdrop-blur-[16px] [box-shadow:inset_0_1px_0_0_var(--surface-strong)]"
      >
        <div className="mb-3 flex items-center gap-1.5" aria-hidden="true">
          {stops.map((s, i) => (
            <span key={s.id} className="h-1 flex-1 overflow-hidden rounded-full bg-surface-strong">
              <span
                className="block h-full rounded-full bg-accent"
                style={{ width: `${i < state.index ? 100 : i === state.index ? (manual ? 100 : progress * 100) : 0}%` }}
              />
            </span>
          ))}
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-mono text-label uppercase tracking-label text-accent-soft">
            Tour · {state.index + 1} of {stops.length}
          </span>
          <span className="hidden font-mono text-label text-text-3 sm:inline" aria-live="off">
            {state.status === "paused" ? "Paused" : manual ? "Reduced motion: press Next" : done ? "End of the tour" : ""}
          </span>
        </div>
        <h2 className="mt-1.5 text-title font-medium text-text" aria-live="polite">
          {stop.title}
        </h2>
        <p className="mt-1.5 text-body text-text-2">{stop.body}</p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => dispatch({ type: "back" })}
            disabled={state.index === 0}
            className="rounded-full border border-border px-4 py-1.5 text-small text-text-2 hover:text-text disabled:opacity-30"
          >
            Back
          </button>
          {!manual &&
            (done ? (
              <button
                type="button"
                onClick={() => dispatch({ type: "start", reducedMotion: false })}
                className="rounded-full border border-border px-4 py-1.5 text-small text-text-2 hover:text-text"
              >
                Replay
              </button>
            ) : (
              <button
                type="button"
                onClick={() => dispatch({ type: state.status === "paused" ? "resume" : "pause" })}
                className="rounded-full border border-border px-4 py-1.5 text-small text-text-2 hover:text-text"
                aria-label={state.status === "paused" ? "Resume tour" : "Pause tour"}
              >
                {state.status === "paused" ? "Resume" : "Pause"}
              </button>
            ))}
          <button
            type="button"
            onClick={() => dispatch({ type: "next" })}
            autoFocus
            className="rounded-full border border-accent px-4 py-1.5 text-small text-accent-soft hover:bg-accent hover:text-bg"
          >
            {isLast ? "Finish" : "Next"}
          </button>
          <button
            type="button"
            onClick={() => dispatch({ type: "stop" })}
            className="ml-auto inline-flex items-center gap-2 rounded-sm px-2 py-1 text-small text-text-3 hover:text-text"
          >
            Exit tour <KeyHint>Esc</KeyHint>
          </button>
        </div>
      </div>
    </div>
  );
}
