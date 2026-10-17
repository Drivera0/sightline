import "@fontsource-variable/caveat";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { configureMapWorker } from "./lib/mapWorker";
import "./shell/theme.css";

configureMapWorker();

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
