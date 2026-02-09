import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/apps/$appId")({
  component: AppDetailPage,
});

function AppDetailPage() {
  const { appId } = Route.useParams();

  return (
    <div className="page-container">
      <div className="page-header">
        <h1 className="page-title">App: {appId}</h1>
      </div>
      <div
        className="panel"
        style={{
          padding: "var(--space-6)",
          textAlign: "center",
          color: "var(--text-muted)",
          fontSize: "var(--text-sm)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        }}
      >
        APP DETAIL VIEW WILL BE IMPLEMENTED IN PHASE 4
      </div>
    </div>
  );
}
