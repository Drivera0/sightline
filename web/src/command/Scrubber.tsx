// The demo mission's time control on the map outside the guided search (Flightradar24's playback): play
// or pause, the seven checkpoints as ticks, the mission clock, and Skip to now. Under it, one line: where a
// play-through is going. The guided search has its own strip instead (GuideStrip, below): no free seeking
// while decisions are open.

import type { ReactNode } from "react";
import { clock, DEMO_TZ, utcLabel, zone } from "../lib/time";
import { CHECKPOINTS, LAST, type Checkpoint } from "./missionTime";


export function Scrubber({
  t,
  progress,
  playing,
  at,
  onSeek,
  onToggle,
  canPlay = false,
  through = null,
  hint = null,
  onSkip,
  stepOnly = false,
}: {
  /** Inside the story: only the next and earlier checkpoints are taps away (a phone's tap never skips ahead; judges 2026-10-23). */
  stepOnly?: boolean;
  t: Checkpoint;
  progress: number;
  playing: boolean;
  /** The mission clock (ISO). */
  at: string;
  onSeek: (t: Checkpoint) => void;
  /** Play or pause: with `canPlay`, at a checkpoint it plays the clock on to the end. */
  onToggle: () => void;
  /** The play button runs the clock from here to the end (else only a run in progress pauses). */
  canPlay?: boolean;
  /** Playing through to the end: the clock it started at (ISO). */
  through?: string | null;
  /** One line under the scrubber, when nothing is playing (how to use the console). */
  hint?: ReactNode;
  /** Skip to now: the mission as it stands at the end of the timeline. */
  onSkip?: () => void;
}) {
  const running = progress < 1;
  // the thumb: between the previous tick and t while the clock runs into t
  const pos = Math.max(0, t - 1 + progress) / (CHECKPOINTS.length - 1);
  const end = CHECKPOINTS[LAST]!.at;
  // the demo mission's clock: Mount Seymour's local time, UTC in the tooltips
  const local = (iso: string) => clock(iso, DEMO_TZ);
  const zoned = (iso: string) => `${local(iso)} ${zone(new Date(iso), DEMO_TZ)}`;
  const note = through ? `${playing ? "Playing" : "Paused"} · ${local(through)} → ${local(end)}` : null;
  return (
    <div className="pointer-events-none flex w-full flex-col items-stretch gap-1">
    <div
      role="group"
      aria-label="Mission time"
      data-tour="scrubber"
      className="@container pointer-events-auto flex w-full items-center gap-3 rounded-lg border border-border bg-surface-solid px-2 py-1.5 shadow-[var(--shadow-pop)]"
    >
      <button
        type="button"
        onClick={onToggle}
        disabled={!running && !canPlay}
        aria-label={playing ? "Pause the mission clock (Space)" : running ? "Play the mission clock (Space)" : "Play the mission clock to the end (Space)"}
        title={playing ? "Pause (Space)" : running || canPlay ? "Play (Space)" : "The clock is at this checkpoint"}
        className="sl-tap inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-border text-text-2 hover:text-text disabled:opacity-40"
      >
        {playing ? (
          <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
            <path d="M4.5 3h2.5v10H4.5zM9 3h2.5v10H9z" fill="currentColor" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
            <path d="M5 3l8 5-8 5z" fill="currentColor" />
          </svg>
        )}
      </button>
      <span className="w-12 shrink-0 text-small text-text" title={`Mission clock, ${zoned(at)} (${utcLabel(at)})`} aria-live="off">
        {local(at)}
      </span>
      <div className="relative min-w-0 flex-1">
        <span aria-hidden className="absolute inset-x-2 top-[11px] h-0.5 rounded-full bg-surface-strong" />
        <span
          aria-hidden
          className="absolute left-2 top-[11px] h-0.5 rounded-full bg-accent"
          style={{ width: `calc((100% - 1rem) * ${pos})` }}
        />
        <ol className="relative flex justify-between">
          {CHECKPOINTS.map((c) => {
            const here = c.t === t && !running;
            const past = c.t < t || here;
            return (
              <li key={c.id} className="flex min-w-0 flex-col items-center">
                <button
                  type="button"
                  disabled={stepOnly && c.t > t + 1}
                  onClick={() => onSeek(c.t)}
                  aria-current={here ? "step" : undefined}
                  title={`${c.label}, ${zoned(c.at)} (${utcLabel(c.at)})`}
                  className="group flex min-h-6 min-w-6 flex-col items-center gap-0.5 rounded-sm px-1 outline-offset-0 disabled:cursor-default disabled:opacity-60"
                >
                  <span
                    aria-hidden
                    className={`mt-[7px] size-2.5 rounded-full border-2 transition-colors ${here ? "border-accent bg-accent" : past ? "border-accent bg-surface-solid" : "border-text-3 bg-surface-solid group-hover:border-text-2"}`}
                  />
                  <span className={`truncate text-caption ${here ? "text-text" : "text-text-3 group-hover:text-text-2"} ${here ? "" : "@max-xl:sr-only"}`}>{c.label}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
      {onSkip && (
        <button type="button" onClick={onSkip} className="sl-tap shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-caption text-text-2 hover:text-text">
          Skip to now
        </button>
      )}
    </div>
    {(note || hint) && (
      // the story's keys are for a keyboard: a touch screen shows no key hints
      <p role="status" aria-label="Mission clock status" className={`self-center rounded-full bg-bg/85 px-3 py-0.5 text-center text-caption text-text-2 backdrop-blur ${note ? "" : "[@media(hover:none)]:hidden [@media(pointer:coarse)]:hidden"}`}>
        {note ?? hint}
      </p>
    )}
    </div>
  );
}

/**
 * The guided search's progress strip, where the scrubber is outside it (no free seeking during play): the
 * decisions this scenario has, named, a check on each one made, the current one marked; the mission clock
 * and whether it is paused for a decision. A live region reads out each new step.
 */
export function GuideStrip({
  pips,
  at,
  call,
  paused,
  announce,
}: {
  pips: readonly { id: string; label: string; state: "done" | "current" | "next"; count?: number }[];
  /** The mission clock (ISO). */
  at: string;
  /** A decision is open: the clock waits for it. */
  call: boolean;
  paused: boolean;
  /** What the live region says ("Your call, Triage: …"). */
  announce: string;
}) {
  const local = (iso: string) => clock(iso, DEMO_TZ);
  return (
    <div className="pointer-events-none flex w-full flex-col items-stretch gap-1">
      <div
        role="group"
        aria-label="Decisions"
        data-tour="scrubber"
        className="pointer-events-auto flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-surface-solid px-3 py-1.5 shadow-[0_12px_32px_-12px_rgba(0,0,0,0.8)]"
      >
        <span className="w-12 shrink-0 text-small text-text" title={`Mission clock, ${utcLabel(at)}`}>
          {local(at)}
        </span>
        <ol className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {pips.map((p, i) => (
            <li
              key={p.id}
              aria-current={p.state === "current" ? "step" : undefined}
              className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-caption ${p.state === "current" ? (call ? "border-caution text-text" : "border-border text-text") : p.state === "done" ? "border-line text-text-2" : "border-line text-text-3"}`}
            >
              <span aria-hidden className={p.state === "done" ? "text-ok" : "text-text-3"}>
                {p.state === "done" ? "✓" : i + 1}
              </span>
              <span>{p.label}</span>
              {p.count && p.count > 1 ? <span className="text-text-3">×{p.count}</span> : null}
              <span className="sr-only">{p.state === "done" ? ", decided" : p.state === "current" ? ", now" : ""}</span>
            </li>
          ))}
        </ol>
        <span className={`shrink-0 text-caption ${call ? "text-caution" : "text-text-3"}`}>{call ? "Mission clock paused" : paused ? "Paused" : "Clock running"}</span>
      </div>
      <p className="sr-only" aria-live="polite" role="status">
        {announce}
      </p>
    </div>
  );
}
