import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { trpcClient } from "../../trpc";
import { useMutation } from "@tanstack/react-query";
import { Input } from "../../components/ui/Input";
import { Button } from "../../components/ui/Button";
import { CodeEditor } from "../../components/ui/CodeEditor";
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

  const createAppMutation = useMutation({
    mutationFn: async (input: {
      name: string;
      description: string;
      icon: string;
      url: string;
      composeYaml: string;
    }) => {
      const created = await trpcClient.apps.create.mutate(input);
      try {
        await trpcClient.docker.start.mutate({ appId: created.id });
      } catch (err) {
        let rollbackOk = false;
        try {
          await trpcClient.apps.delete.mutate({ id: created.id });
          rollbackOk = true;
        } catch {}
        const reason = err instanceof Error ? err.message : "Deploy failed";
        throw new Error(
          rollbackOk
            ? `${reason} (rolled back)`
            : `${reason} (rollback failed)`,
        );
      }
      return created;
    },

    onSuccess: async (result: any) => {
      addToast("App created & deployed successfully", "success");
      navigate({ to: "/apps/$appId", params: { appId: result.id } });
    },

    onError: (err: any) => {
      addToast(`Failed to create/deploy app: ${err.message}`, "error");
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

  const pageContainerStyle: React.CSSProperties = {
    maxWidth: "1440px",
    margin: "0 auto",
    padding: "var(--space-3)",
    width: "100%",
  };

  const formStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-2)",
  };

  const composeSectionStyle: React.CSSProperties = {
    marginBottom: "var(--space-2)",
  };

  const errorBannerStyle: React.CSSProperties = {
    border: "1px solid var(--status-stopped)",
    padding: "12px",
    fontSize: "var(--text-sm)",
    color: "var(--status-stopped)",
  };

  const buttonContainerStyle: React.CSSProperties = {
    display: "flex",
    gap: "8px",
    justifyContent: "flex-end",
    marginTop: "var(--space-3)",
  };

  const labelStyle: React.CSSProperties = {
    display: "block",
    marginBottom: "4px",
    fontSize: "var(--text-xs)",
    fontWeight: "500",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    color: "var(--text-secondary)",
  };

  return (
    <div style={pageContainerStyle}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "var(--space-3)",
        }}
      >
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "var(--text-xl)",
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          New App
        </h1>
      </div>

      <div className="panel" style={{ padding: "var(--space-3)" }}>
        <form className="new-app-form" style={formStyle}>
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

          <div style={composeSectionStyle}>
            <label style={labelStyle}>COMPOSE FILE</label>
            <CodeEditor
              value={composeYaml}
              onChange={setComposeYaml}
              minHeight="400px"
            />
          </div>

          {validationError && (
            <div style={errorBannerStyle}>{validationError}</div>
          )}

          <div style={buttonContainerStyle}>
            <Button
              type="button"
              variant="secondary"
              onClick={handleValidate}
              disabled={createAppMutation.isPending}
            >
              VALIDATE
            </Button>
            <Button
              type="button"
              onClick={handleCreateAndDeploy}
              disabled={createAppMutation.isPending || !name || !composeYaml}
            >
              {createAppMutation.isPending ? "CREATING..." : "CREATE & DEPLOY"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
