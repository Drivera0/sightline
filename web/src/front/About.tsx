// About Sightline: a sheet over whatever is on screen (#about), opened from the wordmark and the `?` menu.
// What it is, the four photographs, how it works in four steps, how it fits together, what the colours
// mean, the models, the disclosure and the limits, and the links.

import { DISCLOSURE, DISCLOSURE_TITLE, Label } from "../shell/components";
import { Sheet } from "../shell/Sheet";
import { Architecture } from "./Architecture";
import { FOOTER, HERO, PRINCIPLES } from "./copy";
import { HOME, PhotoRow, SAMPLE_PHOTOS_URL } from "./Home";
import { REPORT_URL } from "./judges";
import { CREDITS_URL, PHOTO_CREDIT } from "./photos";
import { RadioClip } from "./RadioClip";
import { Steps } from "./Steps";

/** The models, by job (README "Models"). */
export const MODELS: readonly { job: string; model: string }[] = [
  { job: "Finds people in drone photos", model: "YOLO11s, trained on HERIDAL, run by OpenCV 5 cv2.dnn (ONNX Runtime Web for Try a photo)" },
  { job: "Second look at uncertain finds", model: "OpenCV 5 re-look tools, then Nemotron-3.5-Super-VL" },
  { job: "Briefings, conditions and the debrief", model: "Nemotron 3 Nano" },
  { job: "The radio desk", model: "Parakeet TDT 0.6B v2 (speech to text), Nemotron 3 Super (tools), Magpie TTS (voice)" },
];

/** One swatch per kind of thing: the same colour on the map, the cards, the timeline and the chips. */
export const COLOURS: readonly { token: string; label: string }[] = [
  { token: "--team", label: "Ground teams" },
  { token: "--drone", label: "Drones" },
  { token: "--clue", label: "Clues" },
  { token: "--proposal", label: "The agent's proposals" },
  { token: "--found", label: "The find" },
  { token: "--alert", label: "Alerts, overdue" },
  { token: "--searched", label: "Searched ground" },
];

const LIMITS = PRINCIPLES.find((p) => p.title.startsWith("Honest"))!.body;
const NEVER = PRINCIPLES[0].body;
const link = "text-text-2 underline underline-offset-2 hover:text-text";

export function AboutSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet label="About Sightline" onClose={onClose} width="max-w-4xl">
      <article className="flex flex-col gap-8 px-5 pb-10 pt-6 lg:px-8">
        <header className="flex flex-col gap-3">
          <Label>{HERO.eyebrow}</Label>
          <h1 className="text-headline font-medium tracking-[-0.01em] text-text">{HERO.tagline}</h1>
          <p className="text-body text-text-2">{HOME.line2}</p>
        </header>

        <PhotoRow />

        <section aria-labelledby="about-how" className="flex flex-col gap-3">
          <h2 id="about-how" className="text-title font-medium text-text">
            How it works
          </h2>
          <Steps />
        </section>

        <section aria-labelledby="about-fits" className="flex flex-col gap-3">
          <h2 id="about-fits" className="text-title font-medium text-text">
            {HOME.how}
          </h2>
          <Architecture />
        </section>

        <section aria-labelledby="about-colours" className="flex flex-col gap-3">
          <h2 id="about-colours" className="text-title font-medium text-text">
            What the colours mean
          </h2>
          <ul className="flex flex-wrap gap-x-5 gap-y-2 text-small text-text-2">
            {COLOURS.map((c) => (
              <li key={c.token} className="flex items-center gap-2">
                <span aria-hidden className="size-3 rounded-full border border-line" style={{ background: `var(${c.token})` }} />
                {c.label}
              </li>
            ))}
            <li className="flex items-center gap-2">
              <span aria-hidden className="h-3 w-12 rounded-full" style={{ background: "linear-gradient(to right, var(--prob-1), var(--prob-2), var(--prob-3), var(--prob-4), var(--prob-5))" }} />
              Probability, low to high
            </li>
          </ul>
          <p className="text-caption text-text-3">Orange is kept for the one thing to do next and the story.</p>
        </section>

        <section aria-labelledby="about-models" className="flex flex-col gap-3">
          <h2 id="about-models" className="text-title font-medium text-text">
            The models
          </h2>
          <dl className="grid gap-x-6 gap-y-2 text-small sm:grid-cols-[minmax(0,14rem)_1fr]">
            {MODELS.map((m) => (
              <div key={m.job} className="contents">
                <dt className="text-text-2">{m.job}</dt>
                <dd className="text-text">{m.model}</dd>
              </div>
            ))}
          </dl>
          <RadioClip />
        </section>

        <section aria-labelledby="about-limits" className="flex flex-col gap-2">
          <h2 id="about-limits" className="text-title font-medium text-text">
            What is simulated, and the limits
          </h2>
          <p className="text-body text-text-2">
            <span className="text-text">{DISCLOSURE}.</span> {DISCLOSURE_TITLE}
          </p>
          <p className="text-body text-text-2">
            {NEVER} {LIMITS}
          </p>
        </section>

        <footer className="flex flex-col gap-3 border-t border-line pt-5 text-small text-text-3">
          <p className="flex flex-wrap gap-x-5 gap-y-1">
            <a className={link} href="#">
              Home: choose a search
            </a>
            <a className={link} href={REPORT_URL} target="_blank" rel="noreferrer">
              The report
            </a>
            <a className={link} href={FOOTER.codeUrl} target="_blank" rel="noreferrer">
              {FOOTER.code}
            </a>
            <a className={link} href={SAMPLE_PHOTOS_URL} download>
              Sample drone photos (.zip)
            </a>
            <a className={link} href={CREDITS_URL} target="_blank" rel="noreferrer">
              Photo credits
            </a>
          </p>
          <p>{FOOTER.data}</p>
          <p>{PHOTO_CREDIT}</p>
        </footer>
      </article>
    </Sheet>
  );
}
