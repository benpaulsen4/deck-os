import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useApiHealth } from "./useApiHealth";
import { useConnectionStore } from "../stores/connection";

const useQueryMock = vi.fn();
const authFetchMock = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useQuery: (...args: unknown[]) => useQueryMock(...args),
}));

vi.mock("../lib/auth", () => ({
  authFetch: (...args: unknown[]) => authFetchMock(...args),
}));

describe("useApiHealth", () => {
  beforeEach(() => {
    useQueryMock.mockReset();
    authFetchMock.mockReset();
    useConnectionStore.setState({
      connections: {
        api: { connected: false, lastConnectedAt: null, attemptCount: 0 },
        metrics: { connected: false, lastConnectedAt: null, attemptCount: 0 },
        events: { connected: false, lastConnectedAt: null, attemptCount: 0 },
        logs: { connected: false, lastConnectedAt: null, attemptCount: 0 },
      },
    });
  });

  it("marks API connected when the query succeeds", async () => {
    useQueryMock.mockReturnValue({
      isSuccess: true,
      isError: false,
      isRefetchError: false,
      dataUpdatedAt: 1,
      errorUpdatedAt: 0,
    });

    renderHook(() => useApiHealth());

    await waitFor(() => {
      expect(useConnectionStore.getState().getConnectionStatus("api").connected).toBe(true);
    });
  });

  it("marks API disconnected when query fails", async () => {
    useConnectionStore.getState().setConnected("api", true);
    useQueryMock.mockReturnValue({
      isSuccess: false,
      isError: true,
      isRefetchError: false,
      dataUpdatedAt: 0,
      errorUpdatedAt: 1,
    });

    renderHook(() => useApiHealth());

    await waitFor(() => {
      expect(useConnectionStore.getState().getConnectionStatus("api").connected).toBe(false);
    });
  });

  it("configures query behavior and handles health query responses", async () => {
    useQueryMock.mockReturnValue({
      isSuccess: false,
      isError: false,
      isRefetchError: false,
      dataUpdatedAt: 0,
      errorUpdatedAt: 0,
    });

    renderHook(() => useApiHealth());

    const options = useQueryMock.mock.calls[0]?.[0] as {
      queryKey: string[];
      refetchInterval: number;
      retry: number;
      queryFn: () => Promise<unknown>;
    };

    expect(options.queryKey).toEqual(["health-check"]);
    expect(options.refetchInterval).toBe(10000);
    expect(options.retry).toBe(0);

    authFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    await expect(options.queryFn()).resolves.toEqual({ status: "ok" });
    expect(authFetchMock).toHaveBeenCalledWith("/api/health", { cache: "no-store" });

    authFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: "bad" }), { status: 500 }));
    await expect(options.queryFn()).rejects.toThrow("Health check failed");
  });
});
