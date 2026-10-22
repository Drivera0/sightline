// The command view on its own (LANE_E §4: web/src/command/dev.tsx), on the demo mission's fixtures and no
// API: open http://localhost:5173/command.html after `pnpm dev`. Actions change the fixtures in memory.
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../shell/theme.css";
import { useMission } from "../lib/mission";
import { CommandView } from "./CommandView";
import { DEMO_CACHE, loadDemoMission } from "./demoMission";

function Dev() {
  const s = useMission();
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    loadDemoMission().then(({ data, now }) => {
      useMission.getState().useDemo(data);
      setNow(new Date(now));
    }, console.error);
  }, []);
  if (!now) return <p className="p-6 text-text-3">Loading the demo mission…</p>;
  const m = useMission.getState();
  return (
    <main className="mx-auto max-w-5xl p-4 lg:p-8">
      <CommandView
        mission={s.mission}
        status={s.status}
        conditions={s.conditions}
        tasks={s.tasks}
        sectors={s.sectors}
        teams={s.teams}
        clues={s.clues}
        proposals={s.proposals}
        imageUrl={(rel) => `${DEMO_CACHE}/${rel}`}
        onSetTask={(sector, body) => m.setTask(sector, body)}
        onUpdateTeam={(id, patch) => m.updateTeam(id, patch)}
        onAddClue={(draft) => m.addClue(draft)}
        onDecide={(pid, decision, by, reason, edits) => m.decide(pid, decision, by, reason, edits)}
        now={() => now}
      />
    </main>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <Dev />
  </StrictMode>,
);
