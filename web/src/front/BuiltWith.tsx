// "Built with": the technology inside Sightline, each piece with its job in the pipeline, one measured
// number and the file that backs it. OpenCV first and largest: it finds the people (the detector on
// OpenCV 5 cv2.dnn, CPU and CUDA), gives the second look its zoom, and lays each photo on the map. Then
// NVIDIA's models, Nebius (where they run) and Tavily. Text wordmarks only, no logos. Every number here is
// in docs/report/EVIDENCE_INDEX.md; change one only with its source.
import { RadioClip } from "./RadioClip";
import { REPO_URL, REPORT_URL } from "./judges";

const BLOB = `${REPO_URL}/blob/main`;

export interface TechLink {
  label: string;
  href: string;
}

/** One thing OpenCV does in Sightline: where, what, and its measured number. */
export interface OpenCvStep {
  step: string;
  title: string;
  body: string;
  calls: string;
  stat: string | null;
}

export const OPENCV = {
  wordmark: "OpenCV 5",
  role: "Finds the people",
  lead: "Every photo goes through OpenCV 5 first. The detector runs on cv2.dnn alone, with no PyTorch at run time, and gives the same boxes on a CPU, a cloud server or a GPU.",
  steps: [
    {
      step: "1 · Detect",
      title: "The detector, on cv2.dnn",
      body: "YOLO11s trained on HERIDAL, exported to ONNX and run by OpenCV: each 4000 × 3000 photo read as 20 slices of 1024 px, merged with cv2.dnn.NMSBoxes.",
      calls: "readNetFromONNX · blobFromImage · NMSBoxes · DNN_BACKEND_CUDA",
      stat: "0.30 s per photo on CUDA, 1.97 s on CPU, 363 of 363 boxes identical",
    },
    {
      step: "2 · Look again",
      title: "The second look's zoom",
      body: "When the detector is unsure, OpenCV cuts the box from the original photo's native pixels, lifts contrast with CLAHE and runs the detector again on the spot. Nemotron VL then reads what OpenCV made.",
      calls: "resize INTER_CUBIC · createCLAHE · GaussianBlur · rectangle",
      stat: "recall 0.864 → 0.875 on test: 4 more of 337 people",
    },
    {
      step: "3 · Map",
      title: "Each photo on the map",
      body: "cv2.fillPoly lays each photo's footprint on the map and cv2.blur tells tree cover from open ground, so a photo over trees counts for less than one over open ground.",
      calls: "fillPoly · blur",
      stat: null,
    },
  ] satisfies readonly OpenCvStep[],
  links: [
    { label: "Every OpenCV call", href: `${REPORT_URL}#38-every-opencv-call-sightline-makes` },
    { label: "cv2.dnn on CUDA", href: `${REPORT_URL}#34-cv2dnn-on-cuda` },
    { label: "Second look, scored once", href: `${REPORT_URL}#54-task-effectiveness` },
  ] satisfies readonly TechLink[],
} as const;

/** The other three: what each does, its models, one measured number, its source. */
export interface Partner {
  wordmark: string;
  role: string;
  body: string;
  /** The models or services, by job. */
  parts: readonly { name: string; job: string }[];
  stat: string;
  link: TechLink;
}

export const PARTNERS: readonly Partner[] = [
  {
    wordmark: "NVIDIA",
    role: "Reads, writes and speaks",
    body: "Every language, vision and speech model is an NVIDIA open model.",
    parts: [
      { name: "Nemotron-3.5-Super-VL", job: "the second look's verdict" },
      { name: "Nemotron 3 Nano", job: "briefings, conditions, the debrief" },
      { name: "Nemotron 3 Super", job: "the radio desk's tool calls" },
      { name: "Parakeet TDT 0.6B v2", job: "radio speech to text" },
      { name: "Magpie TTS", job: "Sightline's voice on the radio" },
    ],
    stat: "Radio: first sound in 2.5 s (p50), replies spoken by Magpie",
    link: { label: "Radio desk, measured", href: `${BLOB}/docs/feedback/radio.md` },
  },
  {
    wordmark: "Nebius",
    role: "Runs the models",
    body: "Every language and vision model call goes through Nebius Token Factory, the key on the server only. A Serverless Job ran the detector over the simulated fleet's photos.",
    parts: [
      { name: "Token Factory", job: "every Nemotron call" },
      { name: "Serverless Job", job: "batch detection on cv2.dnn" },
    ],
    stat: "711 photos in 483 s on 16 vCPUs, about $0.10",
    link: { label: "Nebius, tool by tool", href: `${BLOB}/docs/feedback/nebius.md` },
  },
  {
    wordmark: "Tavily",
    role: "Reads the web for the search",
    body: "Live forecasts, warnings and trail alerts for the area, and the missing person's profile from a public bulletin. A value is kept only with the sentence it came from, quoted word for word.",
    parts: [
      { name: "Search and extract", job: "conditions and the subject's profile" },
    ],
    stat: "Conditions: at most 4 Tavily calls per area per hour",
    link: { label: "Conditions and profile", href: `${BLOB}/docs/report/TAVILY.md` },
  },
];

