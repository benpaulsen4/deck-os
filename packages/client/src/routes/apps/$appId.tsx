import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Play, Square, RotateCcw, Download, Trash2, ExternalLink } from "lucide-react";
import { trpcClient } from "../../trpc";
import { Button } from "../../components/ui/Button";
import { ContainerTable } from "../../components/ui/ContainerTable";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { PullProgress } from "../../components/ui/PullProgress";
import { useToastStore } from "../../stores/toast";
import { CodeEditor } from "../../components/ui/CodeEditor";

export const Route = createFileRoute("/apps/$appId")({
  component: AppDetailPage,
});

const iconBoxStyle: React.CSSProperties = {
  width: "64px",
  height: "64px",
  background: "var(--bg-tertiary)",
  border: "1px solid var(--border-primary)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: "32px",
  fontWeight: "bold",
  color: "var(--text-secondary)",
};

const linkStyle: React.CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--accent-primary)",
  textDecoration: "none",
  display: "flex",
  alignItems: "center",
  gap: "4px",
};

const pageContainerStyle: React.CSSProperties = {
  maxWidth: "1440px",
  margin: "0 auto",
  padding: "var(--space-3)",
  width: "100%",
};

const buttonGroupStyle: React.CSSProperties = {
  display: "flex",
  gap: "8px",
  flexWrap: "wrap",
};

const sectionStyle: React.CSSProperties = {
  marginTop: "var(--space-3)",
};

