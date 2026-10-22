// Tavily, made visible: each fact with its quote and page, the lookup's model, the flyability gate.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Conditions } from "../contract";
import { conditionsFacts, dayNote, flyGate, latestLookup } from "./conditions";
import { ConditionsPanel } from "./ConditionsPanel";
import { CommandView } from "./CommandView";
import { demoConditionsData, loadDemoConditions } from "./demoMission";
import fixture from "./__fixtures__/demo_mission.json";

const utc = (iso: string) => `${iso.slice(11, 16)} UTC`;

describe("conditions from the trace", () => {
  it("reads the recorded lookup: three searches, one extract, the quotes and the model", async () => {
    const d = await loadDemoConditions();
    const l = d.lookup!;
    expect(l.searches.map((s) => s.label)).toEqual(["forecast", "warnings", "alerts"]);
    expect(l.extracted).toEqual(["https://weather.gc.ca/en/forecast/hourly/index.html?coords=49.316%2C-123.071"]);
    expect(l.documents).toHaveLength(15); // the 16 listed, one twice
    expect(l.fields).toEqual({ wind_kmh: { value: 20, quote: "NW 20", url: null }, gust_kmh: { value: 40, quote: "gusts 40", url: null } });
    expect(l.model).toBe("nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B");
    const facts = conditionsFacts(d.conditions, l);
    expect(facts.find((f) => f.id === "gust_kmh")).toMatchObject({ value: "40 km/h (11.1 m/s)", source: { kind: "quote", quote: "gusts 40" } });
    expect(facts.find((f) => f.id === "precip_mm_h")).toMatchObject({ value: "not on the pages read", source: { kind: "missing" } });
    expect(facts.find((f) => f.id === "twilight")?.source.kind).toBe("computed");
    expect(latestLookup([])).toBeNull();
  });

  it("gives the date when twilight isn't today on the mission clock", async () => {
    const d = await loadDemoConditions();
    const c = { ...d.conditions, civil_twilight_end: "2026-10-23T01:40:00Z", sunset: "2026-10-23T01:07:00Z" };
    const twilight = (now: string) => conditionsFacts(c, null, new Date(now)).find((f) => f.id === "twilight")?.value;
    expect(twilight("2026-10-22T08:40:00Z")).toBe("01:40 UTC, 23 Oct (sunset 01:07 UTC)");
    expect(twilight("2026-10-23T00:10:00Z")).toBe("01:40 UTC (sunset 01:07 UTC)");
    expect(dayNote("2026-10-23T01:40:00Z", new Date("2026-10-22T08:40:00Z"))).toBe(", 23 Oct");
  });

  it("states the flyability gate with the limit it was checked against", () => {
    const c = { gust_kmh: 15, wind_kmh: 8, flyable: true, flyable_until: "2026-10-25T01:36:46Z", flyability_reason: "gusts 15 km/h below the drones' limit of 38 km/h" } as Conditions;
    expect(flyGate(c, 43.2, "Mavic 3E", utc)).toEqual({ tone: "ok", text: "Flyable until ~01:36 UTC (gust limit 43 km/h = 12.0 m/s, Mavic 3E)" });
    expect(flyGate(c, null, null, utc).text).toBe("Flyable until ~01:36 UTC (gust limit 38 km/h = 10.6 m/s, default: no fleet attached)");
    const windy = { ...c, gust_kmh: 50, flyable: false, flyable_until: null, flyability_reason: "gusts 50 km/h at or above the drones' limit of 43 km/h" };
    expect(flyGate(windy, 43.2, "Mavic 3E", utc)).toEqual({ tone: "alert", text: "Not flyable: gusts 50 km/h (13.9 m/s) ≥ gust limit 43 km/h = 12.0 m/s, Mavic 3E" });
    const dark = { ...c, gust_kmh: 40, flyable: false, flyable_until: null, flyability_reason: "after civil twilight: no light for photos" };
    expect(flyGate(dark, null, null, utc).text).toBe(
      "Not flyable: after civil twilight: no light for photos; also gusts 40 km/h (11.1 m/s) ≥ gust limit 38 km/h = 10.6 m/s, default: no fleet attached",
    );
  });
});

