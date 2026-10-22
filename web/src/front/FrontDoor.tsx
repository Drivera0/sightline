// The front door (LANE_E §6, E-01): what Sightline is for, how photos get in, and when it runs,
// before anyone clicks anything. Works offline (inline SVG, self-hosted fonts). Built by lane A for
// lane E (issue #70).

import type { ReactNode } from "react";
import { Label, Panel } from "../shell/components";
import { FOOTER, HERO, HOW_IT_WORKS, PRINCIPLES, ROADMAP, ROADMAP_LABEL, WHO_ITS_FOR } from "./copy";

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;

/** One line illustration per step: the grid, the photos arriving, the flag, the map. */
const PICTURES: ReactNode[] = [
  // a drone over a lawnmower grid
  <g key="grid" {...stroke}>
    <path d="M10 62 H110 M10 62 V48 H110 V34 H10 V20 H110" opacity={0.5} strokeDasharray="4 4" />
    <circle cx="74" cy="20" r="5" />
    <path d="M62 14 h24 M62 26 h24" />
    <path d="M74 25 v12" opacity={0.6} />
  </g>,
  // photos from an SD card to a laptop
  <g key="photos" {...stroke}>
    <rect x="12" y="22" width="22" height="30" rx="2" />
    <path d="M18 22 v-6 h10 v6" />
    <path d="M40 37 h18 m-6 -6 l6 6 l-6 6" />
    <rect x="64" y="18" width="46" height="30" rx="3" />
    <path d="M58 54 h58" />
    <rect x="70" y="24" width="12" height="9" opacity={0.6} />
    <rect x="86" y="24" width="12" height="9" opacity={0.6} />
    <rect x="70" y="36" width="12" height="9" opacity={0.6} />
  </g>,
  // a ranked photo with a flagged person, and a tick
  <g key="flag" {...stroke}>
    <rect x="12" y="14" width="56" height="42" rx="3" />
    <rect x="34" y="28" width="12" height="14" strokeDasharray="3 2" />
    <path d="M74 20 h10 M74 32 h10 M74 44 h10" opacity={0.5} />
    <circle cx="100" cy="35" r="11" />
    <path d="M95 35 l4 4 l7 -8" />
  </g>,
  // a heat map with arrows to a drone and a team
  <g key="map" {...stroke}>
    <rect x="12" y="12" width="60" height="48" rx="3" />
    <circle cx="42" cy="36" r="14" opacity={0.35} />
    <circle cx="42" cy="36" r="7" opacity={0.7} />
    <path d="M58 26 L86 18 M58 46 L86 52" />
    <circle cx="96" cy="18" r="5" />
    <circle cx="96" cy="52" r="5" />
    <path d="M96 57 v6" />
  </g>,
];

export function FrontDoor({ onStartNew, onWatchDemo }: { onStartNew: () => void; onWatchDemo: () => void }) {
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-14 px-4 py-10 lg:px-8 lg:py-16">
      <section aria-label="Sightline" className="flex flex-col gap-4">
        <h1 className="font-mono text-display text-text">{HERO.title}</h1>
        <p className="text-title text-accent-soft">{HERO.tagline}</p>
        <p className="max-w-3xl text-body text-text-2">{HERO.body}</p>
        <div className="flex flex-wrap gap-3 pt-2">
          <button type="button" onClick={onStartNew} className="rounded-full border border-accent bg-accent/15 px-6 py-3 text-body text-text">
            {HERO.start}
          </button>
          <button type="button" onClick={onWatchDemo} className="rounded-full border border-border px-6 py-3 text-body text-text">
            {HERO.demo}
          </button>
        </div>
        <p className="max-w-3xl text-small italic text-text-3">{HERO.honesty}</p>
      </section>

      <section aria-label="How it works" className="flex flex-col gap-4">
        <Label>How it works</Label>
        <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {HOW_IT_WORKS.map((step, i) => (
            <li key={step.title}>
              <Panel className="flex h-full flex-col gap-3">
                <svg viewBox="0 0 120 70" className="h-20 w-full text-accent-soft" role="img" aria-label={step.title}>
                  {PICTURES[i]}
                </svg>
                <span className="font-mono text-label text-text-3">{i + 1}</span>
                <h2 className="text-body font-medium text-text">{step.title}</h2>
                <p className="text-small text-text-2">{step.body}</p>
              </Panel>
            </li>
          ))}
        </ol>
      </section>

      <section aria-label="Who it's for" className="flex flex-col gap-4">
        <Label>Who it’s for</Label>
        <div className="grid gap-4 md:grid-cols-3">
          {WHO_ITS_FOR.map((card) => (
            <Panel key={card.title} className="flex flex-col gap-2">
              <h2 className="text-body font-medium text-text">{card.title}</h2>
              <p className="text-small text-text-2">{card.body}</p>
            </Panel>
          ))}
        </div>
      </section>

      <section aria-label="Principles" className="flex flex-col gap-3">
        <Label>Principles</Label>
        <ol className="flex flex-col divide-y divide-border">
          {PRINCIPLES.map((p, i) => (
            <li key={p.title} className="flex flex-col gap-1 py-3 sm:flex-row sm:gap-4">
              <span className="font-mono text-label text-text-3 sm:w-6">{i + 1}</span>
              <span className="text-body font-medium text-text sm:w-72">{p.title}</span>
              <span className="text-small text-text-2">{p.body}</span>
            </li>
          ))}
        </ol>
      </section>

      <section aria-label={ROADMAP_LABEL} className="flex flex-col gap-3">
        <Label>{ROADMAP_LABEL}</Label>
        <ul className="flex flex-wrap gap-2">
          {ROADMAP.map((item) => (
            <li key={item} className="rounded-full border border-border px-3 py-1 text-small text-text-2">
              {item}
            </li>
          ))}
        </ul>
      </section>

      <footer className="flex flex-col gap-2 border-t border-border pt-6 text-small text-text-3 sm:flex-row sm:justify-between">
        <span>{FOOTER.data}</span>
        <span className="flex gap-4">
          <a className="underline" href="#results">
            {FOOTER.results}
          </a>
          <a className="underline" href={FOOTER.codeUrl} rel="noreferrer" target="_blank">
            {FOOTER.code}
          </a>
        </span>
      </footer>
    </main>
  );
}
