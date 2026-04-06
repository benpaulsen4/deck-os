import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

describe("ErrorBoundary", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("renders children when no error occurs", () => {
    render(
      <ErrorBoundary>
        <div>Healthy content</div>
      </ErrorBoundary>
    );

    expect(screen.getByText("Healthy content")).toBeInTheDocument();
  });

  it("renders fallback UI when a child throws", () => {
    const Thrower = () => {
      throw new Error("Unexpected crash");
    };

    render(
      <ErrorBoundary>
        <Thrower />
      </ErrorBoundary>
    );

    expect(screen.getByText("System Error")).toBeInTheDocument();
    expect(screen.getByText("Unexpected crash")).toBeInTheDocument();
    expect(screen.getByText("STACK TRACE:")).toBeInTheDocument();
  });

  it("logs caught errors to console", () => {
    const Thrower = () => {
      throw new Error("Console crash");
    };

    render(
      <ErrorBoundary>
        <Thrower />
      </ErrorBoundary>
    );

    expect(console.error).toHaveBeenCalled();
  });
});
