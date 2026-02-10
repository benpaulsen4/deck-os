import { createFileRoute, Link } from "@tanstack/react-router";
import { useTRPC } from "../../trpc";
import { useQuery } from "@tanstack/react-query";

export const Route = createFileRoute("/apps/")({
  component: AppsPage,
});

function AppsPage() {
  const trpc = useTRPC();
  const { data: apps } = useQuery(trpc.apps.list.queryOptions());

  return (
    <div className="page-container">
      <div className="page-header">
        <h1 className="page-title">Apps</h1>
        <Link to="/apps/new" className="topbar-link">
          + NEW APP
        </Link>
      </div>
      {apps && apps.length > 0 ? (
        <div className="panel">
          {apps.map((app) => (
            <Link
              key={app.id}
              to="/apps/$appId"
              params={{ appId: app.id }}
              style={{
                padding: "var(--space-2) var(--space-3)",
                borderBottom: "1px solid var(--border-primary)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                textDecoration: "none",
                color: "inherit",
                transition: "background var(--transition-fast)",
              }}
            >
              <div>
                <div style={{ fontSize: "var(--text-md)", color: "var(--text-primary)", fontWeight: 500 }}>
                  {app.metadata.name}
                </div>
                <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)", marginTop: "4px" }}>
                  ID: {app.id}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                <span className="status-running status-pulse" style={{ fontSize: "var(--text-xs)" }}>
                  ● RUNNING
                </span>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="panel" style={{ padding: "var(--space-6)" }}>
          <div className="app-launcher-empty">
            NO APPS INSTALLED
            <br />
            <Link to="/apps/new">CREATE YOUR FIRST APP</Link>
          </div>
        </div>
      )}
    </div>
  );
}
