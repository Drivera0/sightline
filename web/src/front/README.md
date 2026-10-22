# web/src/front: the words about Sightline

There is no front door any more: the landing is the console on the demo mission (`web/src/shell/README.md`).
This folder keeps the words and the pieces that tell people what Sightline is.

| File | What |
|---|---|
| `copy.ts` | LANE_E §6.2's words: the tagline (it heads the landing's pitch bar), how it works, who it's for, the principles, what's next, the credits, the radio clip. |
| `About.tsx` | The About sheet (`#about`, from the wordmark): the words above, the radio clip, the report and the code. |
| `judges.ts` | "Where to look, in order" (a fold of the Debrief; `#judges` opens it), what is simulated and what is real, and the three "what breaks first" lines, word for word from `docs/submission/WHAT_BREAKS_FIRST.md`. |
| `RadioClip.tsx` | "Hear Sightline on the radio": one briefing in Sightline's voice (NVIDIA Magpie TTS), served from `public/front/briefing.mp3`. In About and the Debrief. |

The old front door's console screenshot (`public/front/console.webp`) is gone: the console itself is the
first screen.
