import { useCallback, useEffect, useMemo, useState } from "react";
import type { CacheBundle } from "../contract";
import { CACHE_DIR, CacheContext, useCache } from "../lib/cache";
import { isTyping } from "../lib/keys";
import { HeatLayer } from "../map/heat/HeatLayer";
import { PanelSlotContext } from "../map/heat/panelSlot";
import { MapView } from "../map/MapView";
import { TryPhoto } from "../detect/TryPhoto";
import { useModelAvailable } from "../detect/useModelAvailable";
import { MetricsView } from "../metrics/MetricsView";
import { prefersReducedMotion } from "../metrics/motion";
import { ResultsSummary } from "../metrics/ResultsSummary";
import { reviewItems } from "../review/items";
import { useReview } from "../review/store";
import { ReviewView } from "../review/ReviewView";
import { AppMenu, type MenuItem } from "./AppMenu";
import { Badge, Label } from "./components";
import { STEPS, nextStep, previousStep, stepFromHash, stepFromKey, type StepId } from "./flow";
import { RankReveal } from "./RankReveal";
import { ScreenBoundary } from "./ScreenBoundary";
import { ShortcutOverlay } from "./ShortcutOverlay";
import { StepBar } from "./StepBar";
import { SurveyIntro } from "./SurveyIntro";
import { TOUR_IDLE, isTouring, tourReducer, tourStops, type TourEvent, type TourStop } from "./tour";
import { TourOverlay, pressForTour } from "./TourOverlay";

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

/** The error page's survey choice: only the surveys whose manifests were verified by App. */
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

/**
 * The survey name as a quiet button, with the one honesty label for the flight path under it.
 * When App verified more than one survey, a native select sits over it (keyboard and screen
 * readers get the real control).
 */
