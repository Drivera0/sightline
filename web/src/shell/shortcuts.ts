export interface ShortcutGroup {
  title: string;
  shortcuts: { keys: string[]; description: string }[];
}

/** Shown by the `?` overlay. Review keys are specified in LANE_D_PIPELINE section 9.2. */
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Review",
    shortcuts: [
      { keys: ["J", "↓"], description: "Next crop" },
      { keys: ["K", "↑"], description: "Previous crop" },
      { keys: ["P"], description: "Person" },
      { keys: ["N"], description: "Not a person" },
      { keys: ["U"], description: "Unsure" },
      { keys: ["Z"], description: "Undo" },
      { keys: ["Enter"], description: "Full frame view" },
      { keys: ["M"], description: "Show on map" },
    ],
  },
  {
    title: "Everywhere",
    shortcuts: [
      { keys: ["1", "2", "3", "4", "5"], description: "Jump to a step: Survey, Rank, Review, Search next, Results" },
      { keys: ["T"], description: "Watch the guided tour (any key or click stops it)" },
      { keys: ["?"], description: "Show or hide this list" },
      { keys: ["Esc"], description: "Close" },
    ],
  },
];
