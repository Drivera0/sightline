import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScreenBoundary } from "./ScreenBoundary";

function Boom({ message = "WebGL2 is required" }: { message?: string }): never {
  throw new Error(message);
}

describe("ScreenBoundary", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {}); // React logs caught render errors
  });
  afterEach(() => vi.restoreAllMocks());

  it("shows its children when nothing goes wrong", () => {
    render(
      <ScreenBoundary name="Map">
        <p>the map</p>
      </ScreenBoundary>,
    );

    expect(screen.getByText("the map")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("replaces a crashed screen with a message that names the screen and the reason", () => {
    render(
      <ScreenBoundary name="Map">
        <Boom />
      </ScreenBoundary>,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Map could not be shown");
    expect(alert).toHaveTextContent("WebGL2 is required");
  });

  it("keeps the rest of the page working", () => {
    render(
      <>
        <p>header stays</p>
        <ScreenBoundary name="Map">
          <Boom />
        </ScreenBoundary>
      </>,
    );

    expect(screen.getByText("header stays")).toBeInTheDocument();
  });

  it("catches an error thrown in an effect, such as a map that cannot start", () => {
    function BadEffect() {
      useEffect(() => {
        throw new Error("GPUInitializationError");
      }, []);
      return <p>starting</p>;
    }

    render(
      <ScreenBoundary name="Map">
        <BadEffect />
      </ScreenBoundary>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("GPUInitializationError");
  });

  it("lets the user try again", async () => {
    let fail = true;
    function Flaky() {
      if (fail) throw new Error("not yet");
      return <p>recovered</p>;
    }
    render(
      <ScreenBoundary name="Map">
        <Flaky />
      </ScreenBoundary>,
    );
    fail = false;

    await userEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(screen.getByText("recovered")).toBeInTheDocument();
  });
});
