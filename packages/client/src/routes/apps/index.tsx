import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTRPC } from "../../trpc";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { trpcClient } from "../../trpc";
import { useToastStore } from "../../stores/toast";
import { APP_BUSY_MESSAGE, isConflictError } from "../../hooks/useTRPCErrors";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { AppRow } from "../../components/layout/AppRow";

export const Route = createFileRoute("/apps/")({
  component: AppsPage,
});

function AppsPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { addToast } = useToastStore();

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

  /**
   * A rejected-because-busy lifecycle call is not an error the user can act on
   * beyond waiting, so it gets a plain informational toast instead of a
   * "Failed to ..." one. Anything else keeps the original wording.
   */
  const notifyActionError = (prefix: string, err: unknown) => {
    if (isConflictError(err)) {
      addToast(APP_BUSY_MESSAGE, "info");
      return;
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    addToast(`${prefix}: ${message}`, "error");
  };

  const invalidateStatusQueries = async (appId: string) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["stackStatus", appId] }),
      queryClient.invalidateQueries({ queryKey: ["stackStatusBatch"] }),
    ]);
  };

  const startMutation = useMutation({
    mutationFn: async (appId: string) => await trpcClient.docker.start.mutate({ appId }),
    onSuccess: async (_data, appId) => {
      addToast("App started", "success");
      await invalidateStatusQueries(appId);
    },
    onError: (err: unknown) => notifyActionError("Failed to start", err),
  });

  const stopMutation = useMutation({
    mutationFn: async (appId: string) => await trpcClient.docker.stop.mutate({ appId }),
    onSuccess: async (_data, appId) => {
      addToast("App stopped", "success");
      await invalidateStatusQueries(appId);
    },
    onError: (err: unknown) => notifyActionError("Failed to stop", err),
  });

  const restartMutation = useMutation({
    mutationFn: async (appId: string) =>
      await trpcClient.docker.restart.mutate({ appId }),
    onSuccess: async (_data, appId) => {
      addToast("App restarted", "success");
      await invalidateStatusQueries(appId);
    },
    onError: (err: unknown) => notifyActionError("Failed to restart", err),
  });

  const deleteMutation = useMutation({
    mutationFn: async (appId: string) =>
      await trpcClient.apps.delete.mutate({ id: appId }),
    onSuccess: async (_data, appId) => {
      addToast("App deleted", "success");
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: trpc.apps.list.queryOptions().queryKey,
        }),
        queryClient.invalidateQueries({ queryKey: ["stackStatus", appId] }),
        queryClient.invalidateQueries({ queryKey: ["stackStatusBatch"] }),
      ]);
    },
    onError: (err: unknown) => notifyActionError("Failed to delete", err),
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

  /**
   * The server serialises lifecycle work per app, so a second action started
   * while one is in flight is either rejected as busy (the docker procedures)
   * or queued behind a compose command that may run for minutes (apps.delete).
   * Disabling only the button that was clicked let the common case straight
   * through - clicking Restart on a row that is mid-Start - so every action on
   * a busy row is disabled instead. Other rows stay live: the lock is per app,
   * and operations on different apps really do run concurrently - hence a set
   * rather than a single "busy app".
   */
  const busyAppIds = new Set(
    [
      startMutation.isPending ? startMutation.variables : undefined,
      stopMutation.isPending ? stopMutation.variables : undefined,
      restartMutation.isPending ? restartMutation.variables : undefined,
      deleteMutation.isPending ? deleteMutation.variables : undefined,
    ].filter((appId): appId is string => typeof appId === "string")
  );

  const isActionDisabled = (appId: string) => busyAppIds.has(appId);

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
                    onAction={handleAction}
                    isActionDisabled={isActionDisabled}
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
              <Link to="/apps/templates">BROWSE TEMPLATES</Link>
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
