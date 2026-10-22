// About Sightline: the words that used to be the front door (copy.ts), as a sheet over the console,
// opened from the wordmark (#about). Reachable, never in the way: the console is the site.

import { Label } from "../shell/components";
import { Sheet } from "../shell/Sheet";
import { FOOTER, HERO, PRINCIPLES, ROADMAP, ROADMAP_LABEL, WHO_ITS_FOR } from "./copy";
import { Steps } from "./Steps";
import { REPORT_URL } from "./judges";
import { RadioClip } from "./RadioClip";

export function AboutSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet label="About Sightline" onClose={onClose}>
      <article className="flex flex-col gap-8 px-5 pb-10 pt-6 lg:px-8">
        <header className="flex flex-col gap-3">
          <Label>{HERO.eyebrow}</Label>
          <h1 className="text-headline font-medium tracking-[-0.01em] text-text">{HERO.tagline}</h1>
        </header>

        <section aria-labelledby="about-how" className="flex flex-col gap-3">
          <h2 id="about-how" className="text-title font-medium text-text">
            How it works
          </h2>
          <Steps />
        </section>

        <section aria-label="In short" className="flex flex-col gap-3">
          <p className="text-body text-text-2">{HERO.body}</p>
          <p className="text-small text-text-3">{HERO.honesty}</p>
          <RadioClip />
        </section>

        <section aria-labelledby="about-who" className="flex flex-col gap-3">
          <h2 id="about-who" className="text-title font-medium text-text">
            Who it's for
          </h2>
          <ul className="flex flex-col gap-3">
            {WHO_ITS_FOR.map((w) => (
              <li key={w.title} className="flex flex-col gap-0.5">
                <span className="text-body text-text">{w.title}</span>
                <span className="text-small text-text-2">{w.body}</span>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="about-principles" className="flex flex-col gap-3">
          <h2 id="about-principles" className="text-title font-medium text-text">
            Principles
          </h2>
          <ul className="flex flex-col gap-3">
            {PRINCIPLES.map((p) => (
              <li key={p.title} className="flex flex-col gap-0.5 border-l-2 border-line pl-3">
                <span className="text-body text-text">{p.title}</span>
                <span className="text-small text-text-2">{p.body}</span>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="about-next" className="flex flex-col gap-2">
          <h2 id="about-next" className="text-title font-medium text-text">
            {ROADMAP_LABEL}
          </h2>
          <ul className="list-disc pl-5 text-small text-text-2">
            {ROADMAP.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </section>

        <footer className="flex flex-col gap-3 border-t border-line pt-5 text-small text-text-3">
          <p>{FOOTER.data}</p>
          <p className="flex flex-wrap gap-x-4 gap-y-1">
            <a className="text-text-2 underline underline-offset-2 hover:text-text" href={REPORT_URL} target="_blank" rel="noreferrer">
              Report
            </a>
            <a className="text-text-2 underline underline-offset-2 hover:text-text" href={FOOTER.codeUrl} target="_blank" rel="noreferrer">
              {FOOTER.code}
            </a>
          </p>
        </footer>
      </article>
    </Sheet>
  );
}
