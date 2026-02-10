import { useEffect, useRef } from "react";
import { useMetricsStore } from "../stores/metrics";

export function useMetricsStream() {
  const { setMetrics, setConnected } = useMetricsStore();
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const eventSource = new EventSource("/api/metrics/stream");

    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      setConnected(true);
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
    };

    return () => {
      eventSource.close();
      setConnected(false);
    };
  }, [setMetrics, setConnected]);

  return useMetricsStore();
}