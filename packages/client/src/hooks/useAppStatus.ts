import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDockerEvents, type DockerEvent } from "./useDockerEvents";
import { useAppStatusStore, type AppStatus } from "../stores/appStatus";
import { trpcClient, useTRPC } from "../trpc";

const APP_ID_PREFIX = "deckos-";

export function useAppStatus(options?: { enabled?: boolean }) {
  const enabled = options?.enabled ?? true;
  const trpc = useTRPC();
  const setAppStatus = useAppStatusStore((state) => state.setAppStatus);
  const setStackStatuses = useAppStatusStore((state) => state.setStackStatuses);
  const triggerFlash = useAppStatusStore((state) => state.triggerFlash);
  const getAppStatus = useAppStatusStore((state) => state.getAppStatus);
  const getResolvedStatus = useAppStatusStore((state) => state.getResolvedStatus);
  const getStackStatus = useAppStatusStore((state) => state.getStackStatus);
  const processingRef = useRef<Set<string>>(new Set());
  const { data: apps } = useQuery(
    trpc.apps.list.queryOptions(undefined, {
      enabled,
    })
  );
  const appIds = apps?.map((app) => app.id) ?? [];

  const { data: batchStatuses } = useQuery({
    queryKey: ["stackStatusBatch", appIds],
    queryFn: async () => await trpcClient.docker.getStatuses.query({ appIds }),
    enabled: enabled && appIds.length > 0,
    refetchInterval: 5000,
  });

  useEffect(() => {
    processingRef.current = new Set();
  }, []);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    if (!batchStatuses) {
      if (appIds.length === 0) {
        setStackStatuses({});
      }
      return;
    }
    setStackStatuses(batchStatuses.statuses);
  }, [appIds.length, batchStatuses, enabled, setStackStatuses]);

  useDockerEvents(
    (event: DockerEvent) => {
      if (!enabled) {
        return;
      }
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
    },
    { enabled }
  );

  return { getAppStatus, getResolvedStatus, getStackStatus };
}
