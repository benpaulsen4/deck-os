import { useEffect, useRef } from "react";
import { useConnectionStore } from "../stores/connection";

export interface DockerEvent {
  Type: string;
  Action: string;
  Actor: {
    ID: string;
    Attributes: {
      [key: string]: string;
    };
  };
  time: number;
  timeNano: number;
}

export function useDockerEvents(callback: (event: DockerEvent) => void) {
  const eventSourceRef = useRef<EventSource | null>(null);
  const callbackRef = useRef(callback);
  const { setConnected } = useConnectionStore();

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    const connect = () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      const eventSource = new EventSource("/api/docker/events");
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        setConnected("events", true);
      };

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          callbackRef.current(data as DockerEvent);
        } catch (e) {
          console.error("Failed to parse Docker event:", e);
        }
      };

      eventSource.onerror = (error) => {
        console.error("Docker events SSE error:", error);
        setConnected("events", false);
        eventSource.close();
        setTimeout(connect, 5000);
      };
    };

    connect();

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
        setConnected("events", false);
      }
    };
  }, [setConnected]);

  return;
}