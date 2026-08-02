import { useEffect, useRef } from "react";
import { useMetricsStore } from "../stores/metrics";
import { useConnectionStore } from "../stores/connection";
import { emitUnauthorizedEvent, fetchAuthStatus } from "../lib/auth";
import { getReconnectDelayMs } from "./useDockerEvents";

export function useMetricsStream() {
  const { setMetrics, setConnected } = useMetricsStore();
  const { setConnected: setConnection } = useConnectionStore();
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const disposedRef = useRef(false);

  useEffect(() => {
    disposedRef.current = false;
    reconnectAttemptRef.current = 0;

    /**
     * `EventSource` only retries by itself on transport failures. An HTTP error
     * response -- a 401 from the auth middleware, or a 502 from a proxy while the
     * server restarts for a self-update -- moves it to CLOSED permanently, which
     * left the dashboard with a red dot and frozen metrics until a manual reload.
     * So the hook drives its own reconnect, like `useDockerEvents` does.
     */
    const connect = () => {
      if (disposedRef.current) {
        return;
      }
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      const eventSource = new EventSource("/api/metrics/stream");
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        reconnectAttemptRef.current = 0;
        setConnected(true);
        setConnection("metrics", true);
      };

      eventSource.onerror = () => {
        if (disposedRef.current) {
          return;
        }
        setConnected(false);
        setConnection("metrics", false);
        void fetchAuthStatus()
          .then((status) => {
            if (status.enabled && !status.unlocked) {
              emitUnauthorizedEvent();
            }
          })
          .catch(() => {});
        eventSource.close();
        const attempt = reconnectAttemptRef.current;
        if (reconnectTimeoutRef.current !== null) {
          window.clearTimeout(reconnectTimeoutRef.current);
        }
        reconnectAttemptRef.current = attempt + 1;
        reconnectTimeoutRef.current = window.setTimeout(
          connect,
          getReconnectDelayMs(attempt, { baseMs: 1_000, maxMs: 30_000 })
        );
      };

      eventSource.addEventListener("metrics", (event) => {
        try {
          const data = JSON.parse((event as MessageEvent).data);
          setMetrics(data);
        } catch (e) {
          console.error("[dashboard] Failed to parse metrics:", e);
        }
      });
      eventSource.addEventListener("keepalive", () => {});
    };

    connect();

    return () => {
      disposedRef.current = true;
      if (reconnectTimeoutRef.current !== null) {
        window.clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      setConnected(false);
      setConnection("metrics", false);
    };
  }, [setMetrics, setConnected, setConnection]);

  return useMetricsStore();
}
