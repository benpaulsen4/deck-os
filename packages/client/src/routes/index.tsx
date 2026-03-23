import { createFileRoute, Link } from "@tanstack/react-router";
import { useTRPC } from "../trpc";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useMetricsStream } from "../hooks/useMetricsStream";
import { MetricsCard } from "../components/layout/MetricsCard";
import { SystemInfoBar } from "../components/layout/SystemInfoBar";
import { AppLauncherGrid } from "../components/layout/AppLauncherGrid";
import { useToastStore } from "../stores/toast";
import { trpcClient } from "../trpc";
import { Button } from "../components/ui/Button";
import type { App, SystemMetrics } from "../../../server/src/lib/schema.js";

export const Route = createFileRoute("/")({
  component: DashboardPage,
});

function DashboardPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { addToast } = useToastStore();
  const metrics = useMetricsStream();
  const { data: apps } = useQuery(trpc.apps.list.queryOptions());
  const [showMoreMetrics, setShowMoreMetrics] = useState(false);

  type AppsList = App[];

  const reorderMutation = useMutation<
    unknown,
    unknown,
    string[],
    { previous?: AppsList }
  >({
    mutationFn: async (orderedIds: string[]) =>
      await trpcClient.apps.reorder.mutate({ orderedIds }),
    onMutate: async (orderedIds: string[]) => {
      await queryClient.cancelQueries({
        queryKey: trpc.apps.list.queryOptions().queryKey,
      });
      const previous = queryClient.getQueryData(
        trpc.apps.list.queryOptions().queryKey
      ) as AppsList | undefined;

      if (previous && Array.isArray(previous)) {
        const byId = new Map(previous.map((a) => [a.id, a] as const));
        const next = orderedIds
          .map((id) => byId.get(id))
          .filter((a): a is App => Boolean(a));
        queryClient.setQueryData(trpc.apps.list.queryOptions().queryKey, next);
      }

      return { previous };
    },
    onError: (err: unknown, _orderedIds, ctx) => {
      if (ctx?.previous) {
        queryClient.setQueryData(trpc.apps.list.queryOptions().queryKey, ctx.previous);
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      addToast(`Failed to reorder: ${message}`, "error");
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({
        queryKey: trpc.apps.list.queryOptions().queryKey,
      });
    },
  });

  const formatBytes = (bytes: number): string => {
    if (!Number.isFinite(bytes)) return "0 B";
    const sign = bytes < 0 ? "-" : "";
    const abs = Math.abs(bytes);
    if (abs === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(abs) / Math.log(k));
    return `${sign}${(abs / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  const formatBytesInUnit = (bytes: number, unitIndex: number): string => {
    const k = 1024;
    return (bytes / Math.pow(k, unitIndex)).toFixed(1);
  };

  const formatBytesPair = (
    usedBytes: number,
    totalBytes: number
  ): { used: string; total: string; unit: string } => {
    if (totalBytes <= 0) return { used: "0.0", total: "0.0", unit: "B" };
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const unitIndex = Math.min(
      sizes.length - 1,
      Math.max(0, Math.floor(Math.log(totalBytes) / Math.log(k)))
    );
    return {
      used: formatBytesInUnit(usedBytes, unitIndex),
      total: formatBytesInUnit(totalBytes, unitIndex),
      unit: sizes[unitIndex],
    };
  };

  const formatSpeedPair = (
    txBytesPerSecond: number,
    rxBytesPerSecond: number
  ): { tx: string; rx: string; unitPerSec: string } => {
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const max = Math.max(txBytesPerSecond, rxBytesPerSecond, 1);
    const unitIndex = Math.min(
      sizes.length - 1,
      Math.max(0, Math.floor(Math.log(max) / Math.log(k)))
    );
    return {
      tx: formatBytesInUnit(txBytesPerSecond, unitIndex),
      rx: formatBytesInUnit(rxBytesPerSecond, unitIndex),
      unitPerSec: `${sizes[unitIndex]}/s`,
    };
  };

  const formatSpeed = (bytesPerSecond: number): string => {
    return formatBytes(bytesPerSecond) + "/s";
  };

  const formatPercent = (value: number): string => {
    return `${Math.round(value)}%`;
  };

  const getDiskEntries = (m: SystemMetrics): SystemMetrics["disk"]["fs"] => {
    return m.disk.fs.filter((disk) => {
      const name = disk.fs.toLowerCase();
      const mount = disk.mount.toLowerCase();
      return (
        !name.includes("tmpfs") &&
        !name.includes("swap") &&
        !name.includes("efivars") &&
        !mount.includes("/efivars")
      );
    });
  };

  const getDiskTotals = (
    m: SystemMetrics
  ): { used: number; total: number; usage: number } => {
    const entries = getDiskEntries(m);
    const total = entries.reduce((sum, disk) => sum + (disk.size || 0), 0);
    const used = entries.reduce((sum, disk) => sum + (disk.used || 0), 0);
    return {
      used,
      total,
      usage: total > 0 ? (used / total) * 100 : 0,
    };
  };

  const getCpuUsageBarWidth = (m: SystemMetrics): number => {
    return m.cpu.usage || 0;
  };

  const getMemoryUsageBarWidth = (m: SystemMetrics): number => {
    return m.memory.usage || 0;
  };

  const getDiskUsageBarWidth = (m: SystemMetrics): number => {
    return getDiskTotals(m).usage;
  };

  const getNetworkRxSpeed = (m: SystemMetrics): number => {
    const speeds = Object.values(m.network.interfaces).map((i) => i.rx_sec || 0);
    return speeds.reduce((a, b) => a + b, 0);
  };

  const getNetworkTxSpeed = (m: SystemMetrics): number => {
    const speeds = Object.values(m.network.interfaces).map((i) => i.tx_sec || 0);
    return speeds.reduce((a, b) => a + b, 0);
  };

  return (
    <div className="page-container page-container--viewport dashboard-layout">
      <div className="page-header">
        <h1 className="page-title">Dashboard</h1>
      </div>
      <div className="page-body">
        <div className="page-grid-2col">
          <div className="page-col">
            <div className="dashboard-system-info">
              <SystemInfoBar />
            </div>
            <div className="page-col-scroll">
              <div className="metrics-grid">
                {metrics.metrics ? (
                  <>
                    <MetricsCard
                      label="CPU"
                      color="var(--meter-cpu)"
                      value={`${Math.round(metrics.metrics.cpu.usage || 0)}%`}
                      usage={getCpuUsageBarWidth(metrics.metrics)}
                      historyValues={(m) => m.cpu.usage}
                      formatSparkValue={formatPercent}
                      sparkMin={0}
                      sparkMax={100}
                    />
                    <MetricsCard
                      label="MEMORY"
                      color="var(--meter-memory)"
                      value={(() => {
                        const p = formatBytesPair(
                          metrics.metrics.memory.used,
                          metrics.metrics.memory.total
                        );
                        return (
                          <>
                            <span>{p.used}</span>
                            <span className="metric-value-sep">/</span>
                            <span className="metric-value-secondary">{p.total}</span>
                            <span className="metric-value-unit">{p.unit}</span>
                          </>
                        );
                      })()}
                      usage={getMemoryUsageBarWidth(metrics.metrics)}
                      historyValues={(m) => m.memory.usage}
                      formatSparkValue={formatPercent}
                      sparkMin={0}
                      sparkMax={100}
                    />
                    <MetricsCard
                      label="DISK"
                      color="var(--meter-disk)"
                      value={(() => {
                        const totals = getDiskTotals(metrics.metrics);
                        const used = totals.used;
                        const total = totals.total;
                        const p = formatBytesPair(used, total);
                        return (
                          <>
                            <span>{p.used}</span>
                            <span className="metric-value-sep">/</span>
                            <span className="metric-value-secondary">{p.total}</span>
                            <span className="metric-value-unit">{p.unit}</span>
                          </>
                        );
                      })()}
                      usage={getDiskUsageBarWidth(metrics.metrics)}
                      historyValues={(m) => getDiskTotals(m).usage}
                      formatSparkValue={formatPercent}
                      sparkMin={0}
                      sparkMax={100}
                    />
                    <MetricsCard
                      label="NETWORK"
                      color="var(--meter-network)"
                      value={(() => {
                        const tx = getNetworkTxSpeed(metrics.metrics);
                        const rx = getNetworkRxSpeed(metrics.metrics);
                        const p = formatSpeedPair(tx, rx);
                        return (
                          <>
                            <span className="metric-value-dir">↓</span>
                            <span>{p.rx}</span>
                            <span className="metric-value-dir">↑</span>
                            <span className="metric-value-secondary">{p.tx}</span>
                            <span className="metric-value-unit">{p.unitPerSec}</span>
                          </>
                        );
                      })()}
                      usage={50}
                      historyValues={(m) =>
                        Object.values(m.network.interfaces)
                          .map((i) => i.rx_sec || 0)
                          .reduce((a, b) => a + b, 0) +
                        Object.values(m.network.interfaces)
                          .map((i) => i.tx_sec || 0)
                          .reduce((a, b) => a + b, 0)
                      }
                      formatSparkValue={formatSpeed}
                    />
                    {showMoreMetrics ? (
                      <>
                        <MetricsCard
                          label="CPU TEMP"
                          color="var(--meter-cpu)"
                          value={
                            typeof metrics.metrics.cpu.temperatureC === "number" &&
                            Number.isFinite(metrics.metrics.cpu.temperatureC)
                              ? `${Math.round(metrics.metrics.cpu.temperatureC)}°C`
                              : "N/A"
                          }
                          usage={
                            typeof metrics.metrics.cpu.temperatureC === "number" &&
                            Number.isFinite(metrics.metrics.cpu.temperatureC)
                              ? Math.min(100, metrics.metrics.cpu.temperatureC)
                              : 0
                          }
                          historyValues={(m) => m.cpu.temperatureC ?? Number.NaN}
                          formatSparkValue={(v) => `${Math.round(v)}°C`}
                        />
                        <MetricsCard
                          label="CPU POWER"
                          color="var(--meter-cpu)"
                          value={
                            typeof metrics.metrics.cpu.powerWatts === "number" &&
                            Number.isFinite(metrics.metrics.cpu.powerWatts)
                              ? `${Math.round(metrics.metrics.cpu.powerWatts)} W`
                              : "N/A"
                          }
                          usage={
                            typeof metrics.metrics.cpu.powerWatts === "number" &&
                            Number.isFinite(metrics.metrics.cpu.powerWatts)
                              ? Math.min(100, metrics.metrics.cpu.powerWatts)
                              : 0
                          }
                          historyValues={(m) => m.cpu.powerWatts ?? Number.NaN}
                          formatSparkValue={(v) => `${Math.round(v)} W`}
                        />
                        <MetricsCard
                          label="SWAP"
                          color="var(--meter-memory)"
                          value={
                            (metrics.metrics.memory.swapTotal ?? 0) > 0
                              ? (() => {
                                  const p = formatBytesPair(
                                    metrics.metrics.memory.swapUsed ?? 0,
                                    metrics.metrics.memory.swapTotal ?? 0
                                  );
                                  return (
                                    <>
                                      <span>{p.used}</span>
                                      <span className="metric-value-sep">/</span>
                                      <span className="metric-value-secondary">
                                        {p.total}
                                      </span>
                                      <span className="metric-value-unit">{p.unit}</span>
                                    </>
                                  );
                                })()
                              : "N/A"
                          }
                          usage={metrics.metrics.memory.swapUsage ?? 0}
                          historyValues={(m) => m.memory.swapUsage ?? 0}
                          formatSparkValue={formatPercent}
                          sparkMin={0}
                          sparkMax={100}
                        />
                        <MetricsCard
                          label="PROCESSES"
                          color="var(--meter-network)"
                          value={
                            <>
                              <span>{metrics.metrics.processes.all}</span>
                              <span className="metric-value-unit">total</span>
                              <span className="metric-value-secondary">
                                {metrics.metrics.processes.running}
                              </span>
                              <span className="metric-value-unit">run</span>
                            </>
                          }
                          usage={
                            metrics.metrics.processes.all > 0
                              ? (metrics.metrics.processes.running /
                                  metrics.metrics.processes.all) *
                                100
                              : 0
                          }
                          historyValues={(m) => m.processes.all}
                          formatSparkValue={(v) => `${Math.round(v)}`}
                        />
                      </>
                    ) : null}
                  </>
                ) : (
                  <div
                    className="panel metric-card loading-scan"
                    style={{
                      gridColumn: "1 / -1",
                      alignItems: "center",
                      justifyContent: "center",
                      minHeight: "48px",
                    }}
                  >
                    <span className="label">LOADING METRICS</span>
                  </div>
                )}
              </div>
              {metrics.metrics ? (
                <div className="metrics-controls">
                  <Button
                    variant="secondary"
                    onClick={() => setShowMoreMetrics((v) => !v)}
                  >
                    {showMoreMetrics ? "Hide extra metrics" : "Show more metrics"}
                  </Button>
                </div>
              ) : null}
            </div>
          </div>

          <div className="page-col">
            <div className="page-col-scroll">
              {apps && apps.length > 0 ? (
                <AppLauncherGrid
                  apps={apps}
                  onReorder={(orderedIds) => {
                    reorderMutation.mutate(orderedIds);
                  }}
                />
              ) : (
                <div className="panel" style={{ padding: "var(--space-6)" }}>
                  <div className="app-launcher-empty">
                    NO APPS INSTALLED
                    <br />
                    <Link to="/apps/templates">BROWSE TEMPLATES</Link>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
