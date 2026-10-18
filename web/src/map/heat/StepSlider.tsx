import type { CSSProperties, Ref } from "react";
import { Label } from "../../shell/components";

export function stepText(stepIndex: number, stepCount: number): string {
  return stepIndex <= 0 ? "Before the first frame" : `After frame ${stepIndex} of ${stepCount}`;
}

interface Props {
  value: number;
  max: number;
  /** The replay clock is running (useFlightReplay); the clock moves the thumb itself between renders. */
  playing?: boolean;
  onTogglePlay?: () => void;
  /** Moved by hand or keyboard: whole frames. */
  onScrub: (value: number) => void;
  /** Jump to the end of the flight. */
  onSkip?: () => void;
  inputRef?: Ref<HTMLInputElement>;
}

/**
 * 0…N frames applied, with play/pause and skip to the end. Hidden when there are no steps. The play
 * clock lives in useFlightReplay; this is only the controls.
 */
export function StepSlider({ value, max, playing = false, onTogglePlay, onScrub, onSkip, inputRef }: Props) {
  if (max <= 0) return null;

  const percent = (value / max) * 100;
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={onTogglePlay}
        aria-pressed={playing}
        aria-label={playing ? "Pause" : "Play"}
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-text text-bg lg:size-9 transition-transform duration-150 hover:scale-105 active:scale-95"
      >
        {playing ? (
          <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden="true">
            <rect x="3.5" y="2.5" width="3" height="11" rx="1" fill="currentColor" />
            <rect x="9.5" y="2.5" width="3" height="11" rx="1" fill="currentColor" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" className="ml-0.5 size-3.5" aria-hidden="true">
            <path d="M4.5 2.8v10.4a.8.8 0 0 0 1.2.7l8.3-5.2a.8.8 0 0 0 0-1.4L5.7 2.1a.8.8 0 0 0-1.2.7Z" fill="currentColor" />
          </svg>
        )}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 pr-2">
        <div className="flex items-baseline justify-between gap-3">
          <Label>Flight replay</Label>
          {/* Announced at rest only: during play it changes several times a second. */}
          <span className="font-mono text-label text-text-2" aria-live={playing ? "off" : "polite"}>
            {stepText(value, max)}
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={max}
          // Fractional while playing so the clock can glide the thumb; whole frames by hand.
          step={playing ? "any" : 1}
          value={value}
          ref={inputRef}
          aria-label="Frames applied to the search map"
          aria-valuetext={stepText(value, max)}
          onChange={(e) => onScrub(Math.round(Number(e.target.value)))}
          className="sl-range w-full"
          style={{ "--sl-range-fill": `${percent}%` } as CSSProperties}
        />
      </div>
      {onSkip && (
        <button
          type="button"
          onClick={onSkip}
          disabled={value >= max && !playing}
          aria-label="Skip to the end of the flight"
          title="Skip to the end of the flight"
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-text-2 transition-colors hover:bg-surface-strong hover:text-text disabled:opacity-40 disabled:hover:bg-transparent lg:size-9"
        >
          <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden="true">
            <path d="M3 3.2v9.6a.7.7 0 0 0 1.1.6l6.4-4.8a.7.7 0 0 0 0-1.2L4.1 2.6a.7.7 0 0 0-1.1.6Z" fill="currentColor" />
            <rect x="11.5" y="2.5" width="2" height="11" rx="0.8" fill="currentColor" />
          </svg>
        </button>
      )}
    </div>
  );
}
