import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMetricsStream } from "./useMetricsStream";
import { useConnectionStore } from "../stores/connection";
import { useMetricsStore } from "../stores/metrics";
import { MockEventSource } from "../test/helpers/eventSource";

const fetchAuthStatusMock = vi.fn();
const emitUnauthorizedEventMock = vi.fn();

vi.mock("../lib/auth", () => ({
  fetchAuthStatus: (...args: unknown[]) => fetchAuthStatusMock(...args),
  emitUnauthorizedEvent: (...args: unknown[]) => emitUnauthorizedEventMock(...args),
}));

const sampleMetrics = {
  cpu: { usage: 10, load: [0.1, 0.2, 0.3], cores: 4, speed: 2.1, temperatureC: 40, powerWatts: 20 },
  memory: {
    total: 1000,
    used: 500,
    free: 500,
    usage: 50,
    swapTotal: 200,
    swapUsed: 20,
    swapFree: 180,
    swapUsage: 10,
  },
  processes: { all: 100, running: 2, blocked: 0, sleeping: 98 },
  disk: { fs: [{ fs: "/dev/sda", mount: "/", size: 1000, used: 200, usePercent: 20 }] },
  network: { interfaces: { eth0: { rx_bytes: 1, tx_bytes: 2, rx_sec: 0.1, tx_sec: 0.2 } } },
  timestamp: "2026-01-01T00:00:00.000Z",
};

describe("useMetricsStream", () => {
  beforeEach(() => {
    fetchAuthStatusMock.mockReset();
    emitUnauthorizedEventMock.mockReset();
    MockEventSource.reset();
    useMetricsStore.setState({ metrics: null, history: [], isConnected: false });
    useConnectionStore.setState({
      connections: {
        api: { connected: false, lastConnectedAt: null, attemptCount: 0 },
        metrics: { connected: false, lastConnectedAt: null, attemptCount: 0 },
        events: { connected: false, lastConnectedAt: null, attemptCount: 0 },
        logs: { connected: false, lastConnectedAt: null, attemptCount: 0 },
      },
    });
  });

  it("sets connected flags on open and records metrics events", () => {
    const { unmount } = renderHook(() => useMetricsStream());
    const source = MockEventSource.latest();

    act(() => {
      source.dispatchOpen();
    });

    expect(useMetricsStore.getState().isConnected).toBe(true);
    expect(useConnectionStore.getState().getConnectionStatus("metrics").connected).toBe(true);

    act(() => {
      source.dispatchMessage("metrics", sampleMetrics);
    });

    expect(useMetricsStore.getState().metrics).toEqual(sampleMetrics);
    expect(useMetricsStore.getState().history).toHaveLength(1);

    unmount();
    expect(source.readyState).toBe(2);
    expect(useMetricsStore.getState().isConnected).toBe(false);
    expect(useConnectionStore.getState().getConnectionStatus("metrics").connected).toBe(false);
  });

  it("handles stream errors and emits unauthorized event for locked sessions", async () => {
    fetchAuthStatusMock.mockResolvedValue({ enabled: true, unlocked: false });
    renderHook(() => useMetricsStream());
    const source = MockEventSource.latest();

    act(() => {
      source.dispatchError(new Error("stream failed"));
    });

    await Promise.resolve();
    expect(useMetricsStore.getState().isConnected).toBe(false);
    expect(useConnectionStore.getState().getConnectionStatus("metrics").connected).toBe(false);
    expect(fetchAuthStatusMock).toHaveBeenCalledTimes(1);
    expect(emitUnauthorizedEventMock).toHaveBeenCalledTimes(1);
  });

  // CLI-7: an HTTP error response (401 from the auth middleware, 502 from a proxy
  // during a self-update restart) closes an EventSource permanently, so the hook
  // has to reconnect itself.
  it("closes the stream and reconnects with a widening delay after an error", async () => {
    vi.useFakeTimers();
    fetchAuthStatusMock.mockResolvedValue({ enabled: false, unlocked: true });

    renderHook(() => useMetricsStream());
    const first = MockEventSource.latest();

    act(() => {
      first.dispatchError(new Error("http 502"));
    });
    expect(first.readyState).toBe(2);

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(MockEventSource.instances.length).toBe(2);

    act(() => {
      MockEventSource.latest().dispatchError(new Error("http 502"));
    });

    // The second retry waits 2s, not another 1s.
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(MockEventSource.instances.length).toBe(2);

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(MockEventSource.instances.length).toBe(3);
  });

  it("resets the reconnect delay once the stream opens again", async () => {
    vi.useFakeTimers();
    fetchAuthStatusMock.mockResolvedValue({ enabled: false, unlocked: true });

    renderHook(() => useMetricsStream());

    act(() => {
      MockEventSource.latest().dispatchError(new Error("boom"));
    });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(MockEventSource.instances.length).toBe(2);

    act(() => {
      MockEventSource.latest().dispatchOpen();
    });
    act(() => {
      MockEventSource.latest().dispatchError(new Error("boom"));
    });

    // Back to the base delay, because the connection had succeeded.
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(MockEventSource.instances.length).toBe(3);
  });

  it("stops reconnecting after unmount", async () => {
    vi.useFakeTimers();
    fetchAuthStatusMock.mockResolvedValue({ enabled: false, unlocked: true });

    const { unmount } = renderHook(() => useMetricsStream());
    act(() => {
      MockEventSource.latest().dispatchError(new Error("boom"));
    });
    unmount();

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(MockEventSource.instances.length).toBe(1);
  });
});
