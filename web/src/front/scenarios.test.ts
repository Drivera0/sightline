import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRESETS } from "../command/scenarios";
import { cardFor, newShuffleSeed, SCENARIO_CARDS } from "./scenarios";

const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, "../command/__fixtures__", name), "utf8")) as { clues: { text: string }[]; mission: { subject: string; base_camp: { name: string } } };

describe("the scenario cards", () => {
  it("has the four presets and Shuffle, in the console's order", () => {
    expect(SCENARIO_CARDS.map((c) => c.name)).toEqual(["Overdue hiker", "Missing child", "Despondent", "Dementia walk-away", "Shuffle"]);
    expect(SCENARIO_CARDS.slice(0, 4).map((c) => c.seed)).toEqual(PRESETS.map((p) => p.seed));
  });

  it("says the clues and subject each scenario's fixture will throw", () => {
    const files: Record<string, string> = { "overdue-hiker": "demo_mission.json", "missing-child": "scenarios/missing-child.json", despondent: "scenarios/despondent.json", dementia: "scenarios/dementia.json" };
    for (const card of SCENARIO_CARDS.slice(0, 4)) {
      const fx = fixture(files[card.seed]!);
      expect(card.clues).toEqual(fx.clues.map((c) => c.text));
      expect(card.subject.toLowerCase().split(", ").sort()).toEqual(fx.mission.subject.toLowerCase().split(", ").sort());
      expect(card.setting.toLowerCase()).toContain(fx.mission.base_camp.name.replace(" (demo point)", "").toLowerCase());
    }
  });

  it("finds a seed's card; any other seed is a shuffle", () => {
    expect(cardFor(null).name).toBe("Overdue hiker");
    expect(cardFor("dementia").name).toBe("Dementia walk-away");
    expect(cardFor("s1x2y").name).toBe("Shuffle");
    expect(newShuffleSeed()).toMatch(/^s[0-9a-z]+$/);
  });
});
