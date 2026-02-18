import { Link } from "@tanstack/react-router";
import { useAppStatusStore, type AppStatus } from "../../stores/appStatus";
import { Button } from "../../components/ui/Button";
import type { App, StackStatus } from "../../../../server/src/lib/schema.js";
import { AppIcon } from "../ui/AppIcon";

interface AppRowProps {
  app: App;
  stackStatus?: StackStatus | null;
  onAction: (appId: string, action: string, e: React.MouseEvent) => void;
  isActionPending: (action: string) => boolean;
}

export function AppRow({ app, stackStatus, onAction, isActionPending }: AppRowProps) {
  const appStatus = useAppStatusStore((state) => state.appStatuses);

  const liveStatus: AppStatus = appStatus[app.id] || "unknown";

  const getActualStatus = (): AppStatus => {
    if (liveStatus && liveStatus !== "unknown") {
      return liveStatus;
    }
    if (!stackStatus) {
      return "unknown";
    }
    if (stackStatus.running > 0) {
      return "running";
    }
    if (stackStatus.restarting > 0) {
      return "restarting";
    }
    if (stackStatus.stopped > 0 || (stackStatus.containers?.length ?? 0) === 0) {
      return "stopped";
    }
    return "unknown";
  };

  const status = getActualStatus();

  const getStatusLabel = (): string => {
    switch (status) {
      case "running":
        return "RUNNING";
      case "stopped":
        return "STOPPED";
      case "restarting":
        return "RESTARTING";
      case "warning":
        return "WARNING";
      case "pulling":
        return "PULLING";
      default:
        return "UNKNOWN";
    }
  };

  const getStatusColor = (): string => {
    switch (status) {
      case "running":
        return "var(--status-running)";
      case "stopped":
        return "var(--status-stopped)";
      case "restarting":
        return "var(--status-warning)";
      case "warning":
        return "var(--status-warning)";
      case "pulling":
        return "var(--status-warning)";
      default:
        return "var(--status-neutral)";
    }
  };

  const formatDate = (dateString: string): string => {
    const date = new Date(dateString);
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  const rowStyle: React.CSSProperties = {
    borderBottom: "1px solid var(--border-primary)",
    transition: "background var(--transition-fast)",
  };

  const cellStyle: React.CSSProperties = {
    padding: "12px 16px",
    fontSize: "var(--text-sm)",
  };

  const actionButtonStyle: React.CSSProperties = {
    padding: "4px 8px",
    fontSize: "var(--text-xs)",
    minWidth: "32px",
  };

  return (
    <tr
      style={rowStyle}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = "var(--bg-tertiary)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = "";
      }}
    >
      <td style={{ ...cellStyle, color: "var(--text-primary)", fontWeight: 500 }}>
        <Link
          to="/apps/$appId"
          params={{ appId: app.id }}
          style={{
            textDecoration: "none",
            color: "inherit",
            display: "flex",
            alignItems: "center",
            gap: "10px",
          }}
        >
          <span
            style={{
              width: "26px",
              height: "26px",
              borderRadius: "6px",
              overflow: "hidden",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              background: "var(--bg-tertiary)",
              border: "1px solid var(--border-primary)",
              fontSize: "var(--text-xs)",
              color: "var(--text-secondary)",
              flex: "0 0 auto",
            }}
          >
            <AppIcon
              name={app.metadata.name}
              src={app.metadata.icon}
              imgStyle={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          </span>
          <span>{app.metadata.name}</span>
        </Link>
      </td>
      <td style={cellStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span
            style={{
              width: "8px",
              height: "8px",
              backgroundColor: getStatusColor(),
              display: "inline-block",
              borderRadius: "50%",
            }}
          />
          <span
            style={{
              fontSize: "var(--text-xs)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            {getStatusLabel()}
          </span>
        </div>
      </td>
      <td style={{ ...cellStyle, fontSize: "var(--text-xs)" }}>
        {stackStatus ? `${stackStatus.containers.length} containers` : "—"}
      </td>
      <td style={{ ...cellStyle, fontSize: "var(--text-xs)" }}>
        {formatDate(app.metadata.createdAt)}
      </td>
      <td style={{ ...cellStyle }}>
        <div style={{ display: "flex", gap: "8px" }}>
          <Button
            variant="secondary"
            onClick={(e) => onAction(app.id, "start", e)}
            disabled={isActionPending("start")}
            style={actionButtonStyle}
            title="Start"
          >
            ▶
          </Button>
          <Button
            variant="danger"
            onClick={(e) => onAction(app.id, "stop", e)}
            disabled={isActionPending("stop")}
            style={actionButtonStyle}
            title="Stop"
          >
            ■
          </Button>
          <Button
            variant="secondary"
            onClick={(e) => onAction(app.id, "restart", e)}
            disabled={isActionPending("restart")}
            style={actionButtonStyle}
            title="Restart"
          >
            ↻
          </Button>
          <Button
            variant="danger"
            onClick={(e) => onAction(app.id, "delete", e)}
            disabled={isActionPending("delete")}
            style={actionButtonStyle}
            title="Delete"
          >
            ✕
          </Button>
        </div>
      </td>
    </tr>
  );
}
