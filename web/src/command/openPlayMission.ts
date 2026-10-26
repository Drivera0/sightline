// Open play's setup applied to the mission (`#m/demo/map?s=play`), pure. The profile's scenario is the
// story (scenarios.ts scenarioMission: who radios which clue, where the person really is, the photos);
// the setup changes what a search manager sets before the first team goes out:
//
// - the subject's description, the last-seen time, the radio check-in interval (Mission fields);
// - the last known point: the profile's prior moved there (scenarios.ts movePrior), each sector's POA read
//   from that map, and the agent's assignments re-ranked on it (scenarios.ts replan);
// - base camp: one of the staging points; teams wait and drones launch and land there;
// - the roster: the visitor's teams in order take the scenario's places (the teams that radio a clue
//   first, then the first assignment's), renamed, with their own head count; a team past the scenario's
//   four is added at base camp; a place left empty goes, with its proposals and its lines in the log (an
//   assignment it had passes to a kept team with none, if there is one);
// - the drones: the first N of the fleet fly; the rest, their flight lines, their feeds and their lines in
//   the log go.
//
// Where the person really is does not move: it is the scenario's, so a last known point far from it makes
// a longer search. Built by lane A.
import type { Clue, MissionEvent, Proposal, Team, TimelineEvent } from "../contract";
import { CHECKPOINTS, type DemoFull } from "./missionTime";
import { movePrior, replan } from "./scenarios";
import { storyProposal } from "./storyCopy";
import { CALL_LOCAL, snapToArea, STAGING, type PlaySetup } from "./openPlay";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The scenario's teams in the order the visitor's roster fills them: the clue reporters, the first assignment's team, then the rest. */
export function teamPlaces(full: DemoFull): string[] {
  const ids = (full.data.teams ?? []).map((t) => t.id);
  const reporters = [...(full.data.clues ?? [])].sort((a, b) => a.at.localeCompare(b.at)).map((c) => c.reported_by);
  const first = storyProposal(full)?.target.team ?? null;
  return [...new Set([...reporters, first, ...ids].filter((x): x is string => !!x && ids.includes(x)))];
}

/** Every string in a value with the old callsigns swapped for the new ones (at once, so names can trade places). */
function renamed<T>(value: T, names: ReadonlyMap<string, string>): T {
  if (names.size === 0) return value;
  const re = new RegExp(`\\b(${[...names.keys()].map(escape).join("|")})\\b`, "g");
  const skip = new Set(["p", "cells", "polygon", "waypoints", "footprint", "canopy", "prior", "steps", "mapBase", "mapUpdates", "sectors", "survey", "detections"]);
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v.replace(re, (m) => names.get(m) ?? m);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, skip.has(k) ? x : walk(x)]));
    return v;
  };
  return walk(value) as T;
}

type Data = DemoFull["data"];

/** The roster applied: places kept and renamed, places added, places left empty gone (see the file's head). */
function withRoster(d: Data, full: DemoFull, setup: PlaySetup): { data: Data; names: Map<string, string> } {
  const fixture = d.teams ?? [];
  const places = teamPlaces(full);
  const kept = places.slice(0, setup.teams.length);
  const gone = new Set(places.slice(setup.teams.length));
  const goneNames = fixture.filter((t) => gone.has(t.id)).map((t) => t.callsign);
  const mentions = goneNames.length ? new RegExp(`\\b(${goneNames.map(escape).join("|")})\\b`) : null;
  const goneRef = (x: unknown) => typeof x === "string" && (gone.has(x) || goneNames.includes(x));
  // the assignments of a place left empty pass to a kept team that has none, in time order
  const assigns = [...(d.proposals ?? [])].filter((p) => p.kind === "assign_sector" && p.target.team).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const free = kept.filter((id) => !assigns.some((p) => p.target.team === id));
  const moved = new Map<string, string>();
  for (const p of assigns) if (gone.has(p.target.team!) && free.length) moved.set(p.id, free.shift()!);
  const callsignOf = (id: string) => fixture.find((t) => t.id === id)?.callsign ?? id;
  const proposals: Proposal[] = (d.proposals ?? []).flatMap((p) => {
    const to = moved.get(p.id);
    if (to) {
      const swap = (s: string) => s.replace(new RegExp(`\\b${escape(callsignOf(p.target.team!))}\\b`, "g"), callsignOf(to));
      return [{ ...p, target: { ...p.target, team: to }, summary: swap(p.summary), reason: swap(p.reason), ...(p.edits ? { edits: null } : {}) }];
    }
    return p.target.team && gone.has(p.target.team) ? [] : [p];
  });
  const droppedProposals = new Set((d.proposals ?? []).filter((p) => !proposals.some((x) => x.id === p.id)).map((p) => p.id));
  const aboutGone = (e: MissionEvent) => {
    if (e.ref && (gone.has(e.ref) || droppedProposals.has(e.ref))) return true;
    const x = (e.data ?? {}) as Record<string, unknown>;
    if (goneRef(x.team_id) || goneRef(x.team) || goneRef(x.callsign) || goneRef(x.reported_by)) return true;
    return !!mentions && mentions.test(e.summary);
  };
  const events = (d.events ?? []).filter((e) => !aboutGone(e)).map((e) => (e.ref && moved.has(e.ref) && e.data ? { ...e, data: proposals.find((p) => p.id === e.ref) as unknown as MissionEvent["data"] } : e));
  const timeline: TimelineEvent[] = (d.timeline ?? []).filter((e) => !goneRef(e.team) && !(mentions && mentions.test(e.text)));
  // a clue is never left without its reporter (the roster keeps every reporter while it has 2 teams or more)
  const clues: Clue[] = (d.clues ?? []).map((c) => (gone.has(c.reported_by ?? "") ? { ...c, reported_by: kept[0]! } : c));
  const tasks = (d.tasks ?? []).map((t) => (t.team_id && gone.has(t.team_id) ? { ...t, team_id: null } : t));
  const taken = new Set(fixture.map((t) => t.id));
  let n = fixture.length;
  const nextId = () => {
    do n += 1;
    while (taken.has(`T${n}`));
    taken.add(`T${n}`);
    return `T${n}`;
  };
  const names = new Map<string, string>();
  const teams: Team[] = setup.teams.map((want, i) => {
    const id = kept[i];
    const callsign = want.callsign.trim();
    const own = id ? fixture.find((t) => t.id === id) : undefined;
    if (own) {
      if (own.callsign !== callsign) names.set(own.callsign, callsign);
      return { ...own, callsign, members: want.members };
    }
    return { id: nextId(), callsign, members: want.members, status: "standby", position: null, position_at: null, note: null, last_heard_at: null, eta_min: null };
  });
  const radio_clues = (d as { radio_clues?: { team?: string }[] }).radio_clues?.filter((r) => !goneRef(r.team));
  const mission = d.mission?.found && gone.has(d.mission.found.team ?? "") ? { ...d.mission, found: { ...d.mission.found, team: kept[0]! } } : d.mission;
  return { data: { ...d, teams, proposals, events, timeline, clues, tasks, mission, ...(radio_clues ? { radio_clues } : {}) } as Data, names };
}