export const BUILT_WITH = {
  title: "Built with",
  lead: "OpenCV finds the people; NVIDIA's models read, write and speak; Nebius runs them; Tavily reads the web. Each with its job, a measured number and the file behind it.",
} as const;

const linkCls = "text-small text-text-2 underline underline-offset-2 hover:text-text";

/** A text wordmark, styled as a badge (no logos). */
function Wordmark({ children, big = false }: { children: string; big?: boolean }) {
  return (
    <span
      className={`inline-flex items-center self-start rounded-md border border-line bg-bg font-semibold tracking-[-0.02em] text-text ${big ? "px-3 py-1 text-[28px] leading-[36px] sm:text-[36px] sm:leading-[44px]" : "px-2 py-0.5 text-title"}`}
    >
      {children}
    </span>
  );
}

function Out({ l }: { l: TechLink }) {
  return (
    <a className={linkCls} href={l.href} target="_blank" rel="noreferrer">
      {l.label}
      <span aria-hidden className="text-text-3">
        {" "}
        ↗
      </span>
    </a>
  );
}

function OpenCvCard() {
  return (
    <article aria-labelledby="built-opencv" className="flex flex-col gap-6 rounded-lg border border-line bg-surface-solid p-5 sm:p-7">
      <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between md:gap-8">
        <div className="flex flex-col gap-3">
          <Wordmark big>{OPENCV.wordmark}</Wordmark>
          <h3 id="built-opencv" className="text-headline font-medium tracking-[-0.01em] text-text">
            {OPENCV.role}
          </h3>
        </div>
        <p className="max-w-[60ch] text-body text-text-2">{OPENCV.lead}</p>
      </header>
      <ol className="grid gap-px overflow-hidden rounded-md border border-line bg-line md:grid-cols-3">
        {OPENCV.steps.map((s) => (
          <li key={s.step} className="flex flex-col gap-2 bg-surface-solid p-4">
            <span className="text-label font-medium text-text-3">{s.step}</span>
            <span className="text-title font-medium text-text">{s.title}</span>
            <span className="text-small text-text-2">{s.body}</span>
            <code className="font-mono text-caption text-text-3">{s.calls}</code>
            {s.stat && <span className="mt-auto border-t border-line pt-3 text-small font-medium text-text">{s.stat}</span>}
          </li>
        ))}
      </ol>
      <p className="flex flex-wrap gap-x-5 gap-y-1">
        {OPENCV.links.map((l) => (
          <Out key={l.label} l={l} />
        ))}
      </p>
    </article>
  );
}

function PartnerCard({ p }: { p: Partner }) {
  const id = `built-${p.wordmark.toLowerCase()}`;
  return (
    <article aria-labelledby={id} className="flex flex-col gap-3 rounded-lg border border-line bg-surface-solid p-5">
      <Wordmark>{p.wordmark}</Wordmark>
      <h3 id={id} className="text-title font-medium text-text">
        {p.role}
      </h3>
      <p className="text-small text-text-2">{p.body}</p>
      <dl className="flex flex-col gap-1 text-small">
        {p.parts.map((x) => (
          <div key={x.name} className="flex flex-wrap gap-x-2">
            <dt className="font-medium text-text">{x.name}</dt>
            <dd className="text-text-2">{x.job}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-auto border-t border-line pt-3 text-small font-medium text-text">{p.stat}</p>
      {p.wordmark === "NVIDIA" && <RadioClip />}
      <Out l={p.link} />
    </article>
  );
}

/** The section's body (its heading is the Reveal's, in Home.tsx). */
export function BuiltWith() {
  return (
    <div className="flex flex-col gap-4">
      <p className="-mt-1 max-w-[70ch] text-body text-text-2">{BUILT_WITH.lead}</p>
      <OpenCvCard />
      <div className="grid gap-4 md:grid-cols-3">
        {PARTNERS.map((p) => (
          <PartnerCard key={p.wordmark} p={p} />
        ))}
      </div>
    </div>
  );
}
