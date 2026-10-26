// LANE_D §6 test 9 (ingest) and test 8 (review in live mode), plus the live routes.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Detections, MapFile, Verdict } from "../contract";
import { App } from "../App";
import { useGuide, useStory } from "../command/story";
import { diskFetch } from "../lib/diskFetch";
import { LiveReview, liveReviewItems, relookName, verdictWords } from "../review/LiveReview";
import { RUN_MAX_MS, SECOND_LOOK_LABEL, useSecondLook } from "../review/SecondLook";
import { EMPTY, useMission } from "../lib/mission";
import type { Route } from "../shell/flow";
import { useConsole } from "../command/consoleStore";
import { LiveMission } from "./LiveMission";
import { NewSearch } from "./NewSearch";
import { batches, hostLabel, photoFiles, uploadCommand } from "./upload";
import { UploadPanel, WatchPanel } from "./UploadPanel";
import { BANNED } from "../command/terms";

// MapLibre needs WebGL, which jsdom lacks; the real pick was checked in Chromium.
vi.mock("./LkpPicker", () => ({ LkpPicker: () => <div aria-label="Pick the last known position on the map" /> }));
vi.mock("../map/heat/LiveHeatMap", () => ({ LiveHeatMap: () => <figure aria-label="Live map" /> }));

const API = { base: "http://api.test" };
const jpeg = (name: string) => new File(["x"], name, { type: "image/jpeg" });

describe("New search: the console's empty state", () => {
  it("on the demo-only site, hands over the demo mission and never shows a developer message", async () => {
    window.history.replaceState(null, "", "#new");
    render(<App base={null} />);
    const sheet = screen.getByRole("region", { name: "Start a search" });
    expect(within(sheet).getByRole("heading", { level: 1 })).toHaveTextContent("Drop photos or watch a folder");
    expect(sheet).toHaveTextContent("The live mission server runs during demos and judging");
    expect(sheet).not.toHaveTextContent("VITE_API_URL");
    expect(within(sheet).getByRole("link", { name: "Load the demo mission" })).toHaveAttribute("href", "#m/demo/map");
    expect(within(sheet).getByLabelText("Latitude")).toBeDisabled();
    // the same app bar: the wordmark goes home
    expect(within(screen.getAllByRole("banner")[0]!).getByRole("link", { name: "Sightline" })).toHaveAttribute("href", "#");
    expect(await screen.findByLabelText("Pick the last known position on the map")).toBeInTheDocument(); // the empty map
  });
});

