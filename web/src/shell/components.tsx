import type { ComponentProps, HTMLAttributes, ReactNode } from "react";

const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(" ");

/**
 * The one card surface: opaque, so it reads the same over the map, the photo wall and the page.
 * Inner elements use `rounded-sm` (concentric corners).
 */
export function Panel({ className, ...props }: ComponentProps<"div">) {
  // 16 px on phones, 24 px from lg, unless the caller sets its own padding.
  const ownPadding = /(^|\s)(p|px|py|pt|pb|pl|pr)-/.test(className ?? "");
  return <div className={cx("rounded-lg border border-line bg-surface-solid", !ownPadding && "p-4 lg:p-6", className)} {...props} />;
}

export type ButtonVariant = "primary" | "secondary" | "ghost";
export type ButtonSize = "md" | "lg";

const BUTTON_BASE =
  "sl-tap inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full transition-[background-color,border-color,color,filter] disabled:pointer-events-none disabled:opacity-50";
const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent font-medium text-bg hover:brightness-110",
  secondary: "border border-border text-text hover:border-text-2 hover:bg-surface-strong",
  ghost: "text-text-2 hover:bg-surface-strong hover:text-text",
};
const BUTTON_SIZE: Record<ButtonSize, string> = {
  md: "h-10 px-4 text-small",
  lg: "h-12 px-6 text-body",
};

/** The one button style's classes, for a control that can't be a `Button` (a file input's label). */
export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md", className?: string): string {
  return cx(BUTTON_BASE, BUTTON_VARIANT[variant], BUTTON_SIZE[size], className);
}

interface ButtonLook {
  variant?: ButtonVariant;
  size?: ButtonSize;
}
export type ButtonProps =
  | (ButtonLook & ComponentProps<"button"> & { href?: undefined })
  | (ButtonLook & ComponentProps<"a"> & { href: string });

/**
 * The one button: primary (solid accent, one per screen), secondary (outlined), ghost (text only).
 * With `href` it is a link that looks like a button (it navigates); without, a `<button>`.
 */
export function Button(props: ButtonProps) {
  if (props.href !== undefined) {
    const { variant = "secondary", size = "md", className, ...rest } = props;
    return <a className={buttonClass(variant, size, className)} {...rest} />;
  }
  const { variant = "secondary", size = "md", className, type = "button", ...rest } = props;
  return <button type={type} className={buttonClass(variant, size, className)} {...rest} />;
}

/**
 * The one page header: an eyebrow label, the page's h1 and one line under it. `aside` sits on the
 * right from sm (a status chip); `children` go below (a list, a player).
 */
export function PageHeader({
  eyebrow,
  title,
  sub,
  aside,
  children,
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex flex-col gap-3", className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex min-w-0 flex-col gap-2">
          {eyebrow && <Label>{eyebrow}</Label>}
          <h1 className="text-headline font-medium tracking-[-0.01em] text-text">{title}</h1>
          {sub && <p className="max-w-[72ch] text-body text-text-2">{sub}</p>}
        </div>
        {aside && <div className="flex shrink-0 flex-wrap items-center gap-2">{aside}</div>}
      </div>
      {children}
    </div>
  );
}

/** The one page container, for every page that isn't the console or a guided-demo map step. */
export function Page({ className, children, ...props }: ComponentProps<"main">) {
  return (
    <main className={cx("mx-auto flex w-full max-w-6xl flex-col gap-10 px-4 pb-12 pt-8 lg:px-8 lg:pt-10", className)} {...props}>
      {children}
    </main>
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
