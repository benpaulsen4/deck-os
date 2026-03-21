import { useState, useEffect, useRef } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useConnectionStore } from "../../stores/connection";
import { authFetch } from "../../lib/auth";

interface LogEntry {
  timestamp?: string;
  line: string;
}

interface ContainerTab {
  id: string;
  name: string;
}

interface LogViewerProps {
  containers: ContainerTab[];
  height?: string;
}

// NOTE: Virtual scrolling could be implemented with react-window for very high log volumes.
// Current implementation caps logs at 5000 entries per container.

type FollowState = boolean | Record<string, boolean>;

export function LogViewer({ containers, height = "400px" }: LogViewerProps) {
  const [activeContainerId, setActiveContainerId] = useState<string | null>(null);
  const [logsByContainer, setLogsByContainer] = useState<Record<string, LogEntry[]>>({});
  const [isConnectedByContainer, setIsConnectedByContainer] = useState<
    Record<string, boolean>
  >({});
  const [isConnectingByContainer, setIsConnectingByContainer] = useState<
    Record<string, boolean>
  >({});
  const [errorByContainer, setErrorByContainer] = useState<Record<string, string | null>>(
    {}
  );
  const [follow, setFollow] = useState<FollowState>(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const streamControllersRef = useRef<Record<string, AbortController>>({});
  const reconnectTimeoutsRef = useRef<Record<string, number>>({});
  const flushTimeoutsRef = useRef<Record<string, number>>({});
  const pendingLogsRef = useRef<Record<string, LogEntry[]>>({});
  const sinceByContainerRef = useRef<Record<string, number>>({});
  const recentLinesRef = useRef<Record<string, Map<string, number>>>({});
  const logsEndRefs = useRef<Record<string, HTMLDivElement>>({});
  const { setConnected } = useConnectionStore();
  const maxEntriesPerContainer = 5000;
  const containerIdsKey = containers.map((c) => c.id).join("|");

  useEffect(() => {
    if (containers.length > 0 && !activeContainerId) {
      setActiveContainerId(containers[0].id);
    }
  }, [containers, activeContainerId]);

  useEffect(() => {
    setConnected("logs", Object.values(isConnectedByContainer).some(Boolean));
  }, [isConnectedByContainer, setConnected]);

  useEffect(() => {
    const activeIds = new Set(containers.map((c) => c.id));
    const decoder = new TextDecoder();
    let disposed = false;

    const enqueueLogs = (containerId: string, logs: LogEntry[]) => {
      if (logs.length === 0) return;
      pendingLogsRef.current[containerId] = [
        ...(pendingLogsRef.current[containerId] || []),
        ...logs,
      ];

      if (flushTimeoutsRef.current[containerId]) return;
      flushTimeoutsRef.current[containerId] = window.setTimeout(() => {
        delete flushTimeoutsRef.current[containerId];
        const batch = pendingLogsRef.current[containerId] || [];
        pendingLogsRef.current[containerId] = [];
        if (batch.length === 0) return;
        setLogsByContainer((prev) => ({
          ...prev,
          [containerId]: [...(prev[containerId] || []), ...batch].slice(
            -maxEntriesPerContainer
          ),
        }));
      }, 50);
    };

    const scheduleReconnect = (containerId: string) => {
      if (disposed) return;
      if (reconnectTimeoutsRef.current[containerId]) return;
      reconnectTimeoutsRef.current[containerId] = window.setTimeout(() => {
        delete reconnectTimeoutsRef.current[containerId];
        if (disposed) return;
        if (!activeIds.has(containerId)) return;
        void startStream(containerId, false);
      }, 3000);
    };

    const startStream = async (containerId: string, initial: boolean) => {
      if (streamControllersRef.current[containerId]) return;

      setIsConnectingByContainer((prev) => ({ ...prev, [containerId]: true }));
      setErrorByContainer((prev) => ({ ...prev, [containerId]: null }));

      const controller = new AbortController();
      streamControllersRef.current[containerId] = controller;

      try {
        const params = new URLSearchParams();
        if (initial) {
          params.set("tail", "2000");
        } else {
          const since = sinceByContainerRef.current[containerId];
          if (since !== undefined) {
            params.set("since", String(since));
          }
        }

        const res = await authFetch(`/api/logs/${containerId}?${params.toString()}`, {
          signal: controller.signal,
          headers: { Accept: "text/event-stream" },
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status} from /api/logs`);
        }

        sinceByContainerRef.current[containerId] = Math.floor(Date.now() / 1000) - 2;
        setIsConnectedByContainer((prev) => ({ ...prev, [containerId]: true }));
        setIsConnectingByContainer((prev) => ({
          ...prev,
          [containerId]: false,
        }));
        setErrorByContainer((prev) => ({ ...prev, [containerId]: null }));

        if (!res.body) {
          throw new Error("No response body for log stream");
        }

        const reader = res.body.getReader();
        let buffer = "";
        const recent =
          recentLinesRef.current[containerId] ||
          (recentLinesRef.current[containerId] = new Map());

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;

          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop() ?? "";

          for (const block of blocks) {
            const lines = block.split("\n");
            const dataLines: string[] = [];

            for (const line of lines) {
              if (line.startsWith("data:")) {
                dataLines.push(line.slice(5).trimStart());
              }
            }

            if (dataLines.length === 0) continue;

            const rawData = dataLines.join("\n");
            const nowMs = Date.now();
            try {
              const parsed = JSON.parse(rawData) as { line?: unknown };
              const line = typeof parsed?.line === "string" ? parsed.line : rawData;
              const lastSeen = recent.get(line);
              if (lastSeen !== undefined && nowMs - lastSeen < 2000) {
                continue;
              }
              recent.delete(line);
              recent.set(line, nowMs);
              if (recent.size > 500) {
                const toDrop = recent.size - 400;
                let dropped = 0;
                for (const key of recent.keys()) {
                  recent.delete(key);
                  dropped++;
                  if (dropped >= toDrop) break;
                }
              }
              const logEntry: LogEntry = {
                timestamp: new Date().toISOString(),
                line,
              };
              enqueueLogs(containerId, [logEntry]);
            } catch {
              const logEntry: LogEntry = {
                timestamp: new Date().toISOString(),
                line: rawData,
              };
              enqueueLogs(containerId, [logEntry]);
            }
          }
        }

        if (!controller.signal.aborted) {
          throw new Error("Log stream ended");
        }
      } catch (err) {
        if (controller.signal.aborted) return;

        setIsConnectedByContainer((prev) => ({
          ...prev,
          [containerId]: false,
        }));
        setIsConnectingByContainer((prev) => ({
          ...prev,
          [containerId]: false,
        }));
        setErrorByContainer((prev) => ({
          ...prev,
          [containerId]: err instanceof Error ? err.message : "Connection failed",
        }));
      } finally {
        if (streamControllersRef.current[containerId] === controller) {
          delete streamControllersRef.current[containerId];
        }
      }

      if (activeIds.has(containerId)) scheduleReconnect(containerId);
    };

    Object.keys(streamControllersRef.current).forEach((id) => {
      if (!activeIds.has(id)) {
        streamControllersRef.current[id]?.abort();
        delete streamControllersRef.current[id];
      }
    });

    Object.keys(reconnectTimeoutsRef.current).forEach((id) => {
      if (!activeIds.has(id)) {
        window.clearTimeout(reconnectTimeoutsRef.current[id]);
        delete reconnectTimeoutsRef.current[id];
      }
    });

    Object.keys(flushTimeoutsRef.current).forEach((id) => {
      if (!activeIds.has(id)) {
        window.clearTimeout(flushTimeoutsRef.current[id]);
        delete flushTimeoutsRef.current[id];
      }
    });

    Object.keys(pendingLogsRef.current).forEach((id) => {
      if (!activeIds.has(id)) {
        delete pendingLogsRef.current[id];
      }
    });

    Object.keys(sinceByContainerRef.current).forEach((id) => {
      if (!activeIds.has(id)) {
        delete sinceByContainerRef.current[id];
      }
    });

    Object.keys(recentLinesRef.current).forEach((id) => {
      if (!activeIds.has(id)) {
        delete recentLinesRef.current[id];
      }
    });

    setIsConnectedByContainer((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([id]) => activeIds.has(id)))
    );
    setIsConnectingByContainer((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([id]) => activeIds.has(id)))
    );
    setErrorByContainer((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([id]) => activeIds.has(id)))
    );
    setLogsByContainer((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([id]) => activeIds.has(id)))
    );

    containers.forEach((container) => {
      void startStream(container.id, true);
    });

    return () => {
      disposed = true;
      Object.keys(streamControllersRef.current).forEach((id) => {
        streamControllersRef.current[id]?.abort();
        delete streamControllersRef.current[id];
      });
      Object.keys(reconnectTimeoutsRef.current).forEach((id) => {
        window.clearTimeout(reconnectTimeoutsRef.current[id]);
        delete reconnectTimeoutsRef.current[id];
      });
      Object.keys(flushTimeoutsRef.current).forEach((id) => {
        window.clearTimeout(flushTimeoutsRef.current[id]);
        delete flushTimeoutsRef.current[id];
      });
      setConnected("logs", false);
    };
  }, [containerIdsKey, setConnected]);

  useEffect(() => {
    const currentFollow =
      follow === true || (follow as Record<string, boolean>)[activeContainerId || ""];

    if (
      currentFollow &&
      logsEndRefs.current[activeContainerId || ""] &&
      scrollRef.current
    ) {
      logsEndRefs.current[activeContainerId || ""]?.scrollIntoView({
        behavior: "smooth",
      });
    }
  }, [activeContainerId, logsByContainer, follow]);

  const handleScroll = () => {
    if (!scrollRef.current || !activeContainerId) return;

    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const isAtBottom = scrollHeight - scrollTop <= clientHeight + 50;

    if (typeof follow === "object") {
      setFollow((prev) => ({
        ...(prev as Record<string, boolean>),
        [activeContainerId]: isAtBottom,
      }));
    } else {
      setFollow(isAtBottom);
    }
  };

  const toggleFollow = () => {
    if (typeof follow === "object") {
      setFollow((prev) => ({
        ...(prev as Record<string, boolean>),
        [activeContainerId || ""]: !(prev as Record<string, boolean>)[
          activeContainerId || ""
        ],
      }));
    } else {
      setFollow(!follow);
    }
  };

  const currentFollow =
    typeof follow === "object"
      ? ((follow as Record<string, boolean>)[activeContainerId || ""] ?? true)
      : follow;

  const currentLogs = activeContainerId ? logsByContainer[activeContainerId] || [] : [];
  const isConnected = activeContainerId
    ? isConnectedByContainer[activeContainerId] || false
    : false;
  const isConnecting = activeContainerId
    ? isConnectingByContainer[activeContainerId] || false
    : false;
  const currentError = activeContainerId
    ? errorByContainer[activeContainerId] || null
    : null;

  const containerStyle: React.CSSProperties = {
    minHeight: height,
    maxHeight: height,
    display: "flex",
    flexDirection: "column",
  };

  const tabsStyle: React.CSSProperties = {
    display: "flex",
    background: "var(--bg-primary)",
    borderBottom: "1px solid var(--border-primary)",
  };

  const tabStyle: React.CSSProperties = {
    padding: "8px 12px",
    fontSize: "var(--text-xs)",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: "var(--text-secondary)",
    border: "none",
    background: "transparent",
    cursor: "pointer",
    borderBottom: "2px solid transparent",
  };

  const tabActiveStyle: React.CSSProperties = {
    borderBottomColor: "var(--accent-primary)",
    color: "var(--text-primary)",
  };

  const headerStyle: React.CSSProperties = {
    padding: "var(--space-2)",
    borderBottom: "1px solid var(--border-primary)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    fontSize: "var(--text-xs)",
    color: "var(--text-secondary)",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    background: "var(--bg-secondary)",
  };

  const contentStyle: React.CSSProperties = {
    flex: 1,
    overflow: "auto",
    background: "var(--bg-primary)",
    padding: "var(--space-2)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-sm)",
    color: "var(--text-secondary)",
  };

  const lineStyle: React.CSSProperties = {
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    padding: "2px 0",
    lineHeight: 1.4,
  };

  const timestampStyle: React.CSSProperties = {
    color: "var(--text-muted)",
    fontSize: "var(--text-xs)",
    marginRight: "8px",
    userSelect: "none",
  };

  const statusIndicatorStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "6px",
  };

  const statusDotStyle: React.CSSProperties = {
    width: "6px",
    height: "6px",
    borderRadius: "50%",
    background: isConnected ? "var(--status-running)" : "var(--status-stopped)",
  };

  if (containers.length === 0) {
    return (
      <div
        style={{
          ...containerStyle,
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-muted)",
        }}
      >
        No containers to show logs for
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <div style={tabsStyle}>
        {containers.map((container) => (
          <button
            key={container.id}
            type="button"
            onClick={() => setActiveContainerId(container.id)}
            style={{
              ...tabStyle,
              ...(activeContainerId === container.id ? tabActiveStyle : {}),
            }}
          >
            {container.name}
          </button>
        ))}
      </div>
      <div style={headerStyle}>
        <div style={statusIndicatorStyle}>
          <span style={statusDotStyle} />
          <span>
            {activeContainerId
              ? containers.find((c) => c.id === activeContainerId)?.name || "Unknown"
              : "Select a container"}
          </span>
          {isConnecting ? (
            <span> - CONNECTING</span>
          ) : !isConnected ? (
            <span> - DISCONNECTED</span>
          ) : null}
          {currentError ? <span> - {currentError}</span> : null}
        </div>
        <button
          type="button"
          onClick={toggleFollow}
          style={{
            background: currentFollow ? "var(--accent-muted)" : "transparent",
            border: "1px solid var(--border-primary)",
            color: currentFollow ? "var(--accent-primary)" : "var(--text-secondary)",
            padding: "4px 8px",
            fontSize: "var(--text-xs)",
            textTransform: "uppercase",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: "4px",
          }}
        >
          {currentFollow ? <Eye size={12} /> : <EyeOff size={12} />}
          {currentFollow ? "FOLLOWING" : "PAUSED"}
        </button>
      </div>
      <div ref={scrollRef} style={contentStyle} onScroll={handleScroll}>
        {!activeContainerId || currentLogs.length === 0 ? (
          <div style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>
            {activeContainerId ? "Waiting for logs..." : "Select a container"}
          </div>
        ) : (
          currentLogs.map((log, i) => (
            <div key={i} style={lineStyle}>
              {log.timestamp && (
                <span style={timestampStyle}>
                  {new Date(log.timestamp).toLocaleTimeString("en-US", {
                    hour12: false,
                  })}
                </span>
              )}
              {log.line}
            </div>
          ))
        )}
        <div
          ref={(el) => {
            if (activeContainerId)
              logsEndRefs.current[activeContainerId] = el as HTMLDivElement;
          }}
        />
      </div>
    </div>
  );
}
