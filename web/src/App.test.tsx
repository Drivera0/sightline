import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { useCache } from "./lib/cache";
import { diskFetch } from "./lib/diskFetch";

describe("App", () => {
  beforeEach(() => {
    useCache.getState().reset();
    vi.unstubAllGlobals();
  });

  it("shows a loading state, then the shell", async () => {
    vi.stubGlobal("fetch", diskFetch());
    render(<App dir="sample" />);

    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);
    expect(await screen.findByRole("heading", { name: /Sightline/ })).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows which file failed and how to fix it, with no tabs", async () => {
    vi.stubGlobal("fetch", diskFetch());
    render(<App dir="demo" />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/manifest\.json/);
    expect(alert).toHaveTextContent(/pipeline/);
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });
});
