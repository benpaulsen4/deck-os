import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  return (
    <div className="page-container">
      <div className="page-header">
        <h1 className="page-title">Settings</h1>
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
        SETTINGS WILL BE IMPLEMENTED IN PHASE 4
      </div>
    </div>
  );
}
