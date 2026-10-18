import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { CacheBundle } from "../contract";
import { loadCache, useCache } from "../lib/cache";
import { diskFetch } from "../lib/diskFetch";
import { MetricsView } from "./MetricsView";

// "The details" read by a rescue worker or a judge, not a reviewer of the code: plain titles,
// plain column headers, and a short plain sentence under each table. The technical name may stay
// (other tests and the audit trail pin it), but never without its plain gloss nearby.

let cache: CacheBundle;

beforeEach(async () => {
  cache = await loadCache("sample", diskFetch());
  useCache.setState({ status: "ready", data: cache, error: null, dir: "sample" });
});

/** The five collapsible blocks, in page order. */
function sections(container: HTMLElement): HTMLDetailsElement[] {
  return Array.from(
    container.querySelectorAll<HTMLDetailsElement>('[data-testid="metrics"] > details'),
  );
}

const TITLES = [
  "People found, real alerts and speed, against the human study",
  "Against the best published model (AIR)",
  "What each choice adds",
  "Photos reviewed before the first and the last person",
  "Cells a ground team checks before reaching the person",
];

/** Words a rescue worker should not have to know to read a plain sentence. */
const JARGON = /\b(AP50|AP|SAR-APD|VOC|IoU|ablation|threshold|percentile|seed|prior|recall|precision|SOTA|state of the art)\b/i;

describe("the details, in plain words", () => {
  it("titles each section in plain words", () => {
    const { container } = render(<MetricsView />);
    const titles = sections(container).map((d) => d.querySelector("summary")!.textContent);
    expect(titles).toHaveLength(5);
    TITLES.forEach((title, i) => expect(titles[i]).toContain(title));
    for (const t of titles) {
      expect(t).not.toMatch(/Recall|Precision|state of the art|technique/);
    }
  });

  it("opens every section with one plain sentence that uses no jargon", () => {
    const { container } = render(<MetricsView />);
    for (const details of sections(container)) {
      const plain = details.querySelector("[data-plain]");
      expect(plain, details.querySelector("summary")!.textContent!).not.toBeNull();
      expect(plain!.textContent!.length).toBeGreaterThan(20);
      expect(plain!.textContent).not.toMatch(JARGON);
    }
  });

  it("never shows AP, SAR-APD or VOC in a section without its plain gloss", () => {
    const { container } = render(<MetricsView />);
    for (const details of sections(container)) {
      const text = details.textContent ?? "";
      if (/\bAP(50)?\b/.test(text)) expect(text).toMatch(/one number that combines/);
      if (/SAR-APD/.test(text)) expect(text).toMatch(/like the human study/);
      if (/VOC/.test(text)) expect(text).toMatch(/box must match the person closely/);
    }
  });

  it("labels the headline tiles people found and alerts that are real people", () => {
    render(<MetricsView />);
    const tile = (value: string) => screen.getByLabelText(value).closest("div.flex.flex-col.gap-2")!;
    expect(tile("84%")).toHaveTextContent("People found");
    expect(tile("86%")).toHaveTextContent("Alerts that are real people");
    expect(screen.getByText(/Strict VOC/)).toHaveTextContent("people found");
    expect(screen.getByText(/Strict VOC/)).toHaveTextContent("alerts that are real people");
  });

  it("heads the detector tables with people found and alerts that are real people", () => {
    render(<MetricsView />);
    for (const name of ["State of the art", "Ablations"]) {
      const headers = within(screen.getByRole("table", { name }))
        .getAllByRole("columnheader")
        .map((h) => h.textContent);
      expect(headers[1]).toBe("Alerts that are real people");
      expect(headers[2]).toBe("People found");
      expect(headers[3]).toMatch(/^Overall score \(AP(50)?\)$/);
    }
  });

  it("heads the ranking table in photos until the first and the last person", () => {
    render(<MetricsView />);
    const headers = within(screen.getByRole("table", { name: "Ranking" }))
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toEqual([
      "Order",
      "Photos to the first person",
      "Photos to the last person",
      "Share of all photos",
    ]);
  });

  it("heads the search tables typical and 9 in 10 searches, and explains each method", () => {
    render(<MetricsView />);
    const table = screen.getByRole("table", { name: "Search simulation" });
    const headers = within(table).getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["Search order", "Typical (median)", "9 in 10 searches (90th percentile)"]);
    const section = table.closest('[data-testid="metrics"] > details')!;
    expect(section).toHaveTextContent(/starting guess/);
    expect(section).toHaveTextContent(/photographed = searched/);
    expect(section).toHaveTextContent(/forest/);
    // Still labelled simulated.
    expect(within(section as HTMLElement).getByText("Simulated evaluation")).toBeInTheDocument();
  });
});
