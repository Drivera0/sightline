import { describe, expect, it } from "vitest";
import type { MapUpdate } from "../contract";
import type { MissionData } from "../lib/mission";
import demo from "./__fixtures__/demo_mission.json";
import child from "./__fixtures__/scenarios/missing-child.json";
import despondent from "./__fixtures__/scenarios/despondent.json";
import dementia from "./__fixtures__/scenarios/dementia.json";
import hiker from "./__fixtures__/scenarios/overdue-hiker.json";
import { CHECKPOINTS, clockAt, demoAt, LAST, type Checkpoint, type DemoFull } from "./missionTime";
import { shiftTimes } from "./scenarios";
import { beatCounts, markIndex, STORY_BANNED, storyBeats, storyClue, storyProposal, type Beat } from "./storyCopy";

type Fixture = Partial<MissionData> & { now: string; map_updates: MapUpdate[]; t0?: string };

// ten survey photos on the flight (the cache's map is not in the repository)
const frames: MapUpdate[] = Array.from({ length: 10 }, (_, k) => ({ seq: k + 1, kind: "step", source: "frame", ref: `f${String(k + 1).padStart(4, "0")}`, cells: [], canopy: null, at: "2026-10-24T20:30:00Z" }));

/** A fixture as the console loads it: on the demo mission's afternoon (scenarios.ts), its map log in. */
function load(raw: unknown): DemoFull {
  const fx0 = raw as Fixture;
  const from = fx0.t0 ?? fx0.mission?.created_at;
  const to = (demo as unknown as Fixture).mission!.created_at;
  const fx = from && to ? shiftTimes(fx0, new Date(to).getTime() - new Date(from).getTime()) : fx0;
  return { now: fx.now, data: { ...fx, mapUpdates: [...frames, ...fx.map_updates], verdicts: [] } };
}

const overdue = load(demo);
const missingChild = load(child);
const texts = (beats: Beat[][]) => beats.flat().map((b) => b.text);
/** Sentences outside quotes (a radio call quoted whole counts as none). */
const sentences = (s: string) => s.replace(/"[^"]*"/g, "").split(/[.!?](?:\s|$)/).filter((x) => x.trim()).length;

describe("the story on the overdue hiker", () => {
  const beats = storyBeats(overdue);
  const at = (t: Checkpoint, k = 0) => beats[t]![k]!;

  it("tells seven moments, every one with a mark, and numbers the marks across the story", () => {
    expect(beatCounts(beats)).toEqual([1, 2, 3, 2, 2, 1, 1]);
    expect(markIndex(beats, 0, 0)).toBe(1);
    expect(markIndex(beats, 2, 2)).toBe(6);
    expect(markIndex(beats, LAST, 0)).toBe(12);
  });

  it("t0, the call: the clock, the last sighting, the teams at base and the first drone up, on the status line", () => {
    expect(at(0)).toEqual({ text: "13:35. Last seen at 10:30. Four teams at base, the trailhead lot. Drone one up.", target: '[aria-label="Mission status"]' });
  });

  it("t1 and t2 point at the map, then Needs you: the photos landing, the people, the bag, the second look", () => {
    expect(at(1).text).toBe("Drone one flies the survey from base and 10 photos land as it goes. The map dims where it has looked and brightens where it has not.");
    expect(at(1).target[0]).toContain("#console-map");
    expect(at(1, 1).target[0]).toBe('[data-tour="review"]');
    expect(at(2).text).toMatch(/^The first two are plainly people: Person, Person/);
    expect(at(2, 1).text).toMatch(/Not a person/);
    expect(at(2, 2).text).toMatch(/second look caught it.*mark Person: the pin lands/);
    expect(at(2, 2).target).toContain('[data-proposal="p001"]'); // the pending promotion, when the queue has no card for it
  });

  it("t3, where next: the clue the first assignment names, by radio, then that proposal, which waits for approval", () => {
    expect(storyProposal(overdue)?.id).toBe("p002");
    expect(storyClue(overdue)?.id).toBe("c004"); // c001 and c004 raised C2; c004 came by radio, last
    expect(at(3).text).toBe("Team One on the radio: possible whistle, three blasts, to the south-west. I confirm it as a clue and the map moves toward it.");
    expect(at(3).target[0]).toBe('group:[data-tour="timeline"] li[data-kind="clue"], [data-tour="timeline"] li[data-kind="radio"]');
    expect(at(3, 1)).toMatchObject({ text: "The agent proposes Team One for C2, and its reason names that clue. Nobody moves until I approve.", gate: "approve" });
    expect(at(3, 1).target[0]).toBe("[data-story-proposal]");
  });

  it("t4, the run: the lost link and the relay on Resources, the team walking its sector on the map", () => {
    expect(at(4)).toEqual({ text: "Drone two loses its link and flies its approved leg on its own. Drone three relays Team Two, who has no signal.", target: ['group:[data-drone="D2"], [data-drone="D3"]', '[data-tour="tasks"]'] });
    expect(at(4, 1).text).toBe("Team One walks C2, the sector the clue raised.");
  });

  it("t5, the find: the radio call word for word, and Found on the status line", () => {
    expect(at(5)).toEqual({
      text: '"Sightline, Team One. Subject located in Charlie Two, conscious and talking, over." The status line flips to Found, and the map holds on the find.',
      target: '[aria-label="Mission status"]',
    });
    expect(at(6).target[0]).toBe('[aria-label="Mission report"]');
  });

  it("the checkpoint model: nothing found at t4, found at t5, the report's mission at t6", () => {
    expect(demoAt(overdue, clockAt(4)).mission!.found).toBeNull();
    expect(demoAt(overdue, clockAt(5)).mission!.status).toBe("found");
    expect(demoAt(overdue, clockAt(LAST)).mission!.found!.sector).toBe("C2");
  });
});

