// The notification mapping (V3 §2): which mission events become toasts, with what words and where "Show
// me" goes; the manager's own actions and position reports make none; bursts (the story seeking) reseed
// silently; toasts with one key merge; the clue ring fades instead of flashing.
import { beforeEach, describe, expect, it } from "vitest";
import type { MissionEvent } from "../contract";
import { useNotify, TOAST_MAX, unreadCount } from "../shell/notify";
import { ringAlpha } from "../map/heat/clueFlash";
import { BURST, freshEvents, reviewToast, toastFor } from "./notifications";

const AT = "2026-10-24T21:40:00Z";
const teams = [{ id: "T1", callsign: "Team One" }, { id: "T2", callsign: "Team Two" }];
const ev = (id: string, type: MissionEvent["type"], summary: string, ref: string | null, data: unknown): MissionEvent => ({ id, type, at: AT, summary, ref, data: data as MissionEvent["data"] });

describe("toastFor", () => {
  it("a proposal: violet, its summary, Show me focuses it", () => {
    const t = toastFor(ev("e1", "proposal.new", "p003 new", "p003", { id: "p003", summary: "Assign C2 to Team One", kind: "assign_sector" }), teams);
    expect(t).toMatchObject({ tone: "proposal", title: "AI suggests", body: "Assign C2 to Team One", target: { kind: "proposal", id: "p003" } });
  });

  it("a clue from a team, but not its read-back", () => {
    const clue = { id: "c002", kind: "object", text: "blue backpack by the creek", reported_by: "T2", confirmed: false };
    expect(toastFor(ev("e2", "clue.added", "object: blue backpack", "c002", clue), teams)).toMatchObject({
      tone: "clue", title: "New clue from Team Two", body: "Object: blue backpack by the creek", target: { kind: "clue", id: "c002" },
    });
    expect(toastFor(ev("e3", "clue.added", "c002 confirmed", "c002", { ...clue, confirmed: true }), teams)).toBeNull();
  });

  it("a team's call in, not the desk's call out or a plain copy", () => {
    const turn = (direction: string, transcript: string) => ({ id: "r1", direction, callsign: "Team One", transcript });
    expect(toastFor(ev("e4", "radio.turn", "", "r1", turn("in", "Sightline, Team One. Found a glove at the junction, over.")), teams)).toMatchObject({
      tone: "team", title: "Team One on the radio", target: { kind: "radio", id: "r1" }, key: "radio:T1",
    });
    expect(toastFor(ev("e5", "radio.turn", "", "r2", turn("out", "Team One, Sightline.")), teams)).toBeNull();
    expect(toastFor(ev("e6", "radio.turn", "", "r3", turn("in", "Sightline, Team One. Copy, over.")), teams)).toBeNull();
  });

  it("the find, an overdue team, a second look, a drone home", () => {
    expect(toastFor(ev("e7", "mission.note", "Found: Team One has the subject in C2", "C2", { action: "found", mission: { found: { team: "T1", sector: "C2" } } }), teams)).toMatchObject({
      tone: "found", title: "Subject located", body: "Team One in C2",
    });
    expect(toastFor(ev("e8", "team.updated", "", "T2", { id: "T2", callsign: "Team Two", status: "overdue" }), teams)).toMatchObject({ tone: "alert", target: { kind: "team", id: "T2" } });
    expect(toastFor(ev("e9", "verdict", "", "f0273-d02", { detection_id: "f0273-d02", person: "yes" }), teams)).toMatchObject({ body: "A near-miss photo: likely a person", target: { kind: "candidate", id: "f0273-d02" } });
    expect(toastFor(ev("e10", "fleet.updated", "D1 back at base camp (L004 done)", "L004", {}), teams)).toMatchObject({ tone: "drone" });
  });

  it("no toast for the manager's own actions or for position reports", () => {
    expect(toastFor(ev("e11", "mission.note", "Search manager assigned B3 to Team Two", "B3", { action: "assign" }), teams)).toBeNull();
    expect(toastFor(ev("e12", "proposal.decided", "p003 approved", "p003", { id: "p003", status: "approved" }), teams)).toBeNull();
    expect(toastFor(ev("e13", "fleet.updated", "D1 on L004", "L004", {}), teams)).toBeNull();
    expect(toastFor(ev("e14", "photo.processed", "f0001 processed", "f0001", {}), teams)).toBeNull();
  });

  it("every toast is free of the words the product never uses for an area", () => {
    const words = JSON.stringify([reviewToast(3), toastFor(ev("e7", "mission.note", "", "C2", { action: "found", mission: { found: { team: "T1", sector: "C2" } } }), teams)]);
    expect(words).not.toMatch(/clear|rule out/i);
  });
});

describe("freshEvents", () => {
  const list = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ev(`e${from + i}`, "mission.note", "", null, {}));
  it("seeds on the first look, then gives what is new", () => {
    expect(freshEvents(null, list(3))).toBeNull();
    const seen = new Set(list(3).map((e) => e.id));
    expect(freshEvents(seen, list(5))?.map((e) => e.id)).toEqual(["e3", "e4"]);
  });
  it("a burst (the story seeking) or the clock going back is a jump: no toasts", () => {
    expect(freshEvents(new Set(["e0"]), list(BURST + 5))).toBeNull();
    expect(freshEvents(new Set(list(5).map((e) => e.id)), list(2))).toBeNull();
  });
});

describe("the notification store", () => {
  beforeEach(() => useNotify.getState().reset());
  it("merges toasts with one key, counts them, and keeps a log with an unread count", () => {
    const { push } = useNotify.getState();
    push(reviewToast(2));
    push(reviewToast(5));
    const s = useNotify.getState();
    expect(s.toasts).toHaveLength(1);
    expect(s.toasts[0]).toMatchObject({ title: "5 photos to review", count: 2 });
    expect(unreadCount(s.log)).toBe(1);
    s.markRead();
    expect(unreadCount(useNotify.getState().log)).toBe(0);
  });
  it("shows at most TOAST_MAX at once; the log keeps the rest", () => {
    for (let i = 0; i < TOAST_MAX + 2; i++) useNotify.getState().push({ key: `k${i}`, tone: "note", title: `n${i}` });
    expect(useNotify.getState().toasts).toHaveLength(TOAST_MAX);
    expect(useNotify.getState().log).toHaveLength(TOAST_MAX + 2);
  });
});

describe("the clue ring", () => {
  it("rises, then fades to nothing over its two seconds without pulsing", () => {
    const a = Array.from({ length: 21 }, (_, i) => ringAlpha(i / 20));
    expect(a[0]).toBe(0);
    expect(Math.max(...a)).toBeCloseTo(1);
    expect(a.at(-1)).toBe(0);
    const peak = a.indexOf(Math.max(...a));
    for (let i = peak + 1; i < a.length; i++) expect(a[i]!).toBeLessThanOrEqual(a[i - 1]!);
  });
});
