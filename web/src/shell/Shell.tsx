import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { CacheBundle } from "../contract";
import { CACHE_DIR, CacheContext, useCache } from "../lib/cache";
import { isTyping } from "../lib/keys";
import { HeatLayer } from "../map/heat/HeatLayer";
import { PanelSlotContext } from "../map/heat/panelSlot";
import { MapView } from "../map/MapView";
import { MetricsView } from "../metrics/MetricsView";
import { prefersReducedMotion } from "../metrics/motion";
import { ResultsSummary } from "../metrics/ResultsSummary";
import { reviewItems } from "../review/items";
import { useReview } from "../review/store";
import { ReviewView } from "../review/ReviewView";
import { AppBar } from "./AppBar";
import { AppMenu, type MenuItem } from "./AppMenu";
import { Badge, Button, Label, PageHeader, Panel } from "./components";
import { InfoTip } from "./Popover";
import { DEMO_CONSOLE_HASH, STEPS, nextStep, previousStep, stepFromHash, stepFromKey, type StepId } from "./flow";
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
      {simulatedPath && <span className="truncate text-caption text-caution">Simulated flight path</span>}
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

const GITHUB_URL = "https://github.com/Drivera0/sightline";

/** Back and the one primary action, bottom-right of the step's content. `nextHref` leaves the guided demo. */
function StepNav({ onBack, onNext, next, nextHref }: { onBack: () => void; onNext?: () => void; next: string; nextHref?: string }) {
  const arrow = <span aria-hidden="true">→</span>;
  return (
    <nav aria-label="Step navigation" className="flex shrink-0 items-center justify-end gap-2">
      <Button variant="ghost" onClick={onBack}>
        Back
      </Button>
      {nextHref ? (
        <Button variant="primary" href={nextHref}>
          {next} {arrow}
        </Button>
      ) : (
        <Button variant="primary" onClick={onNext}>
          {next} {arrow}
        </Button>
      )}
    </nav>
  );
}

/** The end of the story: what to do next. */
function ClosingCard({ onTour, onRealGps }: { onTour: () => void; onRealGps?: () => void }) {
  return (
    <Panel role="region" aria-label="What next" className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col gap-1">
        <h2 className="text-title font-medium">That&rsquo;s the whole search.</h2>
        <p className="text-small text-text-2">Run it yourself in the console, watch it again, try the survey with real GPS positions, or read the code.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" href={DEMO_CONSOLE_HASH}>
          Open the console
        </Button>
        <Button onClick={onTour}>Replay the tour</Button>
        {onRealGps && <Button onClick={onRealGps}>Try the real-GPS survey</Button>}
        <Button href={GITHUB_URL} target="_blank" rel="noreferrer">
          Code on GitHub <span aria-hidden="true">↗</span>
        </Button>
      </div>
    </Panel>
  );
}

/** A step's header: the page header with "Step n of 5" as its eyebrow. */
function StepHeader({ step, title, subtitle, info }: { step: StepId; title: string; subtitle: string; info?: ReactNode }) {
  const index = STEPS.findIndex((s) => s.id === step);
  return (
    <PageHeader
      eyebrow={`Step ${index + 1} of ${STEPS.length} · ${STEPS[index]?.label ?? ""}`}
      title={title}
      sub={
        <span className="inline-flex flex-wrap items-center gap-2">
          {subtitle}
          {info && (
            <InfoTip label="How to read this map" side="bottom" align="start">
              {info}
            </InfoTip>
          )}
        </span>
      }
    />
  );
}

/** Reads the guided-demo step encoded in the current URL hash. */
function readStep(): StepId {
  return typeof window === "undefined" ? "survey" : stepFromHash(window.location.hash);
}

