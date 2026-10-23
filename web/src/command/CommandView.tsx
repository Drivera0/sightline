// The command post (COMMAND_POST.md §5): the console a search manager runs the search from. Resources on
// the left (T-cards), the map in the middle (about 55 % of a 1440 px screen; click a sector to act on it,
// drag a team onto one), Needs you on the right (decisions only), the timeline along the bottom with the
// talk bar. The status line is the header's second row (StatusLine.tsx). The views change the right-hand
// column or lay a sheet over the console, never the map. Phones stack the regions (Needs you, the map, the
// timeline, the resources) and the bottom tabs jump between them. Built by lane A.

import { useEffect, useState, type ReactNode } from "react";
import type { Clue, ClueDraft, Conditions, Drone, FleetState, Mission, MissionEvent, Proposal, SectorTask, Team, TimelineEvent } from "../contract";
import type { SectorNow } from "../lib/api";
import { useMission, type FleetLinks } from "../lib/mission";
import { DEMO_TZ, clock, zone, type Tz } from "../lib/time";
import { type Decide } from "./ApprovalInbox";
import { ConditionsPanel, type ConditionsData } from "./ConditionsPanel";
import { dayNote } from "./conditions";
import { FleetControls } from "./FleetControls";
import { useConsole } from "./consoleStore";
import { NeedsYou } from "./NeedsYou";
import { Resources } from "./Resources";
import { SectorPopover, type SectorActions } from "./SectorPopover";
import { ClueForm, Timeline, TalkBar, type TalkVoice } from "./Timeline";

/** The demo mission is dated at Mount Seymour; a live mission reads the browser's zone. */
export const missionTz = (status: string): Tz => (status === "demo" ? DEMO_TZ : false);

export interface ConsoleActions extends SectorActions {
  call: (teamId: string, text: string) => void | Promise<void>;
  recall: (teamId: string) => void;
  recallDrone: (droneId: string) => void;
  confirmClue: (clueId: string) => void;
}

/** The console's actions on the mission store (useMission): live missions call the API, the demo acts in memory. */
export function storeActions(): ConsoleActions {
  const m = () => useMission.getState();
  return {
    assign: (team, sector) => void m().assign(team, sector),
    droneLeg: (sector, drone) => void m().droneLeg(sector, drone),
    searched: (sector, pod) => void m().searched(sector, pod),
    recheck: (sector) => void m().recheck(sector),
    found: (team, sector) => void m().found(team, sector),
    call: (team, text) => m().call(team, text),
    recall: (team) => void m().recall(team),
    recallDrone: (drone) => void m().recallDrone(drone),
    confirmClue: (clue) => void m().confirmClue(clue),
  };
}

export interface CommandProps {
  mission: Mission | null;
  status: string;
  conditions: Conditions | null;
  tasks: readonly SectorTask[];
  sectors: readonly SectorNow[];
  teams: readonly Team[];
  clues: readonly Clue[];
  proposals: readonly Proposal[];
  events: readonly MissionEvent[];
  /** The server's timeline, when it sends one. */
  timeline?: readonly TimelineEvent[];
  fleet: FleetState | null;
  links: FleetLinks;
  imageUrl: (rel: string) => string;
  /** The clues behind an assignment's sector, from the map log (clueShift.ts). */
  clueNote?: (p: Proposal) => string | null;
  onDecide: Decide;
  onAddClue: (draft: ClueDraft) => void | Promise<void>;
  /** Pick the clue's position on the live map (B-M3); null when cancelled. */
  onPickOnMap?: () => Promise<{ lat: number; lon: number } | null>;
  actions: ConsoleActions;
  /** Where a sector's assignment card opens (E-09); without it, no Card links. */
  cardHref?: (sectorId: string) => string;
  map: ReactNode;
  /** Over the map, along its bottom edge (the story's scrubber). */
  overMap?: ReactNode;
  /** Right above the map, phones only (the Photos view's strip). */
  aboveMap?: ReactNode;
  /** The right-hand column in place of Needs you (the Photos or Debrief view). */
  rightRail?: ReactNode;
  /** The right-hand column is the wide debrief; the resources step aside on a desktop. */
  rightWide?: boolean;
  /** Over the whole console, the map still mounted under it (the Trace view). */
  cover?: ReactNode;
  /** The review cards for Needs you, and how many wait for an answer. */
  review: ReactNode;
  reviewCount: number;
  briefings?: ReactNode;
  storyProposal?: string | null;
  voice?: TalkVoice | null;
  /** The Conditions panel (W): its data, and whether it is open (the status line toggles it). */
  conditionsData?: ConditionsData | null;
  conditionsOpen?: boolean;
  conditionsId?: string;
  now?: () => Date;
  feedHref?: string;
}

