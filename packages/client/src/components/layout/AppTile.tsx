import { type App } from "../../../../server/src/lib/schema.js";
import { Link } from "@tanstack/react-router";
import { useAppStatusStore } from "../../stores/appStatus";
import { AppIcon } from "../ui/AppIcon";

interface AppTileProps {
  app: App;
  style?: React.CSSProperties;
  className?: string;
  rootRef?: React.Ref<HTMLDivElement>;
  rootProps?: React.HTMLAttributes<HTMLDivElement>;
}

export function AppTile({ app, style, className, rootRef, rootProps }: AppTileProps) {
  const getResolvedStatus = useAppStatusStore((state) => state.getResolvedStatus);
  const flashStates = useAppStatusStore((state) => state.flashStates);
  const isFlashing = flashStates[app.id];
  const status = getResolvedStatus(app.id);

  const safeUrl = (() => {
    const u = typeof app.metadata.url === "string" ? app.metadata.url.trim() : "";
    if (!u) return "";
    return /^https?:\/\//i.test(u) ? u : "";
  })();

  const getStatusLabel = (): string => {
    switch (status) {
      case "running":
        return "RUN";
      case "stopped":
        return "STOP";
      case "restarting":
        return "RESTARTING";
      case "warning":
        return "WARN";
      case "pulling":
        return "PULLING";
      default:
        return "UNKNOWN";
    }
  };

  const {
    className: rootClassName,
    style: rootStyle,
    ...restRootProps
  } = rootProps ?? {};

  return (
    <div
      ref={rootRef}
      className={`app-tile ${isFlashing ? "app-tile-flash" : ""} ${rootClassName || ""} ${className || ""}`}
      style={{ ...(rootStyle ?? {}), ...(style ?? {}) }}
      {...restRootProps}
    >
      <a
        href={safeUrl || "#"}
        target={safeUrl ? "_blank" : undefined}
        rel={safeUrl ? "noopener noreferrer" : undefined}
        className="app-tile-inner"
        style={{
          textDecoration: "none",
          color: "inherit",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-2)",
          width: "100%",
          alignItems: "center",
        }}
      >
        <div className="app-tile-icon">
          <AppIcon name={app.metadata.name} src={app.metadata.icon} />
        </div>
        <span className="app-tile-name">{app.metadata.name}</span>
        <span className="app-tile-status">
          <span
            className={`app-tile-status-dot ${status === "running" ? "status-pulse" : ""}`}
            data-status={status}
          />
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
