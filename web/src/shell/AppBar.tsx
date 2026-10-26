// The app's one header. Row one: the wordmark (it goes to the home page), the mission on screen (name, Live/Demo,
// the one disclosure chip), the view switch (Map · Photos · Trace · Debrief, `aria-pressed`), the action,
// the theme toggle (dark or light) and the shortcuts. Row two, on a mission: the status line (StatusLine.tsx). Under 1024 px the view switch
// becomes four tabs along the bottom: Map, Needs you, Timeline, More (Photos, Trace, Debrief).

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, DisclosureChip, ModeChip, type Mode } from "./components";
import type { View } from "./flow";
import { VIEWS } from "./flow";
import { Brand } from "./Logo";
import { ThemeToggle } from "./ThemeToggle";

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
  /** "14:18 PDT", the incident's local time; null before the mission has loaded. */
  clock: string | null;
  /** The clock's tooltip: the same moment in UTC. */
  clockTitle?: string;
  /** The demo's one disclosure ("Simulation on real aerial photographs"). */
  disclose?: boolean;
}

export interface BarAction {
  label: string;
  href?: string;
  onClick?: () => void;
  primary?: boolean;
}

export interface BarViews {
  current: View;
  onSelect: (view: View) => void;
  /** A count beside a view (Map: decisions waiting). */
  counts?: Partial<Record<View, number>>;
}

/** The phone's four tabs. Map, Needs you and Timeline are parts of the console; More holds the other views. */
export type PhoneTab = "map" | "needs" | "timeline" | "more";
export interface BarTabs {
  current: PhoneTab;
  onSelect: (tab: PhoneTab) => void;
  needs?: number;
}

function ViewButtons({ views }: { views: BarViews }) {
  return (
    <ul className="flex items-center gap-0.5 rounded-full border border-line bg-surface-solid p-0.5">
      {VIEWS.map((v) => {
        const on = views.current === v.id;
        const n = views.counts?.[v.id];
        return (
          <li key={v.id}>
            <button
              type="button"
              aria-pressed={on}
              title={`${v.label}: ${v.what} (${v.key})`}
              onClick={() => views.onSelect(v.id)}
              className={`sl-tap whitespace-nowrap rounded-full px-3 py-1 text-small transition-colors ${on ? "bg-surface-strong text-text shadow-[inset_0_0_0_1px_var(--border)]" : "text-text-2 hover:text-text"}`}
            >
              {v.label}
              {n ? <span className="ml-1.5 text-accent">{n}</span> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

const TAB_LABEL: Record<PhoneTab, string> = { map: "Map", needs: "Needs you", timeline: "Timeline", more: "More" };

/** The phone's bottom bar: four tabs; More opens the other views. The Map tab keeps `aria-pressed` with the view switch's name. */
function PhoneBar({ views, tabs }: { views: BarViews; tabs: BarTabs }) {
  const [more, setMore] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!more) return undefined;
    const off = (e: PointerEvent) => !menu.current?.contains(e.target as Node) && setMore(false);
    document.addEventListener("pointerdown", off);
    return () => document.removeEventListener("pointerdown", off);
  }, [more]);
  const inConsole = views.current === "map";
  return (
    <div ref={menu} className="relative">
      {more && (
        <ul role="menu" aria-label="More views" className="absolute right-2 bottom-full mb-2 flex w-48 flex-col rounded-lg border border-line bg-surface-solid p-1 shadow-[var(--shadow-pop)]">
          {VIEWS.filter((v) => v.id !== "map").map((v) => (
            <li key={v.id} role="none">
              <button
                role="menuitem"
                type="button"
                aria-pressed={views.current === v.id}
                onClick={() => {
                  setMore(false);
                  views.onSelect(v.id);
                }}
                className={`sl-tap w-full rounded-sm px-3 py-2 text-left text-small ${views.current === v.id ? "bg-surface-strong text-text" : "text-text-2"}`}
              >
                {v.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      <ul className="grid grid-cols-4">
        {(Object.keys(TAB_LABEL) as PhoneTab[]).map((t) => {
          const on = t === "more" ? !inConsole || more : inConsole && tabs.current === t;
          return (
            <li key={t} className="flex">
              <button
                type="button"
                aria-pressed={on}
                aria-haspopup={t === "more" ? "menu" : undefined}
                aria-expanded={t === "more" ? more : undefined}
                onClick={() => {
                  if (t === "more") return setMore((m) => !m);
                  setMore(false);
                  if (!inConsole) views.onSelect("map");
                  tabs.onSelect(t);
                }}
                className={`sl-tap flex flex-1 flex-col items-center justify-center gap-1 py-2 text-caption ${on ? "text-text" : "text-text-3"}`}
              >
                <span aria-hidden className={`h-0.5 w-6 rounded-full ${on ? "bg-accent" : "bg-transparent"}`} />
                <span>
                  {TAB_LABEL[t]}
                  {t === "needs" && tabs.needs ? <span className="ml-1 text-accent">{tabs.needs}</span> : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function AppBar({
  mission,
  views,
  tabs,
  action,
  extra,
  status,
}: {
  mission?: BarMission | null;
  views?: BarViews | null;
  /** The phone's four tabs (the console); without them the view switch goes along the bottom as before. */
  tabs?: BarTabs | null;
  action?: BarAction | null;
  extra?: ReactNode;
  /** The status line under the bar (a mission's elapsed time, daylight, flyability, people out…). */
  status?: ReactNode;
}) {
  return (
    <>
      <header className="relative z-30 shrink-0 border-b border-line bg-bg">
        <div className="flex h-12 min-w-0 items-center gap-3 overflow-hidden px-3 lg:gap-4 lg:px-4">
          <Brand />
          {mission && (
            <div role="group" className="flex min-w-0 items-center gap-2" aria-label="Mission">
              <span aria-hidden className="hidden h-5 w-px bg-line sm:block" />
              <span className="truncate text-small font-medium text-text" title={mission.name}>
                {mission.name}
              </span>
              {/* the demo's one disclosure is its chip: no Demo chip beside it */}
              {!mission.disclose && <ModeChip mode={mission.mode} />}
              {mission.disclose && (
                // the pill's own display rule outranks a utility class: hide its wrapper on phones
                <span className="hidden md:inline-flex">
                  <DisclosureChip />
                </span>
              )}
              {mission.clock && !status && (
                <span className="hidden whitespace-nowrap text-small text-text-2 sm:inline" title={mission.clockTitle ?? "Mission clock"}>
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
          <div className={`flex shrink-0 items-center gap-2 ${views ? "" : "ml-auto"}`}>
            {action && (
              <Button href={action.href} onClick={action.onClick} variant={action.primary ? "primary" : "secondary"} className="h-8! max-sm:hidden">
                {action.label}
              </Button>
            )}
            <ThemeToggle />
            {extra}
          </div>
        </div>
        {status}
      </header>
      {views && (
        <nav aria-label="Mission views" className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
          {tabs ? <PhoneBar views={views} tabs={tabs} /> : <OldBottom views={views} />}
        </nav>
      )}
    </>
  );
}

/** Without the console's tabs (a mission still loading): the views along the bottom. */
function OldBottom({ views }: { views: BarViews }) {
  return (
    <ul className="grid grid-cols-4">
      {VIEWS.map((v) => (
        <li key={v.id} className="flex">
          <button type="button" aria-pressed={views.current === v.id} onClick={() => views.onSelect(v.id)} className={`sl-tap flex-1 py-2 text-caption ${views.current === v.id ? "text-text" : "text-text-3"}`}>
            {v.label}
          </button>
        </li>
      ))}
    </ul>
  );
}
