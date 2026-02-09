import { createFileRoute } from "@tanstack/react-router";
import { useTRPC } from "../trpc";
import { useQuery } from "@tanstack/react-query";

export const Route = createFileRoute("/")({
  component: DashboardPage,
});

function DashboardPage() {
  const trpc = useTRPC();
  const ping = useQuery(trpc.system.ping.queryOptions());

  return (
    <div className="page-container">
      <div className="page-header">
        <h1 className="page-title">Dashboard</h1>
      </div>

      <div className="panel" style={{ padding: "var(--space-3)" }}>
        <div className="label" style={{ marginBottom: "var(--space-1)" }}>
          SYSTEM STATUS
        </div>
        {ping.isLoading && (
          <div style={{ color: "var(--text-muted)" }}>CONNECTING...</div>
        )}
        {ping.isError && (
          <div style={{ color: "var(--status-stopped)" }}>
            CONNECTION FAILED
          </div>
        )}
        {ping.data && (
          <div>
            <div style={{ color: "var(--status-running)", fontSize: "var(--text-md)", marginBottom: "var(--space-1)" }}>
              &#9632; ONLINE
            </div>
            <div style={{ color: "var(--text-secondary)", fontSize: "var(--text-sm)" }}>
              SERVER UPTIME: {Math.floor(ping.data.uptime)}s
            </div>
            <div style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)", marginTop: "var(--space-1)" }}>
              {ping.data.timestamp}
            </div>
          </div>
        )}
      </div>

      <div
        className="panel"
        style={{
          padding: "var(--space-3)",
          marginTop: "var(--space-2)",
          color: "var(--text-muted)",
          fontSize: "var(--text-sm)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          textAlign: "center",
        }}
      >
        METRICS AND APP LAUNCHER WILL BE IMPLEMENTED IN PHASE 2
      </div>
    </div>
  );
}
