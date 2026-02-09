import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/apps/new")({
  component: NewAppPage,
});

function NewAppPage() {
  return (
    <div className="page-container">
      <div className="page-header">
        <h1 className="page-title">New App</h1>
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
        APP CREATION FORM WILL BE IMPLEMENTED IN PHASE 3
      </div>
    </div>
  );
}
