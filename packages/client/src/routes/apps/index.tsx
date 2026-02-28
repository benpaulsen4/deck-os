import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTRPC } from "../../trpc";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { trpcClient } from "../../trpc";
import { useToastStore } from "../../stores/toast";
import { useAppStatus } from "../../hooks/useAppStatus";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { AppRow } from "../../components/layout/AppRow";

export const Route = createFileRoute("/apps/")({
  component: AppsPage,
});

function AppsPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { addToast } = useToastStore();

  // Initialize app status listener
  useAppStatus();

  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    action: string;
    message: string;
    appId: string;
  }>({
    isOpen: false,
    action: "",
    message: "",
    appId: "",
  });

  const { data: apps } = useQuery(trpc.apps.list.queryOptions());
  const appIds = apps?.map((a) => a.id) ?? [];
  const { data: batchStatuses } = useQuery({
    queryKey: ["stackStatusBatch", appIds],
    queryFn: async () => await trpcClient.docker.getStatuses.query({ appIds }),
    enabled: appIds.length > 0,
    refetchInterval: 5000,
  });

  const startMutation = useMutation({
    mutationFn: async (appId: string) => await trpcClient.docker.start.mutate({ appId }),
    onSuccess: () => {
      addToast("App started", "success");
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : "Unknown error";
      addToast(`Failed to start: ${message}`, "error");
    },
  });

  const stopMutation = useMutation({
    mutationFn: async (appId: string) => await trpcClient.docker.stop.mutate({ appId }),
    onSuccess: () => {
      addToast("App stopped", "success");
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : "Unknown error";
      addToast(`Failed to stop: ${message}`, "error");
    },
  });

  const restartMutation = useMutation({
    mutationFn: async (appId: string) =>
      await trpcClient.docker.restart.mutate({ appId }),
    onSuccess: () => {
      addToast("App restarted", "success");
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : "Unknown error";
      addToast(`Failed to restart: ${message}`, "error");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (appId: string) =>
      await trpcClient.apps.delete.mutate({ id: appId }),
    onSuccess: async () => {
      addToast("App deleted", "success");
      await queryClient.invalidateQueries({
        queryKey: trpc.apps.list.queryOptions().queryKey,
      });
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : "Unknown error";
      addToast(`Failed to delete: ${message}`, "error");
    },
  });

  const handleAction = (appId: string, action: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (action === "delete") {
      setConfirmDialog({
        isOpen: true,
        action: "delete",
        message:
          "Are you sure you want to delete this app? This action cannot be undone.",
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

  const isActionPending = (action: string) => {
    switch (action) {
      case "start":
        return startMutation.isPending;
      case "stop":
        return stopMutation.isPending;
      case "restart":
        return restartMutation.isPending;
      case "delete":
        return deleteMutation.isPending;
      default:
        return false;
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

  return (
    <div className="page-container page-container--viewport">
      <div className="page-header">
        <h1 className="page-title">Apps</h1>
        <div style={{ display: "flex", gap: "8px" }}>
          <Link to="/apps/templates" className="page-header-action">
            + TEMPLATED APP
          </Link>
          <Link to="/apps/new" className="page-header-action">
            + CUSTOM APP
          </Link>
        </div>
      </div>
      <div className="page-body">
        {apps && apps.length > 0 ? (
          <div className="panel apps-table-scroll">
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
                {apps.map((app) => (
                  <AppRow
                    key={app.id}
                    app={app}
                    stackStatus={batchStatuses?.statuses[app.id] ?? null}
                    onAction={handleAction}
                    isActionPending={isActionPending}
                  />
                ))}
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
      </div>

      <ConfirmDialog
        isOpen={confirmDialog.isOpen}
        title="DELETE APP"
        message={confirmDialog.message}
        variant="danger"
        onConfirm={handleConfirm}
        onCancel={() =>
          setConfirmDialog({
            isOpen: false,
            action: "",
            message: "",
            appId: "",
          })
        }
      />
    </div>
  );
}
