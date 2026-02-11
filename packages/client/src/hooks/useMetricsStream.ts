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

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setMetrics(data);
      } catch (e) {
        console.error("Failed to parse metrics:", e);
      }
    };

    eventSource.onerror = () => {
      setConnected(false);
      setConnection("metrics", false);
    };

    return () => {
      eventSource.close();
      setConnected(false);
      setConnection("metrics", false);
    };
  }, [setMetrics, setConnected, setConnection]);

  return useMetricsStore();
}