// About Sightline: a sheet over whatever is on screen (#about), opened from the wordmark and the `?` menu.
// Only what the home page does not say: who built it and for which competitions, what the colours in the
// console mean, the models, what is simulated and the limits, the licences, and where to ask. The
// pitch, the photographs, how it works and the guided simulation are on the home page (#).

import { DISCLOSURE, DISCLOSURE_TITLE, Label } from "../shell/components";
import { Sheet } from "../shell/Sheet";
import { Icon } from "../shell/icons";
import { FOOTER, INTAKE, PRINCIPLES } from "./copy";
import { LICENCE_URL, SAMPLE_PHOTOS_URL } from "./Home";
import { JUDGES, REPO_URL, REPORT_URL } from "./judges";
import { CREDITS_URL, PHOTO_CREDIT } from "./photos";
import { RadioClip } from "./RadioClip";

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

const BLOB = `${REPO_URL}/blob/main`;

/** The two competition entries, each with its Devpost text in the repo. */
export const ENTRIES: readonly { name: string; href: string }[] = [
  { name: "OpenCV AI Competition 2026", href: `${BLOB}/docs/submission/DEVPOST_OPENCV.md` },
  { name: "Nebius × NVIDIA Global AI Hackathon, Physical AI track", href: `${BLOB}/docs/submission/DEVPOST_NEBIUS.md` },
];

/** Who may use what. */
export const LICENCES: readonly { what: string; licence: string }[] = [
  { what: "Sightline's code", licence: "GNU AGPL-3.0" },
  { what: "Drone photos (HERIDAL, Božić-Štulić, Marušić & Gotovac, 2019)", licence: "CC BY 3.0" },
  { what: "Photographs of the Eagle Peak search (NPS / Jacob W. Frank)", licence: "Public domain" },
  { what: "Basemap", licence: "© OpenStreetMap contributors (ODbL)" },
];

const LIMITS = PRINCIPLES.find((p) => p.title.startsWith("Honest"))!.body;
const NEVER = PRINCIPLES[0].body;
const link = "text-text-2 underline underline-offset-2 hover:text-text";

export function AboutSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet label="About Sightline" onClose={onClose} width="max-w-3xl">
      <article className="flex flex-col gap-8 px-5 pb-10 pt-6 lg:px-8">
        <header className="flex flex-col gap-3">
          <Label>About</Label>
          <h1 className="text-headline font-medium tracking-[-0.01em] text-text">Sightline</h1>
          <p className="text-body text-text-2">{JUDGES.logline}</p>
        </header>

        <section aria-labelledby="about-who" className="flex flex-col gap-2">
          <h2 id="about-who" className="text-title font-medium text-text">
            Who built it
          </h2>
          <p className="text-body text-text-2">
            Daniel Rivera. {JUDGES.built} (
            <a className={link} href={JUDGES.changedUrl} target="_blank" rel="noreferrer">
              what changed since
            </a>
            ). Entered in:
          </p>
          <ul className="flex flex-col gap-1 text-small">
            {ENTRIES.map((e) => (
              <li key={e.name}>
                <a className={link} href={e.href} target="_blank" rel="noreferrer">
                  {e.name}
                </a>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="about-intake" className="flex flex-col gap-2">
          <h2 id="about-intake" className="text-title font-medium text-text">
            How photos get in
          </h2>
          <ul aria-labelledby="about-intake" className="flex flex-col gap-1.5 text-small text-text-2">
            {INTAKE.map((p) => (
              <li key={p.title} className="flex items-start gap-2">
                <Icon name={p.icon} size={14} className="mt-[3px] shrink-0 text-text-3" />
                {p.short}
              </li>
            ))}
          </ul>
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

        <section aria-labelledby="about-licences" className="flex flex-col gap-2">
          <h2 id="about-licences" className="text-title font-medium text-text">
            Licences
          </h2>
          <dl className="grid gap-x-6 gap-y-1.5 text-small sm:grid-cols-[1fr_auto]">
            {LICENCES.map((l) => (
              <div key={l.what} className="contents">
                <dt className="text-text-2">{l.what}</dt>
                <dd className="text-text">{l.licence}</dd>
              </div>
            ))}
          </dl>
        </section>

        <footer className="flex flex-col gap-3 border-t border-line pt-5 text-small text-text-3">
          <p className="flex flex-wrap gap-x-5 gap-y-1">
            <a className={link} href="#">
              Home page
            </a>
            <a className={link} href={REPORT_URL} target="_blank" rel="noreferrer">
              The report
            </a>
            <a className={link} href={FOOTER.codeUrl} target="_blank" rel="noreferrer">
              {FOOTER.code}
            </a>
            <a className={link} href={`${REPO_URL}/issues`} target="_blank" rel="noreferrer">
              Questions and issues
            </a>
            <a className={link} href={LICENCE_URL} target="_blank" rel="noreferrer">
              Licence
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
