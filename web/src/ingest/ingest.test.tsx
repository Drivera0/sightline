// LANE_D §6 test 9 (ingest) and test 8 (review in live mode), plus the live routes.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Detections, Verdict } from "../contract";
import { LiveRoutes } from "../App";
import { LiveReview, liveReviewItems, relookName, verdictWords } from "../review/LiveReview";
import { routeFromHash } from "../shell/flow";
import { SAFETY_FRAME } from "../radio/RadioDesk";
import { cardFromHash, LiveMission, tabFromHash } from "./LiveMission";
import { NewSearch } from "./NewSearch";
import { batches, photoFiles, uploadCommand } from "./upload";
import { UploadPanel } from "./UploadPanel";

// MapLibre needs WebGL, which jsdom lacks; the real pick was checked in Chromium.
vi.mock("./LkpPicker", () => ({ LkpPicker: () => <div aria-label="Pick the last known position on the map" /> }));

const API = { base: "http://api.test" };
const jpeg = (name: string) => new File(["x"], name, { type: "image/jpeg" });

describe("routes", () => {
  it("knows New search, live missions and the demo", () => {
    expect(routeFromHash("#new")).toEqual({ kind: "new" });
    expect(routeFromHash("#m/a1b2c3d4/review")).toEqual({ kind: "mission", id: "a1b2c3d4" });
    expect(routeFromHash("#review")).toEqual({ kind: "demo" });
    expect(routeFromHash("#m/demo/command")).toEqual({ kind: "mission", id: "demo" });
    expect(routeFromHash("#command")).toEqual({ kind: "mission", id: "demo" });
    expect(routeFromHash("#m/../../x")).toEqual({ kind: "demo" });
  });

  it("on the demo-only site, hands over the demo mission first and never shows a developer message", () => {
    render(<LiveRoutes route={{ kind: "new" }} base={null} />);
    const box = screen.getByRole("region", { name: "No mission server" });
    expect(box).toHaveTextContent("The live mission server runs during demos and judging; here is the demo mission.");
    expect(box).not.toHaveTextContent("VITE_API_URL");
    const links = screen.getAllByRole("link").filter((a) => a.getAttribute("href") !== "#");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["#m/demo/command", "#survey"]);
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

  it("offers the map to pick the last known position", async () => {
    render(<NewSearch api={API} onCreated={vi.fn()} createMission={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Pick on the map" });
    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText(/Click where the person was last seen/)).toBeInTheDocument();
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

describe("live mission tabs", () => {
  // the state request never answers: the tabs still render, with no mission data yet
  const pending = { base: "http://api.test", fetch: (() => new Promise(() => {})) as unknown as typeof fetch };

  it("knows a sector's card from the address", () => {
    expect(cardFromHash("#m/a1b2c3d4/card/B3")).toBe("B3");
    expect(cardFromHash("#m/a1b2c3d4/card")).toBeNull();
    expect(cardFromHash("#m/a1b2c3d4/command")).toBeNull();
  });

  it("knows the radio tab from the address", () => {
    expect(tabFromHash("#m/a1b2c3d4/radio")).toBe("radio");
    expect(tabFromHash("#m/a1b2c3d4/nope")).toBe("photos");
  });

  it("C goes to the Command tab, but not while typing", async () => {
    render(<LiveMission api={pending} missionId="a1b2c3d4" initialTab="feed" />);
    await userEvent.keyboard("c");
    expect(screen.getByRole("button", { name: "Command" })).toHaveAttribute("aria-pressed", "true");
    expect(window.location.hash).toBe("#m/a1b2c3d4/command");
  });

  // /health answers (radio on or off); everything else stays pending
  const withHealth = (radio: boolean) => ({
    base: "http://api.test",
    fetch: ((url: string) =>
      String(url).endsWith("/health")
        ? Promise.resolve(new Response(JSON.stringify({ status: "ok", contract_version: "1.2", backend: "cv2", radio })))
        : new Promise(() => {})) as unknown as typeof fetch,
  });

  it("says when the server has no radio desk", async () => {
    render(<LiveMission api={withHealth(false)} missionId="a1b2c3d4" initialTab="radio" />);
    expect(await screen.findByText(/radio desk isn't running on this server/)).toBeInTheDocument();
  });

  it("puts the radio desk beside the approvals on the Command tab (D-R3)", async () => {
    render(<LiveMission api={withHealth(true)} missionId="a1b2c3d4" initialTab="command" />);
    expect(await screen.findByText(SAFETY_FRAME)).toBeInTheDocument();
  });

  it("mounts the radio desk, safety frame first, and links the debrief", async () => {
    render(<LiveMission api={withHealth(true)} missionId="a1b2c3d4" initialTab="radio" />);
    expect(await screen.findByText(SAFETY_FRAME)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Debrief" })).toHaveAttribute("href", "http://api.test/missions/a1b2c3d4/debrief.md");
    await userEvent.click(screen.getByRole("button", { name: "Feed" }));
    expect(screen.getByRole("link", { name: "Debrief (markdown)" })).toHaveAttribute(
      "href",
      "http://api.test/missions/a1b2c3d4/debrief.md",
    );
  });
});

describe("the demo mission (E-04)", () => {
  it("opens with no API: command, approvals and feed only, labelled a demo", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ steps: [], prior: { p: [], outside: 0 } })));
    render(<LiveRoutes route={{ kind: "mission", id: "demo" }} base={null} />);
    expect(await screen.findByText("Demo mission · simulated data, no server")).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "Mission views" })).queryByRole("button", { name: "Photos" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Debrief" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Approvals/ }));
    expect(await screen.findByText("Promote f0127-d01 to the review queue")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});

