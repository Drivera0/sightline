// "Built with": the technology inside Sightline, each piece with its job in the pipeline, its measured
// numbers and the files that back them. OpenCV 5, NVIDIA and Nebius get the same card, side by side: OpenCV
// sees (the detector on cv2.dnn, the second look's zoom, the map), NVIDIA's open models read, reason,
// listen and speak, and Nebius runs every model call and the batch job. Tavily, a bonus prize, is the row
// under them. Text wordmarks only, no logos. Every number here is in docs/report/EVIDENCE_INDEX.md; change
// one only with its source.
import { RadioClip } from "./RadioClip";
import { REPO_URL, REPORT_URL } from "./judges";

const BLOB = `${REPO_URL}/blob/main`;

export interface TechLink {
  label: string;
  href: string;
}

/** One thing a piece of the stack does in Sightline: where, what, and its measured number. */
export interface StackStep {
  step: string;
  title: string;
  body: string;
  calls: string;
  stat: string | null;
}

/** One of the three equal cards: a wordmark, its job, three steps and the files behind them. */
export interface StackCard {
  id: string;
  wordmark: string;
  role: string;
  lead: string;
  steps: readonly StackStep[];
  links: readonly TechLink[];
}

export const OPENCV = {
  id: "built-opencv",
  wordmark: "OpenCV 5",
  role: "Sees",
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
  ] satisfies readonly StackStep[],
  links: [
    { label: "Every OpenCV call", href: `${REPORT_URL}#38-every-opencv-call-sightline-makes` },
    { label: "cv2.dnn on CUDA", href: `${REPORT_URL}#34-cv2dnn-on-cuda` },
    { label: "Second look, scored once", href: `${REPORT_URL}#54-task-effectiveness` },
  ] satisfies readonly TechLink[],
} as const satisfies StackCard;

export const NVIDIA = {
  id: "built-nvidia",
  wordmark: "NVIDIA",
  role: "Reads, reasons, listens, speaks",
  lead: "Every language, vision and speech model in Sightline is an NVIDIA open model: Nemotron reads OpenCV's zooms and reasons, Parakeet hears the radio and Magpie speaks.",
  steps: [
    {
      step: "1 · Read",
      title: "The second look's verdict",
      body: "Nemotron-3.5-Super-VL reads OpenCV's zoom of an unsure box and answers in JSON: person yes, no or unclear, with posture, clothing and how many.",
      calls: "nvidia/Nemotron-3.5-Super-VL",
      stat: "461 of 461 replies valid JSON; 1.35 s per verdict (p50)",
    },
    {
      step: "2 · Reason",
      title: "Briefings and the radio desk",
      body: "Nemotron 3 Nano writes the teams' briefings and reads conditions pages, keeping each value with its sentence. Nemotron 3 Super makes the radio desk's tool calls and answers from the tools' data.",
      calls: "NVIDIA-Nemotron-3-Nano-30B-A3B · nemotron-3-super-120b-a12b",
      stat: "Radio: first sound in 2.5 s (p50), replies spoken by Magpie",
    },
    {
      step: "3 · Listen and speak",
      title: "The radio, by voice",
      body: "Parakeet TDT 0.6B v2 turns a team's radio call into text; Magpie TTS speaks Sightline's replies and the simulated teams' voices. Both run on a GPU through NeMo.",
      calls: "parakeet-tdt-0.6b-v2 · magpie_tts_multilingual_357m",
      stat: "WER 0.025 on 20 radio phrases in one human voice, both coordinates exact",
    },
  ] satisfies readonly StackStep[],
  links: [
    { label: "Radio desk, measured", href: `${BLOB}/docs/feedback/radio.md` },
    { label: "Nemotron VL, measured", href: `${BLOB}/docs/feedback/nebius.md#2-nemotron-35-super-vl-nvidianemotron-35-super-vl` },
    { label: "Parakeet and Magpie", href: `${BLOB}/docs/feedback/nebius.md#7-parakeet-tdt-06b-v2-nvidiaparakeet-tdt-06b-v2-speech-to-text` },
  ] satisfies readonly TechLink[],
} as const satisfies StackCard;

export const NEBIUS = {
  id: "built-nebius",
  wordmark: "Nebius",
  role: "Runs every model call and the batch jobs",
  lead: "Every language and vision model call goes through Nebius Token Factory, from one OpenAI-compatible client with the key on the server only. A Serverless Job ran the detector over the simulated fleet's photos.",
  steps: [
    {
      step: "1 · Serve",
      title: "Token Factory, every Nemotron call",
      body: "Second looks, briefings, conditions and radio turns with tool calls, all through one client on the openai SDK. Each call is written to the mission's Trace.",
      calls: "TokenFactoryClient · api.tokenfactory.nebius.com/v1",
      stat: "Vision verdict p50 1.35 s, p90 1.65 s, over 461 calls",
    },
    {
      step: "2 · Batch",
      title: "A Serverless Job over the fleet's photos",
      body: "The detector on OpenCV 5 cv2.dnn, CPU only, in one container image, over the creek scenario's 711 photos: the same boxes as the same image run locally.",
      calls: "nebius ai job create · cpu-d3 · 16vcpu-64gb",
      stat: "711 photos in 483 s on 16 vCPUs, about $0.10",
    },
    {
      step: "3 · Fail fast",
      title: "When Token Factory is down",
      body: "After 4 failed attempts in a row a circuit breaker opens and the next calls fail fast, each fallback noted in the Trace. The agent still never moves anything without a person.",
      calls: "CircuitOpen · 20 s per attempt",
      stat: "Fully down: about 82 s per mission in all, not minutes per call",
    },
  ] satisfies readonly StackStep[],
  links: [
    { label: "Nebius, tool by tool", href: `${BLOB}/docs/feedback/nebius.md` },
    { label: "Token Factory down, measured", href: `${BLOB}/docs/report/AGENT_EVAL.md#failure-handling-injected` },
    { label: "The client: llm.py", href: `${BLOB}/sightline/agent/llm.py` },
  ] satisfies readonly TechLink[],
} as const satisfies StackCard;