describe("the story on another scenario: the missing child", () => {
  const beats = storyBeats(missingChild);

  it("keeps the rhythm: shifted onto the same afternoon, the find between t4 and t5", () => {
    const found = missingChild.data.mission!.found!;
    expect(new Date(found.at).getTime()).toBeGreaterThan(new Date(clockAt(4)).getTime());
    expect(new Date(found.at).getTime()).toBeLessThan(new Date(clockAt(5)).getTime());
    expect(demoAt(missingChild, clockAt(4)).mission!.found).toBeNull();
    expect(demoAt(missingChild, clockAt(5)).mission!).toMatchObject({ status: "found", found: { sector: "B3" } });
    const s3 = demoAt(missingChild, clockAt(3));
    expect(s3.proposals!.find((p) => p.id === storyProposal(missingChild)!.id)!.status).toBe("pending");
  });

  it("reads its own beats: no drones, so no drone line and no fleet beat; its own clue, sector and radio call", () => {
    expect(beatCounts(beats)).toEqual([1, 2, 3, 2, 1, 1, 1]);
    expect(beats[0]![0]!.text).toBe("13:35. Last seen at 11:48. Four teams at base, the creek bridge pull-out.");
    expect(storyClue(missingChild)?.text).toBe("a juice box, half full");
    expect(beats[3]![0]!.text).toBe("Team Three on the radio: a juice box, half full. I confirm it as a clue and the map moves toward it.");
    expect(beats[3]![1]!.text).toBe("The agent proposes Team One for B3, and its reason names that clue. Nobody moves until I approve.");
    expect(beats[4]![0]!.text).toBe("Team One walks B3, the sector the clue raised.");
    expect(beats[5]![0]!.text).toContain('"Sightline, Team One. Subject located in Bravo Three, conscious and talking, over."');
  });

  it("leaves out a beat the scenario does not have: no find, no find mark, and the debrief says so", () => {
    const lost: DemoFull = { ...missingChild, data: { ...missingChild.data, mission: { ...missingChild.data.mission!, found: null, status: "searching" } } };
    const b = storyBeats(lost);
    expect(b[5]).toEqual([]);
    expect(b[6]![0]!.target).toBe('[data-tour="debrief"]');
    expect(storyBeats(null).flat()).toEqual([]);
  });
});

describe("the story's words", () => {
  const all = [overdue, missingChild, load(despondent), load(dementia), load(hiker)];

  it("never says demo, recorded, scripted or simulated inside the story, on any scenario", () => {
    expect(STORY_BANNED.test("Simulation on real aerial photographs")).toBe(true);
    expect(STORY_BANNED.test("Drone two loses its link")).toBe(false);
    for (const full of all) for (const t of texts(storyBeats(full))) expect(t).not.toMatch(STORY_BANNED);
  });

  it("never says clear or rule out about an area, and each mark is one or two sentences (the call: its four)", () => {
    for (const full of all) {
      const beats = storyBeats(full);
      for (const t of texts(beats)) expect(t).not.toMatch(/\bclear(ed|ing|s)?\b|\brul(e|ed|es|ing) out\b/i);
      beats.forEach((list, t) => {
        for (const b of list) expect(sentences(b.text)).toBeLessThanOrEqual(t === 0 ? 4 : 2);
      });
    }
  });

  it("names every checkpoint on the scrubber", () => {
    expect(CHECKPOINTS.map((c) => c.label)).toEqual(["The call", "Photos land", "Confirm", "Where next", "Run", "The find", "Debrief"]);
  });
});
