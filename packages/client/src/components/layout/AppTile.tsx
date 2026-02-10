import { type App } from "../../../../server/src/lib/schema.js";
import { Link } from "@tanstack/react-router";
import { useAppStatusStore } from "../../stores/appStatus";
import { useQuery } from "@tanstack/react-query";
import { trpcClient } from "../../trpc";
import type { AppStatus } from "../../stores/appStatus";

interface AppTileProps {
  app: App;
}

export function AppTile({ app }: AppTileProps) {
  const appStatus = useAppStatusStore((state) => state.appStatuses);
  const flashStates = useAppStatusStore((state) => state.flashStates);
  
  const { data: stackStatus } = useQuery({
    queryKey: ["stackStatus", app.id],
    queryFn: async () => await trpcClient.docker.getStatus.query({ appId: app.id }),
    refetchInterval: 5000,
  });

  const liveStatus: AppStatus = appStatus[app.id] || "unknown";
  const isFlashing = flashStates[app.id];

  const getActualStatus = (): AppStatus => {
    if (liveStatus && liveStatus !== "unknown") {
      return liveStatus;
    }
    if (!stackStatus) {
      return "unknown";
    }
    if (stackStatus.running > 0) {
      return "running";
    }
    if (stackStatus.stopped > 0) {
      return "stopped";
    }
    if (stackStatus.restarting > 0) {
      return "restarting";
    }
    return "unknown";
  };

  const status = getActualStatus();

  const getStatusLabel = (): string => {
    switch (status) {
      case "running": return "RUN";
      case "stopped": return "STOP";
      case "restarting": return "RESTARTING";
      case "warning": return "WARN";
      case "pulling": return "PULLING";
      default: return "UNKNOWN";
    }
  };

  const iconUrl = app.metadata.icon || "";
  const firstLetter = app.metadata.name.charAt(0).toUpperCase();

  return (
    <div className={`app-tile ${isFlashing ? "app-tile-flash" : ""}`}>
      <a
        href={app.metadata.url || "#"}
        target={app.metadata.url ? "_blank" : undefined}
        rel={app.metadata.url ? "noopener noreferrer" : undefined}
        className="app-tile-inner"
        style={{ textDecoration: "none", color: "inherit", display: "flex", flexDirection: "column", gap: "var(--space-2)", width: "100%", alignItems: "center" }}
      >
        <div className="app-tile-icon">
          {iconUrl ? (
            <img src={iconUrl} alt={app.metadata.name} />
          ) : (
            firstLetter
          )}
        </div>
        <span className="app-tile-name">{app.metadata.name}</span>
        <span className="app-tile-status">
          <span className="app-tile-status-dot" data-status={status} />
          {getStatusLabel()}
        </span>
      </a>
      <Link
        to="/apps/$appId"
        params={{ appId: app.id }}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
        className="app-tile-gear"
      >
        ⚙
      </Link>
    </div>
  );
}