/** The three equal cards, in pipeline order: see, reason, run. */
export const STACK: readonly StackCard[] = [OPENCV, NVIDIA, NEBIUS];

/** Tavily, the Nebius bonus prize: the row under the three. */
export const TAVILY = {
  id: "built-tavily",
  wordmark: "Tavily",
  role: "Reads the web for the search",
  body: "Live forecasts, warnings and trail alerts for the area, and the missing person's profile from a public bulletin. A value is kept only with the sentence it came from, quoted word for word.",
  stat: "Conditions: at most 4 Tavily calls per area per hour",
  link: { label: "Conditions and profile", href: `${BLOB}/docs/report/TAVILY.md` } satisfies TechLink,
} as const;

export const BUILT_WITH = {
  title: "Built with",
  lead: "OpenCV 5 sees, NVIDIA's open models read, reason, listen and speak, and Nebius runs every model call. Each with its steps, measured numbers and the files behind them.",
  physical: "Physical AI: drones sense, the map decides where to look next, and drones and teams act, each move approved by a person. The fleet is simulated, flying over real aerial photos.",
} as const;

const linkCls = "text-small text-text-2 underline underline-offset-2 hover:text-text";

/** A text wordmark, styled as a badge (no logos). */
function Wordmark({ children }: { children: string }) {
  return <span className="inline-flex items-center self-start rounded-md border border-line bg-bg px-2.5 py-0.5 text-[24px] font-semibold leading-[32px] tracking-[-0.02em] text-text">{children}</span>;
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

function Card({ c }: { c: StackCard }) {
  return (
    <article aria-labelledby={c.id} className="flex min-w-0 flex-col gap-4 rounded-lg border border-line bg-surface-solid p-5">
      <header className="flex flex-col gap-2">
        <Wordmark>{c.wordmark}</Wordmark>
        <h3 id={c.id} className="text-title font-medium text-text">
          {c.role}
        </h3>
        <p className="text-small text-text-2">{c.lead}</p>
      </header>
      <ol className="flex flex-col gap-px overflow-hidden rounded-md border border-line bg-line">
        {c.steps.map((s) => (
          <li key={s.step} className="flex flex-col gap-1.5 bg-surface-solid p-4">
            <span className="text-label font-medium text-text-3">{s.step}</span>
            <span className="text-small font-medium text-text">{s.title}</span>
            <span className="text-small text-text-2">{s.body}</span>
            <code className="break-words font-mono text-caption text-text-3">{s.calls}</code>
            {s.stat && <span className="border-t border-line pt-2 text-small font-medium text-text">{s.stat}</span>}
          </li>
        ))}
      </ol>
      {c.id === NVIDIA.id && <RadioClip />}
      <p className="mt-auto flex flex-wrap gap-x-5 gap-y-1">
        {c.links.map((l) => (
          <Out key={l.label} l={l} />
        ))}
      </p>
    </article>
  );
}

function TavilyRow() {
  return (
    <article aria-labelledby={TAVILY.id} className="flex flex-col gap-3 rounded-lg border border-line bg-surface-solid p-5 md:flex-row md:items-center md:gap-6">
      <div className="flex shrink-0 flex-col gap-1 md:w-56">
        <span className="inline-flex items-center self-start rounded-md border border-line bg-bg px-2 py-0.5 text-title font-semibold tracking-[-0.02em] text-text">{TAVILY.wordmark}</span>
        <h3 id={TAVILY.id} className="text-small font-medium text-text">
          {TAVILY.role}
        </h3>
      </div>
      <p className="min-w-0 flex-1 text-small text-text-2">{TAVILY.body}</p>
      <div className="flex shrink-0 flex-col gap-1 md:w-64">
        <span className="text-small font-medium text-text">{TAVILY.stat}</span>
        <Out l={TAVILY.link} />
      </div>
    </article>
  );
}

/** The section's body (its heading is the Reveal's, in Home.tsx). */
export function BuiltWith() {
  return (
    <div className="flex flex-col gap-4">
      <p className="-mt-1 max-w-[70ch] text-body text-text-2">{BUILT_WITH.lead}</p>
      <div className="grid gap-4 lg:grid-cols-3">
        {STACK.map((c) => (
          <Card key={c.id} c={c} />
        ))}
      </div>
      <TavilyRow />
      <p className="max-w-[80ch] text-small text-text-2">{BUILT_WITH.physical}</p>
    </div>
  );
}
