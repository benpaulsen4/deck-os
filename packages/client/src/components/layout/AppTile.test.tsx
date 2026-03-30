import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppTile } from "./AppTile";

const state = vi.hoisted(() => ({
  status: "running",
  flash: true,
}));

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual("@tanstack/react-router");
  return {
    ...actual,
    Link: (props: { children: unknown }) => <a>{props.children as string}</a>,
  };
});

vi.mock("../../stores/appStatus", () => ({
  useAppStatusStore: (selector: (state: unknown) => unknown) =>
    selector({
      getResolvedStatus: () => state.status,
      flashStates: { "app-1": state.flash },
    }),
}));

describe("AppTile", () => {
  beforeEach(() => {
    state.status = "running";
    state.flash = true;
  });

  it("renders external link when app url is http(s)", () => {
    render(
      <AppTile
        app={{
          id: "app-1",
          metadata: {
            name: "My App",
            icon: "",
            url: "https://example.com",
          },
        } as never}
      />
    );
    expect(screen.getByText("My App")).toBeInTheDocument();
    expect(screen.getByText("RUN")).toBeInTheDocument();
    expect(screen.getByText("⚙")).toBeInTheDocument();
    const external = screen.getByRole("link", { name: /My App/i });
    expect(external).toHaveAttribute("href", "https://example.com");
  });

  it("falls back to non-anchor inner content for unsafe urls", () => {
    state.status = "warning";
    state.flash = false;
    render(
      <AppTile
        app={{
          id: "app-1",
          metadata: {
            name: "Unsafe App",
            icon: "",
            url: "javascript:alert(1)",
          },
        } as never}
      />
    );
    expect(screen.getByText("Unsafe App")).toBeInTheDocument();
    expect(screen.getByText("WARN")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Unsafe App/i })).not.toBeInTheDocument();
  });
});
