import { createFileRoute } from "@tanstack/react-router";
import { useTRPC } from "../trpc";
import { useQuery } from "@tanstack/react-query";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const trpc = useTRPC();
  const { data: systemInfo, isLoading } = useQuery(trpc.system.getInfo.queryOptions());

  const formatUptime = (seconds: number): string => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${days}d ${hours}h ${minutes}m`;
  };

  return (
    <div className="page-container">
      <div className="page-header">
        <h1 className="page-title">Settings</h1>
      </div>

      <div className="panel" style={{ padding: "var(--space-3)" }}>
        <div className="label" style={{ marginBottom: "var(--space-2)" }}>
          SYSTEM INFORMATION
        </div>
        {isLoading ? (
          <div className="loading-scan" style={{ padding: "var(--space-2)" }}>
            <span className="label">LOADING...</span>
          </div>
        ) : systemInfo ? (
          <div style={{ display: "grid", gap: "var(--space-2)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
              <span className="system-info-label" style={{ width: "120px" }}>HOSTNAME</span>
              <span className="system-info-value">{systemInfo.hostname}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
              <span className="system-info-label" style={{ width: "120px" }}>OS</span>
              <span className="system-info-value">{systemInfo.os}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
              <span className="system-info-label" style={{ width: "120px" }}>DISTRO</span>
              <span className="system-info-value">{systemInfo.osDistro || "N/A"}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
              <span className="system-info-label" style={{ width: "120px" }}>RELEASE</span>
              <span className="system-info-value">{systemInfo.osRelease || "N/A"}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
              <span className="system-info-label" style={{ width: "120px" }}>ARCHITECTURE</span>
              <span className="system-info-value">{systemInfo.osArch || "N/A"}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
              <span className="system-info-label" style={{ width: "120px" }}>NODE VERSION</span>
              <span className="system-info-value">{systemInfo.nodeVersion}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
              <span className="system-info-label" style={{ width: "120px" }}>UPTIME</span>
              <span className="system-info-value">{formatUptime(systemInfo.uptime)}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
              <span className="system-info-label" style={{ width: "120px" }}>DOCKER VERSION</span>
              <span className="system-info-value">{systemInfo.dockerVersion || "NOT INSTALLED"}</span>
            </div>
          </div>
        ) : null}
      </div>

      <div className="panel" style={{ padding: "var(--space-3)", marginTop: "var(--space-2)" }}>
        <div className="label" style={{ marginBottom: "var(--space-2)" }}>
          ABOUT
        </div>
        <div style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
          <div>DeckOS v0.1.0</div>
          <div style={{ marginTop: "var(--space-1)", color: "var(--text-muted)" }}>
            Self-hosted homelab management platform
          </div>
        </div>
      </div>
    </div>
  );
}