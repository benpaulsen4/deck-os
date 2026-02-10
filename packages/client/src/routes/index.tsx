import { createFileRoute, Link } from "@tanstack/react-router";
import { useTRPC } from "../trpc";
import { useQuery } from "@tanstack/react-query";
import { useMetricsStream } from "../hooks/useMetricsStream";
import { MetricsCard } from "../components/layout/MetricsCard";
import { SystemInfoBar } from "../components/layout/SystemInfoBar";
import { AppTile } from "../components/layout/AppTile";
import type { SystemMetrics } from "../../../server/src/lib/schema.js";

export const Route = createFileRoute("/")({
  component: DashboardPage,
});

function DashboardPage() {
  const trpc = useTRPC();
  const metrics = useMetricsStream();
  const { data: apps } = useQuery(trpc.apps.list.queryOptions());

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  const formatSpeed = (bytesPerSecond: number): string => {
    return formatBytes(bytesPerSecond) + "/s";
  };

  const getCpuUsageBarWidth = (m: SystemMetrics): number => {
    return m.cpu.usage || 0;
  };

  const getMemoryUsageBarWidth = (m: SystemMetrics): number => {
    return m.memory.usage || 0;
  };

  const getDiskUsageBarWidth = (m: SystemMetrics): number => {
    if (m.disk.fs.length === 0) return 0;
    return m.disk.fs[0].usePercent || 0;
  };

  const getNetworkRxSpeed = (m: SystemMetrics): number => {
    const speeds = Object.values(m.network.interfaces).map(i => i.rx_sec || 0);
    return speeds.reduce((a, b) => a + b, 0);
  };

  const getNetworkTxSpeed = (m: SystemMetrics): number => {
    const speeds = Object.values(m.network.interfaces).map(i => i.tx_sec || 0);
    return speeds.reduce((a, b) => a + b, 0);
  };

  return (
    <div className="page-container">
      <div className="page-header">
        <h1 className="page-title">Dashboard</h1>
      </div>

      <SystemInfoBar />

      <div className="metrics-grid">
        {metrics.metrics ? (
          <>
            <MetricsCard
              label="CPU"
              color="var(--meter-cpu)"
              value={`${Math.round(metrics.metrics.cpu.usage || 0)}%`}
              usage={getCpuUsageBarWidth(metrics.metrics)}
              historyValues={(m) => m.cpu.usage}
            />
            <MetricsCard
              label="MEMORY"
              color="var(--meter-memory)"
              value={`${formatBytes(metrics.metrics.memory.used)} / ${formatBytes(metrics.metrics.memory.total)}`}
              usage={getMemoryUsageBarWidth(metrics.metrics)}
              historyValues={(m) => m.memory.usage}
            />
            <MetricsCard
              label="DISK"
              color="var(--meter-disk)"
              value={`${formatBytes(metrics.metrics.disk.fs[0]?.used || 0)} / ${formatBytes(metrics.metrics.disk.fs[0]?.size || 0)}`}
              usage={getDiskUsageBarWidth(metrics.metrics)}
              historyValues={(m) => m.disk.fs[0]?.usePercent || 0}
            />
            <MetricsCard
              label="NETWORK"
              color="var(--meter-network)"
              value={`↑ ${formatSpeed(getNetworkTxSpeed(metrics.metrics))} ↓ ${formatSpeed(getNetworkRxSpeed(metrics.metrics))}`}
              usage={50}
              historyValues={(m) =>
                Object.values(m.network.interfaces)
                  .map(i => i.rx_sec || 0)
                  .reduce((a, b) => a + b, 0) +
                Object.values(m.network.interfaces)
                  .map(i => i.tx_sec || 0)
                  .reduce((a, b) => a + b, 0)
              }
            />
          </>
        ) : (
          <div className="panel metric-card loading-scan" style={{ gridColumn: "1 / -1", alignItems: "center", justifyContent: "center", minHeight: "48px" }}>
            <span className="label">LOADING METRICS</span>
          </div>
        )}
      </div>

      <div style={{ marginTop: "var(--space-3)" }}>
        <div className="label" style={{ marginBottom: "var(--space-2)" }}>
          APPS
        </div>
        {apps && apps.length > 0 ? (
          <div className="app-launcher-grid">
            {apps.map((app) => (
              <AppTile key={app.id} app={app} />
            ))}
          </div>
        ) : (
          <div className="panel" style={{ padding: "var(--space-6)" }}>
            <div className="app-launcher-empty">
              NO APPS INSTALLED
              <br />
              <Link to="/apps/new">CREATE YOUR FIRST APP</Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