/** The first `n` drones of the fleet; the others, their flight lines, feeds and lines in the log go. */
function withDrones(d: Data, n: number): Data {
  const fleet = d.fleet;
  if (!fleet) return d;
  const keep = fleet.drones.slice(0, n);
  const gone = fleet.drones.slice(n);
  if (!gone.length) return d;
  const goneIds = new Set(gone.map((x) => x.id));
  const goneLegs = new Set(fleet.legs.filter((l) => goneIds.has(l.drone_id)).map((l) => l.id));
  // "Drone 3", "D3 link lost", "heard via D3", "L003 …": never a sector (D1–D4 are sector ids too)
  const said = [...gone.flatMap((x) => [`\\b${escape(x.name)}\\b`, `^${escape(x.id)}\\b`, `\\bvia ${escape(x.id)}\\b`]), ...[...goneLegs].map((l) => `\\b${escape(l)}\\b`)];
  const re = new RegExp(said.join("|"));
  const proposals = (d.proposals ?? []).filter((p) => !(p.target.drone && goneIds.has(p.target.drone)) && !(p.leg && goneLegs.has(p.leg.id)));
  const droppedProposals = new Set((d.proposals ?? []).filter((p) => !proposals.includes(p)).map((p) => p.id));
  return {
    ...d,
    fleet: { ...fleet, drones: keep, legs: fleet.legs.filter((l) => !goneLegs.has(l.id)) },
    proposals,
    events: (d.events ?? []).filter((e) => !re.test(e.summary) && !(e.ref && (goneLegs.has(e.ref) || droppedProposals.has(e.ref)))),
    timeline: (d.timeline ?? []).filter((e) => !(e.drone && goneIds.has(e.drone)) && !re.test(e.text)),
    feeds: d.feeds?.filter((f) => !goneIds.has(f.drone) && !goneLegs.has(f.leg)),
  };
}

/** "10:30" on the search's day, as an instant: that many minutes before the call (13:35 local, the first checkpoint). */
export function lastSeenAt(hhmm: string, call = CALL_LOCAL): string | null {
  const m = (x: string) => Number(x.slice(0, 2)) * 60 + Number(x.slice(3, 5));
  if (!/^\d\d:\d\d$/.test(hhmm)) return null;
  const callAt = new Date(CHECKPOINTS[0]!.at).getTime();
  return new Date(callAt - (m(call) - m(hhmm)) * 60_000).toISOString().replace(/\.\d+Z$/, "Z");
}

/** The setup applied to the profile's scenario (see the file's head). */
export function applySetup(full: DemoFull, setup: PlaySetup): DemoFull {
  if (!full.data.mission) return full;
  const camp = STAGING.find((x) => x.name === setup.camp) ?? STAGING[0]!;
  const { data: rostered, names } = withRoster(full.data, full, setup);
  let d = withDrones(rostered, setup.drones.length);
  if (d.mapBase && setup.lkp) {
    const base = movePrior(d.mapBase, snapToArea(setup.lkp));
    d = { ...d, mapBase: base, ...replan(d, base, d.mapUpdates ?? [], "ranked from your last known point") };
  }
  const home = { lat: camp.lat, lon: camp.lon };
  const fleet = d.fleet ? { ...d.fleet, drones: d.fleet.drones.map((x) => ({ ...x, home: { ...home } })) } : d.fleet;
  const m = d.mission!;
  const mission = {
    ...m,
    subject: setup.subject.trim() || m.subject,
    area: { ...m.area, lkp: d.mapBase?.lkp ?? m.area.lkp },
    base_camp: { ...home, name: camp.name },
    last_seen_at: lastSeenAt(setup.lastSeen) ?? m.last_seen_at,
    check_in_min: setup.checkInMin,
  };
  // the log says the new names; the roster and the description are the visitor's own words already
  const out = renamed({ ...d, mission, fleet }, names);
  return { now: full.now, data: { ...out, teams: d.teams, mission: { ...out.mission!, subject: mission.subject } } };
}
