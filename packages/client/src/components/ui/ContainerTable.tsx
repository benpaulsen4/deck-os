import { useEffect, useState } from "react";
import { trpcClient } from "../../trpc";

interface ContainerInfo {
  id: string;
  names: string[];
  image: string;
  imageId: string;
  command?: string;
  created: number;
  state: {
    status: string;
    running: boolean;
    paused: boolean;
    restarting: boolean;
    dead: boolean;
    pid: number;
    exitCode?: number;
    error?: string;
    startedAt?: string;
    finishedAt?: string;
  };
  status: string;
  ports?: Array<{
    private: number;
    public?: number;
    type?: string;
    ip?: string;
  }>;
  labels?: Record<string, string>;
  stats?: {
    cpu: number;
    memory: number;
    memoryBytes: number;
  };
}

interface ContainerTableProps {
  containers: ContainerInfo[];
}

export function ContainerTable({ containers }: ContainerTableProps) {
  const [containerStats, setContainerStats] = useState<
    Record<string, { cpu: number; memory: number; memoryBytes: number }>
  >({});
  const containerKey = containers
    .map((container) => `${container.id}:${container.state.running ? 1 : 0}`)
    .join("|");

  useEffect(() => {
    let cancelled = false;
    let runId = 0;

    const fetchStats = async () => {
      const currentRunId = ++runId;
      const stats: Record<string, { cpu: number; memory: number; memoryBytes: number }> =
        {};

      for (const container of containers) {
        if (container.state.running) {
          try {
            const result = await trpcClient.docker.getContainerStats.query({
              containerId: container.id,
            });
            if (result) {
              stats[container.id] = result;
            }
          } catch (error) {
            console.error(`Failed to fetch stats for container ${container.id}:`, error);
          }
        }
      }

      if (cancelled || currentRunId !== runId) {
        return;
      }
      setContainerStats(stats);
    };

    void fetchStats();

    const interval = window.setInterval(() => {
      void fetchStats();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [containerKey]);

  const getStatusColor = (running: boolean) => {
    return running ? "var(--status-running)" : "var(--status-stopped)";
  };

  const getStatusText = (state: string) => {
    if (state.includes("running") || state.includes("Up")) return "RUNNING";
    if (state.includes("stopped") || state.includes("Exited")) return "STOPPED";
    if (state.includes("restarting")) return "RESTARTING";
    return "UNKNOWN";
  };

  const portsFromList = (ports: ContainerInfo["ports"]) => {
    return (
      ports
        ?.map((port: { public?: number; private: number; type?: string }) =>
          port.public
            ? `${port.public}:${port.private}/${port.type}`
            : `${port.private}/${port.type}`
        )
        .join(", ") || "—"
    );
  };

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  const tableStyle: React.CSSProperties = {
    borderCollapse: "collapse",
  };

  const thStyle: React.CSSProperties = {
    textAlign: "left",
    padding: "8px",
    fontSize: "var(--text-xs)",
    fontWeight: 500,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    color: "var(--text-secondary)",
  };

  const cellStyle: React.CSSProperties = {
    padding: "8px",
    fontSize: "var(--text-sm)",
  };

  const nameStyle: React.CSSProperties = {
    ...cellStyle,
    color: "var(--text-primary)",
    fontFamily: "var(--font-mono)",
  };

  const imageStyle: React.CSSProperties = {
    ...cellStyle,
    color: "var(--text-secondary)",
    fontFamily: "var(--font-mono)",
    maxWidth: "200px",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  };

  const statusStyle: React.CSSProperties = {
    ...cellStyle,
    fontSize: "var(--text-xs)",
    fontWeight: 500,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  };

  const resourceBarContainer: React.CSSProperties = {
    width: "80px",
    height: "4px",
    background: "var(--bg-tertiary)",
    borderRadius: 0,
    overflow: "hidden",
  };

  const resourceBarFill: React.CSSProperties = {
    height: "100%",
    transition: "width var(--transition-meter) linear",
  };

  const emptyStyle: React.CSSProperties = {
    padding: "16px",
    textAlign: "center",
    color: "var(--text-muted)",
    fontSize: "var(--text-xs)",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  };

  if (containers.length === 0) {
    return <div style={emptyStyle}>No containers</div>;
  }

  return (
    <div className="container-table-scroll">
      <table className="container-table" style={tableStyle}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border-primary)" }}>
            <th style={thStyle}>Name</th>
            <th style={thStyle}>Image</th>
            <th style={thStyle}>Status</th>
            <th style={thStyle}>CPU</th>
            <th style={thStyle}>Memory</th>
            <th style={thStyle}>Ports</th>
          </tr>
        </thead>
        <tbody>
          {containers.map((container) => {
            const stats = containerStats[container.id];
            const cpu = stats?.cpu || 0;
            const memory = stats?.memory || 0;
            const memoryBytes = stats?.memoryBytes || 0;

            return (
              <tr
                key={container.id}
                style={{
                  borderBottom: "1px solid var(--border-primary)",
                  transition: "background-color 80ms linear",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = "var(--bg-tertiary)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "";
                }}
              >
                <td style={nameStyle}>{container.names[0]?.replace(/^\//, "") || "—"}</td>
                <td style={imageStyle} title={container.image}>
                  {container.image}
                </td>
                <td style={statusStyle}>
                  <span style={{ color: getStatusColor(container.state.running) }}>
                    {getStatusText(container.state.status)}
                  </span>
                </td>
                <td style={cellStyle}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span
                      style={{
                        fontSize: "var(--text-xs)",
                        color: "var(--text-secondary)",
                        minWidth: "32px",
                      }}
                    >
                      {container.state.running ? `${cpu}%` : "—"}
                    </span>
                    {container.state.running && (
                      <div style={resourceBarContainer}>
                        <div
                          style={{
                            ...resourceBarFill,
                            width: `${Math.min(100, cpu)}%`,
                            backgroundColor: "var(--meter-cpu)",
                          }}
                        />
                      </div>
                    )}
                  </div>
                </td>
                <td style={cellStyle}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span
                      style={{
                        fontSize: "var(--text-xs)",
                        color: "var(--text-secondary)",
                        minWidth: "32px",
                      }}
                    >
                      {container.state.running ? `${formatBytes(memoryBytes)}` : "—"}
                    </span>
                    {container.state.running && (
                      <div style={resourceBarContainer}>
                        <div
                          style={{
                            ...resourceBarFill,
                            width: `${Math.min(100, memory)}%`,
                            backgroundColor: "var(--meter-memory)",
                          }}
                        />
                      </div>
                    )}
                  </div>
                </td>
                <td style={{ ...cellStyle, fontSize: "var(--text-xs)" }}>
                  {portsFromList(container.ports)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
