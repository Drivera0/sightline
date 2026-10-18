// Narrow screens: the Search next panels go below the map instead of over it, so the map keeps its
// whole area (at 390 px wide the floating panels covered most of it). The shell puts an element
// under the map and passes it down through PanelSlotContext; HeatLayer portals the panels into it
// when the layout is narrow.
import { createContext, useEffect, useState } from "react";

/** Where the Search next panels go on narrow screens (null: keep them over the map). */
export const PanelSlotContext = createContext<HTMLElement | null>(null);

/** Tailwind's lg breakpoint: from here up the panels float over the map. */
export const WIDE_LAYOUT_QUERY = "(min-width: 1024px)";

/** From here up the Search next legend stays open over the map; below it folds into a pill. */
export const ROOMY_LAYOUT_QUERY = "(min-width: 1280px)";

/** A CSS media query as React state. Without matchMedia (tests, old browsers) it is `fallback`. */
export function useMediaQuery(query: string, fallback: boolean): boolean {
  const read = () =>
    typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : fallback;
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, [query]);
  return matches;
}
