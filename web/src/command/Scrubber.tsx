// The demo mission's time control, on the map (Flightradar24's playback): play or pause, the six
// checkpoints as ticks, the mission clock. The same control is the story's progress: a tick is a
// checkpoint of the story and a moment of the mission at once.

import type { ReactNode } from "react";
import { clock, DEMO_TZ, utcLabel, zone } from "../lib/time";
import { CHECKPOINTS, type Checkpoint } from "./missionTime";

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
}: {
  t: Checkpoint;
  progress: number;
  playing: boolean;
  /** The mission clock (ISO). */
  at: string;
  onSeek: (t: Checkpoint) => void;
  /** Play or pause: with `canPlay`, at a checkpoint it plays the clock on to the end. */
  onToggle: () => void;
  /** Outside the story: the play button runs the clock from here to the end (else only a run in progress pauses). */
  canPlay?: boolean;
  /** Playing through to the end: the clock it started at (ISO). */
  through?: string | null;
  /** One line under the scrubber, when nothing is playing (how to use the console). */
  hint?: ReactNode;
}) {
  const running = progress < 1;
  // the thumb: between the previous tick and t while the clock runs into t
  const pos = Math.max(0, t - 1 + progress) / (CHECKPOINTS.length - 1);
  const end = CHECKPOINTS[4]!.at;
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
      className="@container pointer-events-auto flex w-full items-center gap-3 rounded-lg border border-border bg-surface-solid px-2 py-1.5 shadow-[0_12px_32px_-12px_rgba(0,0,0,0.8)]"
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
      <span className="w-12 shrink-0 font-mono text-small text-text" title={`Mission clock, ${zoned(at)} (${utcLabel(at)})`} aria-live="off">
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
                  onClick={() => onSeek(c.t)}
                  aria-current={here ? "step" : undefined}
                  title={`${c.label}, ${zoned(c.at)} (${utcLabel(c.at)})`}
                  className="group flex min-h-6 min-w-6 flex-col items-center gap-0.5 rounded-sm px-1 outline-offset-0"
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
    </div>
    {(note || hint) && (
      <p role="status" aria-label="Mission clock status" className="self-center rounded-full bg-bg/85 px-3 py-0.5 text-center text-caption text-text-2 backdrop-blur">
        {note ?? hint}
      </p>
    )}
    </div>
  );
}
