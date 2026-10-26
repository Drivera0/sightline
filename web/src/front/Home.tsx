// The home page (`#`). It sells Sightline the way professional product pages in this space do (the
// research and the eight rules it follows are in front/README.md): the name, a claim, one measured proof
// and one action above the fold, over the real aerial photos the detector reads; four measured facts with
// their sources; what the photo changes (one real chain of the agent's loop, and Try your own photo);
// what it is built with (OpenCV 5, NVIDIA and Nebius side by side, then Tavily); how it works; who it is for; the guided simulation (the one place
// that explains it); the links judges need; About (`#about` lands there); the footer with
// the credits, the licence and the one disclosure. The console is #m/demo.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AppBar } from "../shell/AppBar";
import { Button, DISCLOSURE, DISCLOSURE_TITLE, Label } from "../shell/components";
import { ABOUT_ID, SCENARIOS_ID, type HomeSection } from "../shell/flow";
import { AboutSection } from "./About";
import { AgenticVision } from "./AgenticVision";
import { Architecture } from "./Architecture";
import { BUILT_WITH, BuiltWith } from "./BuiltWith";
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
/** The rows of docs/report/EVIDENCE_INDEX.md (Home.test.tsx counts them, so this cannot drift). */
export const EVIDENCE_CLAIMS = 105;

export const HOME = {
  eyebrow: HERO.eyebrow,
  title: HERO.title,
  tagline: HERO.tagline,
  proof: "OpenCV 5 finds 86 % of the people in aerial test photos it never trained on. NVIDIA Nemotron models on Nebius Token Factory reason over the finds and the radio, and a person approves every move.",
  builtWith: "Built with",
  stack: ["OpenCV 5 cv2.dnn", "NVIDIA Nemotron, Parakeet, Magpie", "Nebius Token Factory", "Tavily"],
  primary: "Try the guided simulation",
  secondary: "Open the console",
  facts: "Measured, with sources",
  built: BUILT_WITH.title,
  how: "How it works",
  intake: "How photos get in",
  who: "Who it is for",
  sim: "Guided simulation",
  simLead:
    "A three-minute simulated search on real aerial photographs. You are the search manager: the AI proposes, you decide, and the simulation shows what your decisions change. It teaches the console as you go.",
  simNote: "Five searches on the same mountain and the same photos. Each card says who is missing, the clues the field will report and how long it takes.",
  judges: "For judges",
} as const;

/** A measured fact: a big number, a short headline, one supporting line and its source. The number
 *  counts up once when it scrolls into view, with a small picture of it (`viz`) filling alongside. */
export interface Fact {
  value: number;
  decimals: number;
  unit: string;
  /** What the number means, in at most eight words. */
  headline: string;
  /** One line with the exact figures behind it. */
  detail: string;
  /** A small picture of the number: a share filled, two times side by side, or n of n squares. */
  viz: { kind: "share"; of: number } | { kind: "versus"; a: [string, number]; b: [string, number] } | { kind: "count"; n: number } | null;
  source: { label: string; href: string };
}

