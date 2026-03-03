import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
import { useTRPC } from "../trpc";
import { useQuery } from "@tanstack/react-query";
import { ToastContainer } from "../components/layout/ToastContainer";
import { useConnectionStore } from "../stores/connection";
import { useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { RouteErrorComponent } from "../components/ui/RouteErrorComponent";
import { useApiHealth } from "../hooks/useApiHealth";

export const Route = createRootRoute({
  component: RootLayout,
  errorComponent: RouteErrorComponent,
});

function RootLayout() {
  return (
    <div className="app-shell">
      <TopBar />
      <main className="app-content">
        <Outlet />
      </main>
      <ToastContainer />
    </div>
  );
}

function TopBar() {
  const trpc = useTRPC();
  const { data: systemInfo } = useQuery(trpc.system.getInfo.queryOptions());
  const { data: updateStatus } = useQuery(
    trpc.system.getUpdateStatus.queryOptions(undefined, {
      refetchInterval: 10 * 60 * 1000,
    })
  );
  const { getConnectionStatus, getAnyConnected } = useConnectionStore();
  const scanlineApplied = useRef(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const hostname = systemInfo?.hostname || "DECKOS";
  useApiHealth();

  useLayoutEffect(() => {
    if (!scanlineApplied.current) {
      scanlineApplied.current = true;
    }
  }, []);

  const isAnyConnected = getAnyConnected();
  const apiStatus = getConnectionStatus("api");
  const currentPath = window.location.pathname;

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
              ...(currentPath === "/"
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
              ...(currentPath === "/apps"
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
            to="/settings"
            className="topbar-menu-link"
            style={{
              ...(currentPath === "/settings"
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
        </div>
      )}
    </>
  );
}
