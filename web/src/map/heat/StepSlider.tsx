import { useEffect, useRef, useState } from "react";
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

  return (
    <div className="flex items-center gap-4">
      <button
        type="button"
        onClick={togglePlay}
        aria-pressed={playing}
        className="shrink-0 rounded-sm border border-border bg-surface-strong px-3 py-1.5 font-mono text-small text-text hover:border-accent"
      >
        {playing ? "Pause" : "Play"}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-baseline justify-between gap-3">
          <Label>Flight replay</Label>
          <span className="font-mono text-small text-text" aria-live="polite">
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
          className="w-full accent-[var(--accent)]"
        />
      </div>
    </div>
  );
}
