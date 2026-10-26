// About Sightline: the home page's last section (`#about` lands here; it was a sheet over the console).
// Only what the rest of the home page does not say: who built it and for which competitions, what the
// colours in the console mean, what it will not do and where it struggles, and where to ask. The models
// are in "Built with" (BuiltWith.tsx), how photos get in under "How it works", the disclosure, the
// credits and the licences in the footer.

import type { ReactNode } from "react";
import { ABOUT_ID } from "../shell/flow";
import { PRINCIPLES } from "./copy";
import { JUDGES, REPO_URL, REPORT_URL } from "./judges";

const BLOB = `${REPO_URL}/blob/main`;

/** One swatch per kind of thing: the same colour on the map, the cards, the timeline and the chips. */
export const COLOURS: readonly { token: string; label: string }[] = [
  { token: "--team", label: "Ground teams" },
  { token: "--drone", label: "Drones" },
  { token: "--clue", label: "Clues" },
  { token: "--proposal", label: "The agent's proposals" },
  { token: "--found", label: "The find" },
  { token: "--alert", label: "Alerts, overdue" },
  { token: "--searched", label: "Searched ground" },
];

/** The two competition entries, each with its Devpost text in the repo. */
export const ENTRIES: readonly { name: string; href: string }[] = [
  { name: "OpenCV AI Competition 2026", href: `${BLOB}/docs/submission/DEVPOST_OPENCV.md` },
  { name: "Nebius × NVIDIA Global AI Hackathon, Physical AI track", href: `${BLOB}/docs/submission/DEVPOST_NEBIUS.md` },
];

/** The BCS Hackathon 2026 team that built the first version (README "Credits"), with their GitHub handles. */
export const BCS_TEAM: readonly { name: string; handle: string; href: string }[] = [
  { name: "Grace Chu", handle: "bamobam", href: "https://github.com/bamobam" },
  { name: "Harvir Nijjar", handle: "har-vir", href: "https://github.com/har-vir" },
  { name: "Jason Kim", handle: "jkiim", href: "https://github.com/jkiim" },
];

export const ABOUT = {
  title: "About",
  who: "Who built it",
  colours: "What the colours mean",
  limits: "What it will not do, and where it struggles",
  ask: "Questions",
} as const;

const LIMITS = PRINCIPLES.find((p) => p.title.startsWith("Honest"))!.body;
/** The first principle in words the home page can carry (its own copy names the word it never uses). */
export const NEVER = "Sightline assists and never decides: a searched sector says how well it was searched (“searched at POD 60%”), and every move needs a person’s approval.";
const link = "text-text-2 underline underline-offset-2 hover:text-text";

function Block({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h3 id={id} className="text-title font-medium text-text">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** The home page's About section: its heading is the one #about scrolls to and focuses. */
export function AboutSection() {
  return (
    <section aria-labelledby={ABOUT_ID} className="flex scroll-mt-4 flex-col gap-6">
      <div className="flex max-w-[70ch] flex-col gap-2">
        <h2 id={ABOUT_ID} tabIndex={-1} className="text-headline font-medium tracking-[-0.01em] text-text outline-none">
          {ABOUT.title}
        </h2>
        <p className="text-body text-text-2">{JUDGES.logline}</p>
      </div>
      <div className="grid gap-x-10 gap-y-8 md:grid-cols-2">
        <Block id="about-who" title={ABOUT.who}>
          <p className="text-body text-text-2">
            Daniel Rivera,{" "}
            {BCS_TEAM.map((m, i) => (
              <span key={m.handle}>
                {m.name} (
                <a className={link} href={m.href} target="_blank" rel="noreferrer">
                  @{m.handle}
                </a>
                )
                {i < BCS_TEAM.length - 2 ? ", " : i === BCS_TEAM.length - 2 ? " and " : ""}
              </span>
            ))}
            . We built the first version together at BCS Hackathon 2026 (Oct 16–17), and it was extended from Oct 20 to 25 (
            <a className={link} href={JUDGES.changedUrl} target="_blank" rel="noreferrer">
              what changed since
            </a>
            ). Entered in:
          </p>
          <ul className="flex flex-col gap-1 text-small">
            {ENTRIES.map((e) => (
              <li key={e.name}>
                <a className={link} href={e.href} target="_blank" rel="noreferrer">
                  {e.name}
                </a>
              </li>
            ))}
          </ul>
        </Block>

        <Block id="about-colours" title={ABOUT.colours}>
          <ul className="flex flex-wrap gap-x-5 gap-y-2 text-small text-text-2">
            {COLOURS.map((c) => (
              <li key={c.token} className="flex items-center gap-2">
                <span aria-hidden className="size-3 rounded-full border border-line" style={{ background: `var(${c.token})` }} />
                {c.label}
              </li>
            ))}
            <li className="flex items-center gap-2">
              <span aria-hidden className="h-3 w-12 rounded-full" style={{ background: "linear-gradient(to right, var(--prob-1), var(--prob-2), var(--prob-3), var(--prob-4), var(--prob-5))" }} />
              Probability, low to high
            </li>
          </ul>
          <p className="text-caption text-text-3">Orange is kept for the one thing to do next.</p>
        </Block>

        <Block id="about-limits" title={ABOUT.limits}>
          <p className="text-body text-text-2">
            {NEVER} {LIMITS}
          </p>
        </Block>

        <Block id="about-ask" title={ABOUT.ask}>
          <p className="flex flex-wrap gap-x-5 gap-y-1 text-small">
            <a className={link} href={`${REPO_URL}/issues`} target="_blank" rel="noreferrer">
              Questions and issues
            </a>
            <a className={link} href={`${REPORT_URL}#10-limitations-and-failure-cases`} target="_blank" rel="noreferrer">
              Limits and failure cases, in the report
            </a>
          </p>
        </Block>
      </div>
    </section>
  );
}
