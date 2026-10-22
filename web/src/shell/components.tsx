import type { ComponentProps, HTMLAttributes, ReactNode } from "react";

const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(" ");

/** Glass panel over the map or background. Inner elements use `rounded-sm` (concentric corners). */
export function Panel({ className, ...props }: ComponentProps<"div">) {
  // 16 px on phones, 24 px from lg, unless the caller sets its own padding.
  const ownPadding = /(^|\s)(p|px|py|pt|pb|pl|pr)-/.test(className ?? "");
  return (
    <div
      className={cx("rounded-lg border border-border bg-surface backdrop-blur-[16px]", !ownPadding && "p-4 lg:p-6", className)}
      {...props}
    />
  );
}

/** Uppercase mono label, 12 px. */
export function Label({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cx("font-mono text-label uppercase tracking-label text-text-3", className)}
      {...props}
    />
  );
}

/** Big number with its label and where it came from. Every number on screen needs a source. */
export function Stat({ value, label, source }: { value: ReactNode; label: string; source?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-display leading-none text-text">{value}</span>
      <Label className="text-text-2">{label}</Label>
      {source && <span className="text-small text-text-3">{source}</span>}
    </div>
  );
}

export type BadgeKind = "simulated" | "placeholder" | "info";

/** Status colours, by meaning (theme.css `.sl-pill`): orange `action` only for "needs a person". */
export type Tone = "ok" | "caution" | "alert" | "action" | "neutral" | "muted";

const BADGE_TONES: Record<BadgeKind, Tone> = { simulated: "caution", placeholder: "caution", info: "neutral" };

/**
 * Honesty badge. The label always says what is simulated, colour is only a hint:
 * "Simulated flight path", "Simulated evaluation", "Placeholder prior", "10 m position uncertainty".
 * Same chip as the LIVE / DEMO / SIM mode chips (an opaque fill, readable over the map's heat).
 */
export function Badge({ kind, children }: { kind: BadgeKind; children: ReactNode }) {
  return (
    <span data-kind={kind} data-tone={BADGE_TONES[kind]} data-mode="badge" className="sl-pill">
      {children}
    </span>
  );
}

/** A status in words with its colour (`--c`): a team searching, a sector in progress, flyability. */
export function StatusPill({ tone = "neutral", dot = true, title, children, className }: { tone?: Tone; dot?: boolean; title?: string; children: ReactNode; className?: string }) {
  return (
    <span data-tone={tone} title={title} className={cx("sl-pill", className)}>
      {dot && <span aria-hidden className="sl-pill-dot" />}
      {children}
    </span>
  );
}

export type Mode = "live" | "demo" | "sim" | "replay" | "offline" | "connecting";
const MODE: Record<Mode, { tone: Tone; word: string; title: string }> = {
  live: { tone: "ok", word: "Live", title: "Connected to the mission server" },
  demo: { tone: "neutral", word: "Demo", title: "Demo mission: fixtures in the page, no server" },
  sim: { tone: "caution", word: "Sim", title: "Simulated" },
  replay: { tone: "neutral", word: "Recorded", title: "A recorded run, replayed: not happening now" },
  offline: { tone: "alert", word: "Offline", title: "Not connected to the mission server" },
  connecting: { tone: "muted", word: "Connecting", title: "Connecting to the mission server" },
};

/** LIVE / DEMO / SIM: where the data on screen comes from, in one chip style everywhere. */
export function ModeChip({ mode, children }: { mode: Mode; children?: ReactNode }) {
  const m = MODE[mode];
  return (
    <span data-mode={mode} data-tone={m.tone} title={m.title} className="sl-pill">
      <span aria-hidden className="sl-pill-dot" />
      {children ?? m.word}
    </span>
  );
}

/** The mission stream's status word → its mode chip. */
export function modeOf(status: string): Mode {
  if (status === "live") return "live";
  if (status === "demo") return "demo";
  if (status === "error") return "offline";
  return "connecting";
}

/** A one-off handwritten note, like the pitch deck's. Never for data or labels. */
export function Annotation({ children }: { children: ReactNode }) {
  return <span className="font-hand text-title text-accent-soft">{children}</span>;
}

/** A key to press. Hidden on touch screens (no hover, or a finger for a pointer), where there is no keyboard to press it on. */
export function KeyHint({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex min-w-6 items-center justify-center rounded-sm border border-border bg-surface-strong px-1.5 py-0.5 font-mono text-label text-text-2 [@media(hover:none)]:hidden [@media(pointer:coarse)]:hidden">
      {children}
    </kbd>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-title text-text">{title}</p>
      {children && <p className="max-w-prose text-body text-text-2">{children}</p>}
    </div>
  );
}
