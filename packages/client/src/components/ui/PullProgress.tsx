import { useCallback, useEffect, useRef, useState } from "react";
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

/**
 * Deliberately says "stopped watching", not "stopped pulling".
 *
 * Cancel aborts the client's request and closes the SSE stream, but the server's
 * pull job runs to completion: `cancelPullJob(jobId)` already exists in
 * `packages/server/src/services/pullJobs.ts:198` (it holds a live
 * `AbortController` per job) and simply has no HTTP route -- `runtimeRoutes.ts`
 * exposes only `POST /api/apps/:appId/pull/start` and the `GET /api/pull/:jobId`
 * stream. Until a `POST /api/pull/:jobId/cancel` exists and is called from
 * `cancelPull` below, claiming the download stopped would be a lie.
 */
export const PULL_CANCELLED_MESSAGE =
  "Stopped watching the pull. The download continues on the server until it finishes.";

export function PullProgress({ isOpen, appId, title, onComplete }: PullProgressProps) {
  const [error, setError] = useState<string | null>(null);
  const [isPulling, setIsPulling] = useState(false);
  const [progress, setProgress] = useState<PullOverallProgress | null>(null);
  const onCompleteRef = useRef(onComplete);
  const completeTimeoutRef = useRef<number | null>(null);
  // Hoisted out of the effect so the Cancel button and the Escape handler can
  // actually tear the pull down: previously nothing outside the SSE stream could
  // close this full-screen `aria-modal` overlay, so a stalled pull left a page
  // reload as the only exit -- which on the new-app route abandons an
  // already-created app whose rollback never runs.
  const abortRef = useRef<AbortController | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const finishedRef = useRef(false);

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

    finishedRef.current = false;
    const controller = new AbortController();
    abortRef.current = controller;

    const closeStream = () => {
      controller.abort();
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };

    const completeOk = () => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      closeStream();
      setIsPulling(false);
      completeTimeoutRef.current = window.setTimeout(() => {
        onCompleteRef.current({ ok: true });
        completeTimeoutRef.current = null;
      }, 500);
    };

    const completeErr = (message: string) => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      closeStream();
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
        const eventSource = new EventSource(`/api/pull/${encodedJobId}`);
        eventSourceRef.current = eventSource;
        let consecutiveFailures = 0;

        eventSource.onopen = () => {
          consecutiveFailures = 0;
        };

        eventSource.addEventListener("pull", (event) => {
          if (finishedRef.current) return;
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
          if (finishedRef.current) return;
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
        if (finishedRef.current) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        completeErr(err instanceof Error ? err.message : "Failed to start pull");
      }
    };

    start();

    return () => {
      closeStream();
      abortRef.current = null;
      if (completeTimeoutRef.current !== null) {
        window.clearTimeout(completeTimeoutRef.current);
        completeTimeoutRef.current = null;
      }
    };
  }, [isOpen, appId]);

  /**
   * Cancellation is reported through the existing `onComplete` contract
   * (`{ ok: false, error }`) rather than a new shape, because the route files
   * that consume it are outside this change. The routes already treat a
   * `{ ok: false }` result as a failed pull and run their rollback.
   */
  const cancelPull = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    abortRef.current?.abort();
    abortRef.current = null;
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    if (completeTimeoutRef.current !== null) {
      window.clearTimeout(completeTimeoutRef.current);
      completeTimeoutRef.current = null;
    }
    setIsPulling(false);
    setError(PULL_CANCELLED_MESSAGE);
    onCompleteRef.current({ ok: false, error: PULL_CANCELLED_MESSAGE });
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancelPull();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, cancelPull]);

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

  const actionsStyle: React.CSSProperties = {
    marginTop: "var(--space-3)",
    display: "flex",
    justifyContent: "flex-end",
  };

  const cancelButtonStyle: React.CSSProperties = {
    background: "transparent",
    border: "1px solid var(--border-primary)",
    color: "var(--text-secondary)",
    padding: "6px 12px",
    fontSize: "var(--text-xs)",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    cursor: "pointer",
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
        {isPulling && (
          <div style={actionsStyle}>
            <button type="button" onClick={cancelPull} style={cancelButtonStyle}>
              CANCEL
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
