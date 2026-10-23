// The guided simulation's searches: one card per scenario, each saying who is missing, the setting, the
// clues the field will report and the length. "Start the simulation" opens the console on it with the
// guided simulation on; "Open the console only" opens it without the story. The first card is marked as
// the one to start with. On the home page and in the console's "Change scenario" sheet.
import type { MouseEvent } from "react";
import { buttonClass } from "../shell/components";
import { Icon } from "../shell/icons";
import { scenarioHash } from "../shell/flow";
import { newShuffleSeed, RECOMMENDED, SCENARIO_CARDS, type ScenarioCard } from "./scenarios";

/** The clues shown before a hover opens the rest (every clue shows on touch screens). */
const FIRST_CLUES = 2;

function Clue({ text }: { text: string }) {
  return (
    <li className="flex items-start gap-1.5 text-text">
      <Icon name="clue" size={14} className="mt-[3px] shrink-0 text-clue" />
      {text}
    </li>
  );
}

function Card({ card, current, onPick }: { card: ScenarioCard; current: boolean; onPick?: () => void }) {
  const shuffle = card.seed === "shuffle";
  const first = card.seed === RECOMMENDED;
  // a Shuffle's seed is made when it is opened, so each Start is a new search
  const go = (guide: boolean) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (shuffle) {
      e.preventDefault();
      window.location.hash = scenarioHash(newShuffleSeed(), guide);
    }
    onPick?.();
  };
  const titleId = `scenario-${card.seed}`;
  const shown = card.clues.slice(0, FIRST_CLUES);
  const more = card.clues.slice(FIRST_CLUES);
  return (
    <li aria-labelledby={titleId} className={`sl-card flex flex-col gap-3 rounded-lg border bg-surface-solid p-4 ${current ? "border-text-3" : "border-line"}`}>
      <div className="flex flex-col gap-1">
        <h3 id={titleId} className="flex flex-wrap items-center gap-2 text-title font-medium text-text">
          {card.name}
          {first && (
            <span data-tone="action" className="sl-pill font-normal">
              Start here
            </span>
          )}
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
              {shown.map((c) => (
                <Clue key={c} text={c} />
              ))}
            </ul>
            {more.length > 0 && (
              <>
                <div className="sl-more">
                  {/* the clipped box has no padding of its own, so it closes to nothing */}
                  <div>
                    <ul className="flex flex-col gap-1 pt-1">
                      {more.map((c) => (
                        <Clue key={c} text={c} />
                      ))}
                    </ul>
                  </div>
                </div>
                <span aria-hidden className="sl-more-hint pt-1 text-caption text-text-3">
                  and {more.length} more
                </span>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-caption text-text-3">Length</dt>
          <dd className="text-text">{card.length}</dd>
        </div>
      </dl>
      <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
        <a href={scenarioHash(card.seed)} onClick={go(true)} className={buttonClass("secondary", "md", "bg-surface-strong")} aria-label={`Start the simulation: ${card.name}`}>
          Start the simulation
        </a>
        <a
          href={scenarioHash(card.seed, false)}
          onClick={go(false)}
          className="sl-tap inline-flex items-center text-small text-text-2 underline underline-offset-2 hover:text-text"
          aria-label={`Open the console only: ${card.name}`}
        >
          Open the console only
        </a>
      </div>
    </li>
  );
}

/** The five cards. `current`: the seed on screen (the console's sheet marks it); `onPick`: a card was opened. */
export function ScenarioCards({ current, onPick }: { current?: string | null; onPick?: () => void }) {
  const on = current === undefined ? null : SCENARIO_CARDS.find((c) => c.seed === (current || RECOMMENDED))?.seed ?? "shuffle";
  return (
    <ul aria-label="Scenarios" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {SCENARIO_CARDS.map((c) => (
        <Card key={c.seed} card={c} current={on === c.seed} onPick={onPick} />
      ))}
    </ul>
  );
}
