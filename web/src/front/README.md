# Front door (lane E, E-01 to E-03)

`FrontDoor.tsx` with the words in `copy.ts` (LANE_E §6.2), mounted at the default route `#`.

**Checked (lane A, 2026-10-22, headless Chromium):**

- **Accessibility:** axe-core (via `axe-playwright-python`) reports **no violations** on the front door at
  1440×900, 1920×1080 and 390×844, nor on the command view's demo mission (`#m/demo/command`, 1280×900).
- **Keyboard:** Tab goes "Start a new search" → "Watch a demo search" → Results → Code on GitHub, and
  every focus is visible (`:focus-visible` in `theme.css`).
- **Motion:** the front door has no animation; the rest of the app follows `prefers-reduced-motion`.
- **Offline:** `pnpm check:offline` (no external web address in the build); the drawings are inline SVG and
  the fonts are self-hosted.
- **Responsive:** screenshots at the three sizes in `docs/architecture/screens/front-door/`.

Still needs a person: the 30-second test with someone outside the team ("who is it for, how do photos get
in, live or after landing?").
