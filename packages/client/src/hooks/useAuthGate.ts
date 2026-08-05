import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AUTH_STATUS_UNAVAILABLE_MESSAGE,
  AuthRequestError,
  authFetch,
  fetchAuthStatus,
  onUnauthorizedEvent,
  readAuthErrorResponse,
  type AuthFailureKind,
} from "../lib/auth";
import { getReconnectDelayMs } from "./useDockerEvents";

/**
 * A failed status check fails *closed* (see below), which means a flaky proxy or
 * a server restart would otherwise leave the operator staring at a lock screen
 * for a passcode that may not even exist. So every failure schedules a retry
 * with a widening delay until the status endpoint answers again.
 */
const STATUS_RETRY_BASE_MS = 1_000;
const STATUS_RETRY_MAX_MS = 30_000;

export function useAuthGate() {
  const queryClient = useQueryClient();
  const [authChecking, setAuthChecking] = useState(true);
  const [authEnabled, setAuthEnabled] = useState(false);
  const [authUnlocked, setAuthUnlocked] = useState(true);
  const [pin, setPin] = useState("");
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [retryAfterMs, setRetryAfterMs] = useState(0);
  const [authStatusError, setAuthStatusError] = useState<string | null>(null);
  const [authErrorKind, setAuthErrorKind] = useState<AuthFailureKind | null>(null);

  const statusRetryTimeoutRef = useRef<number | null>(null);
  const statusRetryAttemptRef = useRef(0);
  const disposedRef = useRef(false);
  /** Whether any status read has ever succeeded. Drives the fail-closed policy. */
  const hasReadStatusRef = useRef(false);
  const refreshAuthRef = useRef<() => Promise<void>>(async () => {});

  const clearStatusRetry = useCallback(() => {
    if (statusRetryTimeoutRef.current !== null) {
      window.clearTimeout(statusRetryTimeoutRef.current);
      statusRetryTimeoutRef.current = null;
    }
  }, []);

  const scheduleStatusRetry = useCallback(() => {
    if (disposedRef.current || statusRetryTimeoutRef.current !== null) {
      return;
    }
    const delay = getReconnectDelayMs(statusRetryAttemptRef.current, {
      baseMs: STATUS_RETRY_BASE_MS,
      maxMs: STATUS_RETRY_MAX_MS,
    });
    statusRetryAttemptRef.current += 1;
    statusRetryTimeoutRef.current = window.setTimeout(() => {
      statusRetryTimeoutRef.current = null;
      if (disposedRef.current) {
        return;
      }
      void refreshAuthRef.current();
    }, delay);
  }, []);

  const refreshAuth = useCallback(async () => {
    try {
      const status = await fetchAuthStatus();
      hasReadStatusRef.current = true;
      setAuthEnabled(status.enabled);
      setAuthUnlocked(status.unlocked);
      setAuthStatusError(null);
      setAuthErrorKind(null);
      statusRetryAttemptRef.current = 0;
      clearStatusRetry();
    } catch (error) {
      const kind = error instanceof AuthRequestError ? error.kind : "network";
      // Fail closed. Previously the permissive initial state (`enabled:false`,
      // `unlocked:true`) survived a failed status read and the full shell
      // rendered for an operator who had never unlocked anything.
      //
      // The one exception, decided deliberately: once a status read has
      // succeeded, a *transport* failure (no HTTP answer at all) holds the
      // last-known-good state while the retry runs, instead of throwing an
      // already-authorized operator back to the gate and discarding whatever was
      // in flight -- an unsaved compose edit, for instance. Any HTTP answer
      // (401, 503, 5xx) is a real signal and always locks, and the very first
      // read always locks, so CLI-4's guarantee holds: the shell is never
      // rendered to someone who was never authorized.
      if (!hasReadStatusRef.current || kind !== "network") {
        setAuthEnabled(true);
        setAuthUnlocked(false);
      }
      setAuthErrorKind(kind);
      setAuthStatusError(
        error instanceof AuthRequestError ? error.message : AUTH_STATUS_UNAVAILABLE_MESSAGE
      );
      scheduleStatusRetry();
    } finally {
      setAuthChecking(false);
    }
  }, [clearStatusRetry, scheduleStatusRetry]);

  useEffect(() => {
    refreshAuthRef.current = refreshAuth;
  }, [refreshAuth]);

  useEffect(() => {
    disposedRef.current = false;
    void refreshAuth();
    const unsubscribe = onUnauthorizedEvent(() => {
      setAuthEnabled(true);
      setAuthUnlocked(false);
      // Everything cached was fetched by a session that is now gone; leaving it
      // in the QueryClient means a locked console still hands out compose files,
      // file listings and system info via devtools.
      queryClient.clear();
    });
    return () => {
      disposedRef.current = true;
      clearStatusRetry();
      unsubscribe();
    };
    // `refreshAuth`, `clearStatusRetry` and `queryClient` are all stable, so this
    // effect subscribes exactly once.
  }, [refreshAuth, clearStatusRetry, queryClient]);

  useEffect(() => {
    if (retryAfterMs <= 0) {
      return;
    }
    const timeout = window.setTimeout(() => {
      setRetryAfterMs((value) => Math.max(0, value - 1000));
    }, 1000);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [retryAfterMs]);

  const handleUnlock = async () => {
    if (pin.length < 4 || unlocking || retryAfterMs > 0) {
      return;
    }
    setUnlocking(true);
    setUnlockError(null);
    try {
      const response = await authFetch("/api/auth/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode: pin }),
      });
      if (!response.ok) {
        const failure = await readAuthErrorResponse(response, "Unlock failed");
        if (failure.retryAfterMs !== null) {
          setRetryAfterMs(failure.retryAfterMs);
        }
        throw failure;
      }
      // The unlock response is itself an authoritative status. Adopting it before
      // the confirming refresh means a transient failure in that refresh holds
      // "unlocked" (see refreshAuth) rather than bouncing the operator straight
      // back to the gate they just cleared.
      const granted = (await response.json().catch(() => null)) as {
        unlocked?: unknown;
      } | null;
      if (granted?.unlocked === true) {
        hasReadStatusRef.current = true;
        setAuthEnabled(true);
        setAuthUnlocked(true);
      }
      setPin("");
      await refreshAuth();
    } catch (error) {
      setAuthErrorKind(error instanceof AuthRequestError ? error.kind : "network");
      setUnlockError(error instanceof Error ? error.message : "Unlock failed");
      setAuthUnlocked(false);
    } finally {
      setUnlocking(false);
    }
  };

  const handleLock = async () => {
    await authFetch("/api/auth/lock", {
      method: "POST",
    });
    setAuthUnlocked(false);
    // NOTE: the zustand stores (metrics, appStatus, connection) still hold their
    // last values after a lock; clearing them needs `stores/**`, which is owned
    // by another change. Tracked as a follow-up.
    queryClient.clear();
  };

  return {
    authChecking,
    authEnabled,
    authUnlocked,
    pin,
    setPin,
    // The gate screen has a single error slot, so the status failure shares it.
    // A fresh unlock attempt wins over a stale status error.
    unlockError: unlockError ?? authStatusError,
    authStatusError,
    authErrorKind,
    authConfigUnavailable: authErrorKind === "config-unavailable",
    unlocking,
    retryAfterMs,
    handleUnlock,
    handleLock,
    refreshAuth,
  };
}
