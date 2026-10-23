# web/src/front: the home page and the words about Sightline

The home page (`#`) says what Sightline is and opens the console on a search; the console itself is
`#m/demo` (`web/src/shell/README.md`).

| File | What |
|---|---|
| `Home.tsx` | The home page: two lines, the four photographs, how it fits together, "Choose a search", and the footer (the repo, the report, the sample photos, the credits, the one disclosure). |
| `scenarios.ts` | The five cards' words: setting, who is missing, the clues each fixture throws, the length. `scenarios.test.ts` checks them against the fixtures. |
| `ScenarioCards.tsx` | The cards. Start: `#m/demo?s=<seed>&guide=1` (the guided simulation); Just the console: `#m/demo/map?s=<seed>`; Shuffle makes a new seed on each click. |
| `ScenarioBanner.tsx` | The demo console's line under the app bar ("Overdue hiker · Mount Seymour · 13:35 PDT") and Change scenario, which opens the cards in a sheet. |
| `Architecture.tsx` | How it fits together, drawn in the colour tokens (an SVG on wide screens, a list on a phone), from `docs/architecture/system.png` and `agent.png`. |
| `photos.ts` | The four photographs (public domain, NPS; `public/front/CREDITS.md`), served from `public/front/`. |
| `About.tsx` | The About sheet (`#about`, from the wordmark and the `?` menu): the photographs, how it works in four steps, the diagram, what the colours mean, the models, the disclosure and limits, the links. |
| `Steps.tsx` | How it works in four steps, each with its icon in its colour. |
| `copy.ts` | LANE_E §6.2's words: the tagline, how it works, who it's for, the principles, the credits, the radio clip. |
| `judges.ts` | "Where to look, in order" (a fold of the Debrief; `#judges` opens it), what is simulated and what is real, and the three "what breaks first" lines, word for word from `docs/submission/WHAT_BREAKS_FIRST.md`. |
| `RadioClip.tsx` | "Hear Sightline on the radio": one briefing in Sightline's voice (NVIDIA Magpie TTS), served from `public/front/briefing.mp3`. In About and the Debrief. |