function AppDetailPage() {
  const { appId } = Route.useParams();
  const { addToast } = useToastStore();
  
  const [isComposeEditOpen, setIsComposeEditOpen] = useState(false);
  const [editedComposeYaml, setEditedComposeYaml] = useState("");
  const [composeModified, setComposeModified] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{ isOpen: boolean; action: string; message: string }>({
    isOpen: false,
    action: "",
    message: "",
  });
  const [isPulling, setIsPulling] = useState(false);

  const { data: app, isLoading: appLoading } = useQuery({
    queryKey: ["app", appId],
    queryFn: async () => await trpcClient.apps.get.query({ id: appId }),
  });

  const { data: stackStatus } = useQuery({
    queryKey: ["stackStatus", appId],
    queryFn: async () => await trpcClient.docker.getStatus.query({ appId }),
    refetchInterval: 2000,
  });

  useEffect(() => {
    if (app) {
      setEditedComposeYaml(app.composeYaml);
    }
  }, [app]);

  const startMutation = useMutation({
    mutationFn: async () => await trpcClient.docker.start.mutate({ appId }),
    onSuccess: () => {
      addToast("App started", "success");
    },
    onError: (err: any) => {
      addToast(`Failed to start: ${err.message}`, "error");
    },
  });

  const stopMutation = useMutation({
    mutationFn: async () => await trpcClient.docker.stop.mutate({ appId }),
    onSuccess: () => {
      addToast("App stopped", "success");
    },
    onError: (err: any) => {
      addToast(`Failed to stop: ${err.message}`, "error");
    },
  });

  const restartMutation = useMutation({
    mutationFn: async () => await trpcClient.docker.restart.mutate({ appId }),
    onSuccess: () => {
      addToast("App restarted", "success");
    },
    onError: (err: any) => {
      addToast(`Failed to restart: ${err.message}`, "error");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => await trpcClient.apps.delete.mutate({ id: appId }),
    onSuccess: async () => {
      addToast("App deleted", "success");
      window.location.href = "/apps";
    },
    onError: (err: any) => {
      addToast(`Failed to delete: ${err.message}`, "error");
    },
  });

  const updateComposeMutation = useMutation({
    mutationFn: async () => await trpcClient.apps.updateCompose.mutate({ id: appId, composeYaml: editedComposeYaml }),
    onSuccess: () => {
      addToast("Compose file updated", "success");
      setComposeModified(false);
      setIsComposeEditOpen(false);
    },
    onError: (err: any) => {
      addToast(`Failed to update compose: ${err.message}`, "error");
    },
  });

  const pullMutation = useMutation({
    mutationFn: async () => await trpcClient.docker.pull.mutate({ appId }),
    onSuccess: () => {
      addToast("Images pulled successfully", "success");
    },
    onError: (err: any) => {
      addToast(`Failed to pull images: ${err.message}`, "error");
    },
  });

  const handleConfirmAction = (action: string) => {
    let message = "";
    
    if (action === "stop") {
      message = "Are you sure you want to stop this app?";
    } else if (action === "delete") {
      message = "Are you sure you want to delete this app? This action cannot be undone.";
    }
    
    setConfirmDialog({ isOpen: true, action, message });
  };

  const handleDialogConfirm = async () => {
    setConfirmDialog({ isOpen: false, action: "", message: "" });
    
    if (confirmDialog.action === "stop") {
      stopMutation.mutate();
    } else if (confirmDialog.action === "delete") {
      deleteMutation.mutate();
    }
  };

  const handlePull = () => {
    setIsPulling(true);
  };

  const isRunning = (stackStatus?.running ?? 0) > 0;

  if (appLoading) {
    return (
      <div className="page-container loading-scan" style={pageContainerStyle}>
        <div className="panel" style={{ padding: "var(--space-6)" }}>
          <span className="label">LOADING APP...</span>
        </div>
      </div>
    );
  }

  if (!app) {
    return (
      <div style={pageContainerStyle}>
        <div className="panel" style={{ padding: "var(--space-6)" }}>
          <span style={{ color: "var(--text-muted)" }}>App not found</span>
        </div>
      </div>
    );
  }

  const pageTitleStyle: React.CSSProperties = {
    fontFamily: "var(--font-display)",
    fontSize: "var(--text-xl)",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  };

  const statusStyle: React.CSSProperties = {
    fontSize: "var(--text-xs)",
    fontWeight: 500,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  };

  const descriptionStyle: React.CSSProperties = {
    fontSize: "var(--text-sm)",
    color: "var(--text-secondary)",
    marginBottom: "var(--space-3)",
  };

  const labelStyle: React.CSSProperties = {
    fontSize: "var(--text-xs)",
    fontWeight: 500,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    color: "var(--text-secondary)",
    marginBottom: "var(--space-2)",
  };

  const preStyle: React.CSSProperties = {
    fontSize: "var(--text-sm)",
    color: "var(--text-secondary)",
    whiteSpace: "pre-wrap",
    overflowX: "auto",
  };

  const modifierStyle: React.CSSProperties = {
    marginTop: "var(--space-2)",
    fontSize: "var(--text-xs)",
    color: "var(--status-warning)",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  };

  return (
    <div style={pageContainerStyle}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--space-3)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          <div style={iconBoxStyle}>
            {app.metadata.icon ? (
              <img src={app.metadata.icon} alt={app.metadata.name} style={{ width: "64px", height: "64px", objectFit: "contain" }} />
            ) : (
              app.metadata.name.charAt(0).toUpperCase()
            )}
          </div>
          <div>
            <h1 style={pageTitleStyle}>{app.metadata.name}</h1>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", marginTop: "4px" }}>
              <span style={{ ...statusStyle, color: isRunning ? "var(--status-running)" : "var(--status-stopped)" }}>
                {isRunning ? "● RUNNING" : "○ STOPPED"}
              </span>
              {app.metadata.url && (
                <a
                  href={app.metadata.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={linkStyle}
                >
                  <ExternalLink size={12} /> OPEN
                </a>
              )}
            </div>
          </div>
        </div>
      </div>

      <p style={descriptionStyle}>{app.metadata.description || "No description"}</p>

      <div className="panel" style={{ padding: "var(--space-3)" }}>
        <div style={buttonGroupStyle}>
          <Button variant="primary" onClick={() => startMutation.mutate()} disabled={startMutation.isPending || isRunning}>
            <Play size={16} style={{ marginRight: "8px" }} /> START
          </Button>
          <Button variant="danger" onClick={() => handleConfirmAction("stop")} disabled={stopMutation.isPending || !isRunning}>
            <Square size={16} style={{ marginRight: "8px" }} /> STOP
          </Button>
          <Button variant="secondary" onClick={() => restartMutation.mutate()} disabled={restartMutation.isPending}>
            <RotateCcw size={16} style={{ marginRight: "8px" }} /> RESTART
          </Button>
          <Button variant="secondary" onClick={handlePull}>
            <Download size={16} style={{ marginRight: "8px" }} /> PULL IMAGES
          </Button>
          <Button variant="danger" onClick={() => handleConfirmAction("delete")} disabled={deleteMutation.isPending}>
            <Trash2 size={16} style={{ marginRight: "8px" }} /> DELETE
          </Button>
        </div>
      </div>

      <div style={sectionStyle}>
        <div style={labelStyle}>CONTAINERS</div>
        <div className="panel">
          <ContainerTable containers={stackStatus?.containers || []} />
        </div>
      </div>

      <div style={sectionStyle}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
          <div style={labelStyle}>COMPOSE FILE</div>
          <Button
            variant="secondary"
            onClick={() => setIsComposeEditOpen(!isComposeEditOpen)}
          >
            {isComposeEditOpen ? "CLOSE" : "EDIT"}
          </Button>
        </div>
        {isComposeEditOpen ? (
          <div className="panel" style={{ padding: "var(--space-2)" }}>
            <CodeEditor
              value={editedComposeYaml}
              onChange={(value) => {
                setEditedComposeYaml(value);
                setComposeModified(value !== app.composeYaml);
              }}
              minHeight="400px"
            />
            {composeModified && (
              <div style={{ marginTop: "var(--space-2)", display: "flex", gap: "8px", justifyContent: "flex-end" }}>
                <Button variant="secondary" onClick={() => {
                  setEditedComposeYaml(app.composeYaml);
                  setComposeModified(false);
                }}>
                  CANCEL
                </Button>
                <Button
                  variant="primary"
                  onClick={() => updateComposeMutation.mutate()}
                  disabled={updateComposeMutation.isPending}
                >
                  {updateComposeMutation.isPending ? "SAVING..." : "SAVE"}
                </Button>
              </div>
            )}
            {composeModified && (
              <div style={modifierStyle}>
                Stack restart required to apply changes
              </div>
            )}
          </div>
        ) : (
          <div className="panel p-4">
            <pre style={preStyle}>{app.composeYaml}</pre>
          </div>
        )}
      </div>

      <ConfirmDialog
        isOpen={confirmDialog.isOpen}
        title={confirmDialog.action === "delete" ? "DELETE APP" : "STOP APP"}
        message={confirmDialog.message}
        variant={confirmDialog.action === "delete" ? "danger" : "default"}
        onConfirm={handleDialogConfirm}
        onCancel={() => setConfirmDialog({ isOpen: false, action: "", message: "" })}
      />

      <PullProgress
        isOpen={isPulling}
        onComplete={() => setIsPulling(false)}
        onPull={async () => {
          await pullMutation.mutateAsync();
        }}
      />
    </div>
  );
}