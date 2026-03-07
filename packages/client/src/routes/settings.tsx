import { createFileRoute } from "@tanstack/react-router";
import { useTRPC } from "../trpc";
import { trpcClient } from "../trpc";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToastStore } from "../stores/toast";
import { Button } from "../components/ui/Button";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

function SettingsPage() {
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

  const applyUpdateMutation = useMutation({
    mutationFn: async () => await trpcClient.system.applyUpdate.mutate({}),
    onSuccess: (res: { targetVersion: string; restarting: boolean }) => {
      if (res.restarting) {
        addToast(`Updating to v${res.targetVersion}...`, "success");
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

  return (
    <div className="page-container page-container--viewport">
      <div className="page-header">
        <h1 className="page-title">Settings</h1>
      </div>

      <div className="page-body">
        <div className="page-grid-2col">
          <div className="page-col">
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

            <div className="panel" style={{ padding: "var(--space-3)" }}>
              <div className="label" style={{ marginBottom: "var(--space-2)" }}>
                DISK INFORMATION
              </div>
              {diskMetricsLoading ? (
                <div className="loading-scan" style={{ padding: "var(--space-2)" }}>
                  <span className="label">LOADING...</span>
                </div>
              ) : diskMetrics ? (
                <div className="settings-kv">
                  {diskMetrics.disk.fs.length > 0 ? (
                    diskMetrics.disk.fs.map((disk) => (
                      <div
                        key={`${disk.fs}:${disk.mount}`}
                        style={{
                          gridColumn: "1 / -1",
                          borderTop: "1px solid var(--border-subtle)",
                          paddingTop: "var(--space-2)",
                          marginTop: "var(--space-2)",
                          fontSize: "var(--text-sm)",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            gap: "var(--space-2)",
                          }}
                        >
                          <div style={{ minWidth: 0 }}>
                            <div
                              className="system-info-label"
                              style={{ marginBottom: "var(--space-1)" }}
                            >
                              {disk.mount}
                            </div>
                            <div
                              style={{
                                color: "var(--text-muted)",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {disk.fs}
                            </div>
                          </div>
                          <div
                            style={{
                              textAlign: "right",
                              whiteSpace: "nowrap",
                              color: "var(--text-secondary)",
                            }}
                          >
                            {formatBytes(disk.used)} / {formatBytes(disk.size)} (
                            {Math.round(disk.usePercent)}%)
                          </div>
                        </div>
                        <div
                          className="metric-card-bar-container"
                          style={{
                            marginTop: "var(--space-1)",
                          }}
                        >
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
                    ))
                  ) : (
                    <span className="system-info-value">NO DISKS DETECTED</span>
                  )}
                </div>
              ) : null}
            </div>
          </div>

          <div className="page-col">
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
