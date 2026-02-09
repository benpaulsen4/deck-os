import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/apps/")({
  component: AppsPage,
});

function AppsPage() {
  return (
    <div className="page-container">
      <div className="page-header">
        <h1 className="page-title">Apps</h1>
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
        NO APPS INSTALLED
      </div>
    </div>
  );
}
