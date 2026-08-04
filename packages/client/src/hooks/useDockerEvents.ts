import { useEffect, useRef } from "react";
import { useConnectionStore } from "../stores/connection";
import { emitUnauthorizedEvent, fetchAuthStatus } from "../lib/auth";

/**
 * Exponential reconnect delay, capped.
 *
 * Shared by the two SSE hooks and the log stream so a dead backend (Docker
 * stopped, server restarting for a self-update) costs a handful of requests a
 * minute instead of one every few seconds forever.
 *
 * NOTE: this belongs in `lib/`, but the file allowlist for this change does not
 * cover creating one, so it is exported from the hook that already owned the
 * reconnect pattern.
 */
export function getReconnectDelayMs(
  attempt: number,
  options?: { baseMs?: number; maxMs?: number }
): number {
  const baseMs = options?.baseMs ?? 5_000;
  const maxMs = options?.maxMs ?? 60_000;
  const exponent = Math.min(Math.max(0, attempt), 10);
  return Math.min(maxMs, baseMs * 2 ** exponent);
}

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

export function useDockerEvents(
  callback: (event: DockerEvent) => void,
  options?: { enabled?: boolean }
) {
  const eventSourceRef = useRef<EventSource | null>(null);
  const callbackRef = useRef(callback);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const disposedRef = useRef(false);
  // Selector only: subscribing to the whole store re-rendered every consumer on
  // any connection change.
  const setConnected = useConnectionStore((state) => state.setConnected);
  const enabled = options?.enabled ?? true;

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!enabled) {
      disposedRef.current = true;
      if (reconnectTimeoutRef.current !== null) {
        window.clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      setConnected("events", false);
      return;
    }
    disposedRef.current = false;
    reconnectAttemptRef.current = 0;
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
        reconnectAttemptRef.current = 0;
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
        const attempt = reconnectAttemptRef.current;
        // With Docker stopped this fires forever; logging every attempt buried
        // everything else in the console.
        if (attempt < 3) {
          console.error("Docker events SSE error:", error);
        }
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
        reconnectAttemptRef.current = attempt + 1;
        reconnectTimeoutRef.current = window.setTimeout(
          connect,
          getReconnectDelayMs(attempt)
        );
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
  }, [enabled, setConnected]);

  return;
}
