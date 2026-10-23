// "Choose a search": one card per scenario, each saying the setting, who is missing, the clues the field
// will report and the length. Start opens the console on it with the guided simulation on; "Just the
// console" opens it without the story. On the home page and in the console's "Change scenario" sheet.
import type { MouseEvent } from "react";
import { buttonClass } from "../shell/components";
import { Icon } from "../shell/icons";
import { scenarioHash } from "../shell/flow";
import { newShuffleSeed, SCENARIO_CARDS, type ScenarioCard } from "./scenarios";

function Card({ card, current, onPick }: { card: ScenarioCard; current: boolean; onPick?: () => void }) {
  const shuffle = card.seed === "shuffle";
  // a Shuffle's seed is made when it is opened, so each Start is a new search
  const go = (guide: boolean) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (shuffle) {
      e.preventDefault();
      window.location.hash = scenarioHash(newShuffleSeed(), guide);
    }
    onPick?.();
  };
  const titleId = `scenario-${card.seed}`;
  return (
    <li aria-labelledby={titleId} className={`flex flex-col gap-3 rounded-lg border bg-surface-solid p-4 ${current ? "border-text-3" : "border-line"}`}>
      <div className="flex flex-col gap-1">
        <h3 id={titleId} className="flex items-center gap-2 text-title font-medium text-text">
          {card.name}
          {current && <span className="text-caption font-normal text-text-3">on screen</span>}
        </h3>
        <p className="text-small text-text-2">{card.subject}</p>
      </div>
      <dl className="flex flex-col gap-2 text-small">
        <div>
          <dt className="text-caption text-text-3">Setting</dt>
          <dd className="text-text">{card.setting}</dd>
        </div>
        <div>
          <dt className="text-caption text-text-3">Clues it will throw</dt>
          <dd>
            <ul className="flex flex-col gap-1">
              {card.clues.map((c) => (
                <li key={c} className="flex items-start gap-1.5 text-text">
                  <Icon name="clue" size={14} className="mt-[3px] shrink-0 text-clue" />
                  {c}
                </li>
              ))}
            </ul>
          </dd>
        </div>
        <div>
          <dt className="text-caption text-text-3">Length</dt>
          <dd className="text-text">{card.length}</dd>
        </div>
      </dl>
      <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
        <a href={scenarioHash(card.seed)} onClick={go(true)} className={buttonClass("secondary")} aria-label={`Start: ${card.name}`}>
          Start
        </a>
        <a href={scenarioHash(card.seed, false)} onClick={go(false)} className="sl-tap inline-flex items-center text-small text-text-2 underline underline-offset-2 hover:text-text" aria-label={`Just the console: ${card.name}`}>
          Just the console
        </a>
      </div>
    </li>
  );
}

/** The five cards. `current`: the seed on screen (the console's sheet marks it); `onPick`: a card was opened. */
export function ScenarioCards({ current, onPick }: { current?: string | null; onPick?: () => void }) {
  const on = current === undefined ? null : SCENARIO_CARDS.find((c) => c.seed === (current || "overdue-hiker"))?.seed ?? "shuffle";
  return (
    <ul aria-label="Scenarios" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {SCENARIO_CARDS.map((c) => (
        <Card key={c.seed} card={c} current={on === c.seed} onPick={onPick} />
      ))}
    </ul>
  );
}
