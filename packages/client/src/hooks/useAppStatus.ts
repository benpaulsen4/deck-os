import { useEffect, useRef } from "react";
import { useDockerEvents, type DockerEvent } from "./useDockerEvents";
import { useAppStatusStore, type AppStatus } from "../stores/appStatus";

const APP_ID_PREFIX = "deckos-";

export function useAppStatus() {
  const setAppStatus = useAppStatusStore((state) => state.setAppStatus);
  const triggerFlash = useAppStatusStore((state) => state.triggerFlash);
  const getAppStatus = useAppStatusStore((state) => state.getAppStatus);
  const processingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    processingRef.current = new Set();
  }, []);

  useDockerEvents((event: DockerEvent) => {
    if (event.Actor?.Attributes?.["com.docker.compose.project"]) {
      const projectName = event.Actor.Attributes["com.docker.compose.project"];
      
      if (!projectName.startsWith(APP_ID_PREFIX)) {
        return;
      }

      const appId = projectName.slice(APP_ID_PREFIX.length);
      const containerName = event.Actor.Attributes["name"];
      const eventKey = `${appId}:${containerName}:${event.Action}`;

      if (processingRef.current.has(eventKey)) {
        return;
      }

      processingRef.current.add(eventKey);

      setTimeout(() => {
        processingRef.current.delete(eventKey);
      }, 100);

      let newStatus: AppStatus;

      switch (event.Action) {
        case "start":
        case "unpause":
          newStatus = "running";
          break;
        case "stop":
        case "die":
        case "pause":
          newStatus = "stopped";
          break;
        case "restart":
          newStatus = "restarting";
          break;
        case "pull":
        case "pulling":
          newStatus = "pulling";
          break;
        default:
          return;
      }

      setAppStatus(appId, newStatus);
      triggerFlash(appId);
    }
  });

  return { getAppStatus };
}