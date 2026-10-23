// "Show me" on a toast or a line of the bell's log: bring the thing it is about in front of the search
// manager. A proposal: its card in Needs you, focused (the map glows its sector). A candidate: the large
// review frame. A clue or a team: selected (the map flies there). A radio call: its timeline row,
// highlighted. The find: the map. Add clue: the form. Built by lane A.
import { useSelection } from "../lib/selection";
import { prefersReducedMotion } from "../metrics/motion";
import type { ShowTarget } from "../shell/notify";
import { useConsole } from "./consoleStore";

const phone = () => typeof window !== "undefined" && window.innerWidth < 1024;
const behavior = (): ScrollBehavior => (prefersReducedMotion() ? "auto" : "smooth");

/** Scroll a region of the console into view (phones stack them) and run `then` on the next frame. */
function region(id: string, then?: () => void) {
  requestAnimationFrame(() => {
    if (phone()) document.getElementById(id)?.scrollIntoView({ block: "start", behavior: behavior() });
    then?.();
  });
}

export function showMe(target: ShowTarget | null | undefined): void {
  if (!target) return;
  const ui = useConsole.getState();
  switch (target.kind) {
    case "proposal":
      ui.setTab("needs");
      ui.setFocus({ kind: "proposal", id: target.id });
      region("console-needs", () => {
        const el = document.querySelector<HTMLElement>(`[data-proposal="${CSS.escape(target.id)}"]`);
        el?.scrollIntoView?.({ block: "nearest", behavior: behavior() });
        el?.focus({ preventScroll: true });
      });
      return;
    case "candidate":
      ui.openReview(target.id);
      return;
    case "clue":
      useSelection.getState().selectClue(target.id);
      region("console-map");
      return;
    case "team":
      useSelection.getState().selectTeam(target.id);
      region("console-resources", () => document.querySelector<HTMLElement>(`[data-team="${CSS.escape(target.id)}"]`)?.scrollIntoView?.({ block: "nearest", behavior: behavior() }));
      return;
    case "radio":
      ui.setTab("timeline");
      if (target.id) ui.showRow(target.id);
      region("console-timeline");
      return;
    case "sector":
      ui.openSector(target.id, Number.NaN, Number.NaN);
      region("console-map");
      return;
    case "found":
      ui.setTab("map");
      region("console-map");
      return;
    case "addClue":
      ui.setTab("timeline");
      ui.openClue(target.at ?? null);
      region("console-timeline");
      return;
  }
}
