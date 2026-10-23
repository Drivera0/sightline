// The AI second look as a real button (V3 §3): "AI second look (OpenCV zoom + Nemotron VL)" with its two
// model chips; pressed, it shows its progress (the zoom, then the VL model) and then the result inline: the
// verdict in words and the images it looked at. One state per candidate, shared by the review rail and the
// large review frame. A candidate the agent did not give a second look has the button off, and says why.
// Built by lane A.
import { create } from "zustand";
import { relookName, type ReviewCard } from "./LiveReview";

type Run = { stage: "running"; started: number; ms: number } | { stage: "done" };

interface SecondLookState {
  runs: Record<string, Run>;
  run: (id: string, ms: number) => void;
  reset: () => void;
}

/** The progress takes the model's own time, within these bounds (ms), so it is seen and never drags. */
export const RUN_MIN_MS = 900;
export const RUN_MAX_MS = 2400;
const timers = new Map<string, number>();

export const useSecondLook = create<SecondLookState>((set, get) => ({
  runs: {},
  run: (id, ms) => {
    if (get().runs[id]) return;
    const t = Math.min(RUN_MAX_MS, Math.max(RUN_MIN_MS, ms || RUN_MIN_MS));
    set((s) => ({ runs: { ...s.runs, [id]: { stage: "running", started: Date.now(), ms: t } } }));
    timers.set(
      id,
      window.setTimeout(() => {
        timers.delete(id);
        set((s) => ({ runs: { ...s.runs, [id]: { stage: "done" } } }));
      }, t),
    );
  },
  reset: () => {
    for (const t of timers.values()) window.clearTimeout(t);
    timers.clear();
    set({ runs: {} });
  },
}));

/** The button's label: what runs, by name. */
export const SECOND_LOOK_LABEL = "AI second look (OpenCV zoom + Nemotron VL)";
const DEFAULT_CHIPS = ["OpenCV 5 zoom native", "Nemotron VL"];

export function SecondLook({ c, large = false }: { c: ReviewCard; large?: boolean }) {
  const run = useSecondLook((s) => s.runs[c.id]);
  const available = !!c.words;
  const chips = c.chips?.length ? c.chips : DEFAULT_CHIPS;
  const images = c.relook ?? [];
  return (
    <div role="group" aria-label="AI second look" className="flex flex-col gap-1.5">
      {run?.stage !== "done" && (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={!available || run?.stage === "running"}
            aria-busy={run?.stage === "running" || undefined}
            onClick={(e) => {
              e.stopPropagation();
              useSecondLook.getState().run(c.id, c.ms ?? 0);
            }}
            title={available ? undefined : "The agent gives a second look to near misses, the candidates under the review threshold; this one has none."}
            className="sl-tap inline-flex h-7 items-center gap-1.5 rounded-full border border-proposal/60 bg-proposal/10 px-3 text-small text-text hover:bg-proposal/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {run?.stage === "running" ? "Looking again…" : SECOND_LOOK_LABEL}
          </button>
          <span className="flex flex-wrap gap-1" aria-label="Models">
            {chips.map((m) => (
              <span key={m} className="rounded-full border border-line bg-surface-strong px-2 py-px text-caption text-text-2">
                {m}
              </span>
            ))}
          </span>
        </div>
      )}
      {!available && <p className="text-caption text-text-3">No second look on this one: the agent runs it on near misses under the review threshold.</p>}
      {run?.stage === "running" && (
        <div aria-label="Second look running" className="flex flex-col gap-1">
          <span className="relative h-1 overflow-hidden rounded-full bg-surface-strong">
            <span className="sl-progress absolute inset-y-0 left-0 rounded-full bg-proposal" style={{ animationDuration: `${run.ms}ms` }} />
          </span>
          <span className="text-caption text-text-3">OpenCV zooms into the photo at full resolution, then Nemotron VL looks at the zoom…</span>
        </div>
      )}
      {run?.stage === "done" && (
        <div aria-label="Second look result" className="sl-slide-in flex flex-col gap-1.5 rounded-md border border-proposal/40 bg-proposal/5 p-2">
          <p className="text-caption font-medium text-proposal">AI second look done{c.ms ? ` in ${(c.ms / 1000).toFixed(1)} s` : ""}</p>
          <p className="text-small text-text">{c.words}</p>
          <span className="flex flex-wrap gap-1" aria-label="Models">
            {chips.map((m) => (
              <span key={m} className="rounded-full border border-line bg-surface-strong px-2 py-px text-caption text-text-2">
                {m}
              </span>
            ))}
          </span>
          {images.length > 0 && (
            <div className={`grid gap-1 ${large ? "grid-cols-2" : "grid-cols-2"}`}>
              {images.map((r) => (
                <figure key={r.url + r.name} className="flex flex-col gap-0.5">
                  <img loading="lazy" decoding="async" src={r.url} alt={`Re-look image ${r.name}`} className="aspect-square w-full rounded-sm object-cover" />
                  <figcaption className="text-caption text-text-3">{relookName(r.name)}</figcaption>
                </figure>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
