// Free play's clock control (`#m/demo/map`, the console on its own): one slim bar over the map with the
// mission time, Play/Pause (Space), the speed, Restart (asks first), and the ways out: the guided search
// instead, or another scenario. A run starts paused at the call: nothing moves until the visitor presses Play. No coach bar, no step strip, no ring: the decisions arrive in Needs you
// and wait there while the clock runs. GuideRun.tsx mounts it. Built by lane A.

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
  /** Items in Needs you waiting for a person (said beside the clock). */
  waiting: number;
  /** Still at the call, never played: the console is the visitor's to set up first. */
  atCall?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  return (
    <div className="pointer-events-none flex w-full justify-center">
      <div
        role="group"
        aria-label="Mission clock"
        data-free-clock
        className="pointer-events-auto flex max-w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-surface-solid px-2.5 py-1.5 text-small shadow-[var(--shadow-pop)]"
      >
        <button
          type="button"
          onClick={onPause}
          aria-label={paused ? "Play the mission clock" : "Pause the mission clock"}
          className="sl-tap inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-0.5 text-text hover:bg-surface-strong"
        >
          {paused ? "Play" : "Pause"} <KeyHint>Space</KeyHint>
        </button>
        <span className="font-mono text-body text-text tabular-nums" aria-live="off" title="Mission time">
          {clock}
        </span>
        <span role="group" aria-label="Speed" className="flex items-center gap-0.5 rounded-full border border-line p-0.5">
          {speeds.map((s) => (
            <button key={s} type="button" aria-pressed={s === speed} onClick={() => onSpeed(s)} className={`sl-tap rounded-full px-2.5 py-0.5 text-caption ${s === speed ? "bg-surface-strong text-text" : "text-text-2 hover:text-text"}`}>
              {s}×
            </button>
          ))}
        </span>
        <span className="text-caption text-text-3">{waiting ? `${waiting} ${waiting === 1 ? "proposal waits" : "proposals wait"} in Needs you` : paused && atCall ? "Nothing runs until you press Play: assign teams, add a clue or try a photo first" : paused ? "Paused" : "Time passes; decisions wait in Needs you"}</span>
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
