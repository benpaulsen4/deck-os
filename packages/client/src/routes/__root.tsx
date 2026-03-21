import { createRootRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { trpcClient, useTRPC } from "../trpc";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ToastContainer } from "../components/layout/ToastContainer";
import { useConnectionStore } from "../stores/connection";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Lock, Power, X } from "lucide-react";
import { RouteErrorComponent } from "../components/ui/RouteErrorComponent";
import { useApiHealth } from "../hooks/useApiHealth";
import { useToastStore } from "../stores/toast";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { PinEntry } from "../components/auth/PinEntry";
import { Button } from "../components/ui/Button";
import { authFetch, fetchAuthStatus, onUnauthorizedEvent } from "../lib/auth";

export const Route = createRootRoute({
  component: RootLayout,
  errorComponent: RouteErrorComponent,
});

function RootLayout() {
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
        const payload = (await response.json().catch(() => null)) as
          | { error?: string; retryAfterMs?: number }
          | null;
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

  if (authChecking) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <div className="label">LOADING SECURITY STATUS...</div>
        </div>
      </div>
    );
  }

  if (authEnabled && !authUnlocked) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <h1 className="auth-title">UNLOCK DECKOS</h1>
          <div className="auth-subtitle">Enter your passcode to continue</div>
          <PinEntry
            value={pin}
            onChange={setPin}
            onSubmit={() => {
              void handleUnlock();
            }}
            autoFocus
            disabled={unlocking}
          />
          <div className="auth-actions">
            <Button
              onClick={() => {
                void handleUnlock();
              }}
              disabled={pin.length < 4 || unlocking || retryAfterMs > 0}
            >
              {unlocking ? "UNLOCKING..." : "UNLOCK"}
            </Button>
          </div>
          {retryAfterMs > 0 && (
            <div className="auth-message auth-message--warning">
              Retry in {Math.ceil(retryAfterMs / 1000)}s
            </div>
          )}
          {unlockError && <div className="auth-message auth-message--error">{unlockError}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <TopBar authEnabled={authEnabled} onLock={handleLock} />
      <main className="app-content">
        <Outlet />
      </main>
      <ToastContainer />
    </div>
  );
}

