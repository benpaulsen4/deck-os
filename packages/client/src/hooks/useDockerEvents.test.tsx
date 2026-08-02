import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDockerEvents } from "./useDockerEvents";
import { useConnectionStore } from "../stores/connection";
import { MockEventSource } from "../test/helpers/eventSource";

const fetchAuthStatusMock = vi.fn();
const emitUnauthorizedEventMock = vi.fn();

vi.mock("../lib/auth", () => ({
  fetchAuthStatus: (...args: unknown[]) => fetchAuthStatusMock(...args),
  emitUnauthorizedEvent: (...args: unknown[]) => emitUnauthorizedEventMock(...args),
}));

describe("useDockerEvents", () => {
  beforeEach(() => {
    fetchAuthStatusMock.mockReset();
    emitUnauthorizedEventMock.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.useRealTimers();
    MockEventSource.reset();
    useConnectionStore.setState({
      connections: {
        api: { connected: false, lastConnectedAt: null, attemptCount: 0 },
        metrics: { connected: false, lastConnectedAt: null, attemptCount: 0 },
        events: { connected: false, lastConnectedAt: null, attemptCount: 0 },
        logs: { connected: false, lastConnectedAt: null, attemptCount: 0 },
      },
    });
  });

  it("connects, parses docker events, and updates connection state", () => {
    const callback = vi.fn();
    renderHook(() => useDockerEvents(callback));

    const source = MockEventSource.latest();
    expect(source.url).toBe("/api/docker/events");

    act(() => {
      source.dispatchOpen();
    });
    expect(useConnectionStore.getState().getConnectionStatus("events").connected).toBe(true);

    act(() => {
      source.dispatchMessage("docker-event", {
        Type: "container",
        Action: "start",
        Actor: { ID: "id-1", Attributes: { name: "deckos-a1" } },
        time: 1,
        timeNano: 1,
      });
    });

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]?.[0]).toMatchObject({ Action: "start" });
  });

  it("handles stream errors, emits unauthorized event, and reconnects", async () => {
    vi.useFakeTimers();
    fetchAuthStatusMock.mockResolvedValue({ enabled: true, unlocked: false });
    const callback = vi.fn();

    renderHook(() => useDockerEvents(callback));
    const source = MockEventSource.latest();

    act(() => {
      source.dispatchError(new Error("disconnected"));
    });

    await Promise.resolve();
    expect(useConnectionStore.getState().getConnectionStatus("events").connected).toBe(false);
    expect(fetchAuthStatusMock).toHaveBeenCalledTimes(1);
    expect(emitUnauthorizedEventMock).toHaveBeenCalledTimes(1);
    expect(source.readyState).toBe(2);

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(MockEventSource.instances.length).toBe(2);
  });

  // CLI-13: a flat 5s retry meant 720 attempts an hour, per tab, with Docker down.
  it("widens the reconnect delay while the stream keeps failing and resets on open", async () => {
    vi.useFakeTimers();
    fetchAuthStatusMock.mockResolvedValue({ enabled: false, unlocked: true });

    renderHook(() => useDockerEvents(vi.fn()));

    act(() => {
      MockEventSource.latest().dispatchError(new Error("docker down"));
    });
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(MockEventSource.instances.length).toBe(2);

    act(() => {
      MockEventSource.latest().dispatchError(new Error("docker down"));
    });

    // The second retry waits 10s, not another 5s.
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(MockEventSource.instances.length).toBe(2);

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(MockEventSource.instances.length).toBe(3);

    act(() => {
      MockEventSource.latest().dispatchOpen();
    });
    act(() => {
      MockEventSource.latest().dispatchError(new Error("docker down"));
    });

    // A successful open resets the delay to the base.
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(MockEventSource.instances.length).toBe(4);
  });

  it("keeps reconnecting under a delay ceiling and stops logging every failure", async () => {
    vi.useFakeTimers();
    fetchAuthStatusMock.mockResolvedValue({ enabled: false, unlocked: true });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    renderHook(() => useDockerEvents(vi.fn()));

    for (let i = 0; i < 8; i++) {
      act(() => {
        MockEventSource.latest().dispatchError(new Error("docker down"));
      });
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
    }

    // Every attempt still reconnects within the 60s ceiling...
    expect(MockEventSource.instances.length).toBe(9);
    // ...but the console is not filled at the same rate.
    expect(consoleError.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("does not connect when disabled", () => {
    const callback = vi.fn();
    renderHook(() => useDockerEvents(callback, { enabled: false }));

    expect(MockEventSource.instances.length).toBe(0);
    expect(useConnectionStore.getState().getConnectionStatus("events").connected).toBe(false);
  });
});
