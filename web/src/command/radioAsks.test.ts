// "Ask for a bearing" gets a bearing back, and the clue waits for the manager; "Ask for a confirmation
// first" gets the team's confirmation before the find is recorded (the cold test, 2026-10-26: both got
// "Copy, over.", the clue was logged confirmed and the find recorded in the same breath). Built by lane A.
import { afterEach, describe, expect, it } from "vitest";
import type { Clue, Mission, RadioTurn, Team } from "../contract";
import { EMPTY, useMission } from "../lib/mission";
import { bearingFrom, bearingReply, confirmReply } from "./console";
import { injects } from "./guide";
import { askBearing, confirmThenFind } from "./radioAsks";

const AT = "2026-10-24T21:40:00Z";
const team = (id: string, callsign: string, position: { lat: number; lon: number } | null): Team => ({ id, callsign, members: 3, status: "searching", position, position_at: null, note: null, last_heard_at: null });
const T1 = { lat: 49.37, lon: -122.944 };
// 212 m south and 212 m west of Team One: south-west, 300 m
const SW = { lat: T1.lat - 212 / 111_320, lon: T1.lon - 212 / (111_320 * Math.cos((T1.lat * Math.PI) / 180)) };
const clue = { id: "c004", kind: "sound", text: "possible whistle, three blasts, to the south-west", lat: SW.lat, lon: SW.lon, reliability: "low", reported_by: "T1", source: "radio", confirmed: false, at: AT } as unknown as Clue;
const mission = { mission_id: "demo", name: "Seymour", subject: "Adult, red jacket, day hiker", status: "searching", base_camp: { lat: 49.373, lon: -122.949, name: "Trailhead lot" } } as unknown as Mission;

function demo(teams: Team[]) {
  useMission.getState().useDemo({ ...EMPTY, mission, teams, clues: [clue], events: [] }, AT);
}
const turns = () => useMission.getState().events.filter((e) => e.type === "radio.turn").map((e) => e.data as unknown as RadioTurn);

afterEach(() => useMission.setState({ ...EMPTY }));

describe("a bearing, worked out from the scenario's positions", () => {
  it("says the compass point, the bearing and the distance, rounded as said on the radio", () => {
    expect(bearingFrom(T1, SW)).toMatchObject({ deg: 225, word: "south-west" });
    expect(bearingReply("Team One", T1, SW)).toBe("Sightline, Team One. From our position: south-west, bearing 225, about 300 metres, over.");
    expect(bearingReply("Team One", { lat: 49.37, lon: -122.944 }, { lat: 49.3709, lon: -122.944 }, "base")).toBe("Sightline, Team One. From base camp: north, bearing 000, about 100 metres, over.");
  });
});

describe("Ask for a bearing", () => {
  it("the team answers with its bearing to the clue, and the clue stays unconfirmed until the manager confirms it", () => {
    demo([team("T1", "Team One", T1)]);
    askBearing(useMission.getState(), clue, "Search manager");
    const [out, back] = turns();
    expect(out).toMatchObject({ direction: "out", transcript: "say again your bearing to it, over." });
    expect(back).toMatchObject({ direction: "in", transcript: "Sightline, Team One. From our position: south-west, bearing 225, about 300 metres, over." });
    expect(back!.transcript).not.toMatch(/Copy, over/);
    const decided = useMission.getState().events.filter((e) => e.type === "clue.added" && e.ref === clue.id).at(-1)!;
    expect(decided.data).toMatchObject({ confirmed: false, decided_by: "Search manager" });
    expect((decided.data as { logged?: boolean }).logged).toBeUndefined();
  });

  it("from where the team heard it, when the clue says (the demo's whistle: 226°, 400 m from its origin)", () => {
    // the scenario's own clue c004: heard at its origin, its place 400 m along the bearing; the team stands at that place now
    const whistle = { ...clue, lat: 49.3694, lon: -122.9462, origin: { lat: 49.3719, lon: -122.9422 } } as Clue;
    demo([team("T1", "Team One", { lat: 49.3694, lon: -122.9462 })]);
    askBearing(useMission.getState(), whistle, "Search manager");
    expect(turns()[1]!.transcript).toBe("Sightline, Team One. From where we heard it: south-west, bearing 226, about 400 metres, over.");
  });

  it("the guided step says so: the bearing comes back and the clue waits for you", () => {
    const opt = injects({ full: { now: AT, data: { ...EMPTY, mission, teams: [team("T1", "Team One", T1)], clues: [clue] } }, seed: "s", user: [], choices: [], queue: [] })
      .find((i) => i.id === "clue")
      ?.options.find((o) => o.id === "bearing");
    expect(opt?.effect).toMatch(/bearing and distance/);
    expect(opt?.effect).toMatch(/waits for you to confirm/);
  });
});

describe("Ask for a confirmation first", () => {
  it("the team confirms the subject's description before the find is recorded, a minute on", () => {
    demo([team("T4", "Team Four", T1)]);
    const later = "2026-10-24T21:41:01Z";
    confirmThenFind(useMission.getState(), "T4", "C2", "Search manager", later);
    const evs = useMission.getState().events;
    const reply = evs.findIndex((e) => e.type === "radio.turn" && (e.data as unknown as RadioTurn).direction === "in");
    const found = evs.findIndex((e) => e.type === "mission.note" && (e.data as { action?: string } | null)?.action === "found");
    expect(reply).toBeGreaterThanOrEqual(0);
    expect(found).toBeGreaterThan(reply);
    expect((evs[reply]!.data as unknown as RadioTurn).transcript).toBe(confirmReply("Team Four", mission.subject, "C2"));
    expect((evs[reply]!.data as unknown as RadioTurn).transcript).toBe("Sightline, Team Four. Confirmed: adult, red jacket, day hiker, matches the description; the subject is with us in C2, over.");
    expect(evs[reply]!.at).toBe(later);
    expect(evs[found]!.at).toBe(later);
  });
});