function TopBar({
  authEnabled,
  onLock,
}: {
  authEnabled: boolean;
  onLock: () => Promise<void>;
}) {
  const trpc = useTRPC();
  const { addToast } = useToastStore();
  const { data: systemInfo } = useQuery(trpc.system.getInfo.queryOptions());
  const { data: updateStatus } = useQuery(
    trpc.system.getUpdateStatus.queryOptions(undefined, {
      refetchInterval: 10 * 60 * 1000,
    })
  );
  const { getConnectionStatus, getAnyConnected } = useConnectionStore();
  const scanlineApplied = useRef(false);
  const powerMenuRef = useRef<HTMLDivElement | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [powerMenuOpen, setPowerMenuOpen] = useState(false);
  const [pendingPowerAction, setPendingPowerAction] = useState<"shutdown" | "restart" | null>(
    null
  );

  const powerActionMutation = useMutation({
    mutationFn: async (action: "shutdown" | "restart") =>
      await trpcClient.system.powerAction.mutate({ action }),
    onSuccess: (result) => {
      addToast(
        result.action === "restart"
          ? "System restart requested"
          : "System shutdown requested",
        "info"
      );
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : "Unknown error";
      addToast(`Power action failed: ${message}`, "error");
    },
  });

  const hostname = systemInfo?.hostname || "DECKOS";
  useApiHealth();
  const currentPath = useRouterState({ select: (state) => state.location.pathname });

  useLayoutEffect(() => {
    if (!scanlineApplied.current) {
      scanlineApplied.current = true;
    }
  }, []);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (!powerMenuRef.current) return;
      const target = event.target as Node | null;
      if (target && !powerMenuRef.current.contains(target)) {
        setPowerMenuOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPowerMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const isAnyConnected = getAnyConnected();
  const apiStatus = getConnectionStatus("api");
  const isDashboardPath = currentPath === "/";
  const isAppsPath = currentPath === "/apps" || currentPath.startsWith("/apps/");
  const isFilesPath = currentPath === "/files" || currentPath.startsWith("/files/");
  const isSettingsPath = currentPath === "/settings" || currentPath.startsWith("/settings/");

  const connectionStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    fontSize: "var(--text-xs)",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  };

  const dotStyle: React.CSSProperties = {
    width: "6px",
    height: "6px",
    borderRadius: "50%",
  };

  const confirmTitle =
    pendingPowerAction === "restart" ? "Confirm Restart" : "Confirm Shutdown";
  const confirmMessage =
    pendingPowerAction === "restart"
      ? "Restart the host system now?"
      : "Shut down the host system now?";
  const confirmText = pendingPowerAction === "restart" ? "RESTART" : "SHUTDOWN";

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <div
            className={`topbar-logo ${!scanlineApplied.current ? "scanline-once" : ""}`}
          >
            DECKOS
          </div>
          <nav className="topbar-nav">
            <Link
              to="/"
              className="topbar-link"
              activeProps={{ className: "topbar-link topbar-link--active" }}
            >
              Dashboard
            </Link>
            <Link
              to="/apps"
              className="topbar-link"
              activeProps={{ className: "topbar-link topbar-link--active" }}
            >
              Apps
            </Link>
            <Link
              to="/files"
              className="topbar-link"
              activeProps={{ className: "topbar-link topbar-link--active" }}
            >
              Files
            </Link>
            <Link
              to="/settings"
              className="topbar-link"
              activeProps={{ className: "topbar-link topbar-link--active" }}
            >
              Settings
            </Link>
          </nav>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
            {updateStatus?.updateAvailable && (
              <Link to="/settings" className="topbar-update">
                UPDATE
              </Link>
            )}
            <div style={connectionStyle}>
              <div
                title={
                  apiStatus.connected
                    ? "Connected"
                    : apiStatus.attemptCount > 0
                      ? "Disconnected"
                      : "Connecting"
                }
                style={{
                  ...dotStyle,
                  background: apiStatus.connected
                    ? "var(--status-running)"
                    : apiStatus.attemptCount > 0 || isAnyConnected
                      ? "var(--status-stopped)"
                      : "var(--status-neutral)",
                }}
              />
            </div>
            <button
              className="topbar-hamburger"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Menu"
            >
              ☰
            </button>
            <div className="topbar-host">{hostname}</div>
            {authEnabled && (
              <button
                className="topbar-lock-trigger"
                onClick={() => {
                  void onLock();
                }}
                aria-label="Lock session"
                title="Lock session"
              >
                <Lock size={14} />
              </button>
            )}
            <div className="topbar-power-menu" ref={powerMenuRef}>
              <button
                className="topbar-power-trigger"
                onClick={() => setPowerMenuOpen((open) => !open)}
                aria-haspopup="menu"
                aria-expanded={powerMenuOpen}
                aria-label="Power menu"
              >
                <Power size={14} />
              </button>
              {powerMenuOpen && (
                <div className="topbar-power-dropdown" role="menu" aria-label="Power actions">
                  <button
                    className="topbar-power-item"
                    role="menuitem"
                    onClick={() => {
                      setPowerMenuOpen(false);
                      setPendingPowerAction("restart");
                    }}
                  >
                    RESTART
                  </button>
                  <button
                    className="topbar-power-item topbar-power-item--danger"
                    role="menuitem"
                    onClick={() => {
                      setPowerMenuOpen(false);
                      setPendingPowerAction("shutdown");
                    }}
                  >
                    SHUTDOWN
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {mobileMenuOpen && (
        <div className="topbar-menu-overlay">
          <button
            style={{
              position: "absolute",
              top: "8px",
              right: "8px",
              background: "transparent",
              border: "1px solid var(--border-primary)",
              color: "var(--text-secondary)",
              padding: "8px",
              cursor: "pointer",
            }}
            onClick={() => setMobileMenuOpen(false)}
          >
            <X size={20} />
          </button>
          <Link
            to="/"
            className="topbar-menu-link"
            style={{
              ...(isDashboardPath
                ? {
                    color: "var(--accent-primary)",
                    borderLeft: "2px solid var(--accent-primary)",
                  }
                : {}),
            }}
            onClick={() => setMobileMenuOpen(false)}
          >
            Dashboard
          </Link>
          <Link
            to="/apps"
            className="topbar-menu-link"
            style={{
              ...(isAppsPath
                ? {
                    color: "var(--accent-primary)",
                    borderLeft: "2px solid var(--accent-primary)",
                  }
                : {}),
            }}
            onClick={() => setMobileMenuOpen(false)}
          >
            Apps
          </Link>
          <Link
            to="/files"
            className="topbar-menu-link"
            style={{
              ...(isFilesPath
                ? {
                    color: "var(--accent-primary)",
                    borderLeft: "2px solid var(--accent-primary)",
                  }
                : {}),
            }}
            onClick={() => setMobileMenuOpen(false)}
          >
            Files
          </Link>
          <Link
            to="/settings"
            className="topbar-menu-link"
            style={{
              ...(isSettingsPath
                ? {
                    color: "var(--accent-primary)",
                    borderLeft: "2px solid var(--accent-primary)",
                  }
                : {}),
            }}
            onClick={() => setMobileMenuOpen(false)}
          >
            Settings
          </Link>
          {authEnabled && (
            <button
              className="topbar-menu-link"
              style={{ textAlign: "left", background: "transparent", border: "none" }}
              onClick={() => {
                setMobileMenuOpen(false);
                void onLock();
              }}
            >
              Lock Session
            </button>
          )}
        </div>
      )}

      <ConfirmDialog
        isOpen={pendingPowerAction !== null}
        title={confirmTitle}
        message={confirmMessage}
        confirmText={confirmText}
        onCancel={() => setPendingPowerAction(null)}
        onConfirm={() => {
          if (!pendingPowerAction) return;
          powerActionMutation.mutate(pendingPowerAction);
          setPendingPowerAction(null);
        }}
        variant="danger"
      />
    </>
  );
}
