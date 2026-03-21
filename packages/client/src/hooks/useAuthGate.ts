import { useEffect, useState } from "react";
import { authFetch, fetchAuthStatus, onUnauthorizedEvent } from "../lib/auth";

export function useAuthGate() {
  const [authChecking, setAuthChecking] = useState(true);
  const [authEnabled, setAuthEnabled] = useState(false);
  const [authUnlocked, setAuthUnlocked] = useState(true);
  const [pin, setPin] = useState("");
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [retryAfterMs, setRetryAfterMs] = useState(0);

  const refreshAuth = async () => {
    try {
      const status = await fetchAuthStatus();
      setAuthEnabled(status.enabled);
      setAuthUnlocked(status.unlocked);
    } finally {
      setAuthChecking(false);
    }
  };

  useEffect(() => {
    void refreshAuth();
    const unsubscribe = onUnauthorizedEvent(() => {
      setAuthEnabled(true);
      setAuthUnlocked(false);
    });
    return unsubscribe;
  }, []);

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
        const payload = (await response.json().catch(() => null)) as {
          error?: string;
          retryAfterMs?: number;
        } | null;
        if (typeof payload?.retryAfterMs === "number" && payload.retryAfterMs > 0) {
          setRetryAfterMs(payload.retryAfterMs);
        }
        throw new Error(payload?.error || "Unlock failed");
      }
      setPin("");
      await refreshAuth();
    } catch (error) {
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
  };

  return {
    authChecking,
    authEnabled,
    authUnlocked,
    pin,
    setPin,
    unlockError,
    unlocking,
    retryAfterMs,
    handleUnlock,
    handleLock,
  };
}
