import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { trpcClient } from "../../trpc";
import { useMutation } from "@tanstack/react-query";
import { Input } from "../../components/ui/Input";
import { Button } from "../../components/ui/Button";
import { CodeEditor } from "../../components/ui/CodeEditor";
import { PullProgress } from "../../components/ui/PullProgress";
import { useToastStore } from "../../stores/toast";

export const Route = createFileRoute("/apps/new")({
  component: NewAppPage,
});

const defaultCompose = `version: '3.8'
services:
  app:
    image: nginx:latest
    ports:
      - "80:80"
`;

function NewAppPage() {
  const navigate = useNavigate();
  const { addToast } = useToastStore();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState("");
  const [url, setUrl] = useState("");
  const [composeYaml, setComposeYaml] = useState(defaultCompose);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [deployAppId, setDeployAppId] = useState<string | null>(null);
  const [isPulling, setIsPulling] = useState(false);

  const createAppMutation = useMutation({
    mutationFn: async (input: {
      name: string;
      description: string;
      icon: string;
      url: string;
      composeYaml: string;
    }) => {
      return await trpcClient.apps.create.mutate(input);
    },

    onSuccess: async (result: any) => {
      setDeployAppId(result.id);
      setIsPulling(true);
    },

    onError: (err: any) => {
      addToast(`Failed to create app: ${err.message}`, "error");
    },
  });

  const deployMutation = useMutation({
    mutationFn: async (appId: string) => {
      await trpcClient.docker.start.mutate({ appId });
      return appId;
    },
    onSuccess: async (appId: string) => {
      addToast("App created & deployed successfully", "success");
      navigate({ to: "/apps/$appId", params: { appId } });
    },
    onError: async (err: any, appId: string) => {
      let rollbackOk = false;
      try {
        await trpcClient.apps.delete.mutate({ id: appId });
        rollbackOk = true;
      } catch {}
      const reason = err instanceof Error ? err.message : "Deploy failed";
      addToast(
        rollbackOk
          ? `Failed to deploy app: ${reason} (rolled back)`
          : `Failed to deploy app: ${reason} (rollback failed)`,
        "error"
      );
      setDeployAppId(null);
    },
  });

  const handleValidate = async () => {
    setValidationError(null);

    try {
      const result = await trpcClient.apps.validateCompose.mutate({
        composeYaml,
      });
      if (result.valid) {
        addToast("Compose YAML is valid", "success");
      }
    } catch (err: unknown) {
      const error = err as { message?: string };
      setValidationError(error.message || "Invalid compose YAML");
      addToast("Validation failed", "error");
    }
  };

  const handleCreateAndDeploy = () => {
    setValidationError(null);
    createAppMutation.mutate({
      name,
      description,
      icon,
      url,
      composeYaml,
    });
  };

  return (
    <div className="page-container page-container--viewport">
      <div className="page-header">
        <h1 className="page-title">New App</h1>
      </div>

      <div className="page-body">
        <div className="page-grid-2col">
          <div className="page-col">
            <div className="panel" style={{ padding: "var(--space-3)" }}>
              <div className="label" style={{ marginBottom: "var(--space-2)" }}>
                METADATA
              </div>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--space-2)",
                }}
              >
                <Input
                  label="APP NAME"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="my-app"
                  required
                />

                <Input
                  label="DESCRIPTION"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="My awesome app"
                />

                <Input
                  label="ICON URL"
                  value={icon}
                  onChange={(e) => setIcon(e.target.value)}
                  placeholder="https://example.com/icon.png"
                />

                <Input
                  label="WEB URL"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="http://localhost:8080"
                />
              </div>

              {validationError && (
                <div
                  style={{
                    border: "1px solid var(--status-stopped)",
                    padding: "12px",
                    fontSize: "var(--text-sm)",
                    color: "var(--status-stopped)",
                    marginTop: "var(--space-2)",
                  }}
                >
                  {validationError}
                </div>
              )}

              <div
                style={{
                  display: "flex",
                  gap: "8px",
                  justifyContent: "flex-end",
                  marginTop: "var(--space-3)",
                }}
              >
                <Button
                  type="button"
                  variant="secondary"
                  onClick={handleValidate}
                  disabled={
                    createAppMutation.isPending || isPulling || deployMutation.isPending
                  }
                >
                  VALIDATE
                </Button>
                <Button
                  type="button"
                  onClick={handleCreateAndDeploy}
                  disabled={
                    createAppMutation.isPending ||
                    isPulling ||
                    deployMutation.isPending ||
                    !name ||
                    !composeYaml
                  }
                >
                  {createAppMutation.isPending
                    ? "CREATING..."
                    : deployMutation.isPending
                      ? "DEPLOYING..."
                      : "CREATE & DEPLOY"}
                </Button>
              </div>
            </div>
          </div>

          <div className="page-col">
            <div className="panel compose-editor-panel">
              <div className="label" style={{ marginBottom: "var(--space-2)" }}>
                COMPOSE FILE
              </div>
              <div className="compose-editor-body">
                <CodeEditor
                  value={composeYaml}
                  onChange={setComposeYaml}
                  minHeight="520px"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      <PullProgress
        isOpen={isPulling}
        appId={isPulling ? deployAppId : null}
        title="Pulling Images"
        onComplete={async (result) => {
          setIsPulling(false);
          if (!deployAppId) return;

          if (!result.ok) {
            let rollbackOk = false;
            try {
              await trpcClient.apps.delete.mutate({ id: deployAppId });
              rollbackOk = true;
            } catch {}
            addToast(
              rollbackOk
                ? `Failed to pull images: ${result.error || "Pull failed"} (rolled back)`
                : `Failed to pull images: ${result.error || "Pull failed"} (rollback failed)`,
              "error"
            );
            setDeployAppId(null);
            return;
          }

          deployMutation.mutate(deployAppId);
        }}
      />
    </div>
  );
}
