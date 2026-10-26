// Free play's clock control (`#m/demo/map`, the console on its own): one slim bar over the map with the
// mission time, Play/Pause (Space), the speed, Restart (asks first), and the ways out: the guided search
// instead, or another scenario. A run starts paused at the call: nothing moves until the visitor presses Play. No coach bar, no step strip, no ring: the decisions arrive in Needs you
// and wait there while the clock runs. While the clock stops on a beat, the bar says what happened and what
// it means (caption.ts). It is one line (the ways out under More), so it never hides the map's
// grid or the decision waiting. GuideRun.tsx mounts it. Built by lane A.

import { useState } from "react";
import { KeyHint } from "../shell/components";
import { RestartConfirm } from "./CoachMark";

export function FreeClock({
  clock,
  paused,
  onPause,
  speed,
  speeds,
  onSpeed,
  onRestart,
  guideHref,
  scenariosHref,
  setupHref = null,
  waiting,
  atCall = false,
  caption = null,
}: {
  /** The mission clock as it reads ("13:35"). */
  clock: string;
  paused: boolean;
  onPause: () => void;
  speed: number;
  speeds: readonly number[];
  onSpeed: (s: number) => void;
  onRestart: () => void;
  guideHref: string;
  scenariosHref: string;
  /** Open play: the visitor's own setup (#play), offered in place of the guided search. */
  setupHref?: string | null;
  /** Items waiting in Needs you (its own count, NeedsYou `useNeedsTotal`), said beside the clock. */
  waiting: number;
  /** Still at the call, never played: the console is the visitor's to set up first. */
  atCall?: boolean;
  /** The beat the clock stops on: what happened and what it means (caption.ts). */
  caption?: string | null;
}) {
  const [asking, setAsking] = useState(false);
  const [more, setMore] = useState(false);
  const status = paused && atCall ? "Nothing runs until you press Play: approve the survey, assign teams, add a clue or try a photo first" : waiting ? `${waiting} waiting in Needs you` : paused ? "Paused" : "Time passes; decisions wait in Needs you";
  const ways = (
    <>
      <button type="button" onClick={() => setAsking(true)} aria-haspopup="dialog" aria-expanded={asking} className="sl-tap text-caption text-text-2 hover:text-text">
        Restart
      </button>
      {setupHref ? (
        <a href={setupHref} className="sl-tap text-caption text-text-2 underline underline-offset-2 hover:text-text">
          Edit setup
        </a>
      ) : (
        <a href={guideHref} className="sl-tap text-caption text-text-2 underline underline-offset-2 hover:text-text">
          Start the guided simulation instead
        </a>
      )}
      <a href={scenariosHref} className="sl-tap text-caption text-text-2 underline underline-offset-2 hover:text-text">
        Change scenario
      </a>
    </>
  );
  return (
    <div className="pointer-events-none flex w-full justify-center">
      <div
        role="group"
        aria-label="Mission clock"
        data-free-clock
        className="pointer-events-auto flex w-full max-w-[46rem] flex-col gap-1 rounded-lg border border-border bg-surface-solid px-2.5 py-1.5 text-small shadow-[var(--shadow-pop)]"
      >
        <div className="flex items-center gap-x-3 max-sm:gap-x-2">
          <button
            type="button"
            onClick={onPause}
            aria-label={paused ? "Play the mission clock" : "Pause the mission clock"}
            className="sl-tap inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border px-3 py-0.5 text-text hover:bg-surface-strong"
          >
            {paused ? "Play" : "Pause"} <span className="max-sm:hidden"><KeyHint>Space</KeyHint></span>
          </button>
          <span className="shrink-0 font-mono text-body text-text tabular-nums" aria-live="off" title="Mission time">
            {clock}
          </span>
          <span role="group" aria-label="Speed" className="flex shrink-0 items-center gap-0.5 rounded-full border border-line p-0.5">
            {speeds.map((s) => (
              <button key={s} type="button" aria-pressed={s === speed} onClick={() => onSpeed(s)} className={`sl-tap rounded-full px-2.5 py-0.5 text-caption max-sm:px-2 ${s === speed ? "bg-surface-strong text-text" : "text-text-2 hover:text-text"}`}>
                {s}×
              </button>
            ))}
          </span>
          <span data-free-status className="min-w-0 flex-1 truncate text-caption text-text-3" title={status}>
            {status}
          </span>
          <button type="button" aria-expanded={more} onClick={() => setMore((m) => !m)} className="sl-tap shrink-0 text-caption text-text-2 underline underline-offset-2 hover:text-text">
            {more ? "Less" : "More"}
          </button>
        </div>
        {/* the ways out, one tap away (hidden by a class: the bar stays one line while the clock runs) */}
        <div className={more ? "flex flex-wrap items-center gap-x-3 gap-y-1" : "hidden"}>{ways}</div>
        {caption && (
          <p data-free-caption aria-live="polite" className="max-w-[44rem] text-small text-text max-sm:line-clamp-2">
            {caption}
          </p>
        )}
      </div>
      {asking && (
        <RestartConfirm
          onStay={() => setAsking(false)}
          onRestart={() => {
            setAsking(false);
            onRestart();
          }}
        />
      )}
    </div>
  );
}
