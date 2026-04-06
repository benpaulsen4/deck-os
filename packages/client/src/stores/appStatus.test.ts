import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStatusStore } from "./appStatus";

describe("useAppStatusStore", () => {
  beforeEach(() => {
    vi.useRealTimers();
    useAppStatusStore.setState({
      appStatuses: {},
      stackStatuses: {},
      flashStates: {},
    });
  });

  it("sets and gets app statuses", () => {
    const store = useAppStatusStore.getState();
    store.setAppStatus("app-a", "running");

    expect(store.getAppStatus("app-a")).toBe("running");
    expect(store.getAppStatus("missing")).toBe("unknown");
  });

  it("sets stack statuses and resolves fallback status", () => {
    const store = useAppStatusStore.getState();
    store.setStackStatuses({
      "app-a": { running: 1, stopped: 0, restarting: 0, containers: [] },
      "app-b": { running: 0, stopped: 1, restarting: 0, containers: [] },
    });

    expect(store.getResolvedStatus("app-a")).toBe("running");
    expect(store.getResolvedStatus("app-b")).toBe("stopped");
    expect(store.getResolvedStatus("missing")).toBe("unknown");
  });

  it("prioritizes live status over stack status", () => {
    const store = useAppStatusStore.getState();
    store.setStackStatus("app-a", { running: 0, stopped: 1, restarting: 0, containers: [] });
    store.setAppStatus("app-a", "restarting");

    expect(store.getResolvedStatus("app-a")).toBe("restarting");
  });

  it("triggers and clears flash state", () => {
    vi.useFakeTimers();
    const store = useAppStatusStore.getState();
    store.triggerFlash("app-a");

    expect(useAppStatusStore.getState().flashStates["app-a"]).toBe(true);

    vi.advanceTimersByTime(200);
    expect(useAppStatusStore.getState().flashStates["app-a"]).toBeUndefined();
  });
});
