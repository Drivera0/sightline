export interface ShortcutGroup {
  title: string;
  shortcuts: { keys: string[]; description: string }[];
}

/**
 * Shown by the `?` overlay on the console, one group per region of the console. Every key here has a handler:
 * the views, C, W, `?`, Esc (this list, Conditions) and the clock's Space in ingest/LiveMission.tsx; Tab is the
 * browser's focus order (the proposal cards take focus); A/X/E in command/ApprovalInbox.tsx (the focused card);
 * J/K and P/N/U in review/LiveReview.tsx (the rail), P/N/U in command/ReviewFrame.tsx; L in
 * map/heat/LiveHeatMap.tsx; Esc in SectorPopover, SectorPicker and CommandView (Task mode); V in
 * command/Timeline.tsx and radio/RadioDesk.tsx; the guided simulation's keys in command/CoachMark.tsx
 * (GuideMark), its options from command/guide.ts. Review keys are specified in LANE_D_PIPELINE section 9.2.
 */
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Views",
    shortcuts: [
      { keys: ["1", "2", "4", "5"], description: "Map (the console), Photos, Trace, Debrief (not during the guided simulation)" },
      { keys: ["C"], description: "Back to the map" },
      { keys: ["?"], description: "Show or hide this list" },
      { keys: ["Esc"], description: "Close this list or the Conditions panel" },
    ],
  },
  {
    title: "Needs you",
    shortcuts: [
      { keys: ["3"], description: "Open Needs you: proposals, candidates to review, overdue teams" },
      { keys: ["Tab"], description: "Move to the next card" },
      { keys: ["A"], description: "Approve the focused proposal" },
      { keys: ["X"], description: "Reject the focused proposal (asks for a one-line reason)" },
      { keys: ["E"], description: "Edit the focused proposal before approving (team, briefing)" },
      { keys: ["J", "↓"], description: "Next candidate" },
      { keys: ["K", "↑"], description: "Previous candidate" },
      { keys: ["P"], description: "Person" },
      { keys: ["N"], description: "Not a person" },
      { keys: ["U"], description: "Unsure" },
    ],
  },
  {
    title: "Map",
    shortcuts: [
      { keys: ["W"], description: "Open or close the Conditions panel: sources, quotes, the flyability gate" },
      { keys: ["L"], description: "Open or close the map legend" },
      { keys: ["Esc"], description: "Close the sector popover or the sector list, cancel Task mode" },
    ],
  },
  {
    title: "Timeline and radio",
    shortcuts: [
      { keys: ["6"], description: "The radio: the timeline on Radio, the talk bar ready" },
      { keys: ["V"], description: "Hold to talk to the team picked in the talk bar" },
      { keys: ["Space"], description: "Play or pause the mission clock (outside the guided simulation)" },
    ],
  },
  {
    title: "Guided simulation",
    shortcuts: [
      { keys: ["A"], description: "Take the agent's option" },
      { keys: ["1", "2", "3", "4"], description: "Pick an option" },
      { keys: ["M"], description: "Pick a sector on the map instead" },
      { keys: ["T"], description: "Take over from Watch instead at the next decision" },
      { keys: ["Space"], description: "Pause or resume between decisions" },
      { keys: ["Esc"], description: "Leave the guided simulation" },
    ],
  },
];
