// The home page's motion helpers: slow, once, and never for people who ask for less motion. Tests and
// browsers without IntersectionObserver get the finished state straight away (nothing is ever hidden
// waiting for an observer that will not come).
import { useEffect, useRef, useState, type RefObject } from "react";
import { prefersReducedMotion } from "../metrics/motion";

export { prefersReducedMotion };

/** True when motion is allowed and the page can tell when something scrolls into view. */
export function canAnimate(): boolean {
  return typeof window !== "undefined" && typeof window.IntersectionObserver === "function" && !prefersReducedMotion();
}

/**
 * `seen` turns true the first time the element is at least `threshold` in view, and stays true.
 * Without an observer (tests, old browsers) or with reduced motion it is true from the start.
 */
export function useSeenOnce<T extends Element>(threshold = 0.2): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(() => !canAnimate());
  useEffect(() => {
    if (seen || !ref.current) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { threshold },
    );
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen, threshold]);
  return [ref, seen];
}

/** True while the element is on screen (the hero's wall and the diagram's loop pause when it is not). */
export function useOnScreen<T extends Element>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [on, setOn] = useState(true);
  useEffect(() => {
    if (typeof window.IntersectionObserver !== "function" || !ref.current) return;
    const io = new IntersectionObserver((entries) => setOn(entries.some((e) => e.isIntersecting)));
    io.observe(ref.current);
    return () => io.disconnect();
  }, []);
  return [ref, on];
}
