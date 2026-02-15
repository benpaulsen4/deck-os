import { useEffect, useRef } from "react";
import { useMetricsStore } from "../stores/metrics";
import { useConnectionStore } from "../stores/connection";

export function useMetricsStream() {
  const { setMetrics, setConnected } = useMetricsStore();
  const { setConnected: setConnection } = useConnectionStore();
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const eventSource = new EventSource("/api/metrics/stream");

    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      setConnected(true);
      setConnection("metrics", true);
    };

    eventSource.onerror = (_error) => {
      setConnected(false);
      setConnection("metrics", false);
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

    return () => {
      eventSource.close();
      setConnected(false);
      setConnection("metrics", false);
    };
  }, [setMetrics, setConnected, setConnection]);

  return useMetricsStore();
}