/**
 * The guided demo: Survey -> Rank -> Review (queue beside the live map) -> Search next -> Results; Search next
 * hands over to the console ("Run the search", #m/demo/command).
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
      if (event.key === "c" || event.key === "C") {
        window.location.hash = DEMO_CONSOLE_HASH; // the console on the demo mission (no API needed)
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
  const [modelBg, setModelBg] = useModelBackgroundSetting();
  // The menu keeps what the app bar doesn't: shortcuts (the tour is in them, and on T), Try a photo, the background.
  const menuItems: MenuItem[] = [
    { label: "Keyboard shortcuts", detail: "Including the 60-second tour (T)", hint: "?", onSelect: () => setShowShortcuts(true) },
    { label: "Try a photo", detail: "Run the detector on your own photo, in your browser", onSelect: () => (window.location.hash = "#try") },
    {
      label: modelBg ? "Background animation: on" : "Background animation: off",
      detail: modelBg ? "The detector's layers behind the intro · turn off" : "Turn on the detector's layers behind the intro",
      onSelect: () => setModelBg(!modelBg),
    },
  ];
  const stepInfo = STEPS.find((s) => s.id === step) ?? STEPS[0]!;
  const credit =
    "Imagery: HERIDAL dataset (Božić-Štulić, Marušić & Gotovac, 2019), VOC-format copy by Pyrrö (2021), CC BY 3.0. " +
    (cache.survey.simulated_path ? "Real photos on a simulated flight path." : "Real photos at recorded EXIF positions.");
  // Another survey is a new story: start it from step 1.
  const changeSurvey = (d: string) => {
    if (!onCacheDirChange || d === cacheDir) return;
    setStep("survey");
    onCacheDirChange(d);
  };
  const realGps =
    cacheDir && cacheDir !== "real-gps" && onCacheDirChange && surveyOptions.some((o) => o.dir === "real-gps")
      ? () => changeSurvey("real-gps")
      : undefined;

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
      <div className="flex min-h-full flex-col lg:h-full">
        <AppBar
          current="demo"
          wide
          extra={
            <AppMenu items={menuItems}>
              {/* Phones: the survey picker and its flight-path label move into the menu. */}
              <div className="flex flex-col gap-2 border-b border-border px-3 pb-3 pt-2 sm:hidden">
                <span className="flex flex-col">
                  <span className="text-body text-text">{shortSurveyName(survey.area.name)}</span>
                  {survey.simulated_path && <span className="text-caption text-caution">Simulated flight path</span>}
                </span>
                {cacheDir && onCacheDirChange && surveyOptions.length > 0 && (
                  <SurveySelect options={surveyOptions} value={cacheDir} onChange={changeSurvey} />
                )}
              </div>
            </AppMenu>
          }
          below={
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <StepBar value={step} onChange={setStep} />
              <div className="flex min-w-0 items-center gap-3 sm:ml-auto">
                <SurveyPicker
                  name={shortSurveyName(survey.area.name)}
                  simulatedPath={survey.simulated_path}
                  options={cacheDir && onCacheDirChange ? surveyOptions : []}
                  value={cacheDir ?? ""}
                  onChange={changeSurvey}
                />
                {detections.model === "SAMPLE" && <Badge kind="placeholder">Sample data</Badge>}
                {detections.model === "PLACEHOLDER" && <Badge kind="placeholder">Placeholder detections</Badge>}
              </div>
            </div>
          }
        />

        <div className="flex flex-1 flex-col gap-4 px-4 pb-4 pt-4 lg:min-h-0 lg:px-6">
          <main key={step} className="sl-step flex flex-1 flex-col gap-4 lg:min-h-0" aria-label={stepInfo.label}>
            {step === "survey" && (
              <SurveyIntro cache={cache} dir={dir} onRank={() => setStep("rank")} onReview={() => setStep("review")} onTour={startTour} modelBackground={modelBg} touring={touring} />
            )}

            {step === "rank" && <RankReveal cache={cache} dir={dir} onStart={() => setStep("review")} />}

            {step === "review" && (
              <>
                <StepHeader
                  step="review"
                  title="Is this a person?"
                  subtitle="Person pins them on the map. Not a person lowers that ground's probability; it never removes it. Unsure changes nothing."
                />
                <div className="grid flex-1 grid-cols-1 gap-4 lg:min-h-0 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
                  <ScreenBoundary name="Review">
                    <ReviewView cache={cache} onShowMap={() => setStep("search")} compact />
                  </ScreenBoundary>
                  {map("review")}
                </div>
                <StepNav onBack={() => setStep(previousStep(step))} onNext={() => setStep(nextStep(step))} next="See where to search" />
              </>
            )}

            {step === "search" && (
              <>
                <StepHeader
                  step="search"
                  title="Where the person could still be"
                  subtitle="Filled ground holds the likeliest 90 % of the estimate, in three bands; unfilled ground is outside it. Dimmed = not yet searched; grey = awaiting review."
                  info={
                    <>
                      The colours show probability per cell on ground the drone photographed, on one fixed scale
                      for the whole replay. Search next lists the most likely spots on ground the drone photographed
                      well, numbered the same as their circles on the map; the sectors list below it ranks the remaining work by probability. Press play to
                      watch the drone fly sector by sector: ground it saw clearly turns pale, forest it cannot see
                      into stays dark red.
                    </>
                  }
                />
                <PanelSlotContext.Provider value={searchPanelSlot}>
                  <div className="flex-1 lg:min-h-0">{map("search")}</div>
                </PanelSlotContext.Provider>
                <div ref={setSearchPanelSlot} className="lg:hidden" data-testid="search-panel-slot" />
                {/* The guided demo hands over to the console here: the same map, run by a search manager. */}
                <StepNav onBack={() => setStep(previousStep(step))} next="Run the search" nextHref={DEMO_CONSOLE_HASH} />
              </>
            )}

            {step === "results" && (
              <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:px-2">
                <ResultsSummary
                  metrics={cache.metrics}
                  cellM={cache.map.grid.cell_m}
                  candidateIds={reviewItems(cache).map((i) => i.id)}
                  surveyId={cache.survey.survey_id}
                />
                <div className="mt-4 flex items-center gap-4">
                  <Label>Full tables</Label>
                  <span className="h-px flex-1 bg-border" aria-hidden="true" />
                </div>
                <div data-testid="mount-metrics">
                  <ScreenBoundary name="Metrics">
                    <MetricsView />
                  </ScreenBoundary>
                </div>
                <ClosingCard onTour={startTour} onRealGps={realGps} />
              </div>
            )}
          </main>

          <footer>
            <p className="text-caption text-text-3 sm:truncate" title={credit}>
              {credit}
            </p>
          </footer>
        </div>

        {showShortcuts && <ShortcutOverlay onClose={() => setShowShortcuts(false)} onTour={startTour} />}
        {touring && (
          <TourOverlay stops={stops} state={tour} run={tourRun} dispatch={dispatchTour} onAction={onTourAction} />
        )}
      </div>
    </CacheContext.Provider>
  );
}

const MODEL_BG_KEY = "sightline.modelBackground";

/**
 * The intro's faded detector graph: on by default, remembered per browser, and overridable with
 * ?bg=off or ?bg=model in the address. Storage can be blocked, so every access is guarded.
 */
function useModelBackgroundSetting(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const param = new URLSearchParams(window.location.search).get("bg");
    if (param === "off") return false;
    if (param === "model") return true;
    try {
      return window.localStorage.getItem(MODEL_BG_KEY) !== "off";
    } catch {
      return true;
    }
  });
  const set = (next: boolean) => {
    setOn(next);
    try {
      window.localStorage.setItem(MODEL_BG_KEY, next ? "on" : "off");
    } catch {
      // Storage blocked: the choice lasts for this visit only.
    }
  };
  return [on, set];
}
