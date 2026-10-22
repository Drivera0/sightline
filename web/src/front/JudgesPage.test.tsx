// #judges: renders offline, and every link inside the app goes to a screen that exists.
import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { tabFromHash } from "../ingest/LiveMission";
import { routeFromHash, stepFromHash } from "../shell/flow";
import { HONESTY, JUDGE_LINKS, JUDGES } from "./judges";
import { JudgesPage, LiveStatus } from "./JudgesPage";

/** An in-app link resolves when it lands on a real route, step or mission tab (not a fallback). */
function resolves(href: string): boolean {
  const r = routeFromHash(href);
  if (r.kind === "front" || r.kind === "judges" || r.kind === "new" || r.kind === "try") return true;
  if (r.kind === "mission") return r.id === "demo" && tabFromHash(href) === href.split("/")[2];
  return stepFromHash(href) === href.slice(1);
}

describe("JudgesPage", () => {
  it("is at #judges", () => {
    expect(routeFromHash("#judges")).toEqual({ kind: "judges" });
  });

  it("renders the logline, the links in order with what each proves, the users and the honesty block, offline", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<JudgesPage base={null} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(JUDGES.logline);
    const where = screen.getByRole("region", { name: "Where to look" });
    expect(where).toHaveTextContent("Console1 minthe map directs drones and teams");
    expect(within(where).getByRole("link", { name: "Try a photo" })).toHaveAttribute("href", "#try");
    expect(screen.getByRole("navigation", { name: "Sightline" })).toBeInTheDocument(); // the app bar
    expect(where).toHaveTextContent("Live API status");
    expect(where).toHaveTextContent("The live mission server runs during demos and judging");
    expect(where).toHaveTextContent("link coming");
    expect(screen.getByRole("region", { name: "Who it's for" })).toHaveTextContent("Search manager");
    expect(screen.getByRole("region", { name: "What is simulated and what is real" })).toHaveTextContent(HONESTY.principle);
    expect(screen.getByRole("link", { name: /see what changed/ })).toHaveAttribute("href", JUDGES.changedUrl);
    expect(fetchSpy).not.toHaveBeenCalled(); // no mission server on this site: nothing fetched
  });

  it("every in-app link resolves to a known route; the others go to the repo", () => {
    render(<JudgesPage base={null} />);
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href")!);
    const internal = hrefs.filter((h) => h.startsWith("#"));
    expect(internal.length).toBeGreaterThanOrEqual(5);
    for (const h of internal) expect(resolves(h), h).toBe(true);
    for (const h of hrefs.filter((x) => !x.startsWith("#"))) expect(h.startsWith("https://github.com/Drivera0/sightline"), h).toBe(true);
    expect(JUDGE_LINKS.find((l) => l.label === "Conditions")?.href).toBe("#m/demo/command/conditions");
    expect(resolves("#m/demo/nope")).toBe(false); // the check can fail
    expect(resolves("#nope")).toBe(false);
  });

  it("shows the live server's health when the site has one", async () => {
    const up = vi.fn().mockResolvedValue({ status: "ok", contract_version: "1.2", backend: "cv2", radio: true });
    render(<LiveStatus base="https://api.example.org" health={up} />);
    await waitFor(() => expect(screen.getByText("Live server up")).toBeInTheDocument());
    expect(up).toHaveBeenCalledWith({ base: "https://api.example.org" });
  });

  it("says when the live server is down, and offers the demo", async () => {
    render(<LiveStatus base="https://api.example.org" health={vi.fn().mockRejectedValue(new Error("x"))} />);
    await waitFor(() => expect(screen.getByText("Live server not reachable")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Open the console" })).toHaveAttribute("href", "#m/demo/command");
  });
});
