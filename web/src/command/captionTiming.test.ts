// A beat's caption is up when its first row lands, never after its rows (the cold test, 2026-10-26: a
// beat landed at its last row, so rows a few mission minutes earlier showed with no caption to say what
// they were). Built by lane A.
import { describe, expect, it } from "vitest";
import { beatCaption } from "./caption";
import { lapseBeats, lapseStep, type LapseRow } from "./story";

const at = (h: number, m: number) => Date.UTC(2026, 9, 24, h, m);
// one team's call and the clue it brings (one beat, three minutes apart), then a pass a team radios
const rows: LapseRow[] = [
  { at: at(21, 37), text: "Sightline, Team One. Possible whistle, three blasts, to the south-west, over.", kind: "radio", team: "T1" },
  { at: at(21, 39), text: "Team One, Sightline. Copy a possible whistle, three blasts, south-west, low reliability, over.", kind: "radio", team: "T1" },
  { at: at(21, 40), text: "Sound: possible whistle, three blasts, to the south-west", kind: "clue", team: "T1", detail: "Team One · by radio · low reliability · awaiting read-back" },
  { at: at(21, 58), text: "Sightline, Team Four. Bravo Three searched, no sign of the subject, over.", kind: "radio", team: "T4" },
];

describe("the time-lapse's caption and its rows", () => {
  it("each beat lands at its first row, so no row of it shows before its caption", () => {
    const beats = lapseBeats(rows);
    expect(beats.length).toBe(2);
    expect(beats[0]!.rows.length).toBe(3);
    expect(beats[0]!.at).toBe(at(21, 37));
    for (const b of beats) for (const r of b.rows) expect(r.at).toBeGreaterThanOrEqual(b.at);
  });

  it("the clock running from before the beat stops on its first row, with the caption for the rows to come", () => {
    const beats = lapseBeats(rows);
    const lapse = { from: at(21, 30), hold: at(22, 0), beats: beats.map((b) => b.at) };
    // run the clock as GuideRun does, ten readings a second at 1×, until it stops on a beat
    let clock = lapse.from;
    let r = { clock, beat: false };
    for (let i = 0; i < 100_000 && !r.beat; i++) {
      r = lapseStep(clock, lapse, 100);
      clock = r.clock;
    }
    expect(r.beat).toBe(true);
    // rows on the timeline at that moment: the beat's first one and none of its later ones
    const shown = rows.filter((x) => x.at <= clock);
    expect(shown).toEqual([rows[0]]);
    // the caption up then says what the beat's rows are
    const landed = [...beats].reverse().find((b) => b.at <= clock)!;
    expect(beatCaption(landed)).toMatch(/whistle/);
  });
});
