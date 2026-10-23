// The home page (`#`). It sells Sightline the way professional product pages in this space do (the
// research and the eight rules it follows are in front/README.md): a claim, one measured proof and one
// action above the fold, over the real aerial photos the detector reads; four measured facts with their
// sources; how it works; who it is for; the guided simulation (the one place that explains it); the links
// judges need; the footer with the credits, the licence and the one disclosure. The console is #m/demo.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AppBar } from "../shell/AppBar";
import { Button, DISCLOSURE, DISCLOSURE_TITLE, Label } from "../shell/components";
import { Architecture } from "./Architecture";
import { Icon } from "../shell/icons";
import { FOOTER, HERO, INTAKE, WHO_ITS_FOR } from "./copy";
import "./home.css";
import { REPO_URL, REPORT_URL } from "./judges";
import { canAnimate, prefersReducedMotion, useOnScreen, useSeenOnce } from "./motion";
import { CREDITS_URL, PHOTO_CREDIT, PHOTOS } from "./photos";
import { ScenarioCards } from "./ScenarioCards";

const BLOB = `${REPO_URL}/blob/main`;
export const SAMPLE_PHOTOS_URL = "/sample/sightline-sample-photos.zip";
export const EVIDENCE_URL = `${BLOB}/docs/report/EVIDENCE_INDEX.md`;
export const LICENCE_URL = `${BLOB}/LICENSE`;

export const HOME = {
  eyebrow: HERO.eyebrow,
  title: HERO.tagline,
  proof: "Sightline finds 86 % of the people in aerial test photos it never trained on, and turns drone photos and radio reports into one map of where to look next.",
  primary: "Try the guided simulation",
  secondary: "Open the console",
  facts: "Measured, with sources",
  how: "How it works",
  intake: "How photos get in",
  who: "Who it is for",
  sim: "Guided simulation",
  simLead:
    "A three-minute simulated search on real aerial photographs. You are the search manager: the AI proposes, you decide, and the simulation shows what your decisions change. It teaches the console as you go.",
  simNote: "Five searches on the same mountain and the same photos. Each card says who is missing, the clues the field will report and how long it takes.",
  judges: "For judges",
} as const;

/** A measured fact: the number counts up once when the row scrolls into view. */
export interface Fact {
  value: number;
  decimals: number;
  unit: string;
  label: string;
  source: { label: string; href: string };
}

export const FACTS: readonly Fact[] = [
  {
    value: 5,
    decimals: 0,
    unit: " min",
    label: "to re-score the 86 % yourself: 101 held-out test photos, OpenCV only, on a CPU, beside three published results",
    source: { label: "Baseline table", href: `${BLOB}/docs/report/OPENCV_REPORT.md#310-published-results-on-heridal-side-by-side` },
  },
  {
    value: 0.3,
    decimals: 2,
    unit: " s",
    label: "per 4000 × 3000 drone photo with OpenCV 5 cv2.dnn on one GPU, boxes identical to the CPU path",
    source: { label: "Benchmark", href: `${BLOB}/docs/report/CV2_CUDA.md` },
  },
  {
    value: 12,
    decimals: 0,
    unit: " of 12",
    label: "agent test runs in which no drone or team moved before a person approved it, by name and time",
    source: { label: "Agent evaluation", href: `${BLOB}/docs/report/AGENT_EVAL.md` },
  },
  {
    value: 96,
    decimals: 0,
    unit: "",
    label: "claims in the evidence index, each with its file and line; CI fails when one goes missing",
    source: { label: "Evidence index", href: EVIDENCE_URL },
  },
];

/** The links judges need, each to something this page does not show. */
export const JUDGE_STRIP: readonly { label: string; what: string; href: string }[] = [
  { label: "Report", what: "method, evaluation, failure cases", href: REPORT_URL },
  { label: "Evidence index", what: "every claim, file and line", href: EVIDENCE_URL },
  { label: "Trace", what: "every model and tool call of a mission", href: "#m/demo/trace" },
  { label: "Where to look, in order", what: "the console's list for judges", href: "#judges" },
  { label: "Devpost: OpenCV", what: "the OpenCV AI Competition entry", href: `${BLOB}/docs/submission/DEVPOST_OPENCV.md` },
  { label: "Devpost: Nebius", what: "the Nebius × NVIDIA entry", href: `${BLOB}/docs/submission/DEVPOST_NEBIUS.md` },
  { label: "What breaks first", what: "the three limits, with sources", href: `${BLOB}/docs/submission/WHAT_BREAKS_FIRST.md` },
  { label: "Repository", what: "code, tests, how to run it", href: REPO_URL },
];

