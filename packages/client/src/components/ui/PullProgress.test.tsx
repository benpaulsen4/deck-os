import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PULL_CANCELLED_MESSAGE, PullProgress } from "./PullProgress";
import { MockEventSource } from "../../test/helpers/eventSource";

const authFetchMock = vi.fn();

vi.mock("../../lib/auth", async () => {
  const actual = await vi.importActual<typeof import("../../lib/auth")>("../../lib/auth");
  return {
    ...actual,
    authFetch: (...args: unknown[]) => authFetchMock(...args),
    fetchAuthStatus: vi.fn(async () => ({
      enabled: false,
      unlocked: true,
      sessionDurationMs: 0,
    })),
    emitUnauthorizedEvent: vi.fn(),
  };
});

async function renderRunningPull(onComplete = vi.fn()) {
  authFetchMock.mockResolvedValue(
    new Response(JSON.stringify({ jobId: "job-1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );

  render(<PullProgress isOpen appId="app-1" onComplete={onComplete} />);
  await waitFor(() => {
    expect(MockEventSource.instances.length).toBe(1);
  });
  return { onComplete, source: MockEventSource.latest() };
}

describe("PullProgress", () => {
  beforeEach(() => {
    authFetchMock.mockReset();
    MockEventSource.reset();
    vi.useRealTimers();
  });

  // CLI-15: the modal previously had no button, no Escape handler and a
  // non-interactive backdrop, so a stalled pull trapped the admin behind an
  // opaque full-screen overlay with a page reload as the only exit.
  it("offers a cancel control while the pull is running", async () => {
    await renderRunningPull();
    expect(screen.getByRole("button", { name: "CANCEL" })).toBeInTheDocument();
  });

  it("cancels via the button, tearing down the stream and reporting through onComplete", async () => {
    const user = userEvent.setup();
    const { onComplete, source } = await renderRunningPull();

    await user.click(screen.getByRole("button", { name: "CANCEL" }));

    // The existing `{ ok, error }` contract, so the route call sites are unchanged.
    expect(onComplete).toHaveBeenCalledWith({
      ok: false,
      error: PULL_CANCELLED_MESSAGE,
    });
    expect(source.readyState).toBe(2);
    expect(screen.getByText(PULL_CANCELLED_MESSAGE)).toBeInTheDocument();
  });

  it("cancels on Escape", async () => {
    const user = userEvent.setup();
    const { onComplete, source } = await renderRunningPull();

    await user.keyboard("{Escape}");

    expect(onComplete).toHaveBeenCalledWith({
      ok: false,
      error: PULL_CANCELLED_MESSAGE,
    });
    expect(source.readyState).toBe(2);
  });

  it("ignores a late stream update after cancelling", async () => {
    const user = userEvent.setup();
    const { onComplete, source } = await renderRunningPull();

    await user.click(screen.getByRole("button", { name: "CANCEL" }));
    act(() => {
      source.dispatchMessage("pull", {
        status: "done",
        progress: {
          currentBytes: 1,
          totalBytes: 1,
          percent: 100,
          completedImages: 1,
          totalImages: 1,
          indeterminate: false,
        },
      });
    });

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith({
      ok: false,
      error: PULL_CANCELLED_MESSAGE,
    });
  });

  it("still completes normally when the pull finishes", async () => {
    vi.useFakeTimers();
    const onComplete = vi.fn();
    authFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ jobId: "job-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    render(<PullProgress isOpen appId="app-1" onComplete={onComplete} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      MockEventSource.latest().dispatchMessage("pull", {
        status: "done",
        progress: {
          currentBytes: 1,
          totalBytes: 1,
          percent: 100,
          completedImages: 1,
          totalImages: 1,
          indeterminate: false,
        },
      });
    });
    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    expect(onComplete).toHaveBeenCalledWith({ ok: true });
  });
});