describe("ConditionsPanel", () => {
  it("shows each fact with its quote and link, the model, and says a recorded run is recorded", async () => {
    const d = await loadDemoConditions();
    render(<ConditionsPanel id="c" data={d} now={new Date(d.conditions.fetched_at)} time={utc} />);
    const panel = screen.getByRole("region", { name: "Conditions" });
    expect(panel).toHaveTextContent("Not flyable: after civil twilight");
    expect(panel).toHaveTextContent("Recorded live lookup for Mount Seymour, 2026-10-22 05:31 UTC");
    expect(panel).toHaveTextContent("read by nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B in 5.9 s (11,652 tokens in)");
    const gusts = screen.getByLabelText("Gusts");
    expect(gusts).toHaveTextContent("gusts 40");
    expect(within(gusts).getByRole("link", { name: /weather\.gc\.ca/ })).toHaveAttribute("href", "https://weather.gc.ca/en/forecast/hourly/index.html?coords=49.316%2C-123.071");
    expect(screen.getByLabelText("Alerts and closures")).toHaveTextContent("None found on the pages searched (weather.gc.ca, bcparks.ca)");
    expect(panel.textContent).not.toMatch(/\bclear(s|ed|ing)?\b/i);
  });

  it("links the exact page a quote was verified in, when the trace records it", async () => {
    const d = await loadDemoConditions();
    const lookup = { ...d.lookup!, fields: { ...d.lookup!.fields, gust_kmh: { value: 40, quote: "gusts 40", url: "https://weather.gc.ca/en/forecast/hourly/index.html?coords=49.314%2C-123.067" } } };
    render(<ConditionsPanel id="c" data={{ ...d, lookup }} now={new Date(d.conditions.fetched_at)} time={utc} />);
    const gusts = screen.getByLabelText("Gusts");
    expect(gusts).toHaveTextContent("from weather.gc.ca");
    expect(gusts).not.toHaveTextContent("one of the");
    expect(within(gusts).getByRole("link")).toHaveAttribute("href", "https://weather.gc.ca/en/forecast/hourly/index.html?coords=49.314%2C-123.067");
  });

  it("live: the age turns amber past an hour", () => {
    const conditions = { fetched_at: "2026-10-24T20:00:00Z", stale: false, wind_kmh: null, gust_kmh: null, precip_mm_h: null, precip_prob: null, temp_c: null, visibility_km: null, alerts: [], flyable: null, flyability_reason: "no wind data: flyability unknown", visibility_factor: 1, exposure_band: null, exposure_note: "", civil_twilight_end: null, sunset: null } as unknown as Conditions;
    render(<ConditionsPanel id="c" data={{ conditions, lookup: null, recorded: null, limitKmh: null, drone: null }} now={new Date("2026-10-24T21:05:00Z")} time={utc} />);
    const age = screen.getByText(/as of 20:00 UTC, 65 min ago/);
    expect(age.className).toContain("text-caution");
    expect(screen.getByRole("region", { name: "Conditions" })).toHaveTextContent("No conditions lookup in this mission's trace yet");
  });

  it("the demo: one verdict chip, its own; the recorded lookup's verdict is muted text with its time, even unfolded", async () => {
    const recorded = await loadDemoConditions();
    const own = (fixture as unknown as { conditions: Conditions }).conditions;
    const data = demoConditionsData(own, recorded, { kmh: 43.2, drone: "Drone 1" });
    render(<ConditionsPanel id="c" data={data} now={new Date("2026-10-24T22:00:00Z")} time={utc} />);
    const panel = screen.getByRole("region", { name: "Conditions" });
    const verdictChips = () => [...panel.querySelectorAll(".sl-pill")].filter((e) => /flyable/i.test(e.textContent ?? ""));
    expect(verdictChips().map((e) => e.textContent)).toEqual([expect.stringMatching(/^Flyable until/)]);
    const fold = within(panel).getByText("Another evening's live lookup, for the sources");
    expect(fold).toHaveClass("text-text-3");
    await userEvent.click(fold);
    expect(verdictChips()).toHaveLength(1); // still only the mission's own
    const example = screen.getByRole("region", { name: "Recorded conditions lookup" });
    expect(example.querySelector(".sl-pill[data-tone='alert']")).toBeNull();
    const then = example.querySelector("[data-verdict='example']");
    expect(then).toHaveTextContent("Its verdict then, at 05:31 UTC, not now: Not flyable: after civil twilight");
    expect(then).toHaveClass("text-text-3");
  });

  it("opens from the console header's conditions line, and with W", async () => {
    const d = await loadDemoConditions();
    render(
      <CommandView
        mission={null} status="demo" conditions={d.conditions} tasks={[]} sectors={[]} teams={[]} clues={[]} proposals={[]} imageUrl={(r) => r}
        onSetTask={vi.fn()} onUpdateTeam={vi.fn()} onAddClue={vi.fn()} onDecide={vi.fn()} map={<div>map</div>} conditionsData={d}
      />,
    );
    expect(screen.queryByRole("region", { name: "Conditions" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Sources and quotes/ }));
    expect(screen.getByRole("region", { name: "Conditions" })).toBeInTheDocument();
    await userEvent.keyboard("w");
    expect(screen.queryByRole("region", { name: "Conditions" })).toBeNull();
    await userEvent.keyboard("W");
    expect(screen.getByRole("region", { name: "Conditions" })).toBeInTheDocument();
  });
});