// ---- the hero's photo wall ----------------------------------------------------------------------

/** The wall's photos: the 20 HERIDAL photos of the sample pack, 360 × 270 (public/front/CREDITS.md). */
export const WALL = Array.from({ length: 20 }, (_, i) => `/front/wall/f${String(256 + i).padStart(4, "0")}.webp`);
export const WALL_STILL = "/front/wall/still.webp";
/** The one photo with people in it, and the detector's box on it (the demo's second look, f0273-d02). */
const PERSON_TILE = "/front/wall/f0273.webp";
const PERSON_BOX = { box: [502, 173, 577, 252], w: 1000, h: 750, conf: 0.17 } as const;

const COLS = 7;
const PER_COL = 8;
const TILE_W = 220;
const TILE_H = 165;
const TILE_GAP = 12;
/** Each column's speed in px/s: slow, and slightly different so nothing lines up (at most 8). */
export const WALL_PX_PER_S = [6, 5.2, 6.8, 5.6, 7, 5.4, 6.4] as const;
/** One column's loop: half its height (the tiles are there twice). */
export const WALL_LOOP_PX = PER_COL * (TILE_H + TILE_GAP);

function wallColumns(): string[][] {
  return Array.from({ length: COLS }, (_, c) => Array.from({ length: PER_COL }, (_, r) => WALL[(c * 3 + r * 7) % WALL.length]!));
}

function Tile({ src }: { src: string }) {
  const p = src === PERSON_TILE ? PERSON_BOX : null;
  return (
    <div className="relative shrink-0 overflow-hidden rounded-md bg-surface-strong" style={{ width: TILE_W, height: TILE_H }}>
      <img src={src} alt="" width={TILE_W} height={TILE_H} loading="lazy" decoding="async" className="h-full w-full object-cover" />
      {p && (
        <span
          className="absolute rounded-[4px] border-[1.5px] border-accent"
          style={{
            left: `${((p.box[0] - 10) / p.w) * 100}%`,
            top: `${((p.box[1] - 10) / p.h) * 100}%`,
            width: `${((p.box[2] - p.box[0] + 20) / p.w) * 100}%`,
            height: `${((p.box[3] - p.box[1] + 20) / p.h) * 100}%`,
          }}
        >
          <span className="absolute -top-4 left-0 font-mono text-[10px] leading-none text-accent-soft">{p.conf.toFixed(2)}</span>
        </span>
      )}
    </div>
  );
}

