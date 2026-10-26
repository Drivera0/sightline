// The demo console's scenario line, under the app bar: which search is on screen ("Overdue hiker · Mount
// Seymour · 13:35 PDT") and "Change scenario", which opens the home page's cards in a sheet.
import { useState, type ReactNode } from "react";
import { Sheet } from "../shell/Sheet";
import { cardFor } from "./scenarios";
import { ScenarioCards } from "./ScenarioCards";

export function ScenarioBanner({ seed, name, area, clock, disabled = false, brief = null, setupHref = null }: { seed: string | null; name?: string; area: string; clock: string | null; disabled?: boolean; /** The subject brief (command/SubjectStrip.tsx), in place of the scenario's name. */ brief?: ReactNode; /** Open play: back to the visitor's setup (#play). */ setupHref?: string | null }) {
  const [open, setOpen] = useState(false);
  const title = name ?? cardFor(seed).name;
  return (
    <>
      <div role="region" aria-label="Scenario" className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface px-3 py-1.5 text-small lg:px-4">
        {brief ?? (<span className="min-w-0 truncate">
          <span className="font-medium text-text">{title}</span>
          <span className="text-text-3"> · </span>
          <span className="text-text-2">{area}</span>
          {clock && (
            <>
              <span className="text-text-3"> · </span>
              <span className="text-text-2">{clock}</span>
            </>
          )}
        </span>)}
        {setupHref && (
          <a href={setupHref} title="Back to your setup: who is missing, where, base camp, teams, drones" className="sl-tap hidden text-small sm:inline text-text-2 underline underline-offset-2 hover:text-text">
            Edit setup
          </a>
        )}
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={disabled}
          title={disabled ? "Leave the story to change the scenario" : "Choose another search on the same ground and photos"}
          className="sl-tap text-small text-text-2 underline underline-offset-2 hover:text-text disabled:no-underline disabled:opacity-50"
        >
          Change scenario
        </button>
        <a href="#" className={`sl-tap hidden text-small text-text-3 hover:text-text sm:inline ${brief ? "" : "ml-auto"}`}>
          Home
        </a>
      </div>
      {open && (
        <Sheet label="Choose a search" onClose={() => setOpen(false)} width="max-w-3xl">
          <div className="flex flex-col gap-4 px-5 pb-10 pt-5">
            <p className="text-small text-text-2">Same mountain, same photos, a different search. Start the simulation walks you through it; Open the console only opens it with nothing in the way.</p>
            <ScenarioCards current={seed} onPick={() => setOpen(false)} />
          </div>
        </Sheet>
      )}
    </>
  );
}
