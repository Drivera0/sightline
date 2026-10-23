// The command view on its own (LANE_E §4: web/src/command/dev.tsx), on the demo mission's fixtures and no
// API: open http://localhost:5173/command.html after `pnpm dev`. Actions change the fixtures in memory.
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../shell/theme.css";
import { useMission } from "../lib/mission";
import type { AssignmentCard } from "../contract";
import { AssignmentCardView } from "./AssignmentCardView";
import { CommandView, storeActions } from "./CommandView";
import { DEMO_CACHE, loadDemoMission } from "./demoMission";
import cardB3 from "./__fixtures__/card_sector_B3.json";
import gpxB3 from "./__fixtures__/sample.gpx?url";
import kmlB3 from "./__fixtures__/sample.kml?url";

/** `command.html?card=B3`: lane B's real B3 card fixture as the printable page (the Devpost gallery's O4). */
function DevCard() {
  return (
    <main className="mx-auto max-w-5xl p-4 lg:p-8">
      <AssignmentCardView card={cardB3 as unknown as AssignmentCard} gpxUrl={gpxB3} kmlUrl={kmlB3} imageUrl={(rel) => `${DEMO_CACHE}/${rel}`} backHref="#" />
    </main>
  );
}

function Dev() {
  const s = useMission();
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    loadDemoMission().then(({ data, now }) => {
      useMission.getState().useDemo(data, now);
      setNow(new Date(now));
    }, console.error);
  }, []);
  if (!now) return <p className="p-6 text-text-3">Loading the demo mission…</p>;
  const m = useMission.getState();
  return (
    <main className="flex h-dvh flex-col p-3">
      <CommandView
        mission={s.mission}
        status={s.status}
        conditions={s.conditions}
        tasks={s.tasks}
        sectors={s.sectors}
        teams={s.teams}
        clues={s.clues}
        proposals={s.proposals}
        events={s.events}
        fleet={s.fleet}
        links={s.links}
        imageUrl={(rel) => `${DEMO_CACHE}/${rel}`}
        actions={storeActions()}
        map={<div className="h-full rounded-lg border border-border" />}
        review={null}
        reviewCount={0}
        onAddClue={(draft) => m.addClue(draft)}
        onDecide={(pid, decision, by, reason, edits) => m.decide(pid, decision, by, reason, edits)}
        now={() => now}
      />
    </main>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    {new URLSearchParams(window.location.search).get("card") === "B3" ? <DevCard /> : <Dev />}
  </StrictMode>,
);
