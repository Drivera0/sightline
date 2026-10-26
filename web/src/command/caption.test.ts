// The time-lapse's caption (caption.ts): one plain line per beat, what happened and what it means for the
// search, built from the beat's own rows only (their teams, sectors and counts), in a search manager's words.
import { describe, expect, it } from "vitest";
import { beatCaption, listOf } from "./caption";
import { lapseBeats, type LapseRow } from "./story";
import { BANNED } from "./terms";

const at = (m: number) => Date.UTC(2026, 9, 24, 21, 0) + m * 60_000;
const one = (rows: LapseRow[]) => {
  const beats = lapseBeats(rows);
  expect(beats).toHaveLength(1);
  return beatCaption(beats[0]!);
};
/** Every number in a caption is one its rows carry (no invented figures). */
const numbersIn = (s: string) => s.match(/\d+(\.\d+)?/g) ?? [];

describe("the time-lapse's caption", () => {
  it("says a pass with no sign lowers the sector, and who sends the teams on, from the rows' own sectors", () => {
    const c = one([
      { at: at(0), text: "Sightline, Team Four. Bravo Three searched, no sign of the subject, over.", kind: "radio", team: "T4", sector: "B3" },
      { at: at(0), text: "Sightline, Team One. Charlie Two searched, no sign of the subject, over.", kind: "radio", team: "T1", sector: "C2" },
      { at: at(0), text: "D3 assigned to Team Four: the AI's pick, auto-approved (your standing approval: you chose Send all)", kind: "decision", team: "T4", sector: "D3" },
      { at: at(0), text: "A2 assigned to Team One: the AI's pick, auto-approved (your standing approval: you chose Send all)", kind: "decision", team: "T1", sector: "A2" },
    ]);
    expect(c).toBe("2 teams searched B3 and C2 with no sign of the subject: the map lowers those sectors and the others rise. Your Send all sends the 2 teams on to the AI's next picks: D3 and A2.");
  });

  it("names a single team's pass from the sector in its words", () => {
    expect(one([{ at: at(0), text: "Sightline, Team Two. Charlie Three searched, no sign of the subject, over.", kind: "radio", team: "T2" }])).toBe(
      "Team Two searched C3 with no sign of the subject: the map lowers that sector and the others rise.",
    );
  });

  it("folds a radio call, its read-back and its clue into one line that says what the clue does to the map", () => {
    const rows: LapseRow[] = [
      { at: at(0), text: "Team One, Sightline. Copy a possible whistle, three blasts, south-west, low reliability. Holding it for the search manager to confirm, over.", kind: "radio", team: "T1" },
      { at: at(0), text: "Sightline, Team One. Possible whistle, three blasts, to the south-west, over.", kind: "radio", team: "T1" },
      { at: at(1), text: "sound: possible whistle, three blasts, to the south-west", kind: "clue", team: "T1", sector: "B3", detail: "Team One · by radio · low reliability · awaiting read-back" },
    ];
    expect(one(rows)).toBe("Team One reports by radio: “possible whistle, three blasts, to the south-west”. On the board as a clue; it waits for your confirmation before it moves the map.");
    rows[2] = { ...rows[2]!, detail: "Team One · by radio · low reliability · confirmed by you" };
    expect(one(rows)).toMatch(/the map now leans toward where it points\.$/);
    rows[2] = { ...rows[2]!, detail: "Team One · by radio · logged without mapping by you: not confirmed, the map unchanged" };
    expect(one(rows)).toMatch(/it is logged; the map stays as it was\.$/);
  });

  it("counts the photos the AI re-checked from the rows, and says where the likely ones go", () => {
    const c = one([
      { at: at(0), text: "AI suggests: Add this photo to Review photos: the AI re-check says likely a person", kind: "decision" },
      { at: at(0), text: "AI re-check of a near-miss photo: likely a person", kind: "detection" },
      { at: at(2), text: "AI re-check of a near-miss photo: probably not a person", kind: "detection" },
      { at: at(9), text: "AI re-check of a near-miss photo: probably not a person", kind: "detection" },
    ]);
    expect(c).toBe("The AI re-checked 3 photos the detector nearly missed: 1 likely shows a person and goes to Review photos for you to answer.");
    expect(one([{ at: at(0), text: "AI re-check of a near-miss photo: unclear", kind: "detection" }])).toBe(
      "The AI re-checked a photo the detector nearly missed: unclear. Only a person's answer on a photo pins a sighting on the map.",
    );
  });

  it("says what each drone moment means, naming each drone", () => {
    expect(
      one([
        { at: at(0), text: "Drone 3: flight line approved (auto-approved: guided survey)", kind: "drone" },
        { at: at(0), text: "Drone 1: flight line approved (auto-approved: guided survey)", kind: "drone" },
        { at: at(0), text: "Drone 3 · flight line over B1 started", kind: "drone", sector: "B1" },
        { at: at(0), text: "Drone 1 · flight line over C3 started", kind: "drone", sector: "C3" },
      ]),
    ).toBe("2 drones take off on their flight lines over B1 and C3: photos land for review as they fly, and ground the camera sees lowers on the map.");
    expect(one([{ at: at(0), text: "Drone 2 link lost: it flies its approved flight line on its own and keeps its photos on board", kind: "drone" }])).toBe(
      "Drone 2 lost its radio link: it keeps flying its approved flight line, and its photos arrive only when the link comes back.",
    );
    expect(
      one([
        { at: at(0), text: "Drone 3 · flight line over B1 done", kind: "drone", sector: "B1" },
        { at: at(1), text: "Drone 3 back at base camp (a flight line done)", kind: "drone" },
      ]),
    ).toBe("Drone 3 finished its flight line over B1 and is back at base camp: a battery swap, then it can fly again.");
  });

  it("says a team's report of the subject waits for the find to be recorded", () => {
    expect(one([{ at: at(0), text: "Sightline, Team Four. Subject located in Charlie Two, conscious and talking, over.", kind: "radio", team: "T4", sector: "C2" }])).toBe(
      "Team Four reports the subject found in C2: record the find in Needs you to close the search.",
    );
  });

  it("says check-ins, teams coming back and the AI's suggestions in a manager's words", () => {
    expect(
      one([
        { at: at(0), text: "Team Two: position report (hasty search)", kind: "checkin", team: "T2" },
        { at: at(0), text: "Team One: position report (hasty search)", kind: "checkin", team: "T1" },
      ]),
    ).toBe("Team Two and Team One checked in by radio with position reports: each one's radio check-in clock starts again.");
    expect(one([{ at: at(0), text: "Team One heads back to base camp: the hasty search along the trail is done", kind: "checkin", team: "T1" }])).toBe(
      "Team One heads back to base camp, the hasty search done: free for a sector once it is back.",
    );
    expect(one([{ at: at(0), text: "AI suggests: Assign sector C2 to Team One", kind: "decision", team: "T1", sector: "C2" }])).toBe(
      "The AI suggests: Assign sector C2 to Team One. It waits in Needs you until you decide.",
    );
  });

  it("adds no number the rows do not carry, and no jargon or 'clear'", () => {
    const samples: LapseRow[][] = [
      [{ at: at(0), text: "Sightline, Team Four. Bravo Three searched, no sign of the subject, over.", kind: "radio", team: "T4", sector: "B3" }],
      [{ at: at(0), text: "AI re-check of a near-miss photo: likely a person", kind: "detection" }],
      [{ at: at(0), text: "Survey photos: the flight ends", kind: "drone" }],
      [{ at: at(0), text: "Conditions looked up for Mount Seymour", kind: "note" }],
      [{ at: at(0), text: "Team Four back at base camp", kind: "checkin", team: "T4" }],
      [{ at: at(0), text: "Something new and unforeseen", kind: "note" }],
    ];
    for (const rows of samples) {
      const c = one(rows);
      const own = rows.flatMap((r) => numbersIn(`${r.text} ${r.sector ?? ""}`));
      for (const n of numbersIn(c)) expect(own.includes(n) || n === String(rows.length), `${n} in “${c}”`).toBe(true);
      for (const re of BANNED) expect(c).not.toMatch(re);
      expect(c).not.toMatch(/\bclear(ed|s)?\b/i);
    }
    // an unknown row says itself
    expect(one(samples.at(-1)!)).toBe("Something new and unforeseen");
  });

  it("lists names the way people say them", () => {
    expect(listOf(["B3"])).toBe("B3");
    expect(listOf(["B3", "C2"])).toBe("B3 and C2");
    expect(listOf(["B3", "C2", "A1"])).toBe("B3, C2 and A1");
  });
});
