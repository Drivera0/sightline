import type { KeyboardEvent, ReactNode } from "react";

export interface TabItem<T extends string> {
  id: T;
  label: string;
}

const tabDomId = (prefix: string, id: string) => `${prefix}-tab-${id}`;
const panelDomId = (prefix: string, id: string) => `${prefix}-panel-${id}`;

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  idPrefix = "tabs",
  label,
}: {
  tabs: readonly TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  idPrefix?: string;
  label: string;
}) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const current = (event.target as HTMLElement).closest<HTMLElement>('[role="tab"]')?.dataset.id;
    const index = tabs.findIndex((t) => t.id === current);
    if (index < 0) return;
    const last = tabs.length - 1;
    const target =
      event.key === "ArrowRight"
        ? (index + 1) % tabs.length
        : event.key === "ArrowLeft"
          ? (index + last) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (target === null) return;
    event.preventDefault();
    const next = tabs[target] as TabItem<T>;
    onChange(next.id);
    document.getElementById(tabDomId(idPrefix, next.id))?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="inline-flex gap-1 rounded-full border border-border bg-surface p-1"
    >
      {tabs.map((tab) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            id={tabDomId(idPrefix, tab.id)}
            role="tab"
            type="button"
            data-id={tab.id}
            aria-selected={selected}
            aria-controls={panelDomId(idPrefix, tab.id)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={
              "rounded-full px-5 py-1.5 text-body transition-colors " +
              (selected
                ? "bg-accent text-bg font-medium"
                : "text-text-2 hover:bg-surface-strong hover:text-text")
            }
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({
  id,
  idPrefix = "tabs",
  children,
}: {
  id: string;
  idPrefix?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={panelDomId(idPrefix, id)}
      aria-labelledby={tabDomId(idPrefix, id)}
      className="min-h-0 flex-1"
    >
      {children}
    </div>
  );
}
