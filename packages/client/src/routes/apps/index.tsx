import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTRPC } from "../../trpc";
import { useQuery, useMutation } from "@tanstack/react-query";
import { trpcClient } from "../../trpc";
import { useToastStore } from "../../stores/toast";
import { useAppStatusStore, type AppStatus } from "../../stores/appStatus";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";

export const Route = createFileRoute("/apps/")({
  component: AppsPage,
});

function AppsPage() {
  const trpc = useTRPC();
  const { addToast } = useToastStore();
  const appStatuses = useAppStatusStore((state) => state.appStatuses);
  const [confirmDialog, setConfirmDialog] = useState<{ isOpen: boolean; action: string; message: string; appId: string }>({
    isOpen: false,
    action: "",
    message: "",
    appId: "",
  });

  const { data: apps } = useQuery(trpc.apps.list.queryOptions());

  const startMutation = useMutation({
    mutationFn: async (appId: string) => await trpcClient.docker.start.mutate({ appId }),
    onSuccess: () => {
      addToast("App started", "success");
    },
    onError: (err: any) => {
      addToast(`Failed to start: ${err.message}`, "error");
    },
  });

  const stopMutation = useMutation({
    mutationFn: async (appId: string) => await trpcClient.docker.stop.mutate({ appId }),
    onSuccess: () => {
      addToast("App stopped", "success");
    },
    onError: (err: any) => {
      addToast(`Failed to stop: ${err.message}`, "error");
    },
  });

  const restartMutation = useMutation({
    mutationFn: async (appId: string) => await trpcClient.docker.restart.mutate({ appId }),
    onSuccess: () => {
      addToast("App restarted", "success");
    },
    onError: (err: any) => {
      addToast(`Failed to restart: ${err.message}`, "error");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (appId: string) => await trpcClient.apps.delete.mutate({ id: appId }),
    onSuccess: () => {
      addToast("App deleted", "success");
    },
    onError: (err: any) => {
      addToast(`Failed to delete: ${err.message}`, "error");
    },
  });

  const handleAction = (appId: string, action: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (action === "delete") {
      setConfirmDialog({
        isOpen: true,
        action: "delete",
        message: "Are you sure you want to delete this app? This action cannot be undone.",
        appId,
      });
    } else if (action === "start") {
      startMutation.mutate(appId);
    } else if (action === "stop") {
      stopMutation.mutate(appId);
    } else if (action === "restart") {
      restartMutation.mutate(appId);
    }
  };

  const handleConfirm = () => {
    const appId = confirmDialog.appId;
    setConfirmDialog({ isOpen: false, action: "", message: "", appId: "" });
    if (confirmDialog.action === "delete") {
      deleteMutation.mutate(appId);
    }
  };

  const formatDate = (dateString: string): string => {
    const date = new Date(dateString);
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  const getAppStatus = (appId: string): AppStatus => {
    return appStatuses[appId] || "unknown";
  };

  const getStatusLabel = (status: AppStatus): string => {
    switch (status) {
      case "running": return "RUNNING";
      case "stopped": return "STOPPED";
      case "restarting": return "RESTARTING";
      case "warning": return "WARNING";
      case "pulling": return "PULLING";
      default: return "UNKNOWN";
    }
  };

  const getStatusColor = (status: AppStatus): string => {
    switch (status) {
      case "running": return "var(--status-running)";
      case "stopped": return "var(--status-stopped)";
      case "restarting": return "var(--status-warning)";
      case "warning": return "var(--status-warning)";
      case "pulling": return "var(--status-warning)";
      default: return "var(--status-neutral)";
    }
  };

  const tableStyle: React.CSSProperties = {
    width: "100%",
    borderCollapse: "collapse",
  };

  const thStyle: React.CSSProperties = {
    textAlign: "left",
    padding: "12px 16px",
    fontSize: "var(--text-xs)",
    fontWeight: 500,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    color: "var(--text-secondary)",
    borderBottom: "1px solid var(--border-primary)",
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
    <div className="page-container">
      <div className="page-header">
        <h1 className="page-title">Apps</h1>
        <Link to="/apps/new" className="topbar-link">
          + NEW APP
        </Link>
      </div>
      {apps && apps.length > 0 ? (
        <div className="panel" style={{ padding: 0 }}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Containers</th>
                <th style={thStyle}>Created</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
<tbody>
              {apps.map((app) => {
                const status = getAppStatus(app.id);
                const statusLabel = getStatusLabel(status);
                const statusColor = getStatusColor(status);

                return (
                  <tr
                    key={app.id}
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
                        style={{ textDecoration: "none", color: "inherit" }}
                      >
                        {app.metadata.name}
                      </Link>
                    </td>
                    <td style={{ ...cellStyle, display: "flex", alignItems: "center", gap: "8px" }}>
                      <span
                        style={{
                          width: "8px",
                          height: "8px",
                          backgroundColor: statusColor,
                          display: "inline-block",
                        }}
                      />
                      <span style={{ fontSize: "var(--text-xs)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                        {statusLabel}
                      </span>
                    </td>
                    <td style={{ ...cellStyle, fontSize: "var(--text-xs)" }}>—</td>
                    <td style={{ ...cellStyle, fontSize: "var(--text-xs)" }}>{formatDate(app.metadata.createdAt)}</td>
                    <td style={{ ...cellStyle }}>
                      <div style={{ display: "flex", gap: "8px" }}>
                        <Button
                          variant="secondary"
                          onClick={(e) => handleAction(app.id, "start", e)}
                          disabled={startMutation.isPending}
                          style={actionButtonStyle}
                        >
                          ▶
                        </Button>
                        <Button
                          variant="danger"
                          onClick={(e) => handleAction(app.id, "stop", e)}
                          disabled={stopMutation.isPending}
                          style={actionButtonStyle}
                        >
                          ■
                        </Button>
                        <Button
                          variant="secondary"
                          onClick={(e) => handleAction(app.id, "restart", e)}
                          disabled={restartMutation.isPending}
                          style={actionButtonStyle}
                        >
                          ↻
                        </Button>
                        <Button
                          variant="danger"
                          onClick={(e) => handleAction(app.id, "delete", e)}
                          disabled={deleteMutation.isPending}
                          style={actionButtonStyle}
                        >
                          ✕
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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

      <ConfirmDialog
        isOpen={confirmDialog.isOpen}
        title="DELETE APP"
        message={confirmDialog.message}
        variant="danger"
        onConfirm={handleConfirm}
        onCancel={() => setConfirmDialog({ isOpen: false, action: "", message: "", appId: "" })}
      />
    </div>
  );
}
