import { useEffect, useRef } from "react";
import { useConnectionStore } from "../stores/connection";
import { emitUnauthorizedEvent, fetchAuthStatus } from "../lib/auth";

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
  const reconnectTimeoutRef = useRef<number | null>(null);
  const disposedRef = useRef(false);
  const { setConnected } = useConnectionStore();

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    disposedRef.current = false;
    const connect = () => {
      if (disposedRef.current) {
        return;
      }
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      const eventSource = new EventSource("/api/docker/events");
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        setConnected("events", true);
      };

      const handleDockerEvent = (event: Event) => {
        try {
          const messageEvent = event as MessageEvent;
          const data = JSON.parse(messageEvent.data);
          callbackRef.current(data as DockerEvent);
        } catch (e) {
          console.error("Failed to parse Docker event:", e);
        }
      };

      eventSource.addEventListener("docker-event", handleDockerEvent);

      eventSource.onerror = (error) => {
        if (disposedRef.current) {
          return;
        }
        console.error("Docker events SSE error:", error);
        setConnected("events", false);
        void fetchAuthStatus()
          .then((status) => {
            if (status.enabled && !status.unlocked) {
              emitUnauthorizedEvent();
            }
          })
          .catch(() => {});
        eventSource.close();
        if (reconnectTimeoutRef.current !== null) {
          window.clearTimeout(reconnectTimeoutRef.current);
        }
        reconnectTimeoutRef.current = window.setTimeout(connect, 5000);
      };
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
        setConnected("events", false);
      }
    };
  }, [setConnected]);

  return;
}
