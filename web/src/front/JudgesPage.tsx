// #judges: one screen for someone with two minutes. The logline, what to look at, the links with what
// each proves and how long it takes, the live server's status, the three users, and what is simulated
// and what is real. Offline-safe: it fetches only the mission server's /health, and only when the site
// has one. Built by lane A.
import { useEffect, useState, type ReactNode } from "react";
import { apiBase, getHealth, type Health } from "../lib/api";
import { Label, ModeChip, StatusPill } from "../shell/components";
import { Logo } from "../shell/Logo";
import { WHO_ITS_FOR } from "./copy";
import { HONESTY, JUDGE_LINKS, JUDGES, VIDEOS } from "./judges";

function Ext({ href, children }: { href: string; children: ReactNode }) {
  const external = href.startsWith("http");
  return (
    <a href={href} {...(external ? { target: "_blank", rel: "noreferrer" } : {})} className="sl-tap inline-flex min-w-10 items-center text-text underline decoration-text-3 underline-offset-4 hover:decoration-text">
      {children}
      {external && <span aria-hidden> ↗</span>}
    </a>
  );
}

/** The live mission server: its /health when the site has one, else when it runs and the demo instead. */
export function LiveStatus({ base = apiBase(), health = getHealth }: { base?: string | null; health?: typeof getHealth }) {
  const [state, setState] = useState<Health | "down" | null>(null);
  useEffect(() => {
    if (base === null) return undefined;
    let live = true;
    health({ base }).then(
      (h) => live && setState(h),
      () => live && setState("down"),
    );
    return () => {
      live = false;
    };
  }, [base, health]);
  if (base === null) {
    return (
      <span className="text-small text-text-2">
        The live mission server runs during demos and judging; this site is the demo. <Ext href="#m/demo/command">Open the demo mission</Ext>
      </span>
    );
  }
  if (state === null) return <StatusPill tone="muted">Checking the live server…</StatusPill>;
  if (state === "down") {
    return (
      <span className="flex flex-wrap items-center gap-2 text-small text-text-2">
        <StatusPill tone="alert">Live server not reachable</StatusPill>
        It runs during demos and judging. <Ext href="#m/demo/command">Open the demo mission</Ext>
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2 text-small text-text-2">
      <ModeChip mode="live">Live server up</ModeChip>
      contract {state.contract_version} · detector {state.backend}
      {state.radio ? " · radio desk on" : ""}
      <Ext href="#new">Start a search</Ext>
    </span>
  );
}

export function JudgesPage() {
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-10 px-4 py-8 lg:py-12">
      <header className="flex flex-col gap-4">
        <a href="#" className="sl-tap flex items-center gap-2 text-body font-medium text-text" title="Back to the start">
          <Logo />
          Sightline
        </a>
        <Label>For judges</Label>
        <h1 className="text-title text-text lg:text-headline">{JUDGES.logline}</h1>
        <ol className="flex flex-col gap-2 text-body text-text-2">
          {JUDGES.whatToLook.map((s) => (
            <li key={s.slice(0, 24)}>{s}</li>
          ))}
        </ol>
      </header>

      <section aria-label="Where to look" className="flex flex-col gap-3">
        <Label>Where to look, in order</Label>
        <ol className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface-solid">
          {JUDGE_LINKS.map((l, i) => (
            <li key={l.label} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-baseline sm:gap-4">
              <span className="flex items-baseline gap-3 sm:w-56 sm:shrink-0">
                <span className="w-5 font-mono text-caption text-text-3">{i + 1}</span>
                <span className="text-body font-medium">{l.href ? <Ext href={l.href}>{l.label}</Ext> : l.label}</span>
                {l.time && <span className="font-mono text-caption text-text-3">{l.time}</span>}
              </span>
              <span className="pl-8 text-small text-text-2 sm:pl-0">{l.proves}</span>
            </li>
          ))}
          <li className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-baseline sm:gap-4">
            <span className="flex items-baseline gap-3 sm:w-56 sm:shrink-0">
              <span className="w-5 font-mono text-caption text-text-3">{JUDGE_LINKS.length + 1}</span>
              <span className="text-body font-medium text-text">Live API status</span>
            </span>
            <span className="pl-8 sm:pl-0">
              <LiveStatus />
            </span>
          </li>
          <li className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-baseline sm:gap-4">
            <span className="flex items-baseline gap-3 sm:w-56 sm:shrink-0">
              <span className="w-5 font-mono text-caption text-text-3">{JUDGE_LINKS.length + 2}</span>
              <span className="text-body font-medium text-text">Videos</span>
            </span>
            <span className="flex flex-col gap-0.5 pl-8 text-small text-text-2 sm:pl-0">
              {VIDEOS.map((v) => (
                <span key={v.label}>{v.href ? <Ext href={v.href}>{v.label}</Ext> : `${v.label}: link coming`}</span>
              ))}
            </span>
          </li>
        </ol>
      </section>

      <section aria-label="Who it's for" className="flex flex-col gap-3">
        <Label>Who it’s for</Label>
        <div className="grid gap-3 md:grid-cols-3">
          {WHO_ITS_FOR.map((c) => (
            <div key={c.title} className="flex flex-col gap-1 rounded-lg border border-line bg-surface-solid p-4">
              <h2 className="text-body font-medium text-text">{c.title}</h2>
              <p className="text-small text-text-2">{c.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section aria-label="What is simulated and what is real" className="flex flex-col gap-3">
        <Label>What is simulated, what is real</Label>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface-solid p-4">
            <StatusPill tone="caution" className="self-start">Simulated</StatusPill>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-small text-text-2">
              {HONESTY.simulated.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </div>
          <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface-solid p-4">
            <StatusPill tone="ok" className="self-start">Real</StatusPill>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-small text-text-2">
              {HONESTY.real.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </div>
        </div>
        <p className="text-small text-text-2">
          <span className="font-medium text-text">{HONESTY.principle}</span> {HONESTY.principleMore}
        </p>
      </section>

      <footer className="border-t border-line pt-4 text-small text-text-3">
        {JUDGES.built}; <Ext href={JUDGES.changedUrl}>see what changed</Ext>.
      </footer>
    </main>
  );
}
