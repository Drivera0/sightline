// The app's one top bar, one row, on every screen: the wordmark (it opens About), the mission on screen
// (name, LIVE/DEMO, its clock), the view switch (Map · Photos · Review · Trace · Debrief) and one button.
// Under 1024 px the view switch moves to a bar along the bottom of the screen.

import type { ReactNode } from "react";
import { Button, ModeChip, type Mode } from "./components";
import type { View } from "./flow";
import { VIEWS } from "./flow";
import { Brand } from "./Logo";

const LAST_MISSION_KEY = "sightline.lastMission";

/** Remember the live mission that is open (New search's "back to your mission"). */
export function rememberMission(id: string): void {
  try {
    window.sessionStorage.setItem(LAST_MISSION_KEY, id);
  } catch {
    // storage blocked: nothing to go back to
  }
}

export function lastMission(): string | null {
  try {
    return window.sessionStorage.getItem(LAST_MISSION_KEY);
  } catch {
    return null;
  }
}

export interface BarMission {
  name: string;
  mode: Mode;
  /** "21:18 UTC"; null before the mission has loaded. */
  clock: string | null;
}

export interface BarAction {
  label: string;
  href?: string;
  onClick?: () => void;
  primary?: boolean;
}

export interface BarViews {
  current: View;
  onSelect: (view: Exclude<View, "radio">) => void;
  /** A count beside a view (Review: candidates waiting). */
  counts?: Partial<Record<View, number>>;
}

function ViewButtons({ views, bottom = false }: { views: BarViews; bottom?: boolean }) {
  return (
    <ul className={bottom ? "grid grid-cols-5" : "flex items-center gap-0.5 rounded-full border border-line bg-surface-solid p-0.5"}>
      {VIEWS.map((v) => {
        const on = views.current === v.id;
        const n = views.counts?.[v.id];
        return (
          <li key={v.id} className={bottom ? "flex" : undefined}>
            <button
              type="button"
              aria-pressed={on}
              title={`${v.label} (${v.key})`}
              onClick={() => views.onSelect(v.id)}
              className={
                bottom
                  ? `sl-tap flex flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-caption ${on ? "text-text" : "text-text-3"}`
                  : `sl-tap whitespace-nowrap rounded-full px-3.5 py-1 text-small transition-colors ${on ? "bg-surface-strong text-text shadow-[inset_0_0_0_1px_var(--border)]" : "text-text-2 hover:text-text"}`
              }
            >
              {bottom && <span aria-hidden className={`h-0.5 w-6 rounded-full ${on ? "bg-accent" : "bg-transparent"}`} />}
              <span>
                {v.label}
                {n ? <span className="ml-1 font-mono text-accent">{n}</span> : null}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function AppBar({ mission, views, action, extra }: { mission?: BarMission | null; views?: BarViews | null; action?: BarAction | null; extra?: ReactNode }) {
  return (
    <>
      <header className="relative z-30 shrink-0 border-b border-line bg-bg">
        <div className="flex min-h-14 items-center gap-3 px-4 py-2 lg:gap-5 lg:px-6">
          <Brand />
          {mission && (
            <div className="flex min-w-0 items-center gap-2" aria-label="Mission">
              <span aria-hidden className="hidden h-5 w-px bg-line sm:block" />
              <span className="truncate text-small font-medium text-text" title={mission.name}>
                {mission.name}
              </span>
              <ModeChip mode={mission.mode} />
              {mission.clock && (
                <span className="hidden whitespace-nowrap font-mono text-small text-text-2 sm:inline" title="Mission clock">
                  {mission.clock}
                </span>
              )}
            </div>
          )}
          {views && (
            <nav aria-label="Mission views" className="ml-auto hidden lg:block">
              <ViewButtons views={views} />
            </nav>
          )}
          <div className={`flex shrink-0 items-center gap-3 ${views ? "" : "ml-auto"}`}>
            {extra}
            {action && (
              <Button href={action.href} onClick={action.onClick} variant={action.primary ? "primary" : "secondary"}>
                {action.label}
              </Button>
            )}
          </div>
        </div>
      </header>
      {views && (
        <nav aria-label="Mission views" className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
          <ViewButtons views={views} bottom />
        </nav>
      )}
    </>
  );
}
