import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AuthGateScreen } from "./AuthGateScreen";

function renderAuthGateScreen(overrides: Partial<React.ComponentProps<typeof AuthGateScreen>> = {}) {
  const props: React.ComponentProps<typeof AuthGateScreen> = {
    authChecking: false,
    authEnabled: true,
    authUnlocked: false,
    pin: "",
    unlocking: false,
    retryAfterMs: 0,
    unlockError: null,
    onPinChange: vi.fn(),
    onUnlock: vi.fn(),
    ...overrides,
  };
  return { ...render(<AuthGateScreen {...props} />), props };
}

describe("AuthGateScreen", () => {
  it("shows loading state while auth status is checking", () => {
    renderAuthGateScreen({ authChecking: true });
    expect(screen.getByText("LOADING SECURITY STATUS...")).toBeInTheDocument();
  });

  it("renders nothing when auth is disabled", () => {
    const { container } = renderAuthGateScreen({ authEnabled: false });
    expect(container).toBeEmptyDOMElement();
  });

  it("renders unlock UI and disables unlock button when pin is too short", () => {
    renderAuthGateScreen({ pin: "12" });

    expect(screen.getByText("UNLOCK DECKOS")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "UNLOCK" })).toBeDisabled();
  });

  it("calls unlock handler on button click and pin change from entry", async () => {
    const user = userEvent.setup();
    const onUnlock = vi.fn();
    const onPinChange = vi.fn();
    renderAuthGateScreen({ pin: "1234", onUnlock, onPinChange });

    fireEvent.change(screen.getAllByRole("textbox")[0], { target: { value: "5" } });
    expect(onPinChange).toHaveBeenCalledWith("5234");

    await user.click(screen.getByRole("button", { name: "UNLOCK" }));
    expect(onUnlock).toHaveBeenCalledTimes(1);
  });

  it("shows retry countdown and unlock error message", () => {
    renderAuthGateScreen({
      pin: "1234",
      retryAfterMs: 5200,
      unlockError: "Too many attempts",
    });

    expect(screen.getByText("Retry in 6s")).toBeInTheDocument();
    expect(screen.getByText("Too many attempts")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "UNLOCK" })).toBeDisabled();
  });

  it("shows unlocking button state", () => {
    renderAuthGateScreen({ pin: "1234", unlocking: true });
    expect(screen.getByRole("button", { name: "UNLOCKING..." })).toBeDisabled();
  });
});
