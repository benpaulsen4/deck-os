import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Route } from "../__root";

const authState = vi.hoisted(() => ({
  authChecking: false,
  authEnabled: false,
  authUnlocked: true,
  pin: "",
  setPin: vi.fn(),
  unlockError: null as string | null,
  unlocking: false,
  retryAfterMs: null as number | null,
  handleUnlock: vi.fn(async () => {}),
  handleLock: vi.fn(),
}));

vi.mock("../../hooks/useAuthGate", () => ({
  useAuthGate: () => authState,
}));

vi.mock("../../hooks/useAppStatus", () => ({
  useAppStatus: vi.fn(),
}));

vi.mock("../../components/auth/AuthGateScreen", () => ({
  AuthGateScreen: () => <div>AUTH_GATE</div>,
}));

vi.mock("../../components/layout/TopBar", () => ({
  TopBar: () => <div>TOP_BAR</div>,
}));

vi.mock("../../components/layout/ToastContainer", () => ({
  ToastContainer: () => <div>TOASTS</div>,
}));

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual("@tanstack/react-router");
  return {
    ...actual,
    Outlet: () => <div>OUTLET</div>,
  };
});

describe("root auth gate route", () => {
  it("shows auth gate while locked", () => {
    authState.authEnabled = true;
    authState.authUnlocked = false;
    authState.authChecking = false;
    const Component = Route.options.component;
    render(<Component />);
    expect(screen.getByText("AUTH_GATE")).toBeInTheDocument();
  });

  it("renders shell when unlocked", () => {
    authState.authEnabled = true;
    authState.authUnlocked = true;
    authState.authChecking = false;
    const Component = Route.options.component;
    render(<Component />);
    expect(screen.getByText("TOP_BAR")).toBeInTheDocument();
    expect(screen.getByText("OUTLET")).toBeInTheDocument();
    expect(screen.getByText("TOASTS")).toBeInTheDocument();
  });
});
