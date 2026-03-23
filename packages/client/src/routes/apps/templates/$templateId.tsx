import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useTRPC, trpcClient } from "../../../trpc";
import { AppIcon } from "../../../components/ui/AppIcon";
import { Input } from "../../../components/ui/Input";
import { Button } from "../../../components/ui/Button";
import { CodeEditor } from "../../../components/ui/CodeEditor";
import { PullProgress } from "../../../components/ui/PullProgress";
import { useToastStore } from "../../../stores/toast";

export const Route = createFileRoute("/apps/templates/$templateId")({
  component: TemplateDetailPage,
});

function TemplateDetailPage() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const { addToast } = useToastStore();
  const { templateId } = Route.useParams();

  const { data: tpl } = useQuery(trpc.templates.get.queryOptions({ id: templateId }));

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState("");
  const [url, setUrl] = useState("");
  const [params, setParams] = useState<Record<string, string>>({});
  const [composeOverride, setComposeOverride] = useState<string | null>(null);
  const [isEditingCompose, setIsEditingCompose] = useState(false);
  const [deployAppId, setDeployAppId] = useState<string | null>(null);
  const [isPulling, setIsPulling] = useState(false);
  const [deployMode, setDeployMode] = useState<"deploy" | "deployStart">("deploy");

  useEffect(() => {
    if (!tpl) return;

    if (!name) setName(tpl.title);
    if (!description) setDescription(tpl.description || "");
    if (!icon) setIcon(tpl.icon || "");

    let initialParams: Record<string, string> | null = null;
    if (!Object.keys(params).length) {
      initialParams = {};
      for (const p of tpl.parameters ?? []) {
        if (p.defaultValue !== undefined) initialParams[p.key] = p.defaultValue;
        else initialParams[p.key] = "";
      }
      setParams(initialParams);
    }

    if (!url) {
      const host = window.location.hostname;
      const values = { ...(initialParams ?? params), DECKOS_HOST: host };
      const computed = renderStringTemplate(tpl.webUrlTemplate || "", values);
      if (computed) setUrl(computed);
    }
  }, [tpl, name, description, icon, url, params]);

  const renderedCompose = useMemo(() => {
    if (!tpl) return "";
    const host = window.location.hostname;
    const values = { ...params, DECKOS_HOST: host };
    return renderStringTemplate(tpl.composeTemplate, values);
  }, [tpl, params]);

  const activeCompose = composeOverride ?? renderedCompose;

  const deployMutation = useMutation({
    mutationFn: async (mode: "deploy" | "deployStart") => {
      if (!tpl) throw new Error("Template not loaded");
      const result = await trpcClient.templates.deploy.mutate({
        templateId: tpl.id,
        name,
        description,
        icon,
        url,
        parameters: params,
        composeOverride: isEditingCompose ? activeCompose : undefined,
      });
      return { appId: result.id, mode };
    },
    onSuccess: async ({ appId, mode }) => {
      if (mode === "deploy") {
        addToast("App created from template", "success");
        navigate({ to: "/apps/$appId", params: { appId } });
        return;
      }
      setDeployAppId(appId);
      setDeployMode("deployStart");
      setIsPulling(true);
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : "Unknown error";
      addToast(`Failed to deploy template: ${message}`, "error");
    },
  });

  return (
    <div className="page-container page-container--viewport template-deploy-layout">
      <div className="page-header">
        <h1 className="page-title">{tpl?.title || "Template"}</h1>
        <Link to="/apps/templates" className="page-header-action">
          BACK
        </Link>
      </div>
      <div className="page-body">
        <div className="page-grid-2col">
          <div className="page-col" style={{ minHeight: 0 }}>
            <div className="panel" style={{ padding: "var(--space-3)" }}>
              <div className="label" style={{ marginBottom: "var(--space-2)" }}>
                METADATA
              </div>
              <div
                style={{ display: "grid", gridTemplateColumns: "56px 1fr", gap: "12px" }}
              >
                <div
                  style={{
                    width: 56,
                    height: 56,
                    display: "grid",
                    placeItems: "center",
                    background: "var(--bg-tertiary)",
                    border: "1px solid var(--border-primary)",
                    color: "var(--text-secondary)",
                    fontSize: "var(--text-xl)",
                    fontWeight: 700,
                  }}
                >
                  <AppIcon
                    name={tpl?.title || "T"}
                    src={icon}
                    imgStyle={{ width: 36, height: 36, objectFit: "contain" }}
                  />
                </div>
                <div style={{ minWidth: 0 }}>
                  <Input
                    label="APP NAME"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
              </div>

              <Input
                label="DESCRIPTION"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
              <Input
                label="ICON URL"
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
              />
              <Input
                label="WEB URL"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>

            <div
              className="panel"
              style={{
                padding: "var(--space-3)",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <div className="label" style={{ marginBottom: "var(--space-2)" }}>
                PARAMETERS
              </div>
              <div style={{ maxHeight: "min(520px, 55vh)", overflow: "auto" }}>
                {tpl?.parameters?.length ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    {tpl.parameters.map((p) => (
                      <ParameterField
                        key={p.key}
                        param={p}
                        value={params[p.key] ?? ""}
                        onChange={(next) =>
                          setParams((prev) => ({
                            ...prev,
                            [p.key]: next,
                          }))
                        }
                      />
                    ))}
                  </div>
                ) : (
                  <div style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>
                    NO PARAMETERS
                  </div>
                )}
              </div>

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginTop: "var(--space-2)",
                }}
              >
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    if (!isEditingCompose) {
                      setComposeOverride(renderedCompose);
                      setIsEditingCompose(true);
                      return;
                    }
                    setIsEditingCompose(false);
                    setComposeOverride(null);
                  }}
                  disabled={deployMutation.isPending || isPulling}
                >
                  {isEditingCompose ? "HIDE COMPOSE EDITOR" : "EDIT COMPOSE"}
                </Button>
              </div>

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
                  onClick={() => deployMutation.mutate("deploy")}
                  disabled={deployMutation.isPending || isPulling || !name}
                >
                  DEPLOY
                </Button>
                <Button
                  type="button"
                  onClick={() => deployMutation.mutate("deployStart")}
                  disabled={deployMutation.isPending || isPulling || !name}
                >
                  DEPLOY & START
                </Button>
              </div>
            </div>
          </div>

          <div className="page-col">
            <div className="panel compose-editor-panel">
              <div className="label">COMPOSE</div>
              <div className="compose-editor-body">
                {isEditingCompose ? (
                  <CodeEditor
                    value={activeCompose}
                    onChange={(next) => setComposeOverride(next)}
                    minHeight="520px"
                  />
                ) : (
                  <pre className="app-detail-compose-pre" style={{ margin: 0 }}>
                    {activeCompose}
                  </pre>
                )}
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
          const appId = deployAppId;
          setDeployAppId(null);
          if (!appId) return;

          if (!result.ok) {
            let rollbackOk = false;
            try {
              await trpcClient.apps.delete.mutate({ id: appId });
              rollbackOk = true;
            } catch {
              rollbackOk = false;
            }
            addToast(
              rollbackOk
                ? `Failed to pull images: ${result.error || "Pull failed"} (rolled back)`
                : `Failed to pull images: ${result.error || "Pull failed"} (rollback failed)`,
              "error"
            );
            return;
          }

          if (deployMode === "deployStart") {
            try {
              await trpcClient.docker.start.mutate({ appId });
              addToast("App deployed successfully", "success");
              navigate({ to: "/apps/$appId", params: { appId } });
            } catch (err: unknown) {
              let rollbackOk = false;
              try {
                await trpcClient.apps.delete.mutate({ id: appId });
                rollbackOk = true;
              } catch {
                rollbackOk = false;
              }
              const reason = err instanceof Error ? err.message : "Deploy failed";
              addToast(
                rollbackOk
                  ? `Failed to start app: ${reason} (rolled back)`
                  : `Failed to start app: ${reason} (rollback failed)`,
                "error"
              );
            }
          }
        }}
      />
    </div>
  );
}

function renderStringTemplate(template: string, values: Record<string, string>): string {
  if (!template) return "";
  return template.replace(
    /\{\{([A-Z0-9_]+)\}\}/g,
    (_m, key: string) => values[key] ?? ""
  );
}

function ParameterField({
  param,
  value,
  onChange,
}: {
  param: {
    key: string;
    label: string;
    type: string;
    required?: boolean;
    options?: string[];
  };
  value: string;
  onChange: (value: string) => void;
}) {
  const label = param.required ? `${param.label} *` : param.label;

  if (param.type === "enum" && param.options?.length) {
    const selectId = `template-param-${param.key}`;
    return (
      <div>
        <label className="label" htmlFor={selectId} style={{ marginBottom: "4px" }}>
          {label}
        </label>
        <select
          id={selectId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: "100%",
            background: "var(--bg-input)",
            border: "1px solid var(--border-primary)",
            color: "var(--text-primary)",
            padding: "8px 12px",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-base)",
            minHeight: "40px",
          }}
        >
          {param.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </div>
    );
  }

  return (
    <Input
      label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      inputMode={param.type === "port" || param.type === "number" ? "numeric" : undefined}
    />
  );
}
