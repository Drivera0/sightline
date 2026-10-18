import { useCallback, useEffect, useState } from "react";
import type { CacheBundle } from "../contract";
import { CACHE_DIR, CacheContext, useCache } from "../lib/cache";
import { isTyping } from "../lib/keys";
import { HeatLayer } from "../map/heat/HeatLayer";
import { MapView } from "../map/MapView";
import { MetricsView } from "../metrics/MetricsView";
import { ResultsSummary } from "../metrics/ResultsSummary";
import { reviewItems } from "../review/items";
import { useReview } from "../review/store";
import { ReviewView } from "../review/ReviewView";
import { Badge, KeyHint, Label } from "./components";
import { STEPS, nextStep, previousStep, stepFromHash, stepFromKey, type StepId } from "./flow";
import { RankReveal } from "./RankReveal";
import { ScreenBoundary } from "./ScreenBoundary";
import { ShortcutOverlay } from "./ShortcutOverlay";
import { StepBar } from "./StepBar";
import { SurveyIntro } from "./SurveyIntro";

export interface SurveyOption {
  dir: string;
  label: string;
}

interface ShellProps {
  cache: CacheBundle;
  cacheDir?: string;
  onCacheDirChange?: (dir: string) => void;
  surveyOptions?: readonly SurveyOption[];
}

/** Remove a trailing explanatory parenthetical that is already represented by badges. */
export function shortSurveyName(name: string): string {
  return name.replace(/\s+\([^()]+\)\s*$/, "");
}