export const FACTS: readonly Fact[] = [
  {
    value: 86,
    decimals: 0,
    unit: " %",
    headline: "of people found in photos it never saw",
    detail: "291 of the 337 people in 101 held-out HERIDAL test photos (recall 0.864). Re-score it yourself on a CPU in about 5 minutes.",
    viz: { kind: "share", of: 0.864 },
    source: { label: "Baseline table", href: `${BLOB}/docs/report/OPENCV_REPORT.md#310-published-results-on-heridal-side-by-side` },
  },
  {
    value: 711,
    decimals: 0,
    unit: " photos",
    headline: "in 8 minutes on Nebius, about $0.10",
    detail: "A Nebius Serverless Job ran the OpenCV 5 detector over the simulated fleet's photos: 483 s on 16 vCPUs, 0.68 s per photo.",
    viz: null,
    source: { label: "Nebius Serverless Job", href: `${BLOB}/docs/feedback/nebius.md#5-serverless-jobs` },
  },
  {
    value: 12,
    decimals: 0,
    unit: " of 12",
    headline: "agent runs: nothing moved without a person",
    detail: "No drone or team moved before a person approved it, and every approval names who and when.",
    viz: { kind: "count", n: 12 },
    source: { label: "Agent evaluation", href: `${BLOB}/docs/report/AGENT_EVAL.md` },
  },
  {
    value: EVIDENCE_CLAIMS,
    decimals: 0,
    unit: "",
    headline: "claims, each traced to a file and line",
    detail: "The evidence index: CI fails when a cited file or line goes missing.",
    viz: null,
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
      <div className="relative mx-auto flex min-h-[min(700px,calc(100svh-48px))] w-full max-w-6xl flex-col justify-center gap-5 px-4 py-14 lg:px-8">
        <Label className="sl-home-in self-start rounded-full border border-line bg-bg px-3 py-1">{HOME.eyebrow}</Label>
        <div className="flex flex-col gap-2">
          <h1 id="home-title" className="sl-home-in text-[60px] font-semibold leading-[60px] tracking-[-0.045em] text-text sm:text-[96px] sm:leading-[92px]" style={{ animationDelay: "60ms" }}>
            {HOME.title}
          </h1>
          <p className="sl-home-in max-w-[20ch] text-[26px] font-medium leading-[32px] tracking-[-0.02em] text-text sm:text-[36px] sm:leading-[42px]" style={{ animationDelay: "100ms" }}>
            {HOME.tagline}
          </p>
        </div>
        <p className="sl-home-in max-w-[48ch] text-lead text-text-2" style={{ animationDelay: "140ms" }}>
          {HOME.proof}
        </p>
        <div className="sl-home-in flex flex-wrap items-center gap-3 pt-1" style={{ animationDelay: "180ms" }}>
          <Button variant="primary" size="lg" onClick={() => goTo("home-sim")}>
            {HOME.primary}
          </Button>
          <Button href="#m/demo/map" size="lg" className="bg-bg">
            {HOME.secondary}
          </Button>
        </div>
        <button
          type="button"
          onClick={() => goTo("home-built")}
          aria-label={`${HOME.builtWith}: ${HOME.stack.join(", ")}`}
          className="sl-home-in sl-tap group flex max-w-full flex-wrap items-center gap-x-2 gap-y-1.5 self-start pt-2 text-left text-small text-text-2"
          style={{ animationDelay: "220ms" }}
        >
          <span className="text-text-3 group-hover:text-text-2">{HOME.builtWith}</span>
          {HOME.stack.map((t) => (
            <span key={t} className="rounded-full border border-line bg-bg px-2.5 py-0.5 font-medium text-text">
              {t}
            </span>
          ))}
        </button>
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
/** The facts start one after another, this far apart (and their pictures fill as they count). */
export const FACT_STAGGER_MS = 140;
const COUNT_MS = 1100;

/** 0 → 1 over COUNT_MS once `go` turns true, after `delay` (1 at once without motion). */
function useProgress(go: boolean, delay: number): number {
  const [p, setP] = useState(() => (canAnimate() ? 0 : 1));
  const done = useRef(!canAnimate());
  useEffect(() => {
    if (!go || done.current) return;
    done.current = true;
    let frame = 0;
    let start = 0;
    const tick = (now: number) => {
      if (!start) start = now + delay;
      const t = Math.max(0, Math.min(1, (now - start) / COUNT_MS));
      setP(1 - (1 - t) ** 3);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [go, delay]);
  return p;
}

/** The number as it counts (the final width is kept from the start, so nothing moves while it counts). */
function Count({ fact, p }: { fact: Fact; p: number }) {
  const final = fmt(fact.value, fact.decimals);
  return (
    // the final value, invisible, holds the width; the counting one sits over it
    <span className="inline-grid text-left tabular-nums" aria-hidden="true">
      <span className="invisible col-start-1 row-start-1">{final}</span>
      <span className="col-start-1 row-start-1">{p >= 1 ? final : fmt(fact.value * p, fact.decimals)}</span>
    </span>
  );
}

/** The fact's small picture, filled to `p` of its final state. Decorative: the words say it all. */
function FactViz({ viz, p }: { viz: NonNullable<Fact["viz"]>; p: number }) {
  if (viz.kind === "share")
    return (
      <span className="relative block h-1.5 w-full overflow-hidden rounded-full bg-surface-strong">
        <span className="absolute inset-y-0 left-0 rounded-full bg-[var(--found)]" style={{ width: `${viz.of * p * 100}%` }} />
      </span>
    );
  if (viz.kind === "versus") {
    const max = Math.max(viz.a[1], viz.b[1]);
    return (
      <span className="flex flex-col gap-1">
        {[viz.a, viz.b].map(([label, v], i) => (
          <span key={label} className="flex items-center gap-2 font-mono text-caption text-text-3">
            <span className="w-7 shrink-0">{label}</span>
            <span className="relative block h-1.5 flex-1 overflow-hidden rounded-full bg-surface-strong">
              <span className={`absolute inset-y-0 left-0 rounded-full ${i === 0 ? "bg-[var(--drone)]" : "bg-[var(--text-3)]"}`} style={{ width: `${(v / max) * p * 100}%` }} />
            </span>
            <span className="w-12 shrink-0 text-right">{v.toFixed(2)} s</span>
          </span>
        ))}
      </span>
    );
  }
  return (
    <span className="flex gap-1">
      {Array.from({ length: viz.n }, (_, i) => (
        <span key={i} className={`h-1.5 flex-1 rounded-full transition-colors duration-200 ${i < Math.round(p * viz.n) ? "bg-[var(--found)]" : "bg-surface-strong"}`} />
      ))}
    </span>
  );
}

/** One fact: its number counts up when the fact itself is on screen (on a phone they are stacked). */
function FactItem({ f, i }: { f: Fact; i: number }) {
  const [ref, seen] = useSeenOnce<HTMLDivElement>(0.5);
  const delay = i * FACT_STAGGER_MS;
  const p = useProgress(seen, delay);
  return (
    <div ref={ref} data-seen={seen ? "true" : "false"} className="sl-fact flex flex-col gap-2" style={{ transitionDelay: `${delay}ms` }}>
      <dt className="order-2 text-title font-medium text-text">{f.headline}</dt>
      <dd className="order-1 text-[44px] font-semibold leading-[48px] tracking-[-0.035em] text-text sm:text-[56px] sm:leading-[60px]">
        <span className="sr-only">
          {fmt(f.value, f.decimals)}
          {f.unit}
        </span>
        <Count fact={f} p={p} />
        <span aria-hidden="true" className="ml-0.5 text-[0.5em] font-medium tracking-[-0.01em] text-text-2">
          {f.unit}
        </span>
      </dd>
      {f.viz && (
        <dd aria-hidden="true" className="order-3 pb-1">
          <FactViz viz={f.viz} p={p} />
        </dd>
      )}
      <dd className="order-4 text-small text-text-2">{f.detail}</dd>
      <dd className="order-5 mt-auto text-caption">
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
      <dl className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-x-10 gap-y-10 px-4 py-12 sm:grid-cols-2 lg:grid-cols-4 lg:px-8">
        {FACTS.map((f, i) => (
          <FactItem key={f.source.label} f={f} i={i} />
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

/** The home page; `section` scrolls to one of its sections on arrival (#about lands on About). */
export function Home({ section = null }: { section?: HomeSection | null } = {}) {
  const landed = useRef<HomeSection | null>(null);
  useEffect(() => {
    if (section === "about") goTo(ABOUT_ID);
    else if (section === "scenarios") goTo(SCENARIOS_ID);
    else if (landed.current) window.scrollTo?.({ top: 0 }); // from #about back to # (the wordmark)
    landed.current = section;
  }, [section]);
  return (
    <div className="flex min-h-dvh flex-col">
      <AppBar />
      <main className="flex w-full flex-col">
        <Hero />
        <Facts />
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-16 px-4 pb-12 pt-12 lg:px-8">
          <AgenticVision onDecide={() => goTo("home-sim")} />

          <Reveal id="home-built" title={HOME.built}>
            <BuiltWith />
          </Reveal>

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

          <AboutSection />

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
        <a className={link} href={FOOTER.codeUrl} target="_blank" rel="noreferrer">
          {FOOTER.code}
        </a>
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
