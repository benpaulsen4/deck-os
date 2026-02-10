import { useEffect, useState } from "react";

interface PullProgressProps {
  isOpen: boolean;
  onComplete: () => void;
  onPull: () => Promise<void>;
}

export function PullProgress({ isOpen, onComplete, onPull }: PullProgressProps) {
  const [isPulling, setIsPulling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || isPulling) return;

    setIsPulling(true);
    setError(null);

    onPull()
      .then(() => {
        setIsPulling(false);
        setTimeout(onComplete, 500);
      })
      .catch((err: unknown) => {
        setIsPulling(false);
        setError(err instanceof Error ? err.message : "Pull failed");
        setTimeout(onComplete, 2000);
      });
  }, [isOpen, onPull, onComplete]);

  if (!isOpen) return null;

  const overlayStyle: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    zIndex: 50,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };

  const backdropStyle: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    background: "rgba(0, 0, 0, 0.5)",
  };

  const panelStyle: React.CSSProperties = {
    position: "relative",
    background: "var(--bg-secondary)",
    border: "1px solid var(--border-primary)",
    padding: "var(--space-3)",
    width: "100%",
    maxWidth: "24rem",
    zIndex: 10,
  };

  const titleStyle: React.CSSProperties = {
    fontSize: "var(--text-lg)",
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    marginBottom: "var(--space-2)",
    color: "var(--text-primary)",
  };

  const statusStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-1)",
    fontSize: "var(--text-sm)",
    color: "var(--text-secondary)",
  };

  const contentStyle: React.CSSProperties = {
    marginTop: "var(--space-2)",
  };

  return (
    <div style={overlayStyle}>
      <div style={backdropStyle} />
      <div style={panelStyle}>
        <h2 style={titleStyle}>Pulling Images</h2>
        <div style={contentStyle}>
          {isPulling ? (
            <div>
              <div className="loading-scan" style={{ height: "2px", background: "var(--accent-primary)", marginBottom: "var(--space-2)" }} />
              <div style={statusStyle}>Pulling images from registry...</div>
            </div>
          ) : error ? (
            <div style={{ fontSize: "var(--text-sm)", color: "var(--status-stopped)", marginTop: "var(--space-2)" }}>
              {error}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}