import { createFileRoute } from "@tanstack/react-router";
import { useTRPC } from "../trpc";
import { trpcClient } from "../trpc";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useToastStore } from "../stores/toast";
import { Button } from "../components/ui/Button";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const trpc = useTRPC();
  const { addToast } = useToastStore();
  const { data: systemInfo, isLoading } = useQuery(trpc.system.getInfo.queryOptions());
  const { data: dataDirInfo, isLoading: dataDirLoading } = useQuery(
    trpc.system.getDataDir.queryOptions()
  );
  const { data: updateStatus, isLoading: updateLoading } = useQuery(
    trpc.system.getUpdateStatus.queryOptions(undefined, {
      refetchInterval: 10 * 60 * 1000,
    })
  );

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

  const formatUptime = (seconds: number): string => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${days}d ${hours}h ${minutes}m`;
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
              <div className="label" style={{ marginBottom: "var(--space-2)" }}>
                UPDATES
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