export function SurveyPicker({
  name,
  simulatedPath,
  options,
  value,
  onChange,
}: {
  name: string;
  simulatedPath: boolean;
  options: readonly SurveyOption[];
  value: string;
  onChange: (dir: string) => void;
}) {
  const selected = options.some((option) => option.dir === value) ? value : "";
  const choosable = options.length > 0;
  // "Mount Seymour, North Vancouver" -> "Mount Seymour": the bar has room for the place, not the region.
  const place = name.split(",")[0]!.trim();
  return (
    <div
      className={
        "relative hidden min-w-0 flex-col rounded-sm px-2 py-1 sm:flex " +
        (choosable ? "hover:bg-surface-strong focus-within:bg-surface-strong" : "")
      }
      title={name}
    >
      <span className="inline-flex items-center gap-1 truncate text-small text-text">
        {place}
        {choosable && (
          <svg viewBox="0 0 16 16" className="size-3 shrink-0 text-text-3" aria-hidden="true">
            <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      {simulatedPath && <span className="truncate text-[11px] leading-4 text-accent-soft">Simulated flight path</span>}
      {choosable && (
        <select
          aria-label="Survey"
          className="absolute inset-0 cursor-pointer appearance-none bg-bg text-small text-text opacity-0"
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
      )}
    </div>
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
  const [tryPhoto, setTryPhoto] = useState(false);
  // "Try your own photo" shows only when this deployment ships the model (one HEAD check).
  const canTryPhoto = useModelAvailable();
  // Below the Search next map on narrow screens: HeatLayer puts its panels here (panelSlot.ts).
  const [searchPanelSlot, setSearchPanelSlot] = useState<HTMLDivElement | null>(null);
  const loadedDir = useCache((s) => s.dir);
  const dir = loadedDir ?? CACHE_DIR;

  const setStep = useCallback((id: StepId) => {
    setStepState(id);
    if (window.location.hash !== `#${id}`) window.history.replaceState(null, "", `#${id}`);
  }, []);

  // The guided tour: the stops' captions come from this cache; the tour drives the step.
  const stops = useMemo(() => tourStops(cache), [cache]);
  const [tour, setTour] = useState(TOUR_IDLE);
  const [tourRun, setTourRun] = useState(0);
  const touring = isTouring(tour);
  const dispatchTour = useCallback(
    (event: TourEvent) => {
      if (event.type === "start") setTourRun((r) => r + 1);
      setTour((state) => tourReducer(state, event, stops.length));
    },
    [stops.length],
  );
  const startTour = useCallback(() => {
    setShowShortcuts(false);
    dispatchTour({ type: "start", reducedMotion: prefersReducedMotion() });
  }, [dispatchTour]);
  const tourStep = touring ? stops[tour.index]?.step : undefined;
  useEffect(() => {
    if (tourStep) setStep(tourStep);
    // The demo answer lives only while the tour shows its effect (Review, Search next).
    if (tourStep !== "review" && tourStep !== "search") useReview.getState().endDemo();
  }, [tourStep, tourRun, setStep]);
  useEffect(() => () => useReview.getState().endDemo(), []);
  const onTourAction = useCallback((stop: TourStop) => {
    if (stop.action === "demoAnswer") {
      useReview.getState().beginDemo();
      // The queue's own "P" key, so the viewer sees the real toast, pin and queue move.
      pressForTour("p");
    } else if (stop.action === "playFlight") {
      document.querySelector<HTMLButtonElement>('[data-testid="mount-heat"] button[aria-label="Play"], button[aria-label="Play"]')?.click();
    }
  }, []);

  useEffect(() => {
    const onHash = () => setStepState(readStep());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isTyping(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "t" || event.key === "T") {
        startTour();
        event.preventDefault();
        return;
      }
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
  }, [setStep, startTour]);

  const { survey, detections } = cache;
  const menuItems: MenuItem[] = [
    ...(canTryPhoto
      ? [{ label: "Try your own photo", detail: "Runs the detector in your browser", onSelect: () => setTryPhoto(true) }]
      : []),
    { label: "Keyboard shortcuts", hint: "?", onSelect: () => setShowShortcuts(true) },
    { label: "Take the tour", detail: "The five steps, played for you", hint: "T", onSelect: startTour },
  ];
  const stepInfo = STEPS.find((s) => s.id === step) ?? STEPS[0]!;
  const stepIndex = STEPS.findIndex((s) => s.id === step);
  const isFirst = step === STEPS[0]!.id;
  const isLast = step === STEPS.at(-1)!.id;
  const nextLabel = STEPS.find((s) => s.id === nextStep(step))?.label;

  // Review: the live heat under the pins, fainter, so each answer visibly changes the map.
  // Search next: the full heat with sectors, replay and the side panel.
  const map = (variant: "review" | "search") => (
    <div
      // Search next on narrow screens: the map takes a fixed share of the height and its panels go below it.
      className={"relative min-h-[24rem] overflow-hidden rounded-lg lg:h-full " + (variant === "search" ? "h-[62svh]" : "h-[60vh]")}
      data-testid="mount-map"
    >
      <ScreenBoundary name="Map">
        <MapView
          focusSelection={variant === "review"}
          layers={
            <div data-testid={variant === "search" ? "mount-heat" : "mount-heat-review"}>
              <ScreenBoundary name="Heat layer">
                <HeatLayer variant={variant} />
              </ScreenBoundary>
            </div>
          }
        />
      </ScreenBoundary>
    </div>
  );

  return (
    <CacheContext.Provider value={cache}>
      <div className="flex min-h-full flex-col gap-3 px-4 pb-4 lg:h-full">
        <header className="relative flex h-14 shrink-0 items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <h1 className="flex shrink-0 items-center gap-2 text-title font-medium">
              <Logo />
              Sightline
            </h1>
            <SurveyPicker
              name={shortSurveyName(survey.area.name)}
              simulatedPath={survey.simulated_path}
              options={cacheDir && onCacheDirChange ? surveyOptions : []}
              value={cacheDir ?? ""}
              onChange={(d) => onCacheDirChange?.(d)}
            />
            {detections.model === "SAMPLE" && <Badge kind="placeholder">Sample data</Badge>}
            {detections.model === "PLACEHOLDER" && <Badge kind="placeholder">Placeholder detections</Badge>}
          </div>
          <div className="hidden md:block">
            <StepBar value={step} onChange={setStep} />
          </div>
          <div className="flex items-center gap-3">
            <p className="text-small text-text-2 md:hidden" aria-hidden="true">
              <span className="font-mono text-text-3">
                {stepIndex + 1}/{STEPS.length}
              </span>{" "}
              {stepInfo.label}
            </p>
            <AppMenu items={menuItems}>
              {/* Phones: the survey picker and its flight-path label move into the menu. */}
              <div className="flex flex-col gap-2 border-b border-border px-3 pb-3 pt-2 sm:hidden">
                <span className="flex flex-col">
                  <span className="text-body text-text">{shortSurveyName(survey.area.name)}</span>
                  {survey.simulated_path && <span className="text-[11px] leading-4 text-accent-soft">Simulated flight path</span>}
                </span>
                {cacheDir && onCacheDirChange && surveyOptions.length > 0 && (
                  <SurveySelect options={surveyOptions} value={cacheDir} onChange={onCacheDirChange} />
                )}
              </div>
            </AppMenu>
          </div>
          {/* Phones: the stepper becomes a thin progress line under the bar. */}
          <div className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden rounded-full bg-surface-strong md:hidden" aria-hidden="true">
            <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${((stepIndex + 1) / STEPS.length) * 100}%` }} />
          </div>
        </header>

        <main key={step} className="sl-step flex flex-1 flex-col gap-3 lg:min-h-0" aria-label={stepInfo.label}>
          {step === "survey" && <SurveyIntro cache={cache} dir={dir} onRank={() => setStep("rank")} onTour={startTour} onTryPhoto={canTryPhoto ? () => setTryPhoto(true) : undefined} />}

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
              <div className="grid flex-1 grid-cols-1 gap-3 lg:min-h-0 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
                <ScreenBoundary name="Review">
                  <ReviewView cache={cache} onShowMap={() => setStep("search")} compact />
                </ScreenBoundary>
                {map("review")}
              </div>
            </>
          )}

          {step === "search" && (
            <>
              <p className="rounded-lg border border-border bg-surface px-4 py-2 text-small text-text-2 lg:rounded-full">
                <span className="text-text">Where the person could still be.</span> Darker red is more likely,
                pale yellow less likely, on ground the drone photographed. Dimmed grey ground is not yet searched.
                The sectors list ranks the remaining work by probability. Press play to watch the drone fly
                sector by sector: ground it saw clearly turns pale.
              </p>
              <PanelSlotContext.Provider value={searchPanelSlot}>
                <div className="flex-1 lg:min-h-0">{map("search")}</div>
              </PanelSlotContext.Provider>
              <div ref={setSearchPanelSlot} className="lg:hidden" data-testid="search-panel-slot" />
            </>
          )}

          {step === "results" && (
            <div className="flex flex-col gap-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
              <ResultsSummary
                metrics={cache.metrics}
                cellM={cache.map.grid.cell_m}
                candidateIds={reviewItems(cache).map((i) => i.id)}
                surveyId={cache.survey.survey_id}
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

        {showShortcuts && <ShortcutOverlay onClose={() => setShowShortcuts(false)} onTour={startTour} />}
        {tryPhoto && <TryPhoto cache={cache} dir={dir} onClose={() => setTryPhoto(false)} />}
        {touring && (
          <TourOverlay stops={stops} state={tour} run={tourRun} dispatch={dispatchTour} onAction={onTourAction} />
        )}
      </div>
    </CacheContext.Provider>
  );
}
