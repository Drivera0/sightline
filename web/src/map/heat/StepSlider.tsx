import { type CSSProperties, useEffect, useRef, useState } from "react";
import { Label } from "../../shell/components";

/** Ticks per full play-through: the whole flight plays in about PLAY_TICKS × TICK_MS. */
const PLAY_TICKS = 200;
const TICK_MS = 50;

export function stepText(stepIndex: number, stepCount: number): string {
  return stepIndex <= 0 ? "Before the first frame" : `After frame ${stepIndex} of ${stepCount}`;
}

interface Props {
  value: number;
  max: number;
  onChange: (value: number) => void;
}

/** 0…N frames applied, with play/pause. Hidden when there are no steps. */
export function StepSlider({ value, max, onChange }: Props) {
  const [playing, setPlaying] = useState(false);
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!playing) return undefined;
    const stride = Math.max(1, Math.ceil(max / PLAY_TICKS));
    const timer = setInterval(() => {
      const next = Math.min(max, valueRef.current + stride);
      onChangeRef.current(next);
      if (next >= max) setPlaying(false);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [playing, max]);

  if (max <= 0) return null;

  const togglePlay = () => {
    if (!playing && value >= max) onChange(0);
    setPlaying((p) => !p);
  };

  const percent = (value / max) * 100;
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={togglePlay}
        aria-pressed={playing}
        aria-label={playing ? "Pause" : "Play"}
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-text text-bg transition-transform duration-150 hover:scale-105 active:scale-95"
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
          <span className="font-mono text-label text-text-2" aria-live="polite">
            {stepText(value, max)}
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={max}
          step={1}
          value={value}
          aria-label="Frames applied to the search map"
          aria-valuetext={stepText(value, max)}
          onChange={(e) => {
            setPlaying(false);
            onChange(Number(e.target.value));
          }}
          className="sl-range w-full"
          style={{ "--sl-range-fill": `${percent}%` } as CSSProperties}
        />
      </div>
    </div>
  );
}