/** The slow wall of real aerial photos (sm and up) or one still of them (phones). Decorative. */
function PhotoWall({ paused }: { paused: boolean }) {
  const [moving] = useState(() => !prefersReducedMotion());
  const columns = wallColumns();
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <img src={WALL_STILL} alt="" className="absolute inset-0 h-full w-full object-cover sm:hidden" />
      <div
        data-testid="photo-wall"
        className="absolute hidden gap-3 sm:flex"
        style={{ top: "-38%", left: "30%", height: "180%", width: COLS * (TILE_W + TILE_GAP), transform: "rotate(-8deg)" }}
      >
        {columns.map((col, c) => (
          <div key={c} className="relative overflow-hidden" style={{ width: TILE_W }}>
            <div
              className="sl-home-wall flex flex-col"
              data-dir={c % 2 ? "down" : "up"}
              data-paused={!moving || paused ? "true" : "false"}
              style={{ gap: TILE_GAP, animationDuration: `${Math.round(WALL_LOOP_PX / WALL_PX_PER_S[c]!)}s`, animationName: moving ? undefined : "none" }}
            >
              {[...col, ...col].map((src, i) => (
                <Tile key={`${src}-${i}`} src={src} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="sl-hero-scrim absolute inset-0 hidden lg:block" />
      <div className="sl-hero-scrim-phone absolute inset-0 lg:hidden" />
    </div>
  );
}

/** Scroll to a section of this page and move focus to its heading (smoothly, unless motion is reduced). */
function goTo(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView?.({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  el.focus?.({ preventScroll: true });
}

function Hero() {
  const [ref, onScreen] = useOnScreen<HTMLElement>();
  return (
    <section ref={ref} aria-labelledby="home-title" className="relative isolate overflow-hidden border-b border-line">
      <PhotoWall paused={!onScreen} />
      <div className="relative mx-auto flex min-h-[min(640px,calc(100svh-48px))] w-full max-w-6xl flex-col justify-center gap-5 px-4 py-16 lg:px-8">
        <Label className="sl-home-in self-start">{HOME.eyebrow}</Label>
        <h1 id="home-title" className="sl-home-in max-w-[18ch] text-[36px] font-medium leading-[42px] tracking-[-0.02em] text-text sm:text-[48px] sm:leading-[54px]" style={{ animationDelay: "60ms" }}>
          {HOME.title}
        </h1>
        <p className="sl-home-in max-w-[46ch] text-lead text-text-2" style={{ animationDelay: "120ms" }}>
          {HOME.proof}
        </p>
        <div className="sl-home-in flex flex-wrap items-center gap-3 pt-2" style={{ animationDelay: "180ms" }}>
          <Button variant="primary" size="lg" onClick={() => goTo("home-sim")}>
            {HOME.primary}
          </Button>
          <Button href="#m/demo/map" size="lg" className="bg-bg">
            {HOME.secondary}
          </Button>
        </div>
      </div>
    </section>
  );
}

// ---- the sections -------------------------------------------------------------------------------

/** A section that fades up the first time it scrolls into view (280 ms, once; never under reduced motion). */
function Reveal({ id, title, children, className = "" }: { id: string; title: string; children: ReactNode; className?: string }) {
  const [ref, seen] = useSeenOnce<HTMLElement>(0.08);
  return (
    <section ref={ref} aria-labelledby={id} data-seen={seen ? "true" : "false"} className={`sl-reveal flex flex-col gap-4 ${className}`}>
      <h2 id={id} tabIndex={-1} className="text-headline font-medium tracking-[-0.01em] text-text">
        {title}
      </h2>
      {children}
    </section>
  );
}

const fmt = (v: number, d: number) => v.toFixed(d);

/** A number that counts up once, from 0, when `go` turns true (the final value at once without motion). */
function Count({ fact, go }: { fact: Fact; go: boolean }) {
  const final = fmt(fact.value, fact.decimals);
  const [shown, setShown] = useState(() => (canAnimate() ? fmt(0, fact.decimals) : final));
  const done = useRef(!canAnimate());
  useEffect(() => {
    if (!go || done.current) return;
    done.current = true;
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 900);
      setShown(fmt(fact.value * (1 - (1 - t) ** 3), fact.decimals));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [go, fact]);
  return (
    // the final width is kept from the start, so nothing moves while it counts
    <span className="inline-block text-left" style={{ minWidth: `${final.length}ch` }} aria-hidden="true">
      {shown}
    </span>
  );
}

/** One fact: its number counts up when the fact itself is on screen (on a phone they are stacked). */
function FactItem({ f }: { f: Fact }) {
  const [ref, seen] = useSeenOnce<HTMLDivElement>(0.6);
  return (
    <div ref={ref} className="flex flex-col gap-1.5">
      <dt className="sr-only">{f.label}</dt>
      <dd className="order-first font-mono text-headline text-text">
        <span className="sr-only">
          {fmt(f.value, f.decimals)}
          {f.unit}
        </span>
        <Count fact={f} go={seen} />
        <span aria-hidden="true">{f.unit}</span>
      </dd>
      <dd className="text-small text-text-2">{f.label}</dd>
      <dd className="text-caption">
        <a className="text-text-3 underline underline-offset-2 hover:text-text" href={f.source.href} target="_blank" rel="noreferrer">
          {f.source.label}
        </a>
      </dd>
    </div>
  );
}

function Facts() {
  return (
    <section aria-label={HOME.facts} className="border-b border-line">
      <dl className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-x-8 gap-y-6 px-4 py-8 sm:grid-cols-2 lg:grid-cols-4 lg:px-8">
        {FACTS.map((f) => (
          <FactItem key={f.source.label} f={f} />
        ))}
      </dl>
    </section>
  );
}

/** The three people Sightline serves, each over a photograph of that work in a real search. */
const ROLE_PHOTO = [PHOTOS[3]!, PHOTOS[0]!, PHOTOS[2]!];

function Roles() {
  return (
    <ul className="grid gap-4 md:grid-cols-3">
      {WHO_ITS_FOR.map((r, i) => {
        const p = ROLE_PHOTO[i]!;
        return (
          <li key={r.title} className="flex flex-col gap-3">
            <img src={p.src} alt={p.alt} loading="lazy" decoding="async" width={960} height={640} className="aspect-[3/2] w-full rounded-md border border-line object-cover" />
            <div className="flex flex-col gap-1">
              <h3 className="text-title font-medium text-text">{r.title}</h3>
              <p className="text-small text-text-2">{r.body}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

const link = "text-text-2 underline underline-offset-2 hover:text-text";

/** How photos get in, and whether it is live: three paths, one line each. */
function Intake() {
  return (
    <div className="flex flex-col gap-3 pt-4">
      <h3 id="home-intake" className="text-title font-medium text-text">
        {HOME.intake}
      </h3>
      <ul aria-labelledby="home-intake" className="grid gap-4 md:grid-cols-3">
        {INTAKE.map((p, i) => (
          <li key={p.title} className="flex items-start gap-3">
            <span className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-line ${i === 2 ? "text-text-3" : "text-drone"}`}>
              <Icon name={p.icon} size={16} />
            </span>
            <span className="flex min-w-0 flex-col gap-1">
              <span className="text-small font-medium text-text">{p.title}</span>
              <span className="text-small text-text-2">
                {p.body}
                {"code" in p && (
                  <>
                    {" "}
                    <code className="break-words rounded bg-surface-strong px-1 py-px font-mono text-caption text-text">{p.code}</code>.{" "}
                    <a className={link} href={SAMPLE_PHOTOS_URL} download>
                      Try it with the sample photos (.zip)
                    </a>
                  </>
                )}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function JudgeStrip() {
  return (
    <ul className="grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
      {JUDGE_STRIP.map((j) => {
        const out = j.href.startsWith("http");
        return (
          <li key={j.label} className="bg-surface-solid">
            <a href={j.href} {...(out ? { target: "_blank", rel: "noreferrer" } : {})} className="sl-tap flex h-full flex-col gap-0.5 px-4 py-3 hover:bg-surface-strong">
              <span className="text-small font-medium text-text">
                {j.label}
                {out && (
                  <span aria-hidden className="text-text-3">
                    {" "}
                    ↗
                  </span>
                )}
              </span>
              <span className="text-caption text-text-2">{j.what}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

export function Home() {
  return (
    <div className="flex min-h-dvh flex-col">
      <AppBar />
      <main className="flex w-full flex-col">
        <Hero />
        <Facts />
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-16 px-4 pb-12 pt-12 lg:px-8">
          <Reveal id="home-how" title={HOME.how}>
            <Architecture />
            <Intake />
          </Reveal>

          <Reveal id="home-who" title={HOME.who}>
            <Roles />
          </Reveal>

          <Reveal id="home-sim" title={HOME.sim}>
            <div className="-mt-1 flex max-w-[70ch] flex-col gap-2">
              <p className="text-body text-text">{HOME.simLead}</p>
              <p className="text-small text-text-2">{HOME.simNote}</p>
            </div>
            <ScenarioCards />
          </Reveal>

          <Reveal id="home-judges" title={HOME.judges}>
            <JudgeStrip />
          </Reveal>

          <HomeFooter />
        </div>
      </main>
    </div>
  );
}

/** The credits, the licence, the sample photos and the one disclosure. */
export function HomeFooter() {
  return (
    <footer className="flex flex-col gap-3 border-t border-line pt-5 text-small text-text-3">
      <p>
        <span className="text-text-2">{DISCLOSURE}.</span> {DISCLOSURE_TITLE}
      </p>
      <p>{FOOTER.data}</p>
      <p>{PHOTO_CREDIT}</p>
      <p className="flex flex-wrap gap-x-5 gap-y-1">
        <a className={link} href={LICENCE_URL} target="_blank" rel="noreferrer">
          Code licence: AGPL-3.0
        </a>
        <a className={link} href={CREDITS_URL} target="_blank" rel="noreferrer">
          Photo credits
        </a>
      </p>
    </footer>
  );
}
