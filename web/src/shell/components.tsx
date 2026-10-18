import type { HTMLAttributes, ReactNode } from "react";

const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(" ");

/** Glass panel over the map or background. Inner elements use `rounded-sm` (concentric corners). */
export function Panel({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cx("rounded-lg border border-border bg-surface p-5 backdrop-blur-[16px]", className)}
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

const BADGE_STYLES: Record<BadgeKind, string> = {
  simulated: "border-accent-soft/50 text-accent-soft",
  placeholder: "border-warn/50 text-warn",
  info: "border-border text-text-2",
};

/**
 * Honesty badge. The label always says what is simulated, colour is only a hint:
 * "Simulated flight path", "Simulated evaluation", "Placeholder prior", "10 m position uncertainty".
 */
export function Badge({ kind, children }: { kind: BadgeKind; children: ReactNode }) {
  return (
    <span
      data-kind={kind}
      className={cx(
        "inline-flex items-center rounded-full border px-3 py-1 font-mono text-label uppercase tracking-label",
        BADGE_STYLES[kind],
      )}
    >
      {children}
    </span>
  );
}

/** A one-off handwritten note, like the pitch deck's. Never for data or labels. */
export function Annotation({ children }: { children: ReactNode }) {
  return <span className="font-hand text-title text-accent-soft">{children}</span>;
}

export function KeyHint({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex min-w-6 items-center justify-center rounded-sm border border-border bg-surface-strong px-1.5 py-0.5 font-mono text-label text-text-2">
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
