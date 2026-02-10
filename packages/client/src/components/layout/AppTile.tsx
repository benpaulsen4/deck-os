import { type App } from "../../../../server/src/lib/schema.js";
import { Link } from "@tanstack/react-router";

interface AppTileProps {
  app: App;
}

export function AppTile({ app }: AppTileProps) {
  
  const getStatusLabel = (): string => {
    return "RUN";
  };

  const getStatusValue = (): "running" | "stopped" | "warning" | "pulling" => {
    return "running";
  };

  const iconUrl = app.metadata.icon || "";
  const firstLetter = app.metadata.name.charAt(0).toUpperCase();

  return (
    <div className="app-tile">
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
          <span
            className="app-tile-status-dot"
            data-status={getStatusValue()}
          />
          {getStatusLabel()}
        </span>
      </a>
      <Link
        to="/apps/$appId"
        params={{ appId: app.id }}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
        className="app-tile-gear"
        style={{ position: "absolute", top: "var(--space-2)", right: "var(--space-2)", color: "var(--text-muted)", textDecoration: "none", opacity: 0, transition: "opacity var(--transition-fast), color var(--transition-fast)" }}
      >
        ⚙
      </Link>
    </div>
  );
}