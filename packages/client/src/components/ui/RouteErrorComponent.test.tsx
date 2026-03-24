import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RouteErrorComponent } from "./RouteErrorComponent";

const invalidateMock = vi.fn();
const navigateMock = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({
    invalidate: invalidateMock,
    navigate: navigateMock,
  }),
}));

describe("RouteErrorComponent", () => {
  beforeEach(() => {
    invalidateMock.mockReset();
    navigateMock.mockReset();
  });

  it("renders generic route error UI and error details", () => {
    render(<RouteErrorComponent error={new Error("Route broke")} />);

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText("An error occurred while loading this page.")).toBeInTheDocument();
    expect(screen.getByText("Route broke")).toBeInTheDocument();
  });

  it("uses reset callback on retry when provided", async () => {
    const user = userEvent.setup();
    const reset = vi.fn();
    render(<RouteErrorComponent error={new Error("Boom")} reset={reset} />);

    await user.click(screen.getByRole("button", { name: "RETRY" }));

    expect(reset).toHaveBeenCalledTimes(1);
    expect(invalidateMock).not.toHaveBeenCalled();
  });

  it("invalidates the route on retry without reset callback", async () => {
    const user = userEvent.setup();
    render(<RouteErrorComponent error={new Error("Boom")} />);

    await user.click(screen.getByRole("button", { name: "RETRY" }));

    expect(invalidateMock).toHaveBeenCalledTimes(1);
  });

  it("navigates to home when GO HOME is clicked", async () => {
    const user = userEvent.setup();
    render(<RouteErrorComponent error={new Error("Boom")} />);

    await user.click(screen.getByRole("button", { name: "GO HOME" }));

    expect(navigateMock).toHaveBeenCalledWith({ to: "/" });
  });
});
