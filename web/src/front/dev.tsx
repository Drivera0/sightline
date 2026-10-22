// The front door on its own (LANE_E §4: web/src/front/dev.tsx): open http://localhost:5173/front.html after
// `pnpm dev`. Its links point into the app (index.html), so they only change the hash here.
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../shell/theme.css";
import { FrontDoor } from "./FrontDoor";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <FrontDoor />
  </StrictMode>,
);
