import { trpcClient } from "../../trpc";
import { useTRPC } from "../../trpc";
import { useQuery } from "@tanstack/react-query";

export function SystemInfoBar() {
  const trpc = useTRPC();
  const { data: info, isLoading, isError } = useQuery(trpc.system.getInfo.queryOptions());
  const { data: apps } = useQuery(trpc.apps.list.queryOptions());
  const appIds = apps?.map((app) => app.id) ?? [];
  const { data: batchStatuses } = useQuery({
    // Same key as `useAppStatus` on purpose: a private key ran the identical
    // 5s `docker.getStatuses` poll a second time and, because the two
    // `invalidateStatusQueries` call sites only target this key, left the
    // CONTAINERS counter stale after a start/stop.
    queryKey: ["stackStatusBatch", appIds],
    queryFn: async () => await trpcClient.docker.getStatuses.query({ appIds }),
    // NOTE: `useAppStatus` additionally gates this key on the auth state. React
    // Query runs a query if *any* observer is enabled, so that gate now survives
    // only because this bar renders inside the unlocked shell. Keep it that way,
    // or pass the auth state in.
    enabled: appIds.length > 0,
    refetchInterval: 5000,
  });

  if (isLoading) {
    return (
      <div className="system-info-bar loading-scan">
        <span className="label">LOADING SYSTEM INFO</span>
      </div>
    );
  }

  if (isError || !info) {
    return null;
  }

  const containerTotals = Object.values(batchStatuses?.statuses ?? {}).reduce(
    (acc, status) => {
      if (!status) {
        return acc;
      }
      acc.running += status.running;
      acc.stopped += status.stopped;
      return acc;
    },
    { running: 0, stopped: 0 }
  );

  const formatUptime = (seconds: number): string => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${days}d ${hours}h ${minutes}m`;
  };

  return (
    <div className="system-info-bar">
      <div className="system-info-item">
        <span className="system-info-label">HOSTNAME</span>
        <span className="system-info-value">{info.hostname}</span>
      </div>
      <div className="system-info-item">
        <span className="system-info-label">OS</span>
        <span className="system-info-value">
          {info.osDistro || info.os} {info.osRelease || ""}
        </span>
      </div>
      <div className="system-info-item">
        <span className="system-info-label">UPTIME</span>
        <span className="system-info-value">{formatUptime(info.uptime)}</span>
      </div>
      <div className="system-info-item">
        <span className="system-info-label">DOCKER</span>
        <span className="system-info-value">{info.dockerVersion || "NOT INSTALLED"}</span>
      </div>
      <div className="system-info-item">
        <span className="system-info-label">CONTAINERS</span>
        <span className="system-info-value">
          {containerTotals.running} RUN / {containerTotals.stopped} STOP
        </span>
      </div>
    </div>
  );
}