describe("New search", () => {
  it("creates the mission from the details and hands back its id", async () => {
    const createMission = vi.fn(async () => ({ mission_id: "a1b2c3d4" }) as never);
    const onCreated = vi.fn();
    render(<NewSearch api={API} onCreated={onCreated} createMission={createMission} />);
    await userEvent.click(screen.getByRole("button", { name: "Start the search" }));
    expect(screen.getByRole("alert")).toHaveTextContent("name");
    await userEvent.type(screen.getByPlaceholderText("Seymour — missing hiker"), "Seymour");
    await userEvent.type(screen.getByLabelText("Latitude"), "49.3745");
    await userEvent.type(screen.getByLabelText("Longitude"), "-122.9358");
    await userEvent.click(screen.getByRole("button", { name: "Start the search" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("a1b2c3d4"));
    expect(createMission).toHaveBeenCalledWith(API, expect.objectContaining({ name: "Seymour", lkp: { lat: 49.3745, lon: -122.9358 }, mode: "live" }));
  });
});

describe("upload (test 9)", () => {
  it("keeps JPEGs in name order and sends them in batches of 10", () => {
    const { photos, skipped } = photoFiles([jpeg("DJI_0010.JPG"), jpeg("DJI_0002.JPG"), new File(["x"], "notes.txt")]);
    expect(photos.map((f) => f.name)).toEqual(["DJI_0002.JPG", "DJI_0010.JPG"]);
    expect(skipped).toEqual([{ name: "notes.txt", reason: "not a JPEG" }]);
    expect(batches(Array.from({ length: 23 }, (_, i) => i)).map((b) => b.length)).toEqual([10, 10, 3]);
  });

  it("lists the files the API refused, with its reason", async () => {
    const upload = vi.fn(async (_a: unknown, _m: string, files: readonly File[]) => ({
      accepted: files.filter((f) => f.name !== "phone.jpg").map((_, i) => `f${String(i + 1).padStart(4, "0")}`),
      rejected: files.filter((f) => f.name === "phone.jpg").map((f) => ({ name: f.name, reason: "no GPS position in the photo's EXIF" })),
    }));
    render(<UploadPanel api={API} missionId="a1b2c3d4" upload={upload} />);
    const files = [...Array.from({ length: 11 }, (_, i) => jpeg(`DJI_${String(i).padStart(4, "0")}.JPG`)), jpeg("phone.jpg")];
    await userEvent.upload(screen.getByLabelText("Choose photos"), files);
    await waitFor(() => expect(screen.getByText(/12 \/ 12 sent · 11 accepted/)).toBeInTheDocument());
    expect(upload).toHaveBeenCalledTimes(2); // 10 + 2
    expect(screen.getByLabelText("Rejected files")).toHaveTextContent("phone.jpg: no GPS position");
  });

  it("shows the detector's progress after the upload's", async () => {
    const upload = vi.fn(async (_a: unknown, _m: string, files: readonly File[]) => ({ accepted: files.map((f) => f.name), rejected: [] }));
    render(<UploadPanel api={API} missionId="a1b2c3d4" upload={upload} processed={1} />);
    await userEvent.upload(screen.getByLabelText("Choose photos"), [jpeg("DJI_0001.JPG"), jpeg("DJI_0002.JPG")]);
    await waitFor(() => expect(screen.getByText("1 / 2 ranked by the detector…")).toBeInTheDocument());
    expect(screen.getByLabelText("Detector progress")).toHaveAttribute("value", "1");
    expect(screen.getByLabelText("Upload progress")).toHaveAttribute("max", "2");
  });

  it("names the host in prose, never the bare origin, and copies the exact command", async () => {
    expect(hostLabel("http://127.0.0.1:35587")).toBe("127.0.0.1");
    expect(hostLabel("https://api.example.org")).toBe("api.example.org");
    expect(hostLabel("", "sightline.example")).toBe("sightline.example");
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<WatchPanel base="http://127.0.0.1:35587" missionId="a1b2c3d4" />);
    const panel = screen.getByLabelText("During the flight");
    expect(panel).toHaveTextContent("This mission is connected to 127.0.0.1;");
    // the origin appears only inside the command line, never on its own
    expect(within(panel).queryByText("http://127.0.0.1:35587")).toBeNull();
    expect(screen.queryByRole("heading", { name: /127\.0\.0\.1/ })).toBeNull();
    expect(screen.getByLabelText("Watch command")).toHaveTextContent(uploadCommand("http://127.0.0.1:35587", "a1b2c3d4"));
    await userEvent.click(screen.getByRole("button", { name: "Copy the command" }));
    expect(writeText).toHaveBeenCalledWith(
      "uv run python -m sightline.client watch PHOTO_FOLDER --api http://127.0.0.1:35587 --mission a1b2c3d4",
    );
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("puts the mission id in the command for the laptop", () => {
    expect(uploadCommand("https://api.example.org", "a1b2c3d4")).toBe(
      "uv run python -m sightline.client watch PHOTO_FOLDER --api https://api.example.org --mission a1b2c3d4",
    );
  });
});

const dets: Detections = {
  contract_version: "1.2", model: "m", save_threshold: 0.05, candidate_threshold: 0.29,
  frames: {
    f0001: [
      { id: "f0001-d01", box_px: [1, 1, 9, 9], conf: 0.8, crop: "crops/f0001-d01.jpg", lat: 0, lon: 0, radius_m: 10 },
      { id: "f0001-d02", box_px: [1, 1, 9, 9], conf: 0.2, crop: null, lat: 0, lon: 0, radius_m: 10 },
      { id: "f0001-d03", box_px: [1, 1, 9, 9], conf: 0.1, crop: null, lat: 0, lon: 0, radius_m: 10 },
    ],
  },
};
const verdict = (over: Partial<Verdict>): Verdict => ({
  id: "v0001", detection_id: "f0001-d02", tools: ["zoom_native"], relook_crops: [], person: "yes", posture: "lying",
  group_size: 1, clothing: "red jacket", reason: "r", model: "m", ms: 1, at: "2026-10-24T21:40:00Z", ...over,
});

describe("review in live mode (test 8)", () => {
  it("shows candidates and approved promotions, most confident first", () => {
    expect(liveReviewItems(dets, []).map((d) => d.id)).toEqual(["f0001-d01"]);
    expect(liveReviewItems(dets, ["f0001-d02"]).map((d) => d.id)).toEqual(["f0001-d01", "f0001-d02"]);
  });

  it("shows the second look's re-look images on demand (D-Q1)", async () => {
    expect(relookName("relook/f0003-d01-zoom_native.jpg")).toBe("zoom");
    expect(relookName("relook/f0003-d01-enhance_contrast.jpg")).toBe("contrast");
    const v = verdict({ relook_crops: ["relook/f0001-d02-zoom_native.jpg"] });
    useSecondLook.getState().reset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<LiveReview detections={dets} survey={null} verdicts={[v]} promoted={["f0001-d02"]} imageUrl={(r) => `/f/${r}`} onAnswer={vi.fn()} />);
    expect(screen.queryByAltText(/Re-look image/)).toBeNull(); // not loaded until asked for
    // a real button with its two model chips; pressed, it shows its progress, then the result inline
    const card = screen.getByLabelText("Photo to review f0001-d02");
    await userEvent.click(within(card).getByRole("button", { name: SECOND_LOOK_LABEL }));
    expect(within(card).getByLabelText("AI re-check running")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(RUN_MAX_MS));
    expect(within(card).getByLabelText("AI re-check result")).toHaveTextContent("Likely a person");
    expect(screen.getByAltText("Re-look image relook/f0001-d02-zoom_native.jpg")).toHaveAttribute("src", "/f/relook/f0001-d02-zoom_native.jpg");
    // the OpenCV 5 image beside the detector's crop, and what each model said
    expect(within(card).getByText("detector crop")).toBeInTheDocument();
    expect(within(card).getByLabelText("What each model said")).toHaveTextContent("OpenCV 5 · cv2.dnn detector");
    vi.useRealTimers();
  });

  it("always says the second look in words", () => {
    expect(verdictWords(verdict({}))).toBe("AI re-check: likely a person · lying down · red jacket");
    expect(verdictWords(verdict({ person: "unclear" }))).toBe("AI re-check: unclear");
    expect(verdictWords(verdict({ person: "no" }))).toBe("AI re-check: probably not a person");
    expect(verdictWords(undefined)).toBeNull();
  });

  it("sends each answer", async () => {
    useSecondLook.getState().reset();
    const onAnswer = vi.fn();
    render(
      <LiveReview detections={dets} survey={null} verdicts={[verdict({})]} promoted={["f0001-d02"]} imageUrl={(r) => `/f/${r}`} onAnswer={onAnswer} />,
    );
    expect(within(screen.getByLabelText("Photo to review f0001-d02")).getByRole("button", { name: SECOND_LOOK_LABEL })).toBeEnabled();
    expect(screen.getByAltText("Crop of f0001-d02")).toHaveAttribute("src", "/f/crops/nearmiss/f0001-d02.jpg");
    const card = screen.getByLabelText("Photo to review f0001-d02");
    await userEvent.click(within(card).getByRole("button", { name: "The subject" }));
    expect(onAnswer).toHaveBeenCalledWith("f0001-d02", "person");
  });
});

const missionRoute = (id: string, view: Extract<Route, { kind: "mission" }>["view"], open = {}) => ({ kind: "mission" as const, id, view, t: null, open });

describe("a live mission's console", () => {
  // the state request never answers: the views still render, with no mission data yet
  const pending = { base: "http://api.test", fetch: (() => new Promise(() => {})) as unknown as typeof fetch };
  afterEach(() => vi.unstubAllGlobals());

  it("C goes back to the map, 1-5 switch views, but not while typing", async () => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    render(<LiveMission api={pending} missionId="a1b2c3d4" route={missionRoute("a1b2c3d4", "trace")} />);
    const bar = screen.getAllByRole("banner")[0]!;
    const views = within(bar.parentElement as HTMLElement).getAllByRole("navigation", { name: "Mission views" })[0]!;
    expect(within(views).getByRole("button", { name: "Trace" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.keyboard("c");
    expect(within(views).getByRole("button", { name: /Map/ })).toHaveAttribute("aria-pressed", "true");
    expect(window.location.hash).toBe("#m/a1b2c3d4/map");
    await userEvent.keyboard("2");
    expect(within(views).getByRole("button", { name: "Photos" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("During the flight")).toBeInTheDocument(); // the watch command, in the Photos rail
    expect(within(bar).getByRole("link", { name: "New search" })).toHaveAttribute("href", "#new");
  });

  // /health answers (radio on or off); everything else stays pending
  const withHealth = (radio: boolean) => ({
    base: "http://api.test",
    fetch: ((url: string) =>
      String(url).endsWith("/health")
        ? Promise.resolve(new Response(JSON.stringify({ status: "ok", contract_version: "1.2", backend: "cv2", radio })))
        : new Promise(() => {})) as unknown as typeof fetch,
  });

  it("the radio is the timeline's talk bar: #m/<id>/radio opens the console on Radio (D-R3: one step away)", async () => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    useConsole.getState().reset();
    render(<LiveMission api={withHealth(false)} missionId="a1b2c3d4" route={{ ...missionRoute("a1b2c3d4", "map"), open: { radio: true } }} />);
    expect(useConsole.getState().filter).toBe("Radio");
    expect(screen.queryByRole("button", { name: "Open Radio" })).toBeNull();
    for (const nav of screen.getAllByRole("navigation", { name: "Mission views" })) expect(within(nav).queryByRole("button", { name: "Radio" })).toBeNull();
    useConsole.getState().reset();
  });

  it("6 is the radio and 3 is Needs you: the old views' keys still work", async () => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    useConsole.getState().reset();
    render(<LiveMission api={withHealth(true)} missionId="a1b2c3d4" route={missionRoute("a1b2c3d4", "trace")} />);
    await new Promise((r) => setTimeout(r, 20));
    (document.activeElement as HTMLElement | null)?.blur?.();
    await userEvent.keyboard("6");
    expect(useConsole.getState().filter).toBe("Radio");
    expect(window.location.hash).toBe("#m/a1b2c3d4/map");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Message"))); // the talk bar is ready
    (document.activeElement as HTMLElement).blur();
    await userEvent.keyboard("4");
    await userEvent.keyboard("3");
    expect(useConsole.getState().tab).toBe("needs");
    expect(window.location.hash).toBe("#m/a1b2c3d4/map");
    useConsole.getState().reset();
  });

  it("links the mission's own debrief in the Debrief view, and shows the event log in the Trace view", async () => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    render(<LiveMission api={withHealth(true)} missionId="a1b2c3d4" route={missionRoute("a1b2c3d4", "debrief")} />);
    expect(await screen.findByRole("link", { name: "This mission's debrief (markdown)" })).toHaveAttribute("href", "http://api.test/missions/a1b2c3d4/debrief.md");
    await userEvent.keyboard("4");
    await userEvent.click(screen.getByRole("button", { name: "Event log" }));
    expect(screen.getByRole("button", { name: "Event log" })).toHaveAttribute("aria-pressed", "true");
  });
});

/** The demo cache in tests: the repository's sample cache stands in for it (the demo cache isn't in git). */
const demoFetch = () => {
  const disk = diskFetch();
  return async (input: RequestInfo | URL) => {
    const url = String(input);
    const r = await disk(url.replace("/cache/demo/", "/cache/sample/"));
    if (!url.endsWith("/cache/demo/map.json") || !r.ok) return r;
    // the demo fixture's clue and ground updates index the demo map's 200 × 200 grid: the sample's frame
    // steps on that grid, with a flat prior (half outside), as the demo cache has
    const map = (await r.json()) as MapFile;
    const n = DEMO_GRID.rows * DEMO_GRID.cols;
    const demo = { ...map, grid: DEMO_GRID, prior: { p: new Array(n).fill(0.5 / n), outside: 0.5 }, canopy: new Array(n).fill(null) };
    return new Response(JSON.stringify(demo), { headers: { "content-type": "application/json" } });
  };
};
const DEMO_GRID = { origin_nw: { lat: 49.374492, lon: -122.951898 }, cell_m: 5, rows: 200, cols: 200 };
const settle = () => new Promise((r) => setTimeout(r, 30));

describe("the demo mission: the story on the one console", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lands at t0 with the pitch bar and one primary button; Skip to now leaves the console at the end of the timeline", async () => {
    vi.stubGlobal("fetch", demoFetch());
    useMission.setState({ ...EMPTY, status: "idle" });
    useStory.getState().reset();
    window.history.replaceState(null, "", "#m/demo");
    render(<App base={null} />);
    expect(window.location.hash).toBe("#m/demo");
    // the scenario on screen, under the app bar
    expect(screen.getByRole("region", { name: "Scenario" })).toHaveTextContent("Overdue hiker · Mount Seymour");
    const pitch = screen.getByRole("region", { name: "Sightline" });
    expect(within(pitch).getByRole("heading", { level: 1 })).toHaveTextContent("The brain of a drone search.");
    expect(within(pitch).getByRole("button", { name: "Follow the search (3 min)" }).className).toMatch(/bg-accent/);
    await waitFor(() => expect(within(screen.getAllByRole("banner")[0]!).getByText("13:35 PDT")).toBeInTheDocument());
    expect(screen.queryByRole("group", { name: "Mission time" })).toBeNull(); // the scrubber shows only inside the story
    expect(await screen.findByRole("status", { name: "Mission status" }, { timeout: 5000 })).toHaveTextContent("Clues0"); // the call: the car in the lot is where the search starts
    expect(screen.queryByText(/blue water bottle by the creek crossing/)).toBeNull(); // not found yet at 13:35 PDT (20:35 UTC)
    await userEvent.click(within(pitch).getByRole("button", { name: "Skip to now" }));
    expect(screen.queryByRole("region", { name: "Sightline" })).toBeNull();
    expect((await screen.findAllByText(/blue water bottle by the creek crossing/)).length).toBeGreaterThan(0);
    expect(within(screen.getAllByRole("banner")[0]!).getByText("15:00 PDT")).toBeInTheDocument();
    // the end of the recorded timeline keeps its checkpoint: the plain #m/demo/map is free play
    expect(window.location.hash).toBe("#m/demo/map?t=6");
  });

  it("Follow the search opens the guided search on this scenario: the first decision, no coach marks", async () => {
    vi.stubGlobal("fetch", demoFetch());
    useMission.setState({ ...EMPTY, status: "idle" });
    useStory.getState().reset();
    window.history.replaceState(null, "", "#m/demo");
    render(<App base={null} />);
    await settle();
    await userEvent.click(screen.getByRole("button", { name: "Follow the search (3 min)" }));
    await waitFor(() => expect(window.location.hash).toBe("#m/demo?guide=1"));
    expect(await screen.findByRole("dialog", { name: /Your call: Step 1 of \d · Survey/ }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /The story/ })).toBeNull();
    useGuide.getState().stop();
  });

  it("?t=N still lands: the console at that checkpoint's clock, no coach marks, the address on the map view", async () => {
    vi.stubGlobal("fetch", demoFetch());
    useMission.setState({ ...EMPTY, status: "idle" });
    useStory.getState().reset();
    window.history.replaceState(null, "", "#m/demo?t=3");
    render(<App base={null} />);
    await waitFor(() => expect(within(screen.getAllByRole("banner")[0]!).getByText("14:42 PDT")).toBeInTheDocument(), { timeout: 5000 });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("region", { name: "Sightline" })).toBeNull(); // no pitch bar
    await waitFor(() => expect(window.location.hash).toBe("#m/demo/map?t=3"));
  });

  it("tells one story about conditions: the row's verdict is the Conditions panel's", async () => {
    vi.stubGlobal("fetch", demoFetch());
    useMission.setState({ ...EMPTY, status: "idle" });
    useStory.getState().reset();
    window.history.replaceState(null, "", "#m/demo/map?t=4");
    render(<App base={null} />);
    const header = await screen.findByRole("status", { name: "Mission status" }, { timeout: 5000 });
    const row = await waitFor(() => {
      const pill = header.querySelector("button[data-tone]");
      expect(pill).not.toBeNull();
      return pill!;
    });
    await userEvent.keyboard("w"); // W opens the Conditions panel
    const panel = await screen.findByRole("region", { name: "Conditions" });
    const verdict = await waitFor(() => panel.querySelector("[data-tone]")!);
    expect(row).toHaveTextContent(/^Drones can fly/); // 22:00 UTC is 15:00 in Vancouver: daylight, light wind
    expect(verdict.getAttribute("data-tone")).toBe(row.getAttribute("data-tone"));
    expect(verdict).toHaveTextContent(/^Drones can fly/);
    // the real recorded lookup is still there, folded, on its own evening with its own verdict
    expect(within(panel).getByRole("region", { name: "Recorded conditions lookup" })).toHaveTextContent(/Drones grounded/);
  });

  it("keeps the visitor's approval when the clock moves back and forth", async () => {
    vi.stubGlobal("fetch", demoFetch());
    useMission.setState({ ...EMPTY, status: "idle" });
    useStory.getState().reset();
    window.history.replaceState(null, "", "#m/demo/map?t=6"); // the recorded mission (the plain address is free play)
    render(<App base={null} />);
    // at 15:00 the subject is found and the proposal is closed; at 14:42 it still waits for a person
    useStory.getState().seek(3);
    await settle();
    const card = (await screen.findByText("Put this photo in Review photos?")).closest("[aria-label^='Proposal']") as HTMLElement;
    await userEvent.click(within(card).getByRole("button", { name: /Approve/ }));
    const status = () => useMission.getState().proposals.find((p) => p.id === "p001")?.status;
    expect(status()).toBe("approved");
    useStory.getState().seek(2);
    await settle();
    expect(status()).toBe("pending"); // proposed at 14:01 PDT; the visitor approved it at 14:42, not yet at 14:31
    useStory.getState().seek(6);
    await settle();
    expect(status()).toBe("approved");
  });

  it("opens For judges in the debrief from #judges, and Try a photo in the Photos rail from #try", async () => {
    vi.stubGlobal("fetch", demoFetch());
    useStory.getState().reset();
    window.history.replaceState(null, "", "#judges");
    const { unmount } = render(<App base={null} />);
    expect(screen.getAllByRole("button", { name: "Debrief", pressed: true })).toHaveLength(1);
    expect((await screen.findByText("For judges: where to look, in order")).closest("details")).toHaveAttribute("open");
    unmount();
    window.history.replaceState(null, "", "#try");
    render(<App base={null} />);
    expect(screen.getAllByRole("button", { name: "Photos", pressed: true })).toHaveLength(1);
    expect(await screen.findByRole("button", { name: "Hide Try a photo" })).toHaveAttribute("aria-expanded", "true");
  });

  it("sends the console's #about links to the home page's About section", async () => {
    vi.stubGlobal("fetch", demoFetch());
    useStory.getState().reset();
    window.history.replaceState(null, "", "#m/demo/map");
    render(<App base={null} />);
    expect(await screen.findByLabelText("Command view")).toBeInTheDocument();
    window.location.hash = "#about";
    const about = await screen.findByRole("region", { name: "About" });
    expect(about).toHaveTextContent("Who built it");
    expect(window.location.hash).toBe("#about"); // the console does not rewrite the address
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the guided search (#m/demo?guide=1): the manager makes each decision", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useGuide.getState().stop();
  });

  /** The next decision: Skip ahead (→) through the time-lapse until its bar asks. */
  async function nextCall(name: RegExp): Promise<HTMLElement> {
    for (let k = 0; k < 40; k++) {
      const d = screen.queryByRole("dialog", { name });
      if (d) return d;
      if (screen.queryByRole("dialog", { name: /Watch this/ })) await userEvent.keyboard("{ArrowRight}");
      await new Promise((r) => setTimeout(r, 250));
    }
    return screen.findByRole("dialog", { name }, { timeout: 3000 });
  }

  it("a new run never opens at the last one's end: Start on a home card after the end screen opens at the call", async () => {
    vi.stubGlobal("fetch", demoFetch());
    useMission.setState({ ...EMPTY, status: "idle" });
    useStory.getState().reset();
    window.history.replaceState(null, "", "#m/demo?s=overdue-hiker&guide=1");
    render(<App base={null} />);
    await screen.findByRole("dialog", { name: /Your call: Step 1 of \d · Survey/ }, { timeout: 5000 });
    // a run that has ended, with an action of the visitor's on the console
    await userEvent.keyboard("a");
    act(() => useGuide.getState().end());
    await screen.findByRole("dialog", { name: "What you did" }, { timeout: 5000 });
    // Try another scenario (the home page), then Start on the same scenario's card
    act(() => {
      window.location.hash = "#";
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "What you did" })).toBeNull());
    act(() => {
      window.location.hash = "#m/demo?s=overdue-hiker&guide=1";
    });
    await screen.findByRole("dialog", { name: /Your call: Step 1 of \d · Survey/ }, { timeout: 5000 });
    expect(screen.queryByRole("dialog", { name: "What you did" })).toBeNull();
    expect(useGuide.getState().guide).toMatchObject({ ended: false, choices: [] });
    expect(useStory.getState().user).toEqual([]);
  }, 30_000);

  it("waits at each decision with the clock paused, takes it from the keyboard, and ends with what you did", async () => {
    vi.stubGlobal("fetch", demoFetch());
    useMission.setState({ ...EMPTY, status: "idle" });
    useStory.getState().reset();
    window.history.replaceState(null, "", "#m/demo?guide=1");
    render(<App base={null} />);
    // no pitch bar, no story marks, no scrubber: the first decision at the call
    const survey = await screen.findByRole("dialog", { name: /Your call: Step 1 of \d · Survey/ }, { timeout: 5000 });
    expect(screen.queryByRole("region", { name: "Sightline" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Mission time" })).toBeNull();
    expect(screen.getByText("Mission clock paused")).toBeInTheDocument();
    expect(window.location.hash).toBe("#m/demo?guide=1");
    // the gate: time passes, the clock does not
    const clockText = () => within(screen.getByRole("group", { name: "Decisions" })).getByText(/^\d\d:\d\d$/).textContent;
    const before = clockText();
    await new Promise((r) => setTimeout(r, 400));
    expect(clockText()).toBe(before);
    expect(survey).toHaveTextContent("+12 min");
    await userEvent.keyboard("a");
    // triage: three candidates, one at a time, answered on the photo's own card (its keys), never on the bar
    for (const n of [1, 2, 3]) {
      const d = await nextCall(new RegExp(`Your call: Step 2 of \\d · Review photos, photo ${n} of 3`));
      expect(within(d).queryByRole("button", { name: /^Person|Not a person/ })).toBeNull();
      // the photo opens large, the subject beside it, "photo n of 3", in plain words (no ids, no engine words)
      const frame = await screen.findByRole("dialog", { name: "Review photos" });
      expect(frame).toHaveTextContent(`photo ${n} of 3`);
      expect(within(frame).getByLabelText("Looking for")).toBeInTheDocument();
      for (const re of BANNED) expect(frame.textContent!).not.toMatch(new RegExp(re.source, re.flags.replace("g", "")));
      await userEvent.keyboard(n === 1 ? "s" : n === 2 ? "n" : "p");
    }
    // the radio clue, the assignment, the lost link: the agent's option each time (A: the real card's action)
    await nextCall(/Your call: Step 3 of \d · Clue/);
    await userEvent.keyboard("a");
    const assign = await nextCall(/Your call: Step 4 of \d · Assign/);
    expect(assign).toHaveTextContent("Team One");
    expect(within(assign).queryByRole("button", { name: /Team One to/ })).toBeNull(); // Approve is on the card
    await userEvent.keyboard("a");
    for (let guard = 0; guard < 6; guard++) {
      const d = await nextCall(/Your call/);
      if (/Find/.test(d.getAttribute("aria-label") ?? "")) break;
      await userEvent.keyboard("a");
      await waitFor(() => expect(screen.queryByRole("dialog", { name: d.getAttribute("aria-label")! })).toBeNull(), { timeout: 3000 }).catch(() => undefined);
    }
    await nextCall(/Your call: Step \d of \d · Find/);
    expect(screen.getByRole("status", { name: "Mission status" })).toHaveTextContent("not found"); // only the manager marks it
    await userEvent.keyboard("a");
    await waitFor(() => expect(screen.getByRole("status", { name: "Mission status" })).toHaveTextContent("Found"), { timeout: 3000 });
    // Record find stops the mission clock: no running on toward last light behind the end screen
    const atFind = useGuide.getState().guide!.clock;
    await new Promise((r) => setTimeout(r, 1200));
    expect(useGuide.getState().guide!.clock).toBe(atFind);
    const end = await screen.findByRole("dialog", { name: "What you did" }, { timeout: 5000 });
    expect(end).toHaveTextContent(/Found at \d\d:\d\d by Team/);
    // the details render when opened
    const details = end.querySelector("[data-details]") as HTMLDetailsElement;
    act(() => {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    expect(end).toHaveTextContent("How each pass went");
    expect(end.textContent).not.toMatch(/score|saved a life/i);
  }, 60_000);

  it("Space during each step never makes a decision, even with a decision button focused (round 3)", async () => {
    vi.stubGlobal("fetch", demoFetch());
    useMission.setState({ ...EMPTY, status: "idle" });
    useStory.getState().reset();
    window.history.replaceState(null, "", "#m/demo?guide=1");
    render(<App base={null} />);
    await screen.findByRole("dialog", { name: /Your call: Step 1 of \d · Survey/ }, { timeout: 5000 });
    const DECIDE = /^(Record find|Approve|Confirm|Send|Person|Not a person|The subject|Log without|Serpentine|Lawnmower|The AI's)/;
    let found = false;
    for (let guard = 0; guard < 12 && !found; guard++) {
      const d = await nextCall(/Your call/);
      const name = d.getAttribute("aria-label")!;
      const made = () => [useGuide.getState().guide!.choices.length, useStory.getState().user.length, Object.keys(useStory.getState().answers).length].join();
      const before = made();
      // the worst case: every decision button on screen focused in turn, Space pressed on each
      for (const b of screen.getAllByRole("button").filter((x) => DECIDE.test(x.textContent?.trim() ?? "") && !(x as HTMLButtonElement).disabled)) {
        b.focus();
        await userEvent.keyboard(" ");
      }
      expect(made()).toBe(before);
      expect(screen.getByRole("dialog", { name })).toBeInTheDocument();
      found = /Find/.test(name);
      await userEvent.keyboard(/Review photos/.test(name) ? "p" : "a");
      await waitFor(() => expect(screen.queryByRole("dialog", { name })).toBeNull(), { timeout: 3000 }).catch(() => undefined);
    }
    expect(found).toBe(true);
    await waitFor(() => expect(screen.getByRole("status", { name: "Mission status" })).toHaveTextContent("Found"), { timeout: 3000 });
  }, 90_000);
});

describe("free play (#m/demo/map): the console on its own, a fresh mission at the call", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useGuide.getState().stop();
  });

  const bar = () => within(screen.getAllByRole("banner")[0]!);
  /** No coach bar, no step strip, no ring, nothing dimmed. */
  function noCoach() {
    expect(screen.queryByRole("dialog", { name: /^(Your call|Watch this)/ })).toBeNull();
    expect(document.querySelector("[data-guide-ring], [data-guide-tag], [data-guide-strip], [data-guide-mark]")).toBeNull();
    expect(screen.queryByText("Do this first")).toBeNull();
    expect(screen.queryByRole("group", { name: "Decisions" })).toBeNull();
  }

  it("opens at the call after a guided run, with nothing of that run left (the owner's report)", async () => {
    vi.stubGlobal("fetch", demoFetch());
    useMission.setState({ ...EMPTY, status: "idle" });
    useStory.getState().reset();
    window.history.replaceState(null, "", "#m/demo?guide=1");
    render(<App base={null} />);
    await screen.findByRole("dialog", { name: /Your call: Step 1 of \d · Survey/ }, { timeout: 5000 });
    // a few decisions and some time in the guided run
    await userEvent.keyboard("a");
    act(() => useGuide.getState().setClock(useGuide.getState().guide!.clock + 40 * 60_000));
    expect(useGuide.getState().guide!.choices.length).toBeGreaterThan(0);
    // home, then "Open the console"
    act(() => {
      window.location.hash = "#";
    });
    act(() => {
      window.location.hash = "#m/demo/map";
    });
    await waitFor(() => expect(bar().getByText("13:35 PDT")).toBeInTheDocument(), { timeout: 5000 });
    expect(useGuide.getState().guide).toMatchObject({ free: true, ended: false, choices: [] });
    expect(useStory.getState().user).toEqual([]);
    expect(useStory.getState().answers).toEqual({});
    expect(screen.getByRole("status", { name: "Mission status" })).toHaveTextContent("not found");
    expect(screen.queryByText(/you chose it/)).toBeNull();
    noCoach();
    expect(screen.getByRole("group", { name: "Mission clock" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start the guided simulation instead" })).toHaveAttribute("href", "#m/demo?guide=1");
    expect(screen.getByRole("link", { name: "Change scenario" })).toHaveAttribute("href", "#scenarios");
    expect(window.location.hash).toBe("#m/demo/map");
  }, 30_000);

  it("a card's Open the console only starts that scenario fresh, and the clock runs and pauses", async () => {
    vi.stubGlobal("fetch", demoFetch());
    useMission.setState({ ...EMPTY, status: "idle" });
    useStory.getState().reset();
    window.history.replaceState(null, "", "#m/demo/map?s=overdue-hiker");
    render(<App base={null} />);
    const clock = await screen.findByRole("group", { name: "Mission clock" }, { timeout: 5000 });
    noCoach();
    const start = useGuide.getState().guide!.clock;
    await waitFor(() => expect(useGuide.getState().guide!.clock).toBeGreaterThan(start + 60_000), { timeout: 3000 });
    await userEvent.click(within(clock).getByRole("button", { name: "Pause the mission clock" }));
    const held = useGuide.getState().guide!.clock;
    await new Promise((r) => setTimeout(r, 400));
    expect(useGuide.getState().guide!.clock).toBe(held);
    // Space plays it again
    await userEvent.keyboard(" ");
    await waitFor(() => expect(useGuide.getState().guide!.clock).toBeGreaterThan(held), { timeout: 3000 });
    // 4× runs faster
    await userEvent.click(within(clock).getByRole("button", { name: "4×" }));
    expect(useGuide.getState().guide!.speed).toBe(4);
  }, 30_000);

  it("reaches the find, and the end screen, when the visitor approves the AI each time", async () => {
    vi.stubGlobal("fetch", demoFetch());
    useMission.setState({ ...EMPTY, status: "idle" });
    useStory.getState().reset();
    window.history.replaceState(null, "", "#m/demo/map");
    render(<App base={null} />);
    await screen.findByRole("group", { name: "Mission clock" }, { timeout: 5000 });
    act(() => useGuide.getState().pause(true));
    const needs = () => document.getElementById("console-needs")!;
    let recorded = false;
    for (let k = 0; k < 120 && !recorded; k++) {
      act(() => useGuide.getState().setClock(useGuide.getState().guide!.clock + 3 * 60_000));
      await settle();
      noCoach();
      // the read-back, each proposal's main button (the AI's pick), the find
      const confirm = within(needs()).queryAllByRole("button", { name: "Confirm clue" })[0];
      if (confirm) await userEvent.click(confirm);
      for (const card of needs().querySelectorAll<HTMLElement>("[aria-label^='Proposal']")) {
        const main = card.querySelector<HTMLButtonElement>("button[data-primary]");
        if (main && card.isConnected) await userEvent.click(main);
      }
      const find = within(needs()).queryAllByRole("button", { name: /^Record find in/ })[0];
      if (find) {
        await userEvent.click(find);
        recorded = true;
      }
    }
    expect(recorded).toBe(true);
    await waitFor(() => expect(screen.getByRole("status", { name: "Mission status" })).toHaveTextContent("Found"), { timeout: 3000 });
    const end = await screen.findByRole("dialog", { name: "What you did" }, { timeout: 5000 });
    expect(end).toHaveTextContent(/Found at \d\d:\d\d by Team/);
    // the approvals are the visitor's, logged as theirs
    const g = useGuide.getState().guide!;
    expect(g.choices.some((c) => c.inject === "assign")).toBe(true);
    expect(g.choices.some((c) => c.inject === "find")).toBe(true);
  }, 90_000);

  it("photos landing toast \"N photos to review\"; the review frame opens only when asked", async () => {
    vi.stubGlobal("fetch", demoFetch());
    useMission.setState({ ...EMPTY, status: "idle" });
    useStory.getState().reset();
    window.history.replaceState(null, "", "#m/demo/map");
    render(<App base={null} />);
    await screen.findByRole("group", { name: "Mission clock" }, { timeout: 5000 });
    act(() => useGuide.getState().pause(true));
    let review: HTMLElement | undefined;
    for (let k = 0; k < 40 && !review; k++) {
      act(() => useGuide.getState().setClock(useGuide.getState().guide!.clock + 2 * 60_000));
      await settle();
      review = screen.queryAllByRole("button", { name: "Review now" })[0];
    }
    expect(review).toBeDefined();
    expect(useConsole.getState().review.open).toBe(false);
    await userEvent.click(review!);
    expect(useConsole.getState().review.open).toBe(true);
  }, 30_000);

  it("Restart asks first, then starts the same scenario fresh from the call (free play and the guided run)", async () => {
    vi.stubGlobal("fetch", demoFetch());
    useMission.setState({ ...EMPTY, status: "idle" });
    useStory.getState().reset();
    window.history.replaceState(null, "", "#m/demo/map?s=overdue-hiker");
    render(<App base={null} />);
    const clock = await screen.findByRole("group", { name: "Mission clock" }, { timeout: 5000 });
    const call = useGuide.getState().guide!.clock;
    act(() => useGuide.getState().setClock(call + 30 * 60_000));
    useStory.setState({ answers: { x: "person" } });
    await userEvent.click(within(clock).getByRole("button", { name: "Restart" }));
    const ask = await screen.findByRole("alertdialog", { name: "Restart this search?" });
    expect(ask).toHaveTextContent("Restart this search from the call? Your decisions so far will be lost");
    // Stay keeps the run
    await userEvent.click(within(ask).getByRole("button", { name: "Stay" }));
    expect(useGuide.getState().guide!.clock).toBeGreaterThan(call);
    await userEvent.click(within(clock).getByRole("button", { name: "Restart" }));
    await userEvent.click(within(await screen.findByRole("alertdialog", { name: "Restart this search?" })).getByRole("button", { name: "Restart" }));
    expect(useGuide.getState().guide).toMatchObject({ clock: call, free: true, choices: [] });
    expect(useStory.getState().answers).toEqual({});
    expect(window.location.hash).toBe("#m/demo/map?s=overdue-hiker");

    // the guided run's bar has it too, beside Leave
    act(() => {
      window.location.hash = "#m/demo?s=overdue-hiker&guide=1";
    });
    const d = await screen.findByRole("dialog", { name: /Your call: Step 1 of \d · Survey/ }, { timeout: 5000 });
    await userEvent.keyboard("a");
    expect(useGuide.getState().guide!.choices.length).toBe(1);
    await userEvent.click(within(screen.getByRole("dialog", { name: /^(Your call|Watch this)/ })).getByRole("button", { name: "Restart" }));
    await userEvent.click(within(await screen.findByRole("alertdialog", { name: "Restart this search?" })).getByRole("button", { name: "Restart" }));
    expect(useGuide.getState().guide).toMatchObject({ clock: call, choices: [], ended: false });
    expect(useGuide.getState().guide!.free).toBeFalsy();
    expect(d).toBeDefined();
  }, 30_000);

  it("the checkpoint addresses still show the recorded mission", async () => {
    vi.stubGlobal("fetch", demoFetch());
    useMission.setState({ ...EMPTY, status: "idle" });
    useStory.getState().reset();
    window.history.replaceState(null, "", "#m/demo/map?t=6");
    render(<App base={null} />);
    await waitFor(() => expect(bar().getByText("15:00 PDT")).toBeInTheDocument(), { timeout: 5000 });
    expect(useGuide.getState().guide).toBeNull();
    expect(screen.queryByRole("group", { name: "Mission clock" })).toBeNull();
  }, 30_000);
});
