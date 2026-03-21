import { useEffect, useRef, useState } from "react";
import { authFetch, emitUnauthorizedEvent, fetchAuthStatus } from "../../lib/auth";

interface PullProgressProps {
  isOpen: boolean;
  appId: string | null;
  title?: string;
  onComplete: (result: { ok: boolean; error?: string }) => void;
}

type PullOverallProgress = {
  currentBytes: number | null;
  totalBytes: number | null;
  percent: number;
  completedImages: number;
  totalImages: number;
  activeImage?: string;
  indeterminate: boolean;
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let idx = 0;
  let value = bytes;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx++;
  }
  const digits = idx <= 1 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[idx]}`;
}

function getErrorFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  return typeof record.error === "string" ? record.error : undefined;
}

async function safeJson(res: Response): Promise<unknown | null> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export function PullProgress({ isOpen, appId, title, onComplete }: PullProgressProps) {
  const [error, setError] = useState<string | null>(null);
  const [isPulling, setIsPulling] = useState(false);
  const [progress, setProgress] = useState<PullOverallProgress | null>(null);
  const onCompleteRef = useRef(onComplete);
  const completeTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    if (!isOpen || !appId) return;
    if (completeTimeoutRef.current !== null) {
      window.clearTimeout(completeTimeoutRef.current);
      completeTimeoutRef.current = null;
    }

    setIsPulling(true);
    setError(null);
    setProgress(null);

    let finished = false;
    const controller = new AbortController();
    let eventSource: EventSource | null = null;

    const completeOk = () => {
      if (finished) return;
      finished = true;
      controller.abort();
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      setIsPulling(false);
      completeTimeoutRef.current = window.setTimeout(() => {
        onCompleteRef.current({ ok: true });
        completeTimeoutRef.current = null;
      }, 500);
    };

    const completeErr = (message: string) => {
      if (finished) return;
      finished = true;
      controller.abort();
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      setIsPulling(false);
      setError(message);
      completeTimeoutRef.current = window.setTimeout(() => {
        onCompleteRef.current({ ok: false, error: message });
        completeTimeoutRef.current = null;
      }, 2000);
    };

    const start = async () => {
      try {
        const startRes = await authFetch(
          `/api/apps/${encodeURIComponent(appId)}/pull/start`,
          { method: "POST", signal: controller.signal }
        );
        if (!startRes.ok) {
          const body = await safeJson(startRes);
          completeErr(getErrorFromBody(body) ?? "Failed to start pull");
          return;
        }

        const startBody = (await startRes.json()) as { jobId?: string };
        const jobId = startBody.jobId;
        if (!jobId) {
          completeErr("Failed to start pull");
          return;
        }
        const encodedJobId = encodeURIComponent(jobId);
        eventSource = new EventSource(`/api/pull/${encodedJobId}`);
        let consecutiveFailures = 0;

        eventSource.onopen = () => {
          consecutiveFailures = 0;
        };

        eventSource.addEventListener("pull", (event) => {
          if (finished) return;
          try {
            const message = event as MessageEvent;
            const job = JSON.parse(message.data) as {
              status: "running" | "done" | "error";
              error?: string;
              progress: PullOverallProgress;
            };
            if (job.progress) {
              setProgress(job.progress);
            }
            if (job.status === "done") {
              completeOk();
            } else if (job.status === "error") {
              completeErr(job.error || "Pull failed");
            }
          } catch {
            completeErr("Invalid pull status update");
          }
        });

        eventSource.addEventListener("keepalive", () => {});

        eventSource.onerror = () => {
          if (finished) return;
          consecutiveFailures++;
          if (consecutiveFailures < 3) {
            return;
          }
          void fetchAuthStatus()
            .then((status) => {
              if (status.enabled && !status.unlocked) {
                emitUnauthorizedEvent();
              }
            })
            .catch(() => {});
          completeErr("Lost connection to pull job");
        };
      } catch (err: unknown) {
        if (finished) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        completeErr(err instanceof Error ? err.message : "Failed to start pull");
      }
    };

    start();

    return () => {
      controller.abort();
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      if (completeTimeoutRef.current !== null) {
        window.clearTimeout(completeTimeoutRef.current);
        completeTimeoutRef.current = null;
      }
    };
  }, [isOpen, appId]);

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

  const progressTrackStyle: React.CSSProperties = {
    marginTop: "var(--space-2)",
    background: "var(--bg-tertiary)",
    border: "1px solid var(--border-primary)",
    height: "10px",
    overflow: "hidden",
  };

  const progressFillStyle: React.CSSProperties = {
    height: "100%",
    width: `${Math.max(0, Math.min(100, progress?.percent ?? 0))}%`,
    background: "var(--accent-primary)",
    transition: "width 120ms linear",
  };

  return (
    <div style={overlayStyle}>
      <div style={backdropStyle} />
      <div
        style={panelStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pull-progress-title"
      >
        <h2 id="pull-progress-title" style={titleStyle}>
          {title || "Pulling Images"}
        </h2>
        <div style={contentStyle}>
          {isPulling ? (
            <div>
              <div style={statusStyle}>
                {progress
                  ? progress.currentBytes !== null && progress.totalBytes !== null
                    ? `${Math.floor(progress.percent)}% (${formatBytes(progress.currentBytes)} / ${formatBytes(progress.totalBytes)})`
                    : `${Math.floor(progress.percent)}% (${progress.completedImages}/${progress.totalImages} images)`
                  : "Preparing pull..."}
              </div>
              {progress?.activeImage && (
                <div
                  style={{
                    marginTop: "6px",
                    fontSize: "var(--text-xs)",
                    color: "var(--text-muted)",
                  }}
                >
                  {progress.activeImage}
                </div>
              )}
              <div style={progressTrackStyle}>
                <div style={progressFillStyle} />
              </div>
            </div>
          ) : error ? (
            <div
              style={{
                fontSize: "var(--text-sm)",
                color: "var(--status-stopped)",
                marginTop: "var(--space-2)",
              }}
            >
              {error}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
