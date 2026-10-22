// LANE_D §6 test 9 (ingest) and test 8 (review in live mode), plus the live routes.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Detections, MapFile, Verdict } from "../contract";
import { App } from "../App";
import { useStory } from "../command/story";
import { diskFetch } from "../lib/diskFetch";
import { LiveReview, liveReviewItems, relookName, verdictWords } from "../review/LiveReview";
import { EMPTY, useMission } from "../lib/mission";
import type { Route } from "../shell/flow";
import { SAFETY_FRAME } from "../radio/RadioDesk";
import { LiveMission } from "./LiveMission";
import { NewSearch } from "./NewSearch";
import { batches, hostLabel, photoFiles, uploadCommand } from "./upload";
import { UploadPanel, WatchPanel } from "./UploadPanel";

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
    // the same app bar: the wordmark opens About
    expect(within(screen.getAllByRole("banner")[0]!).getByRole("link", { name: "Sightline" })).toHaveAttribute("href", "#about");
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
    expect(relookName("relook/f0003-d01-zoom_native.jpg")).toBe("zoom native");
    expect(relookName("relook/f0003-d01-enhance_contrast.jpg")).toBe("enhance contrast");
    const v = verdict({ relook_crops: ["relook/f0001-d02-zoom_native.jpg"] });
    render(<LiveReview detections={dets} survey={null} verdicts={[v]} promoted={["f0001-d02"]} imageUrl={(r) => `/f/${r}`} onAnswer={vi.fn()} />);
    expect(screen.queryByAltText(/Re-look image/)).toBeNull(); // not loaded until asked for
    await userEvent.click(screen.getByRole("button", { name: "Show the second look's images (1)" }));
    expect(screen.getByAltText("Re-look image relook/f0001-d02-zoom_native.jpg")).toHaveAttribute("src", "/f/relook/f0001-d02-zoom_native.jpg");
    expect(screen.getByText("zoom native")).toBeInTheDocument();
  });

  it("always says the second look in words", () => {
    expect(verdictWords(verdict({}))).toBe("Second look: likely a person · lying down · red jacket");
    expect(verdictWords(verdict({ person: "unclear" }))).toBe("Second look: unclear");
    expect(verdictWords(verdict({ person: "no" }))).toBe("Second look: probably not a person");
    expect(verdictWords(undefined)).toBeNull();
  });

  it("sends each answer", async () => {
    const onAnswer = vi.fn();
    render(
      <LiveReview detections={dets} survey={null} verdicts={[verdict({})]} promoted={["f0001-d02"]} imageUrl={(r) => `/f/${r}`} onAnswer={onAnswer} />,
    );
    expect(screen.getByText("Second look: likely a person · lying down · red jacket")).toBeInTheDocument();
    expect(screen.getByAltText("Crop of f0001-d02")).toHaveAttribute("src", "/f/crops/nearmiss/f0001-d02.jpg");
    const card = screen.getByLabelText("Candidate f0001-d02");
    await userEvent.click(card.querySelector("button")!);
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

  it("says when the server has no radio desk (#m/<id>/radio, for phones)", async () => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    render(<LiveMission api={withHealth(false)} missionId="a1b2c3d4" route={missionRoute("a1b2c3d4", "radio")} />);
    expect(await screen.findByText(/radio desk isn't running on this server/)).toBeInTheDocument();
  });

  it("keeps the radio one labelled step away: a Radio view, and Open Radio under the approvals (D-R3)", async () => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    render(<LiveMission api={withHealth(true)} missionId="a1b2c3d4" route={missionRoute("a1b2c3d4", "map")} />);
    expect(within(screen.getByRole("region", { name: "Radio" })).getByText(/teams report here/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open Radio" }));
    expect(await screen.findByText(SAFETY_FRAME)).toBeInTheDocument();
    for (const nav of screen.getAllByRole("navigation", { name: "Mission views" })) expect(within(nav).getByRole("button", { name: "Radio" })).toHaveAttribute("aria-pressed", "true");
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
    window.history.replaceState(null, "", "#");
    render(<App base={null} />);
    expect(window.location.hash).toBe("#m/demo");
    const pitch = screen.getByRole("region", { name: "Sightline" });
    expect(within(pitch).getByRole("heading", { level: 1 })).toHaveTextContent("The brain of a drone search.");
    expect(within(pitch).getByRole("button", { name: "Follow the search (3 min)" }).className).toMatch(/bg-accent/);
    await waitFor(() => expect(within(screen.getAllByRole("banner")[0]!).getByText("13:35 PDT")).toBeInTheDocument());
    expect(await screen.findByRole("group", { name: "Mission time" })).toBeInTheDocument();
    expect(await screen.findByText("No clues yet.")).toBeInTheDocument(); // the call: the car in the lot is where the search starts
    expect(screen.queryByText("blue water bottle by the creek crossing")).toBeNull(); // not found yet at 13:35 PDT (20:35 UTC)
    await userEvent.click(within(pitch).getByRole("button", { name: "Skip to now" }));
    expect(screen.queryByRole("region", { name: "Sightline" })).toBeNull();
    expect(await screen.findByText("blue water bottle by the creek crossing")).toBeInTheDocument();
    expect(within(screen.getAllByRole("banner")[0]!).getByText("15:00 PDT")).toBeInTheDocument();
    expect(window.location.hash).toBe("#m/demo/map");
  });

  it("follows the story: the photos rail, then the review with the recorded second look, the approval gate, the debrief", async () => {
    vi.stubGlobal("fetch", demoFetch());
    useMission.setState({ ...EMPTY, status: "idle" });
    useStory.getState().reset();
    window.history.replaceState(null, "", "#m/demo");
    render(<App base={null} />);
    await settle();
    await userEvent.click(screen.getByRole("button", { name: "Follow the search (3 min)" }));
    // t1 (jsdom asks for reduced motion: the clock jumps)
    const mark = await screen.findByRole("dialog", { name: "The story, 1 of 5" });
    expect(mark).toHaveTextContent("Photos are landing");
    expect(screen.getByRole("region", { name: "Photos" })).toBeInTheDocument();
    expect(window.location.hash).toBe("#m/demo?t=1");
    await userEvent.keyboard("{ArrowRight}");
    expect(await screen.findByRole("dialog", { name: "The story, 2 of 5" })).toHaveTextContent("second look");
    const review = screen.getByRole("region", { name: "Review" });
    const recorded = within(review).getByLabelText("Candidate recorded-f0001-d01");
    expect(within(recorded).getByLabelText("Models")).toHaveTextContent("OpenCV 5 zoom native");
    expect(within(recorded).getByLabelText("Models")).toHaveTextContent("Nemotron-3.5-Super-VL");
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    // t3: first the clue log, once ("Clues move the map too"), then the gate waits for the visitor's approval
    const clues = await screen.findByRole("dialog", { name: "The story, 3 of 5" });
    expect(clues).toHaveTextContent("Clues move the map too");
    await userEvent.keyboard("{ArrowRight}");
    await waitFor(() => expect(screen.getByRole("dialog", { name: "The story, 3 of 5" })).not.toHaveTextContent("Clues move the map too"));
    const gate = screen.getByRole("dialog", { name: "The story, 3 of 5" });
    expect(gate).toHaveTextContent("Approve it on the card");
    const card = await screen.findByLabelText("Proposal p003");
    await userEvent.click(within(card).getByRole("button", { name: /Approve/ }));
    expect(await screen.findByRole("dialog", { name: "The story, 4 of 5" })).toHaveTextContent("searched at POD 60 %");
    expect(await screen.findByText("POD 60%")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("dialog", { name: "The story, 5 of 5" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Debrief" })).toHaveTextContent("What breaks first");
    // Esc leaves the story; the console stays at that mission time
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("region", { name: "Debrief" })).toBeInTheDocument();
    expect(window.location.hash).toBe("#m/demo/debrief");
  });

  it("tells one story about conditions: the row's verdict is the Conditions panel's", async () => {
    vi.stubGlobal("fetch", demoFetch());
    useMission.setState({ ...EMPTY, status: "idle" });
    useStory.getState().reset();
    window.history.replaceState(null, "", "#m/demo/map?t=4");
    render(<App base={null} />);
    const header = await screen.findByRole("region", { name: "Mission header" });
    const row = await waitFor(() => {
      const pill = header.querySelector("[data-tone]");
      expect(pill).not.toBeNull();
      return pill!;
    });
    await userEvent.click(await screen.findByRole("button", { name: /Sources and quotes/ }));
    const panel = await screen.findByRole("region", { name: "Conditions" });
    const verdict = await waitFor(() => panel.querySelector("[data-tone]")!);
    expect(row).toHaveTextContent(/^Flyable/); // 22:00 UTC is 15:00 in Vancouver: daylight, light wind
    expect(verdict.getAttribute("data-tone")).toBe(row.getAttribute("data-tone"));
    expect(verdict).toHaveTextContent(/^Flyable/);
    // the real recorded lookup is still there, folded, on its own evening with its own verdict
    expect(within(panel).getByRole("region", { name: "Recorded conditions lookup" })).toHaveTextContent(/Not flyable/);
  });

  it("keeps the visitor's approval when the clock moves back and forth", async () => {
    vi.stubGlobal("fetch", demoFetch());
    useMission.setState({ ...EMPTY, status: "idle" });
    useStory.getState().reset();
    window.history.replaceState(null, "", "#m/demo/map");
    render(<App base={null} />);
    const card = (await screen.findByText("Add f0396-d01 to the review queue: second look says likely a person")).closest("[aria-label^='Proposal']") as HTMLElement;
    await userEvent.click(within(card).getByRole("button", { name: /Approve/ }));
    const status = () => useMission.getState().proposals.find((p) => p.id === "p002")?.status;
    expect(status()).toBe("approved");
    useStory.getState().seek(2);
    await settle();
    expect(status()).toBe("pending"); // proposed at 14:10 PDT; the visitor approved it at 15:00, not yet at 14:31
    useStory.getState().seek(4);
    await settle();
    expect(status()).toBe("approved");
  });

  it("opens For judges in the debrief from #judges, and Try a photo in the Photos rail from #try", async () => {
    vi.stubGlobal("fetch", demoFetch());
    useStory.getState().reset();
    window.history.replaceState(null, "", "#judges");
    const { unmount } = render(<App base={null} />);
    expect(screen.getAllByRole("button", { name: "Debrief", pressed: true })).toHaveLength(2);
    expect((await screen.findByText("For judges: where to look, in order")).closest("details")).toHaveAttribute("open");
    unmount();
    window.history.replaceState(null, "", "#try");
    render(<App base={null} />);
    expect(screen.getAllByRole("button", { name: "Photos", pressed: true })).toHaveLength(2);
    expect(await screen.findByRole("button", { name: "Hide Try a photo" })).toHaveAttribute("aria-expanded", "true");
  });

  it("opens About over the console from the wordmark, and Esc goes back", async () => {
    vi.stubGlobal("fetch", demoFetch());
    useStory.getState().reset();
    window.history.replaceState(null, "", "#m/demo/map");
    render(<App base={null} />);
    window.location.hash = "#about";
    const sheet = await screen.findByRole("dialog", { name: "About Sightline" });
    expect(sheet).toHaveTextContent("How it works");
    expect(sheet).toHaveTextContent("HERIDAL");
    expect(screen.getByLabelText("Command view")).toBeInTheDocument(); // the console stays behind it
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(window.location.hash).toBe("#m/demo/map"));
  });
});
