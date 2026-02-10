import { useTRPC } from "../../trpc";
import { useQuery } from "@tanstack/react-query";

// TODO Phase 4: Add container counts (running/stopped) from Docker status
export function SystemInfoBar() {
  const trpc = useTRPC();
  const { data: info, isLoading, isError } = useQuery(trpc.system.getInfo.queryOptions());

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
        <span className="system-info-value">{info.osDistro || info.os} {info.osRelease || ""}</span>
      </div>
      <div className="system-info-item">
        <span className="system-info-label">UPTIME</span>
        <span className="system-info-value">{formatUptime(info.uptime)}</span>
      </div>
      <div className="system-info-item">
        <span className="system-info-label">DOCKER</span>
        <span className="system-info-value">{info.dockerVersion || "NOT INSTALLED"}</span>
      </div>
    </div>
  );
}