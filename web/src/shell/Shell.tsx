import { useEffect, useState } from "react";
import type { CacheBundle } from "../contract";
import { HeatLayer } from "../map/heat/HeatLayer";
import { MapView } from "../map/MapView";
import { MetricsView } from "../metrics/MetricsView";
import { ReviewView } from "../review/ReviewView";
import { Badge, KeyHint } from "./components";
import { ShortcutOverlay } from "./ShortcutOverlay";
import { TabPanel, Tabs, type TabItem } from "./Tabs";

type TabId = "review" | "map" | "metrics";

const TABS: readonly TabItem<TabId>[] = [
  { id: "review", label: "Review" },
  { id: "map", label: "Map" },
  { id: "metrics", label: "Metrics" },
];

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
}

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
    <div className="flex h-full flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-title font-medium">Sightline · Mount Seymour survey</h1>
          {survey.simulated_path && <Badge kind="simulated">Simulated flight path</Badge>}
          {detections.model === "SAMPLE" && <Badge kind="placeholder">Sample data</Badge>}
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
            <ReviewView />
          </TabPanel>
        )}
        {tab === "map" && (
          <TabPanel id="map" idPrefix="shell">
            <div className="relative h-full" data-testid="mount-map">
              <MapView />
            </div>
            <div data-testid="mount-heat">
              <HeatLayer />
            </div>
          </TabPanel>
        )}
        {tab === "metrics" && (
          <TabPanel id="metrics" idPrefix="shell">
            <div className="h-full" data-testid="mount-metrics">
              <MetricsView />
            </div>
          </TabPanel>
        )}
      </main>

      {showShortcuts && <ShortcutOverlay onClose={() => setShowShortcuts(false)} />}
    </div>
  );
}
