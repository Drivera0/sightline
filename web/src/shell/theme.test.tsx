import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTheme, currentTheme, initTheme, THEME_KEY } from "./theme";
import { ThemeToggle } from "./ThemeToggle";

const system = (light: boolean) =>
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: light && q.includes("light"), media: q, addEventListener: () => undefined, removeEventListener: () => undefined }));

describe("the theme", () => {
  afterEach(() => {
    window.localStorage.removeItem(THEME_KEY);
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.theme;
  });

  it("follows the system preference until the visitor picks one", () => {
    system(true);
    initTheme();
    expect(document.documentElement.dataset.theme).toBe("light");
    system(false);
    applyTheme();
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("toggles from the app bar and remembers the choice", async () => {
    system(false);
    act(() => initTheme());
    render(<ThemeToggle />);
    await userEvent.click(screen.getByRole("button", { name: "Switch to the light theme" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.localStorage.getItem(THEME_KEY)).toBe("light");
    expect(currentTheme()).toBe("light"); // over the system's dark
    await userEvent.click(screen.getByRole("button", { name: "Switch to the dark theme" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem(THEME_KEY)).toBe("dark");
  });
});
