import { useRouter } from "@tanstack/react-router";
import { AlertTriangle, RefreshCw, Home } from "lucide-react";
import { Button } from "./Button";

interface RouteErrorComponentProps {
  error: Error;
  reset?: () => void;
}

export function RouteErrorComponent({ error, reset }: RouteErrorComponentProps) {
  const router = useRouter();

  const handleRetry = () => {
    if (reset) {
      reset();
    } else {
      router.invalidate();
    }
  };

  return (
    <div className="page-container" style={{ paddingTop: "var(--space-8)" }}>
      <div
        className="panel"
        style={{ padding: "var(--space-4)", maxWidth: "600px", margin: "0 auto" }}
      >
        <div className="flex-row gap-2 mb-3">
          <AlertTriangle size={24} style={{ color: "var(--status-warning)" }} />
          <h1
            style={{
              fontSize: "var(--text-lg)",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: "var(--text-primary)",
            }}
          >
            Something went wrong
          </h1>
        </div>

        <p
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--text-secondary)",
            marginBottom: "var(--space-3)",
          }}
        >
          An error occurred while loading this page.
        </p>

        {error && (
          <div
            style={{
              background: "var(--bg-primary)",
              border: "1px solid var(--border-primary)",
              padding: "var(--space-2)",
              marginBottom: "var(--space-3)",
            }}
          >
            <div
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--text-muted)",
                marginBottom: "4px",
                textTransform: "uppercase",
              }}
            >
              Error Details
            </div>
            <div
              style={{
                fontSize: "var(--text-sm)",
                color: "var(--status-stopped)",
                fontFamily: "var(--font-mono)",
                wordBreak: "break-word",
              }}
            >
              {error.message || "Unknown error"}
            </div>
          </div>
        )}

        <div className="flex-row gap-2">
          <Button variant="primary" onClick={handleRetry}>
            <RefreshCw size={16} style={{ marginRight: "8px" }} />
            RETRY
          </Button>
          <Button variant="secondary" onClick={() => router.navigate({ to: "/" })}>
            <Home size={16} style={{ marginRight: "8px" }} />
            GO HOME
          </Button>
        </div>
      </div>
    </div>
  );
}
