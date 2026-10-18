import { useEffect, useState } from "react";

/** True when the viewer asked for reduced motion, or when the environment can't tell (tests, SSR). */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Counts from 0 to `target` over `durationMs` on first render, easing out. Renders the final
 * value at once when motion is reduced. Used for the headline numbers so the Metrics tab
 * settles in rather than popping, like the number tiles in Componentry-style interfaces.
 */
export function useCountUp(target: number, durationMs = 700): number {
  const [value, setValue] = useState(() =>
    prefersReducedMotion() ? target : 0,
  );

  useEffect(() => {
    if (prefersReducedMotion()) {
      setValue(target);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - (1 - t) ** 3;
      setValue(target * eased);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs]);

  return value;
}
