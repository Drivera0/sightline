// Two radio questions of the guided search that the team answers with what was asked (the cold test,
// 2026-10-26: "Ask for a bearing" got "Copy, over." and the clue logged confirmed anyway; "Ask for a
// confirmation first" got "Copy, over." and the find in the same breath). The answers are worked out from
// the scenario's own data (console.ts bearingReply, confirmReply), nothing else. Built by lane A.

import type { Clue } from "../contract";
import type { useMission } from "../lib/mission";
import { bearingReply, confirmReply } from "./console";

type Store = Pick<ReturnType<typeof useMission.getState>, "call" | "emit" | "found" | "teams" | "mission">;

/**
 * "Say again your bearing": the team answers with the bearing and distance from where it heard it (the clue's
 * own origin, else the team's position, else base camp) to the clue's place; the clue stays unconfirmed,
 * waiting for the manager's read-back (its card in Needs you). `at`: when the answer comes (the bearing's minutes on).
 */
export function askBearing(m: Store, clue: Clue, by: string, at?: string): void {
  const team = m.teams.find((t) => t.id === clue.reported_by);
  const from = clue.origin ?? team?.position ?? m.mission?.base_camp ?? null;
  const place = clue.origin ? "heard" : team?.position ? "here" : "base";
  if (team) void m.call(team.id, "say again your bearing to it, over.", from ? { reply: bearingReply(team.callsign, from, clue, place), at } : undefined);
  m.emit("clue.added", `${clue.id}: bearing asked, awaiting confirmation`, clue.id, { ...clue, confirmed: false, decided_by: by });
}

/**
 * "Confirm the subject's description": the team confirms it (the mission's own description), and the find is
 * recorded after its answer, at `at` (the confirmation's minute on).
 */
export function confirmThenFind(m: Store, team: string, sector: string, by: string, at: string): void {
  const callsign = m.teams.find((t) => t.id === team)?.callsign ?? team;
  void m.call(team, "confirm the subject's description, over.", { reply: confirmReply(callsign, m.mission?.subject ?? null, sector), at });
  void m.found(team, sector, by, at);
}
