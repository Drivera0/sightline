// Dark or light. The system preference by default; once the visitor picks one with the app bar's toggle it
// is remembered (localStorage). `data-theme` on <html> carries the result; index.html sets it before the
// first paint with the same rule, so the page never flashes the other theme.
import { useSyncExternalStore } from "react";

export type Theme = "dark" | "light";
export const THEME_KEY = "sightline.theme";

const listeners = new Set<() => void>();
const media = () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null);

/** The remembered choice, or null: follow the system. */
export function storedTheme(): Theme | null {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

export function systemTheme(): Theme {
  return media()?.matches ? "light" : "dark";
}

/** The theme on screen. */
export function currentTheme(): Theme {
  return storedTheme() ?? systemTheme();
}

/** Put the theme on <html> (and the browser's own colours). */
export function applyTheme(theme: Theme = currentTheme()): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#f5f5f2" : "#0a0b0d");
  listeners.forEach((l) => l());
}

/** Choose a theme and remember it. */
export function setTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // storage blocked: the choice lasts for this page
  }
  applyTheme(theme);
}

/** Apply the theme now and follow the system's changes while the visitor has not chosen. */
export function initTheme(): void {
  applyTheme();
  media()?.addEventListener?.("change", () => {
    if (storedTheme() === null) applyTheme();
  });
}

const read = (): Theme => (document.documentElement.dataset.theme === "light" ? "light" : "dark");
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The theme on screen, re-rendering when it changes. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, read, () => "dark");
}
