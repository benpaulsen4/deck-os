import { createFileRoute } from "@tanstack/react-router";
import { useTRPC } from "../trpc";
import { trpcClient } from "../trpc";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToastStore } from "../stores/toast";
import { Button } from "../components/ui/Button";
import { useEffect, useRef } from "react";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const normalizeVersion = (version: string) => version.trim().replace(/^v/i, "");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { addToast } = useToastStore();
  const { data: systemInfo, isLoading } = useQuery(trpc.system.getInfo.queryOptions());
  const { data: dataDirInfo, isLoading: dataDirLoading } = useQuery(
    trpc.system.getDataDir.queryOptions()
  );
  const { data: diskMetrics, isLoading: diskMetricsLoading } = useQuery(
    trpc.system.getMetrics.queryOptions(undefined, {
      refetchInterval: 10_000,
    })
  );
  const updateStatusQuery = useQuery(
    trpc.system.getUpdateStatus.queryOptions(undefined, {
      refetchInterval: 10 * 60 * 1000,
    })
  );
  const {
    data: updateStatus,
    isLoading: updateLoading,
    isFetching: updateFetching,
  } = updateStatusQuery;
  const updateReloadIntervalRef = useRef<number | null>(null);

  const stopUpdateReloadPolling = () => {
    if (updateReloadIntervalRef.current !== null) {
      window.clearInterval(updateReloadIntervalRef.current);
      updateReloadIntervalRef.current = null;
    }
  };

  const startUpdateCompletionPolling = (targetVersion: string) => {
    stopUpdateReloadPolling();
    const expectedVersion = normalizeVersion(targetVersion);
    let attempts = 0;
    const attemptReload = async () => {
      attempts += 1;
      try {
        const response = await fetch(`/api/version?_=${Date.now()}`, {
          cache: "no-store",
        });
        if (response.ok) {
          const payload = (await response.json()) as { version?: unknown };
          if (typeof payload.version === "string") {
            const reportedVersion = normalizeVersion(payload.version);
            if (reportedVersion === expectedVersion) {
              window.location.reload();
              return;
            }
          }
        }
      } catch {}
      if (attempts >= 180) {
        stopUpdateReloadPolling();
        addToast(
          `Still waiting for v${targetVersion}. Refresh manually if needed.`,
          "info"
        );
      }
    };
    updateReloadIntervalRef.current = window.setInterval(() => {
      void attemptReload();
    }, 2000);
    void attemptReload();
  };

  useEffect(() => {
    return () => {
      stopUpdateReloadPolling();
    };
  }, []);

  const applyUpdateMutation = useMutation({
    mutationFn: async () => await trpcClient.system.applyUpdate.mutate({}),
    onSuccess: (res: { targetVersion: string; restarting: boolean }) => {
      if (res.restarting) {
        addToast(
          `Update in progress (v${res.targetVersion}). This page will refresh automatically.`,
          "success"
        );
        startUpdateCompletionPolling(res.targetVersion);
      } else {
        addToast(`v${res.targetVersion} already installed`, "success");
      }
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : "Unknown error";
      addToast(`Update failed: ${message}`, "error");
    },
  });

  const checkForUpdatesMutation = useMutation({
    mutationFn: async () => await trpcClient.system.checkForUpdates.mutate({}),
    onSuccess: (res) => {
      queryClient.setQueryData(trpc.system.getUpdateStatus.queryOptions().queryKey, res);
      if (res.error) {
        addToast(`Update check failed: ${res.error}`, "error");
      } else if (res.updateAvailable && res.latestVersion) {
        addToast(`Update available: v${res.latestVersion}`, "success");
      } else {
        addToast("No updates available", "info");
      }
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : "Unknown error";
      addToast(`Update check failed: ${message}`, "error");
    },
  });

  const formatUptime = (seconds: number): string => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${days}d ${hours}h ${minutes}m`;
  };

  const formatBytes = (bytes: number): string => {
    if (!Number.isFinite(bytes)) return "0 B";
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const unit = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
    return `${(bytes / Math.pow(k, unit)).toFixed(1)} ${sizes[unit]}`;
  };

  const diskEntries = (diskMetrics?.disk.fs ?? [])
    .filter((disk) => {
      const name = disk.fs.toLowerCase();
      const mount = disk.mount.toLowerCase();
      return (
        !name.includes("tmpfs") &&
        !name.includes("swap") &&
        !name.includes("efivars") &&
        !mount.includes("/efivars")
      );
    })
    .sort((a, b) => b.usePercent - a.usePercent);

  return (
    <div className="page-container page-container--viewport">
      <div className="page-header">
        <h1 className="page-title">Settings</h1>
      </div>

      <div className="page-body settings-page-body">
        <div className="page-grid-2col settings-grid">
          <div className="page-col settings-col">
            <div className="panel" style={{ padding: "var(--space-3)" }}>
              <div className="label" style={{ marginBottom: "var(--space-2)" }}>
                SYSTEM INFORMATION
              </div>
              {isLoading ? (
                <div className="loading-scan" style={{ padding: "var(--space-2)" }}>
                  <span className="label">LOADING...</span>
                </div>
              ) : systemInfo ? (
                <div className="settings-kv">
                  <span className="system-info-label">HOSTNAME</span>
                  <span className="system-info-value">{systemInfo.hostname}</span>
                  <span className="system-info-label">OS</span>
                  <span className="system-info-value">{systemInfo.os}</span>
                  <span className="system-info-label">DISTRO</span>
                  <span className="system-info-value">
                    {systemInfo.osDistro || "N/A"}
                  </span>
                  <span className="system-info-label">RELEASE</span>
                  <span className="system-info-value">
                    {systemInfo.osRelease || "N/A"}
                  </span>
                  <span className="system-info-label">ARCHITECTURE</span>
                  <span className="system-info-value">{systemInfo.osArch || "N/A"}</span>
                  <span className="system-info-label">NODE VERSION</span>
                  <span className="system-info-value">{systemInfo.nodeVersion}</span>
                  <span className="system-info-label">UPTIME</span>
                  <span className="system-info-value">
                    {formatUptime(systemInfo.uptime)}
                  </span>
                  <span className="system-info-label">DOCKER VERSION</span>
                  <span className="system-info-value">
                    {systemInfo.dockerVersion || "NOT INSTALLED"}
                  </span>
                </div>
              ) : null}
            </div>

            <div className="panel settings-disk-panel" style={{ padding: "var(--space-3)" }}>
              <div className="label" style={{ marginBottom: "var(--space-2)" }}>
                DISK INFORMATION
              </div>
              {diskMetricsLoading ? (
                <div className="loading-scan" style={{ padding: "var(--space-2)" }}>
                  <span className="label">LOADING...</span>
                </div>
              ) : diskMetrics ? (
                <div className="settings-disk-layout">
                  <div className="settings-disk-scroll">
                    {diskEntries.length > 0 ? (
                      <div className="settings-disk-list">
                        {diskEntries.map((disk) => {
                          const diskFree = Math.max(0, disk.size - disk.used);
                          return (
                            <div className="settings-disk-item" key={`${disk.fs}:${disk.mount}`}>
                              <div className="settings-disk-item-head">
                                <div className="settings-disk-meta">
                                  <span className="settings-disk-mount">{disk.mount}</span>
                                  <span className="settings-disk-fs">{disk.fs}</span>
                                </div>
                                <span className="settings-disk-percent">
                                  {Math.round(disk.usePercent)}%
                                </span>
                              </div>
                              <div className="settings-disk-stats">
                                <span className="settings-disk-stat">
                                  <span className="system-info-label">USED</span>
                                  <span className="system-info-value">
                                    {formatBytes(disk.used)}
                                  </span>
                                </span>
                                <span className="settings-disk-stat">
                                  <span className="system-info-label">TOTAL</span>
                                  <span className="system-info-value">
                                    {formatBytes(disk.size)}
                                  </span>
                                </span>
                                <span className="settings-disk-stat">
                                  <span className="system-info-label">FREE</span>
                                  <span className="system-info-value">
                                    {formatBytes(diskFree)}
                                  </span>
                                </span>
                              </div>
                              <div className="metric-card-bar-container">
                                <div
                                  className="metric-card-bar-fill"
                                  style={{
                                    width: `${Math.min(100, Math.max(0, disk.usePercent))}%`,
                                    background: "var(--meter-disk)",
                                    transition: "width var(--transition-meter) linear",
                                  }}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <span className="system-info-value">NO DISKS DETECTED</span>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <div className="page-col settings-col">
            <div className="panel" style={{ padding: "var(--space-3)" }}>
              <div className="label" style={{ marginBottom: "var(--space-2)" }}>
                DATA DIRECTORY
              </div>
              {dataDirLoading ? (
                <div className="loading-scan" style={{ padding: "var(--space-2)" }}>
                  <span className="label">LOADING...</span>
                </div>
              ) : dataDirInfo ? (
                <div
                  style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}
                >
                  <span style={{ fontFamily: "var(--font-mono)" }}>
                    {dataDirInfo.dataDir}
                  </span>
                </div>
              ) : null}
            </div>

            <div className="panel" style={{ padding: "var(--space-3)" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "var(--space-2)",
                  marginBottom: "var(--space-2)",
                }}
              >
                <div className="label">UPDATES</div>
                <Button
                  variant="secondary"
                  onClick={() => checkForUpdatesMutation.mutate()}
                  disabled={checkForUpdatesMutation.isPending || updateFetching}
                >
                  {checkForUpdatesMutation.isPending || updateFetching
                    ? "CHECKING..."
                    : "CHECK NOW"}
                </Button>
              </div>
              {updateLoading ? (
                <div className="loading-scan" style={{ padding: "var(--space-2)" }}>
                  <span className="label">LOADING...</span>
                </div>
              ) : updateStatus ? (
                <div className="settings-kv">
                  <span className="system-info-label">CURRENT</span>
                  <span className="system-info-value">
                    v{updateStatus.currentVersion}
                  </span>
                  <span className="system-info-label">LATEST</span>
                  <span className="system-info-value">
                    {updateStatus.latestVersion
                      ? `v${updateStatus.latestVersion}`
                      : "N/A"}
                  </span>
                  <span className="system-info-label">STATUS</span>
                  <span className="system-info-value">
                    {updateStatus.updateAvailable ? "UPDATE AVAILABLE" : "UP TO DATE"}
                  </span>
                  <span className="system-info-label">LAST CHECK</span>
                  <span className="system-info-value">
                    {updateStatus.lastCheckedAt
                      ? new Date(updateStatus.lastCheckedAt).toLocaleString()
                      : "N/A"}
                  </span>
                  {updateStatus.error && (
                    <>
                      <span className="system-info-label">ERROR</span>
                      <span className="system-info-value">{updateStatus.error}</span>
                    </>
                  )}
                </div>
              ) : null}
              {updateStatus?.updateAvailable && !updateStatus.error && (
                <div style={{ marginTop: "var(--space-3)" }}>
                  <Button
                    onClick={() => applyUpdateMutation.mutate()}
                    disabled={applyUpdateMutation.isPending}
                  >
                    {applyUpdateMutation.isPending ? "UPDATING..." : "UPDATE NOW"}
                  </Button>
                </div>
              )}
            </div>

            <div className="panel" style={{ padding: "var(--space-3)" }}>
              <div className="label" style={{ marginBottom: "var(--space-2)" }}>
                ABOUT
              </div>
              <div style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
                <div>DeckOS v{systemInfo?.appVersion || "N/A"}</div>
                <div style={{ marginTop: "var(--space-1)", color: "var(--text-muted)" }}>
                  Self-hosted homelab management platform
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
