import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConnectionStore } from "./connection";

function resetConnections() {
  useConnectionStore.setState({
    connections: {
      api: { connected: false, lastConnectedAt: null, attemptCount: 0 },
      metrics: { connected: false, lastConnectedAt: null, attemptCount: 0 },
      events: { connected: false, lastConnectedAt: null, attemptCount: 0 },
      logs: { connected: false, lastConnectedAt: null, attemptCount: 0 },
    },
  });
}

describe("useConnectionStore", () => {
  beforeEach(() => {
    resetConnections();
  });

  it("marks connections online and stores timestamp", () => {
    vi.spyOn(Date, "now").mockReturnValue(12345);
    const store = useConnectionStore.getState();

    store.setConnected("api", true);

    const api = store.getConnectionStatus("api");
    expect(api.connected).toBe(true);
    expect(api.lastConnectedAt).toBe(12345);
    expect(api.attemptCount).toBe(0);
  });

  it("increments attempts when disconnected", () => {
    const store = useConnectionStore.getState();

    store.setConnected("events", false);
    store.setConnected("events", false);

    const events = store.getConnectionStatus("events");
    expect(events.connected).toBe(false);
    expect(events.attemptCount).toBe(2);
  });

  it("reports if any connection is online", () => {
    const store = useConnectionStore.getState();

    expect(store.getAnyConnected()).toBe(false);
    store.setConnected("metrics", true);
    expect(store.getAnyConnected()).toBe(true);
  });
});
