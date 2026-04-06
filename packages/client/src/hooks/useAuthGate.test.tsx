import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthGate } from "./useAuthGate";

const fetchAuthStatusMock = vi.fn();
const authFetchMock = vi.fn();
const onUnauthorizedEventMock = vi.fn();
let unauthorizedHandler: (() => void) | null = null;

vi.mock("../lib/auth", () => ({
  fetchAuthStatus: (...args: unknown[]) => fetchAuthStatusMock(...args),
  authFetch: (...args: unknown[]) => authFetchMock(...args),
  onUnauthorizedEvent: (handler: () => void) => {
    unauthorizedHandler = handler;
    onUnauthorizedEventMock(handler);
    return () => {
      unauthorizedHandler = null;
    };
  },
}));

describe("useAuthGate", () => {
  beforeEach(() => {
    fetchAuthStatusMock.mockReset();
    authFetchMock.mockReset();
    onUnauthorizedEventMock.mockReset();
    unauthorizedHandler = null;
    vi.useRealTimers();
  });

  it("loads auth status on mount", async () => {
    fetchAuthStatusMock.mockResolvedValue({
      enabled: true,
      unlocked: false,
      sessionDurationMs: 86_400_000,
    });

    const { result } = renderHook(() => useAuthGate());

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

    const { result } = renderHook(() => useAuthGate());

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

    const { result } = renderHook(() => useAuthGate());

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

    const { result } = renderHook(() => useAuthGate());

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
});
