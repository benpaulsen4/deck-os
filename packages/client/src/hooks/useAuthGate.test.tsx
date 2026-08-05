import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthGate } from "./useAuthGate";
import {
  AUTH_CONFIG_UNAVAILABLE_MESSAGE,
  AUTH_MALFORMED_REQUEST_MESSAGE,
  AuthRequestError,
} from "../lib/auth";

const fetchAuthStatusMock = vi.fn();
const authFetchMock = vi.fn();
const onUnauthorizedEventMock = vi.fn();
let unauthorizedHandler: (() => void) | null = null;

vi.mock("../lib/auth", async () => {
  const actual = await vi.importActual<typeof import("../lib/auth")>("../lib/auth");
  return {
    ...actual,
    fetchAuthStatus: (...args: unknown[]) => fetchAuthStatusMock(...args),
    authFetch: (...args: unknown[]) => authFetchMock(...args),
    onUnauthorizedEvent: (handler: () => void) => {
      unauthorizedHandler = handler;
      onUnauthorizedEventMock(handler);
      return () => {
        unauthorizedHandler = null;
      };
    },
  };
});

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function renderAuthGate() {
  return renderHook(() => useAuthGate(), { wrapper });
}

describe("useAuthGate", () => {
  beforeEach(() => {
    fetchAuthStatusMock.mockReset();
    authFetchMock.mockReset();
    onUnauthorizedEventMock.mockReset();
    unauthorizedHandler = null;
    vi.useRealTimers();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
  });

  it("loads auth status on mount", async () => {
    fetchAuthStatusMock.mockResolvedValue({
      enabled: true,
      unlocked: false,
      sessionDurationMs: 86_400_000,
    });

    const { result } = renderAuthGate();

    await waitFor(() => {
      expect(result.current.authChecking).toBe(false);
    });

    expect(result.current.authEnabled).toBe(true);
    expect(result.current.authUnlocked).toBe(false);
    expect(onUnauthorizedEventMock).toHaveBeenCalledTimes(1);
  });

  it("unlocks successfully and refreshes auth state", async () => {
    fetchAuthStatusMock
      .mockResolvedValueOnce({
        enabled: true,
        unlocked: false,
        sessionDurationMs: 86_400_000,
      })
      .mockResolvedValueOnce({
        enabled: true,
        unlocked: true,
        sessionDurationMs: 86_400_000,
      });
    authFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const { result } = renderAuthGate();

    await waitFor(() => {
      expect(result.current.authChecking).toBe(false);
    });

    await act(async () => {
      result.current.setPin("1234");
    });
    await act(async () => {
      await result.current.handleUnlock();
    });

    expect(authFetchMock).toHaveBeenCalledWith("/api/auth/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passcode: "1234" }),
    });
    expect(result.current.pin).toBe("");
    expect(result.current.authUnlocked).toBe(true);
    expect(result.current.unlockError).toBeNull();
  });

  it("handles unlock failure with retry timer and error", async () => {
    fetchAuthStatusMock.mockResolvedValue({
      enabled: true,
      unlocked: false,
      sessionDurationMs: 86_400_000,
    });
    authFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Too many attempts", retryAfterMs: 3000 }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      })
    );

    const { result } = renderAuthGate();

    await waitFor(() => {
      expect(result.current.authChecking).toBe(false);
    });

    vi.useFakeTimers();
    await act(async () => {
      result.current.setPin("4321");
    });
    await act(async () => {
      await result.current.handleUnlock();
    });

    expect(result.current.unlockError).toBe("Too many attempts");
    expect(result.current.retryAfterMs).toBe(3000);

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.retryAfterMs).toBe(2000);
  });

  it("locks when unauthorized event is emitted and when handleLock runs", async () => {
    fetchAuthStatusMock.mockResolvedValue({
      enabled: true,
      unlocked: true,
      sessionDurationMs: 86_400_000,
    });
    authFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const { result } = renderAuthGate();

    await waitFor(() => {
      expect(result.current.authChecking).toBe(false);
    });

    act(() => {
      unauthorizedHandler?.();
    });
    expect(result.current.authUnlocked).toBe(false);

    await act(async () => {
      await result.current.handleLock();
    });

    expect(authFetchMock).toHaveBeenCalledWith("/api/auth/lock", { method: "POST" });
    expect(result.current.authUnlocked).toBe(false);
  });

  // CLI-4
  it("fails closed when the status request fails instead of rendering the shell", async () => {
    fetchAuthStatusMock.mockRejectedValue(
      new AuthRequestError("server-error", "boom", { status: 500 })
    );

    const { result } = renderAuthGate();

    await waitFor(() => {
      expect(result.current.authChecking).toBe(false);
    });

    expect(result.current.authEnabled).toBe(true);
    expect(result.current.authUnlocked).toBe(false);
    expect(result.current.authStatusError).toBe("boom");
  });

  // CLI-4: the fail-closed path must not wedge a panel whose passcode is off.
  it("recovers on a scheduled retry once the status endpoint answers again", async () => {
    vi.useFakeTimers();
    fetchAuthStatusMock
      .mockRejectedValueOnce(new AuthRequestError("network", "offline"))
      .mockResolvedValue({ enabled: false, unlocked: true, sessionDurationMs: 0 });

    const { result } = renderAuthGate();

    await act(async () => {});
    expect(result.current.authEnabled).toBe(true);
    expect(result.current.authUnlocked).toBe(false);
    expect(fetchAuthStatusMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    expect(fetchAuthStatusMock).toHaveBeenCalledTimes(2);
    expect(result.current.authEnabled).toBe(false);
    expect(result.current.authUnlocked).toBe(true);
    expect(result.current.authStatusError).toBeNull();
  });

  it("widens the retry delay while the status endpoint keeps failing", async () => {
    vi.useFakeTimers();
    fetchAuthStatusMock.mockRejectedValue(new AuthRequestError("network", "offline"));

    renderAuthGate();

    await act(async () => {});
    expect(fetchAuthStatusMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(fetchAuthStatusMock).toHaveBeenCalledTimes(2);

    // The second retry waits 2s, not another 1s.
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(fetchAuthStatusMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(fetchAuthStatusMock).toHaveBeenCalledTimes(3);
  });

  // CLI-4, review finding 3: fail closed, but do not flap an operator who is
  // already authorized back to the gate on one unanswered request.
  it("holds last-known-good on a transport failure after a status read has succeeded", async () => {
    fetchAuthStatusMock
      .mockResolvedValueOnce({
        enabled: true,
        unlocked: true,
        sessionDurationMs: 86_400_000,
      })
      .mockRejectedValueOnce(new AuthRequestError("network", "offline"));

    const { result } = renderAuthGate();
    await waitFor(() => {
      expect(result.current.authChecking).toBe(false);
    });
    expect(result.current.authUnlocked).toBe(true);

    await act(async () => {
      await result.current.refreshAuth();
    });

    expect(result.current.authUnlocked).toBe(true);
    expect(result.current.authStatusError).toBe("offline");
  });

  it("still fails closed on an HTTP answer, even after a successful read", async () => {
    fetchAuthStatusMock
      .mockResolvedValueOnce({
        enabled: true,
        unlocked: true,
        sessionDurationMs: 86_400_000,
      })
      .mockRejectedValueOnce(
        new AuthRequestError("server-error", "boom", { status: 500 })
      );

    const { result } = renderAuthGate();
    await waitFor(() => {
      expect(result.current.authChecking).toBe(false);
    });

    await act(async () => {
      await result.current.refreshAuth();
    });

    expect(result.current.authEnabled).toBe(true);
    expect(result.current.authUnlocked).toBe(false);
  });

  it("keeps an operator unlocked when the refresh confirming their unlock fails", async () => {
    fetchAuthStatusMock
      .mockResolvedValueOnce({
        enabled: true,
        unlocked: false,
        sessionDurationMs: 86_400_000,
      })
      .mockRejectedValue(new AuthRequestError("network", "offline"));
    authFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ enabled: true, unlocked: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const { result } = renderAuthGate();
    await waitFor(() => {
      expect(result.current.authChecking).toBe(false);
    });

    await act(async () => {
      result.current.setPin("1234");
    });
    await act(async () => {
      await result.current.handleUnlock();
    });

    expect(result.current.authUnlocked).toBe(true);
    expect(result.current.pin).toBe("");
  });

  it("cancels the pending status retry on unmount", async () => {
    vi.useFakeTimers();
    fetchAuthStatusMock.mockRejectedValue(new AuthRequestError("network", "offline"));

    const { unmount } = renderAuthGate();
    await act(async () => {});
    expect(fetchAuthStatusMock).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    expect(fetchAuthStatusMock).toHaveBeenCalledTimes(1);
  });

  // CLI-4: the response codes batch G added server-side.
  it("reports a 503 config-unreadable unlock as a repair task, not a wrong passcode", async () => {
    fetchAuthStatusMock.mockResolvedValue({
      enabled: true,
      unlocked: false,
      sessionDurationMs: 86_400_000,
    });
    authFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Passcode configuration could not be read." }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      })
    );

    const { result } = renderAuthGate();
    await waitFor(() => {
      expect(result.current.authChecking).toBe(false);
    });

    await act(async () => {
      result.current.setPin("1234");
    });
    await act(async () => {
      await result.current.handleUnlock();
    });

    expect(result.current.authErrorKind).toBe("config-unavailable");
    expect(result.current.authConfigUnavailable).toBe(true);
    expect(result.current.unlockError).toBe(AUTH_CONFIG_UNAVAILABLE_MESSAGE);
    expect(result.current.unlockError).not.toMatch(/incorrect|invalid/i);
    expect(result.current.authUnlocked).toBe(false);
  });

  it("reports a 415 unlock as a malformed request", async () => {
    fetchAuthStatusMock.mockResolvedValue({
      enabled: true,
      unlocked: false,
      sessionDurationMs: 86_400_000,
    });
    authFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Content-Type must be application/json" }), {
        status: 415,
        headers: { "Content-Type": "application/json" },
      })
    );

    const { result } = renderAuthGate();
    await waitFor(() => {
      expect(result.current.authChecking).toBe(false);
    });

    await act(async () => {
      result.current.setPin("1234");
    });
    await act(async () => {
      await result.current.handleUnlock();
    });

    expect(result.current.authErrorKind).toBe("malformed-request");
    expect(result.current.authConfigUnavailable).toBe(false);
    expect(result.current.unlockError).toBe(AUTH_MALFORMED_REQUEST_MESSAGE);
  });

  // CLI-12
  it("clears cached query data when locking and when the session is revoked", async () => {
    fetchAuthStatusMock.mockResolvedValue({
      enabled: true,
      unlocked: true,
      sessionDurationMs: 86_400_000,
    });
    authFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const { result } = renderAuthGate();
    await waitFor(() => {
      expect(result.current.authChecking).toBe(false);
    });

    queryClient.setQueryData(["apps", "list"], [{ id: "a", compose: "secret" }]);
    expect(queryClient.getQueryData(["apps", "list"])).toBeDefined();

    act(() => {
      unauthorizedHandler?.();
    });
    expect(queryClient.getQueryData(["apps", "list"])).toBeUndefined();

    queryClient.setQueryData(["apps", "list"], [{ id: "a", compose: "secret" }]);
    await act(async () => {
      await result.current.handleLock();
    });
    expect(queryClient.getQueryData(["apps", "list"])).toBeUndefined();
  });
});
