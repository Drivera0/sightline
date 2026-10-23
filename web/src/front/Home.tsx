// The home page (`#`): what Sightline is in one screen (two lines, four photographs of a real search, how
// it fits together), then "Choose a search": a card per scenario that opens the console on it. The console
// itself is at #m/demo.
import { AppBar } from "../shell/AppBar";
import { Button, DISCLOSURE, DISCLOSURE_TITLE } from "../shell/components";
import { scenarioHash } from "../shell/flow";
import { Architecture } from "./Architecture";
import { FOOTER, HERO } from "./copy";
import { REPORT_URL } from "./judges";
import { CREDITS_URL, PHOTO_CREDIT, PHOTOS } from "./photos";
import { ScenarioCards } from "./ScenarioCards";

export const HOME = {
  title: "Sightline",
  line1: HERO.tagline,
  line2: "Drones and ground teams feed one probability map. It shows the search manager where to look next, and nothing moves until a person approves it.",
  start: "Follow a search",
  choose: "Choose a search",
  chooseSub: "Five searches on the same mountain and the same photos. Start runs the guided simulation; Just the console opens it with nothing in the way.",
  how: "How it fits together",
} as const;

export const SAMPLE_PHOTOS_URL = "/sample/sightline-sample-photos.zip";

const link = "text-text-2 underline underline-offset-2 hover:text-text";

/** The four photographs in a row (two on a phone), each with its caption. */
export function PhotoRow({ className = "" }: { className?: string }) {
  return (
    <ul aria-label="Photographs of a real search" className={`grid grid-cols-2 gap-2 lg:grid-cols-4 ${className}`}>
      {PHOTOS.map((p) => (
        <li key={p.src} className="flex flex-col gap-1.5">
          <img src={p.src} alt={p.alt} loading="lazy" decoding="async" width={960} height={640} className="aspect-[3/2] w-full rounded-md border border-line object-cover" />
          <span className="text-caption text-text-2">{p.caption}</span>
        </li>
      ))}
    </ul>
  );
}

export function Home() {
  return (
    <div className="flex min-h-dvh flex-col">
      <AppBar action={{ label: "Just the console", href: "#m/demo/map" }} />
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-12 px-4 pb-12 pt-8 lg:px-8 lg:pt-12">
        <section aria-labelledby="home-title" className="flex flex-col gap-6">
          <div className="flex flex-col gap-3">
            <h1 id="home-title" className="text-headline font-medium tracking-[-0.01em] text-text sm:text-[32px] sm:leading-[38px]">
              {HOME.line1}
            </h1>
            <p className="max-w-[64ch] text-body text-text-2">{HOME.line2}</p>
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <Button href={scenarioHash("overdue-hiker")} variant="primary" size="lg">
                {HOME.start}
              </Button>
              <Button href="#about" variant="ghost">
                About Sightline
              </Button>
            </div>
          </div>
          <PhotoRow />
        </section>

        <section aria-labelledby="home-how" className="flex flex-col gap-4">
          <h2 id="home-how" className="text-title font-medium text-text">
            {HOME.how}
          </h2>
          <Architecture />
        </section>

        <section aria-labelledby="home-choose" className="flex flex-col gap-4" id="choose">
          <div className="flex flex-col gap-1">
            <h2 id="home-choose" className="text-title font-medium text-text">
              {HOME.choose}
            </h2>
            <p className="text-small text-text-2">{HOME.chooseSub}</p>
          </div>
          <ScenarioCards />
        </section>

        <HomeFooter />
      </main>
    </div>
  );
}

/** The repo, the report, the sample photos, the credits and the one disclosure. */
export function HomeFooter() {
  return (
    <footer className="flex flex-col gap-3 border-t border-line pt-5 text-small text-text-3">
      <p className="flex flex-wrap gap-x-5 gap-y-1">
        <a className={link} href={FOOTER.codeUrl} target="_blank" rel="noreferrer">
          {FOOTER.code}
        </a>
        <a className={link} href={REPORT_URL} target="_blank" rel="noreferrer">
          The report
        </a>
        <a className={link} href={SAMPLE_PHOTOS_URL} download>
          Sample drone photos (.zip)
        </a>
        <a className={link} href={CREDITS_URL} target="_blank" rel="noreferrer">
          Photo credits
        </a>
      </p>
      <p>{FOOTER.data}</p>
      <p>{PHOTO_CREDIT}</p>
      <p>
        <span className="text-text-2">{DISCLOSURE}.</span> {DISCLOSURE_TITLE}
      </p>
    </footer>
  );
}
