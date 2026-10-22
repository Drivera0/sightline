// The front door on its own (LANE_E §4: web/src/front/dev.tsx): open http://localhost:5173/front.html after
// `pnpm dev`. The buttons only log here; in the app they route to #new and the demo.
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../shell/theme.css";
import { FrontDoor } from "./FrontDoor";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <FrontDoor onStartNew={() => console.info("start a new search")} onWatchDemo={() => console.info("watch the demo")} />
  </StrictMode>,
);
