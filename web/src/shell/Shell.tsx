import { useEffect, useState } from "react";
import type { CacheBundle } from "../contract";
import { CacheContext } from "../lib/cache";
import { isTyping } from "../lib/keys";
import { HeatLayer } from "../map/heat/HeatLayer";
import { MapView } from "../map/MapView";
import { MetricsView } from "../metrics/MetricsView";
import { ReviewView } from "../review/ReviewView";
import { Badge, KeyHint } from "./components";
import { ScreenBoundary } from "./ScreenBoundary";
import { ShortcutOverlay } from "./ShortcutOverlay";
import { TabPanel, Tabs, type TabItem } from "./Tabs";

type TabId = "review" | "map" | "metrics";

const TABS: readonly TabItem<TabId>[] = [
  { id: "review", label: "Review" },
  { id: "map", label: "Map" },
  { id: "metrics", label: "Metrics" },
];

export function Shell({ cache }: { cache: CacheBundle }) {
  const [tab, setTab] = useState<TabId>("review");
  const [showShortcuts, setShowShortcuts] = useState(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "?" && !isTyping(event.target)) {
        setShowShortcuts((open) => !open);
      } else if (event.key === "Escape") {
        setShowShortcuts(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const { manifest, survey, detections } = cache;

  return (
    <CacheContext.Provider value={cache}>
    <div className="flex h-full flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-title font-medium">Sightline · Mount Seymour survey</h1>
          {survey.simulated_path && <Badge kind="simulated">Simulated flight path</Badge>}
          {detections.model === "SAMPLE" && <Badge kind="placeholder">Sample data</Badge>}
          {detections.model === "PLACEHOLDER" && <Badge kind="placeholder">Placeholder detections</Badge>}
        </div>
        <Tabs tabs={TABS} value={tab} onChange={setTab} label="Screens" idPrefix="shell" />
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

      <main className="flex min-h-0 flex-1 flex-col">
        {tab === "review" && (
          <TabPanel id="review" idPrefix="shell">
            <ScreenBoundary name="Review">
              <ReviewView cache={cache} onShowMap={() => setTab("map")} />
            </ScreenBoundary>
          </TabPanel>
        )}
        {tab === "map" && (
          <TabPanel id="map" idPrefix="shell">
            <div className="relative h-full" data-testid="mount-map">
              <ScreenBoundary name="Map">
                {/* Lane C's heat layer renders inside lane B's map context, so it can call useMap(). */}
                <MapView
                  layers={
                    <div data-testid="mount-heat">
                      <ScreenBoundary name="Heat layer">
                        <HeatLayer />
                      </ScreenBoundary>
                    </div>
                  }
                />
              </ScreenBoundary>
            </div>
          </TabPanel>
        )}
        {tab === "metrics" && (
          <TabPanel id="metrics" idPrefix="shell">
            <div className="h-full" data-testid="mount-metrics">
              <ScreenBoundary name="Metrics">
                <MetricsView />
              </ScreenBoundary>
            </div>
          </TabPanel>
        )}
      </main>

      <footer className="text-small text-text-3">
        Imagery: HERIDAL dataset (Božić-Štulić, Marušić &amp; Gotovac, 2019), VOC-format copy by
        Pyrrö (2021), CC BY 3.0. Real photos on a simulated flight path.
      </footer>

      {showShortcuts && <ShortcutOverlay onClose={() => setShowShortcuts(false)} />}
    </div>
    </CacheContext.Provider>
  );
}
