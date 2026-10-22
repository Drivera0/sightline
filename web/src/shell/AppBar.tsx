// The app's one top bar, on every page: the brand, the four places (Overview, Guided demo, Console,
// For judges) and one button on the right (New search; "Open demo console" on a site with no mission
// server). A page can add a centre slot (the mission's tabs), extras before the button (Shortcuts, the
// menu) and a second row under it (the guided demo's steps).

import type { ReactNode } from "react";
import { apiBase } from "../lib/api";
import { Button } from "./components";
import { Brand } from "./Logo";

export type Section = "overview" | "demo" | "console" | "judges" | "new" | "try";

const LAST_MISSION_KEY = "sightline.lastMission";

/** Remember the live mission that is open, so Console leads back to it from any page. */
export function rememberMission(id: string): void {
  try {
    window.sessionStorage.setItem(LAST_MISSION_KEY, id);
  } catch {
    // storage blocked: Console falls back to the demo console
  }
}

function lastMission(): string | null {
  try {
    return window.sessionStorage.getItem(LAST_MISSION_KEY);
  } catch {
    return null;
  }
}

export const DEMO_CONSOLE = "#m/demo/command";

/** The console: this live mission's, the last live mission opened (when there is a server), else the demo's. */
export function consoleHref(base: string | null, missionId?: string): string {
  const id = missionId ?? (base === null ? null : lastMission());
  return id ? `#m/${id}/command` : DEMO_CONSOLE;
}

/** The right-hand button: New search when there is a mission server, else the demo console. */
export function primaryAction(base: string | null): { label: string; href: string } {
  return base === null ? { label: "Open demo console", href: DEMO_CONSOLE } : { label: "New search", href: "#new" };
}

export function AppBar({
  current,
  wide = false,
  center,
  extra,
  below,
  missionId,
  base = apiBase(),
}: {
  /** Which place this page belongs to (marked aria-current). */
  current: Section;
  /** Full width (the console, the guided demo, mission pages) instead of the page column. */
  wide?: boolean;
  /** Centre slot: the mission tabs. On the bar's row from 1280 px, on its own row below that. */
  center?: ReactNode;
  /** Before the right-hand button: Shortcuts, the menu. */
  extra?: ReactNode;
  /** A second row under the bar: the guided demo's steps. */
  below?: ReactNode;
  /** The live mission on screen, for the Console link. */
  missionId?: string;
  base?: string | null;
}) {
  const places: { id: Section; label: string; href: string }[] = [
    { id: "overview", label: "Overview", href: "#" },
    { id: "demo", label: "Guided demo", href: "#survey" },
    { id: "console", label: "Console", href: consoleHref(base, missionId) },
    { id: "judges", label: "For judges", href: "#judges" },
  ];
  const action = primaryAction(base);
  // On the console with no server, the button would repeat the page you're on.
  const showAction = !(current === "console" && base === null);
  const column = wide ? "px-4 lg:px-6" : "mx-auto max-w-6xl px-4 lg:px-8";
  return (
    <header className="shrink-0 border-b border-line">
      <div className={`flex min-h-14 flex-wrap items-center gap-x-6 gap-y-1 py-2 ${column}`}>
        <span className="order-1">
          <Brand />
        </span>
        <nav aria-label="Sightline" className="order-3 -mx-1 basis-full overflow-x-auto md:order-2 md:mx-0 md:basis-auto">
          <ul className="flex items-center gap-1">
            {places.map((p) => (
              <li key={p.id}>
                <a
                  href={p.href}
                  aria-current={current === p.id ? "page" : undefined}
                  className={
                    "sl-tap inline-flex items-center whitespace-nowrap rounded-full px-3 text-small transition-colors " +
                    (current === p.id ? "bg-surface-strong text-text" : "text-text-2 hover:text-text")
                  }
                >
                  {p.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        {center && <div className="order-5 flex basis-full justify-start overflow-x-auto xl:order-3 xl:flex-1 xl:basis-auto xl:justify-center">{center}</div>}
        <div className="order-2 ml-auto flex items-center gap-3 md:order-4">
          {extra}
          {showAction && (
            // secondary: the page's own primary button stays the one solid accent on screen
            <Button href={action.href} variant="secondary" aria-current={current === "new" ? "page" : undefined}>
              {action.label}
            </Button>
          )}
        </div>
      </div>
      {below && <div className={`pb-3 ${column}`}>{below}</div>}
    </header>
  );
}
