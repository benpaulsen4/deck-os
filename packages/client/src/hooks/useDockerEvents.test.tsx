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

  it("does not connect when disabled", () => {
    const callback = vi.fn();
    renderHook(() => useDockerEvents(callback, { enabled: false }));

    expect(MockEventSource.instances.length).toBe(0);
    expect(useConnectionStore.getState().getConnectionStatus("events").connected).toBe(false);
  });
});
