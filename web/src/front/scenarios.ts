// The guided simulation's scenarios, as the home page and the console's "Change scenario" sheet show
// them. Each card's words come from its fixture (command/__fixtures__/scenarios/<seed>.json, and the demo
// mission for the overdue hiker); scenarios.test.ts checks they still match. Kept here, small, so the home
// page never loads a fixture. Every scenario runs on the demo's afternoon: the call at 13:30, the find
// before 15:00 (scenarios.ts moves each fixture onto the demo mission's clock).

export interface ScenarioCard {
  /** The `?s=` seed; "shuffle" is a placeholder: the card makes a new seed on Start. */
  seed: string;
  name: string;
  /** Who is missing, as the mission says it. */
  subject: string;
  /** Where: the ground and base camp. */
  setting: string;
  /** The clues the field will report, in order. */
  clues: readonly string[];
  /** How long: the mission's span and the guided simulation's. */
  length: string;
}

const LENGTH = "90 min of search · about 3 min guided";

/** The search to start with: the demo mission itself, the one the guide was written on. */
export const RECOMMENDED = "overdue-hiker";

export const SCENARIO_CARDS: readonly ScenarioCard[] = [
  {
    seed: "overdue-hiker",
    name: "Overdue hiker",
    subject: "Adult, red jacket, day hiker",
    setting: "Mount Seymour · base at the trailhead lot",
    clues: [
      "hiker at the lot saw a red jacket near the lake around 11:30",
      "fresh boot prints heading east off the main trail",
      "blue water bottle by the creek crossing",
      "possible whistle, three blasts, to the south-west",
    ],
    length: LENGTH,
  },
  {
    seed: "missing-child",
    name: "Missing child",
    subject: "Child, 8, missing from a family picnic, yellow raincoat",
    setting: "Mount Seymour · base at the trailhead lot",
    clues: ["a small yellow hood caught on a bush", "small shoe prints in the mud", "a juice box, half full"],
    length: LENGTH,
  },
  {
    seed: "despondent",
    name: "Despondent",
    subject: "Despondent adult, left a note, grey jacket",
    setting: "Mount Seymour · base at the trailhead lot",
    clues: ["a grey scarf on a rock", "a phone case, the subject's colour", "a cyclist saw someone sitting alone near the viewpoint"],
    length: LENGTH,
  },
  {
    seed: "dementia",
    name: "Dementia walk-away",
    subject: "Older adult with dementia, walked away, slippers",
    setting: "Mount Seymour · base at the trailhead lot",
    clues: ["a slipper on the path", "a neighbour saw someone in a dressing gown walking slowly", "shuffling prints on the gravel", "a cardigan on a fence"],
    length: LENGTH,
  },
  {
    seed: "shuffle",
    name: "Shuffle",
    subject: "A new search each time: one of the profiles above, its last known point and base camp moved",
    setting: "Mount Seymour · the same photos, a different afternoon",
    clues: ["four clues from that profile (a report, an object, a track, a sound), placed by the seed"],
    length: LENGTH,
  },
];

/** A new seed for Shuffle (the same form as the console's own: `s` and a base-36 number). */
export function newShuffleSeed(): string {
  return `s${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** The card a seed belongs to: its preset, else Shuffle. */
export function cardFor(seed: string | null | undefined): ScenarioCard {
  return SCENARIO_CARDS.find((c) => c.seed === (seed || RECOMMENDED)) ?? SCENARIO_CARDS[SCENARIO_CARDS.length - 1]!;
}
