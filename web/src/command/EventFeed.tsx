// The event feed (LANE_E §7, E-10): what happened on the mission, newest first, the last 50 events,
// filtered by kind with chips. Built by lane A for lane E (#70).
import { useState, type ReactNode } from "react";
import type { MissionEvent } from "../contract";
import { Panel } from "../shell/components";

export const FEED_LIMIT = 50;

/** Chip → event types. "All" shows everything. */
export const FEED_FILTERS: Record<string, readonly MissionEvent["type"][] | null> = {
  All: null,
  Photos: ["photo.processed", "detection.new", "verdict"],
  Proposals: ["proposal.new", "proposal.decided"],
  "Clues & tasks": ["clue.added", "task.updated", "team.updated"],
  Radio: ["radio.turn"],
  "Map & fleet": ["map.updated", "fleet.updated"],
  Conditions: ["conditions.updated"],
  Notes: ["mission.note"],
};

/** The events a chip shows, newest first, at most FEED_LIMIT. */
export function feedEvents(events: readonly MissionEvent[], filter: string): MissionEvent[] {
  const types = FEED_FILTERS[filter] ?? null;
  const shown = types ? events.filter((e) => types.includes(e.type)) : events;
  return [...shown].reverse().slice(0, FEED_LIMIT);
}

export function EventFeed({ events, extra }: { events: readonly MissionEvent[]; extra?: ReactNode }) {
  const [filter, setFilter] = useState("All");
  const shown = feedEvents(events, filter);
  return (
    <Panel aria-label="Mission feed" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Show">
        {Object.keys(FEED_FILTERS).map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className={`rounded-full border px-2.5 py-0.5 text-caption ${filter === f ? "border-accent text-text" : "border-border text-text-2"}`}
          >
            {f}
          </button>
        ))}
        {extra && <span className="ml-auto">{extra}</span>}
      </div>
      {shown.length === 0 && <p className="text-small text-text-3">Nothing yet.</p>}
      {shown.map((e) => (
        <div key={e.id} className="flex gap-3 text-small">
          <span className="font-mono text-text-3">{e.at.slice(11, 19)}</span>
          <span className="font-mono text-text-2">{e.type}</span>
          <span className="text-text">{e.summary}</span>
        </div>
      ))}
      {events.length > FEED_LIMIT && filter === "All" && (
        <p className="text-caption text-text-3">The last {FEED_LIMIT} of {events.length} events; the debrief has them all.</p>
      )}
    </Panel>
  );
}