export function CommandView(p: CommandProps) {
  const now = p.now ?? (() => new Date());
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000); // the clock and the ages
    return () => clearInterval(id);
  }, []);
  const tz = missionTz(p.status);
  // the simulated fleet's demo controls (live missions only: they call the API)
  const api = useMission((s) => s.api);
  const t = now();
  const panelNow = p.conditionsData?.recorded ? new Date(p.conditionsData.conditions.fetched_at) : t;
  const sel = useConsole((s) => s.sector);
  const picking = useConsole((s) => s.picking);
  const drones: Drone[] = p.fleet?.drones ?? [];
  const wide = !!p.rightWide;
  const popSector = sel ? p.sectors.find((s) => s.sector_id === sel.id) : undefined;
  const [mapBox, setMapBox] = useState<HTMLDivElement | null>(null);
  const pickName = picking ? (picking.kind === "team" ? p.teams.find((x) => x.id === picking.id)?.callsign : drones.find((d) => d.id === picking.id)?.name) : null;
  useEffect(() => {
    if (!picking) return undefined;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && useConsole.getState().pick(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picking]);
  const call = (teamId: string, draft?: string) => useConsole.getState().talk(teamId, draft ?? `${p.teams.find((x) => x.id === teamId)?.callsign ?? teamId}, Sightline. `);
  const grid = wide
    ? "lg:grid-cols-[minmax(0,1fr)_minmax(28rem,44rem)] lg:grid-rows-[minmax(0,1fr)_15rem]"
    : "lg:grid-cols-[17rem_minmax(0,1fr)_21rem] lg:grid-rows-[minmax(0,1fr)_15rem]";
  return (
    <div role="group" aria-label="Command view" className={`relative grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] gap-2 lg:gap-3 ${grid}`}>
      {p.conditionsOpen && p.conditionsData && (
        // over the console, under the status line (the map keeps its place); W or Esc closes it
        <div className="absolute inset-x-0 top-0 z-30 max-h-[75vh] overflow-y-auto rounded-lg shadow-[0_24px_60px_-12px_rgba(0,0,0,0.85)]">
          <ConditionsPanel id={p.conditionsId ?? "conditions-panel"} data={p.conditionsData} now={panelNow} time={(iso) => `${clock(iso, tz)} ${zone(new Date(iso), tz)}${dayNote(iso, panelNow, tz)}`} />
        </div>
      )}
      <div id="console-resources" className={`order-4 flex min-h-0 flex-col lg:order-none ${wide ? "lg:hidden" : ""}`}>
        <Resources
          mission={p.mission}
          teams={p.teams}
          tasks={p.tasks}
          sectors={p.sectors}
          fleet={p.fleet}
          links={p.links}
          events={p.events}
          now={t}
          actions={{ onCall: (id) => call(id), onRecall: p.actions.recall, onRecallDrone: p.actions.recallDrone }}
          footer={api && p.mission ? <FleetControls api={api} missionId={p.mission.mission_id} fleet={p.fleet} links={p.links} conditions={p.conditions} /> : undefined}
        />
      </div>
      <div id="console-map" className="order-2 flex min-h-0 flex-col gap-2 lg:order-none">
        {p.aboveMap}
        <div ref={setMapBox} className="relative h-[52vh] min-h-0 lg:h-auto lg:flex-1">
          {p.map}
          {picking && (
            <p role="status" className="absolute top-3 left-1/2 z-10 -translate-x-1/2 rounded-full border border-accent bg-bg/90 px-3 py-1 text-small text-text">
              Click a sector for {pickName} <span className="text-text-3">· Esc cancels</span>
            </p>
          )}
          {sel && popSector && Number.isFinite(sel.x) && mapBox && (
            <SectorPopover
              sector={popSector}
              task={p.tasks.find((x) => x.sector_id === sel.id)}
              teams={p.teams}
              proposals={p.proposals}
              x={sel.x}
              y={sel.y}
              width={mapBox.clientWidth}
              height={mapBox.clientHeight}
              actions={p.actions}
              cardHref={p.cardHref}
              onClose={() => useConsole.getState().closeSector()}
            />
          )}
          {p.overMap && <div className="pointer-events-none absolute inset-x-2 bottom-7 z-10 flex justify-center sm:inset-x-3">{p.overMap}</div>}
        </div>
      </div>
      <div id="console-needs" className="order-1 flex min-h-0 flex-col lg:order-none">
        {p.rightRail ? (
          <aside aria-label="View" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
            {p.rightRail}
          </aside>
        ) : (
          <NeedsYou
            proposals={p.proposals}
            teams={p.teams}
            drones={drones}
            events={p.events}
            clues={p.clues}
            now={t}
            checkInMin={p.mission?.check_in_min ?? 30}
            onDecide={p.onDecide}
            imageUrl={p.imageUrl}
            clueNote={p.clueNote}
            review={p.review}
            reviewCount={p.reviewCount}
            briefings={p.briefings}
            storyProposal={p.storyProposal}
            onCall={(id, draft) => call(id, draft)}
            onRecall={p.actions.recall}
            onConfirmClue={p.actions.confirmClue}

          />
        )}
      </div>
      <div id="console-timeline" className={`order-3 flex h-[28rem] min-h-0 flex-col lg:order-none lg:h-auto ${wide ? "lg:col-span-2" : "lg:col-span-3"}`}>
        <Timeline
          events={p.events}
          server={p.timeline}
          teams={p.teams}
          onConfirmClue={p.actions.confirmClue}
          talk={<TalkBar teams={p.teams} onSend={(team, text) => p.actions.call(team, text)} voice={p.voice} />}
          clueForm={(close) => <ClueForm teams={p.teams} onAddClue={p.onAddClue} onPickOnMap={p.onPickOnMap} onDone={close} />}
        />
      </div>
      {p.cover && <div className="absolute inset-0 z-30 overflow-y-auto rounded-lg bg-bg">{p.cover}</div>}
    </div>
  );
}
