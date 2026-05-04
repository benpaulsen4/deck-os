import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Play, Square, RotateCcw, Download, Trash2, ExternalLink } from "lucide-react";
import { trpcClient, useTRPC } from "../../trpc";
import { Button } from "../../components/ui/Button";
import { ContainerTable } from "../../components/ui/ContainerTable";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { PullProgress } from "../../components/ui/PullProgress";
import { AppIcon } from "../../components/ui/AppIcon";
import { useToastStore } from "../../stores/toast";
import { LogViewer } from "../../components/ui/LogViewer";
import { MetadataEditModal } from "../../components/layout/MetadataEditModal";
import { ComposeEditor } from "../../components/layout/ComposeEditor";

export const Route = createFileRoute("/apps/$appId")({
  component: AppDetailPage,
});

function AppDetailPage() {
  const [showLogs, setShowLogs] = useState(false);
  const [isMetadataEditOpen, setIsMetadataEditOpen] = useState(false);
  const [removeContainerTarget, setRemoveContainerTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [removingContainerId, setRemovingContainerId] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    action: string;
    message: string;
  }>({
    isOpen: false,
    action: "",
    message: "",
  });
  const [isPulling, setIsPulling] = useState(false);

  const { appId } = Route.useParams();
  const navigate = useNavigate();
  const { addToast } = useToastStore();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const {
    data: app,
    isLoading: appLoading,
    isError: isAppError,
    error: appError,
  } = useQuery(trpc.apps.get.queryOptions({ id: appId }));

  const { data: stackStatus } = useQuery({
    queryKey: ["stackStatus", appId],
    queryFn: async () => await trpcClient.docker.getStatus.query({ appId }),
    refetchInterval: 2000,
  });

  const getErrorMessage = (err: unknown): string => {
    if (err instanceof Error) return err.message;
    return String(err);
  };

  const invalidateStatusQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["stackStatus", appId] }),
      queryClient.invalidateQueries({ queryKey: ["stackStatusBatch"] }),
      queryClient.invalidateQueries({
        queryKey: trpc.apps.list.queryOptions().queryKey,
      }),
    ]);
  };

  const startMutation = useMutation({
    mutationFn: async () => await trpcClient.docker.start.mutate({ appId }),
    onSuccess: async () => {
      addToast("App started", "success");
      await invalidateStatusQueries();
    },
    onError: (err) => addToast(`Failed to start: ${getErrorMessage(err)}`, "error"),
  });

  const stopMutation = useMutation({
    mutationFn: async () => await trpcClient.docker.stop.mutate({ appId }),
    onSuccess: async () => {
      addToast("App stopped", "success");
      await invalidateStatusQueries();
    },
    onError: (err) => addToast(`Failed to stop: ${getErrorMessage(err)}`, "error"),
  });

  const restartMutation = useMutation({
    mutationFn: async () => await trpcClient.docker.restart.mutate({ appId }),
    onSuccess: async () => {
      addToast("App restarted", "success");
      await invalidateStatusQueries();
    },
    onError: (err) => addToast(`Failed to restart: ${getErrorMessage(err)}`, "error"),
  });

  const removeUnknownContainerMutation = useMutation({
    mutationFn: async (containerId: string) =>
      await trpcClient.docker.removeContainer.mutate({ appId, containerId }),
    onSuccess: async () => {
      addToast("Unknown container removed", "success");
      await invalidateStatusQueries();
    },
    onError: (err) => addToast(`Failed to remove container: ${getErrorMessage(err)}`, "error"),
    onSettled: () => {
      setRemovingContainerId(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => await trpcClient.apps.delete.mutate({ id: appId }),
    onSuccess: async () => {
      addToast("App deleted", "success");
      await navigate({ to: "/apps" });
    },
    onError: (err) => addToast(`Failed to delete: ${getErrorMessage(err)}`, "error"),
  });

  const handleConfirmAction = (action: string) => {
    const messages: Record<string, string> = {
      stop: "Are you sure you want to stop this app?",
      delete: "Are you sure you want to delete this app? This action cannot be undone.",
    };
    setConfirmDialog({ isOpen: true, action, message: messages[action] || "" });
  };

  const handleDialogConfirm = () => {
    const { action } = confirmDialog;
    setConfirmDialog({ isOpen: false, action: "", message: "" });
    if (action === "stop") stopMutation.mutate();
    else if (action === "delete") deleteMutation.mutate();
  };

  const isRunning = (stackStatus?.running ?? 0) > 0;
  const safeUrl = (() => {
    const u = typeof app?.metadata.url === "string" ? app.metadata.url.trim() : "";
    return u && /^https?:\/\//i.test(u) ? u : "";
  })();

  if (appLoading) {
    return (
      <div className="page-container page-container--viewport loading-scan">
        <div className="panel" style={{ padding: "var(--space-6)" }}>
          <span className="label">LOADING APP...</span>
        </div>
      </div>
    );
  }

  if (!app) {
    if (isAppError) {
      return (
        <div className="page-container page-container--viewport">
          <div className="panel" style={{ padding: "var(--space-6)" }}>
            <span className="text-muted">{getErrorMessage(appError)}</span>
          </div>
        </div>
      );
    }
    return (
      <div className="page-container page-container--viewport">
        <div className="panel" style={{ padding: "var(--space-6)" }}>
          <span className="text-muted">App not found</span>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container page-container--viewport app-detail-layout">
      <div className="page-body">
        <div className="page-grid-2col">
          <div className="page-col">
            <div className="app-detail-header">
              <div className="flex-row gap-2">
                <div className="app-detail-icon-box">
                  <AppIcon
                    name={app.metadata.name}
                    src={app.metadata.icon}
                    imgStyle={{ width: "64px", height: "64px", objectFit: "contain" }}
                  />
                </div>
                <div>
                  <h1 className="app-detail-title">{app.metadata.name}</h1>
                  <div className="flex-row gap-2" style={{ marginTop: "4px" }}>
                    <span
                      className="app-detail-status"
                      style={{
                        color: isRunning
                          ? "var(--status-running)"
                          : "var(--status-stopped)",
                      }}
                    >
                      {isRunning ? "\u25cf RUNNING" : "\u25cb STOPPED"}
                    </span>
                    {safeUrl && (
                      <a
                        href={safeUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="app-detail-link"
                      >
                        <ExternalLink size={12} /> OPEN
                      </a>
                    )}
                  </div>
                </div>
              </div>
              <Button variant="secondary" onClick={() => setIsMetadataEditOpen(true)}>
                EDIT METADATA
              </Button>
            </div>

            <p className="app-detail-description">
              {app.metadata.description || "No description"}
            </p>

            <div className="panel app-detail-actions-bar">
              <div className="app-detail-button-group">
                <Button
                  variant="primary"
                  onClick={() => startMutation.mutate()}
                  disabled={startMutation.isPending || isRunning}
                >
                  <Play size={16} style={{ marginRight: "8px" }} /> START
                </Button>
                <Button
                  variant="danger"
                  onClick={() => handleConfirmAction("stop")}
                  disabled={stopMutation.isPending || !isRunning}
                >
                  <Square size={16} style={{ marginRight: "8px" }} /> STOP
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => restartMutation.mutate()}
                  disabled={restartMutation.isPending}
                >
                  <RotateCcw size={16} style={{ marginRight: "8px" }} /> RESTART
                </Button>
                <Button variant="secondary" onClick={() => setIsPulling(true)}>
                  <Download size={16} style={{ marginRight: "8px" }} /> PULL IMAGES
                </Button>
                <Button
                  variant="danger"
                  onClick={() => handleConfirmAction("delete")}
                  disabled={deleteMutation.isPending}
                >
                  <Trash2 size={16} style={{ marginRight: "8px" }} /> DELETE
                </Button>
              </div>
            </div>

            <div className="app-detail-section app-detail-containers">
              <div className="app-detail-section-label">CONTAINERS</div>
              <div className="panel app-detail-containers-panel">
                <ContainerTable
                  containers={stackStatus?.containers || []}
                  removingContainerId={removingContainerId}
                  onRemoveUnknownContainer={(container) => {
                    setRemoveContainerTarget({
                      id: container.id,
                      name: container.names[0]?.replace(/^\//, "") || container.id.slice(0, 12),
                    });
                  }}
                />
              </div>
            </div>
          </div>

          <div className="page-col">
            <div className="page-col-scroll app-detail-right-col">
              <ComposeEditor app={app} />

              <div className="app-detail-section">
                <div className="app-detail-section-header">
                  <div className="app-detail-section-label" style={{ marginBottom: 0 }}>
                    LOGS
                  </div>
                  <Button variant="secondary" onClick={() => setShowLogs(!showLogs)}>
                    {showLogs ? "HIDE" : "SHOW"}
                  </Button>
                </div>
                {showLogs ? (
                  <div className="panel" style={{ padding: 0 }}>
                    <LogViewer
                      containers={
                        stackStatus?.containers.map((c) => ({
                          id: c.id,
                          name: c.names[0]?.replace(/^\//, "") || c.id.slice(0, 12),
                        })) || []
                      }
                    />
                  </div>
                ) : (
                  <div className="panel" style={{ padding: "var(--space-3)" }}>
                    <span className="text-muted">LOGS HIDDEN</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <MetadataEditModal
        app={app}
        isOpen={isMetadataEditOpen}
        onClose={() => setIsMetadataEditOpen(false)}
      />

      <ConfirmDialog
        isOpen={confirmDialog.isOpen}
        title={confirmDialog.action === "delete" ? "DELETE APP" : "STOP APP"}
        message={confirmDialog.message}
        variant={confirmDialog.action === "delete" ? "danger" : "default"}
        onConfirm={handleDialogConfirm}
        onCancel={() => setConfirmDialog({ isOpen: false, action: "", message: "" })}
      />

      <ConfirmDialog
        isOpen={removeContainerTarget !== null}
        title="REMOVE UNKNOWN CONTAINER"
        message={
          removeContainerTarget
            ? `Remove ${removeContainerTarget.name}? This only deletes the selected unknown container, not the full app stack.`
            : ""
        }
        confirmText="REMOVE"
        variant="danger"
        onConfirm={() => {
          if (!removeContainerTarget) {
            return;
          }
          const target = removeContainerTarget;
          setRemovingContainerId(target.id);
          setRemoveContainerTarget(null);
          removeUnknownContainerMutation.mutate(target.id);
        }}
        onCancel={() => setRemoveContainerTarget(null)}
      />

      <PullProgress
        isOpen={isPulling}
        appId={isPulling ? appId : null}
        onComplete={(result) => {
          setIsPulling(false);
          if (result.ok) {
            addToast("Images pulled successfully", "success");
          } else {
            addToast(`Failed to pull images: ${result.error || "Pull failed"}`, "error");
          }
        }}
      />
    </div>
  );
}
