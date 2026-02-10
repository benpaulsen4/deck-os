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
}

interface ContainerTableProps {
  containers: ContainerInfo[];
}

export function ContainerTable({ containers }: ContainerTableProps) {
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
    return ports?.map((port: { public?: number; private: number; type?: string }) =>
      port.public ? `${port.public}:${port.private}/${port.type}` : `${port.private}/${port.type}`
    ).join(", ") || "—";
  };

  const tableStyle: React.CSSProperties = {
    width: "100%",
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
    <table style={tableStyle}>
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
        {containers.map((container) => (
          <tr
            key={container.id}
            style={{ borderBottom: "1px solid var(--border-primary)", transition: "background-color 80ms linear" }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = "var(--bg-tertiary)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "";
            }}
          >
            <td style={nameStyle}>
              {container.names[0]?.replace(/^\//, "") || "—"}
            </td>
            <td style={imageStyle} title={container.image}>
              {container.image}
            </td>
            <td style={statusStyle}>
              <span style={{ color: getStatusColor(container.state.running) }}>
                {getStatusText(container.state.status)}
              </span>
            </td>
            <td style={cellStyle}>
              <span style={{ color: "var(--text-secondary)" }}>—</span>
            </td>
            <td style={cellStyle}>
              <span style={{ color: "var(--text-secondary)" }}>—</span>
            </td>
            <td style={{ ...cellStyle, fontSize: "var(--text-xs)" }}>
              {portsFromList(container.ports)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}