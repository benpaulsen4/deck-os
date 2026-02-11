import { useState, useEffect, useRef } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useConnectionStore } from "../../stores/connection";

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
// Current implementation caps logs at 1000 entries per container which should handle most use cases
// without noticeable performance degradation.

type FollowState = boolean | Record<string, boolean>;

export function LogViewer({ containers, height = "400px" }: LogViewerProps) {
  const [activeContainerId, setActiveContainerId] = useState<string | null>(null);
  const [logsByContainer, setLogsByContainer] = useState<Record<string, LogEntry[]>>({});
  const [isConnectedByContainer, setIsConnectedByContainer] = useState<Record<string, boolean>>({});
  const [follow, setFollow] = useState<FollowState>(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const eventSourceRefs = useRef<Record<string, EventSource>>({});
  const logsEndRefs = useRef<Record<string, HTMLDivElement>>({});
  const { setConnected } = useConnectionStore();

  useEffect(() => {
    if (containers.length > 0 && !activeContainerId) {
      setActiveContainerId(containers[0].id);
    }
  }, [containers, activeContainerId]);

  useEffect(() => {
    Object.keys(eventSourceRefs.current).forEach((id) => {
      if (!containers.find((c) => c.id === id)) {
        eventSourceRefs.current[id]?.close();
        delete eventSourceRefs.current[id];
      }
    });

    containers.forEach((container) => {
      if (!eventSourceRefs.current[container.id]) {
        const eventSource = new EventSource(`/api/logs/${container.id}`);
        eventSourceRefs.current[container.id] = eventSource;

        eventSource.onopen = () => {
          setIsConnectedByContainer((prev) => ({ ...prev, [container.id]: true }));
          setConnected("logs", true);
        };

        eventSource.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            const logEntry: LogEntry = {
              timestamp: new Date().toISOString(),
              line: data.line,
            };

            setLogsByContainer((prev) => ({
              ...prev,
              [container.id]: [...(prev[container.id] || []), logEntry].slice(-1000),
            }));
          } catch (e) {
            console.error("Failed to parse log entry:", e);
          }
        };

        eventSource.onerror = () => {
          setIsConnectedByContainer((prev) => ({ ...prev, [container.id]: false }));
          setConnected("logs", false);
          eventSource.close();
          delete eventSourceRefs.current[container.id];

          setTimeout(() => {
            eventSourceRefs.current[container.id] = new EventSource(`/api/logs/${container.id}`);
          }, 3000);
        };
      }
    });

    return () => {
      Object.values(eventSourceRefs.current).forEach((es) => es.close());
      setConnected("logs", false);
    };
  }, [containers, setConnected]);

  useEffect(() => {
    const currentFollow = follow === true || (follow as Record<string, boolean>)[activeContainerId || ""];
    
    if (currentFollow && logsEndRefs.current[activeContainerId || ""] && scrollRef.current) {
      logsEndRefs.current[activeContainerId || ""]?.scrollIntoView({ behavior: "smooth" });
    }
  }, [activeContainerId, logsByContainer, follow]);

  const handleScroll = () => {
    if (!scrollRef.current || !activeContainerId) return;
    
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const isAtBottom = scrollHeight - scrollTop <= clientHeight + 50;
    
    if (typeof follow === "object") {
      setFollow((prev) => ({ ...(prev as Record<string, boolean>), [activeContainerId]: isAtBottom }));
    } else {
      setFollow(isAtBottom);
    }
  };

  const toggleFollow = () => {
    if (typeof follow === "object") {
      setFollow((prev) => ({ ...(prev as Record<string, boolean>), [activeContainerId || ""]: !((prev as Record<string, boolean>)[activeContainerId || ""]) }));
    } else {
      setFollow(!follow);
    }
  };

  const currentFollow = typeof follow === "object" 
    ? (follow as Record<string, boolean>)[activeContainerId || ""] ?? true
    : follow;

  const currentLogs = activeContainerId ? logsByContainer[activeContainerId] || [] : [];
  const isConnected = activeContainerId ? isConnectedByContainer[activeContainerId] || false : false;

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
      <div style={{ ...containerStyle, alignItems: "center", justifyContent: "center", color: "var(--text-muted)" }}>
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
          <span>{activeContainerId ? containers.find((c) => c.id === activeContainerId)?.name || "Unknown" : "Select a container"}</span>
          {!isConnected && <span> - DISCONNECTED</span>}
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
      <div
        ref={scrollRef}
        style={contentStyle}
        onScroll={handleScroll}
      >
        {!activeContainerId || currentLogs.length === 0 ? (
          <div style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>
            {activeContainerId ? "Waiting for logs..." : "Select a container"}
          </div>
        ) : (
          currentLogs.map((log, i) => (
            <div key={i} style={lineStyle}>
              {log.timestamp && (
                <span style={timestampStyle}>
                  {new Date(log.timestamp).toLocaleTimeString("en-US", { hour12: false })}
                </span>
              )}
              {log.line}
            </div>
          ))
        )}
        <div ref={(el) => { if (activeContainerId) logsEndRefs.current[activeContainerId] = el as HTMLDivElement; }} />
      </div>
    </div>
  );
}