/** Render only the survey choices whose manifests were verified by App. */
export function SurveySelect({
  options,
  value,
  onChange,
}: {
  options: readonly SurveyOption[];
  value: string;
  onChange: (dir: string) => void;
}) {
  const selected = options.some((option) => option.dir === value) ? value : "";
  return (
    <label className="flex items-center gap-2 font-mono text-label text-text-2">
      Survey
      <select
        aria-label="Survey"
        className="rounded-sm border border-border bg-surface-strong px-3 py-2 font-mono text-label text-text"
        onChange={(event) => onChange(event.target.value)}
        value={selected}
      >
        {selected === "" && (
          <option value="" disabled>
            Choose a survey
          </option>
        )}
        {options.map((option) => (
          <option key={option.dir} value={option.dir}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A viewfinder ring with a centre dot: what the product does, in one glyph. */
function Logo() {
  return (
    <svg viewBox="0 0 24 24" className="size-6" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" fill="none" stroke="var(--accent)" strokeWidth="1.75" />
      <path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4" stroke="var(--accent)" strokeWidth="1.75" strokeLinecap="round" />
      <circle cx="12" cy="12" r="2.25" fill="var(--text)" />
    </svg>
  );
}

/** Reads the guided-demo step encoded in the current URL hash. */
function readStep(): StepId {
  return typeof window === "undefined" ? "survey" : stepFromHash(window.location.hash);
}

/**
 * The guided demo: Survey -> Rank -> Review (queue beside the live map) -> Search next -> Results.
 * One screen at a time, a step bar that always shows where you are, and the step in the URL hash
 * (so a presenter can open any step directly, e.g. /#review).
 */
export function Shell({
  cache,
  cacheDir,
  onCacheDirChange,
  surveyOptions = [],
}: ShellProps) {
  const [step, setStepState] = useState<StepId>(readStep);
  // Load this survey's saved review answers on every step, not only once Review opens: the search
  // map and the results summary read them too, including after a reload straight onto those steps.
  const bindReview = useReview((s) => s.bind);
  useEffect(() => bindReview(cache.survey.survey_id), [bindReview, cache.survey.survey_id]);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const loadedDir = useCache((s) => s.dir);
  const dir = loadedDir ?? CACHE_DIR;

  const setStep = useCallback((id: StepId) => {
    setStepState(id);
    if (window.location.hash !== `#${id}`) window.history.replaceState(null, "", `#${id}`);
  }, []);

  useEffect(() => {
    const onHash = () => setStepState(readStep());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isTyping(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "?") {
        setShowShortcuts((open) => !open);
        return;
      }
      if (event.key === "Escape") {
        setShowShortcuts(false);
        return;
      }
      const jump = stepFromKey(event.key);
      if (jump) {
        setStep(jump);
        event.preventDefault();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setStep]);

  const { manifest, survey, detections } = cache;
  const stepInfo = STEPS.find((s) => s.id === step) ?? STEPS[0]!;
  const isFirst = step === STEPS[0]!.id;
  const isLast = step === STEPS.at(-1)!.id;
  const nextLabel = STEPS.find((s) => s.id === nextStep(step))?.label;

  const map = (withHeat: boolean) => (
    <div className="relative h-full min-h-[24rem] overflow-hidden rounded-lg" data-testid="mount-map">
      <ScreenBoundary name="Map">
        <MapView
          focusSelection={!withHeat}
          layers={
            withHeat ? (
              <div data-testid="mount-heat">
                <ScreenBoundary name="Heat layer">
                  <HeatLayer />
                </ScreenBoundary>
              </div>
            ) : undefined
          }
        />
      </ScreenBoundary>
    </div>
  );

  return (
    <CacheContext.Provider value={cache}>
      <div className="flex h-full flex-col gap-3 p-4">
        <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="flex items-center gap-2 text-title font-medium">
              <Logo />
              Sightline
            </h1>
            <span className="text-small text-text-3">{shortSurveyName(survey.area.name)}</span>
            {survey.simulated_path && <Badge kind="simulated">Simulated flight path</Badge>}
            {detections.model === "SAMPLE" && <Badge kind="placeholder">Sample data</Badge>}
            {detections.model === "PLACEHOLDER" && <Badge kind="placeholder">Placeholder detections</Badge>}
          </div>
          {cacheDir && onCacheDirChange && surveyOptions.length > 0 ? (
            <SurveySelect options={surveyOptions} value={cacheDir} onChange={onCacheDirChange} />
          ) : null}
          <StepBar value={step} onChange={setStep} />
          <div className="flex items-center gap-4 text-small text-text-3">
            <span>
              {manifest.n_frames} frames · {manifest.survey_id}
            </span>
            <button
              type="button"
              onClick={() => setShowShortcuts(true)}
              className="inline-flex items-center gap-2 rounded-sm text-text-2 hover:text-text"
            >
              Shortcuts <KeyHint>?</KeyHint>
            </button>
          </div>
        </header>

        <main key={step} className="sl-step flex min-h-0 flex-1 flex-col gap-3" aria-label={stepInfo.label}>
          {step === "survey" && <SurveyIntro cache={cache} dir={dir} onRank={() => setStep("rank")} />}

          {step === "rank" && <RankReveal cache={cache} dir={dir} onStart={() => setStep("review")} />}

          {step === "review" && (
            <>
              <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-full border border-border bg-surface px-4 py-2 text-small text-text-2">
                <span className="text-text">Is this a person?</span>
                <span>
                  &ldquo;Person&rdquo; pins them on the map. &ldquo;Not a person&rdquo; tells the search map the
                  drone looked there. Unsure leaves the map as it is.
                </span>
              </p>
              <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
                <ScreenBoundary name="Review">
                  <ReviewView cache={cache} onShowMap={() => setStep("search")} compact />
                </ScreenBoundary>
                {map(false)}
              </div>
            </>
          )}

          {step === "search" && (
            <>
              <p className="rounded-full border border-border bg-surface px-4 py-2 text-small text-text-2">
                <span className="text-text">Where the person could still be.</span> Orange is more likely, on
                ground the drone photographed. Dark ground is not yet searched (less than half of it
                photographed). Press play to watch the flight: ground the drone saw clearly fades.
              </p>
              <div className="min-h-0 flex-1">{map(true)}</div>
            </>
          )}

          {step === "results" && (
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
              <ResultsSummary
                metrics={cache.metrics}
                cellM={cache.map.grid.cell_m}
                candidateIds={reviewItems(cache).map((i) => i.id)}
              />
              <div className="mt-4 flex items-center gap-4">
                <Label>The details</Label>
                <span className="h-px flex-1 bg-border" aria-hidden="true" />
              </div>
              <div data-testid="mount-metrics">
                <ScreenBoundary name="Metrics">
                  <MetricsView />
                </ScreenBoundary>
              </div>
            </div>
          )}
        </main>

        <footer className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-small text-text-3">
            Imagery: HERIDAL dataset (Božić-Štulić, Marušić &amp; Gotovac, 2019), VOC-format copy by
            Pyrrö (2021), CC BY 3.0.{" "}
            {survey.simulated_path
              ? "Real photos on a simulated flight path."
              : "Real photos at recorded EXIF positions."}
          </p>
          <div className="flex items-center gap-2">
            <Label className="mr-2 hidden md:inline">{stepInfo.hint}</Label>
            <button
              type="button"
              disabled={isFirst}
              onClick={() => setStep(previousStep(step))}
              className="rounded-full border border-border px-4 py-1.5 text-small text-text-2 hover:text-text disabled:opacity-30"
            >
              Back
            </button>
            {!isLast && (
              <button
                type="button"
                onClick={() => setStep(nextStep(step))}
                className="rounded-full border border-accent px-4 py-1.5 text-small text-accent-soft hover:bg-accent hover:text-bg"
              >
                Next: {nextLabel}
              </button>
            )}
          </div>
        </footer>

        {showShortcuts && <ShortcutOverlay onClose={() => setShowShortcuts(false)} />}
      </div>
    </CacheContext.Provider>
  );
}
