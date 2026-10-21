// The radio desk on its own (LANE_E §4: web/src/radio/dev.tsx), talking to
// `uv run uvicorn sightline.radio.dev:app --port 8010`. Open http://localhost:5173/radio.html after
// `pnpm dev`. ?api=<base>&mission=<id> point it elsewhere.
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../shell/theme.css";
import { RadioDesk } from "./RadioDesk";

const params = new URLSearchParams(location.search);
const api = { base: params.get("api") ?? "http://127.0.0.1:8010", missionId: params.get("mission") ?? "demo0001" };

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <main className="mx-auto max-w-3xl p-4 lg:p-8">
      <RadioDesk api={api} operator="Dev operator" />
    </main>
  </StrictMode>,
);
