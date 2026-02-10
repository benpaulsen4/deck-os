import { useState, useCallback } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import type { App } from "../../../../server/src/lib/schema.js";

export interface AppLauncherGridProps {
  apps: App[];
  onReorder?: (orderedIds: string[]) => void;
}

interface DraggableAppTileProps {
  app: App;
  isDragging: boolean;
}

function DraggableAppTile({ app, isDragging }: DraggableAppTileProps) {
  const iconUrl = app.metadata.icon || "";
  const firstLetter = app.metadata.name.charAt(0).toUpperCase();

  return (
    <div
      className="app-tile"
      style={{
        opacity: isDragging ? 0.5 : 1,
        cursor: "grab",
        userSelect: "none",
      }}
    >
      <a
        href={app.metadata.url || "#"}
        target={app.metadata.url ? "_blank" : undefined}
        rel={app.metadata.url ? "noopener noreferrer" : undefined}
        className="app-tile-inner"
        style={{ textDecoration: "none", color: "inherit", display: "flex", flexDirection: "column", gap: "var(--space-2)", width: "100%", alignItems: "center", cursor: "pointer" }}
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
          <span className="app-tile-status-dot" data-status="unknown" />
          UNKNOWN
        </span>
      </a>
    </div>
  );
}

export function AppLauncherGrid({ apps, onReorder }: AppLauncherGridProps) {
  const [draggedApp, setDraggedApp] = useState<App | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5,
      },
    })
  );

  const handleDragStart = useCallback((event: any) => {
    const { active } = event;
    const app = apps.find((a) => a.id === active.id);
    if (app) {
      setDraggedApp(app);
    }
  }, [apps]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    
    setDraggedApp(null);

    if (!over || active.id === over.id) {
      return;
    }

    const oldIndex = apps.findIndex((a) => a.id === active.id);
    const newIndex = apps.findIndex((a) => a.id === over.id);

    if (oldIndex === -1 || newIndex === -1) {
      return;
    }

    const newApps = [...apps];
    const [movedApp] = newApps.splice(oldIndex, 1);
    newApps.splice(newIndex, 0, movedApp);

    const orderedIds = newApps.map((a) => a.id);
    onReorder?.(orderedIds);
  }, [apps, onReorder]);

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="app-launcher-grid" style={{ minHeight: draggedApp ? "140px" : "auto" }}>
        {apps.map((app) => (
          <DraggableAppTile key={app.id} app={app} isDragging={draggedApp?.id === app.id} />
        ))}
      </div>
      {draggedApp && (
        <DragOverlay>
          <DraggableAppTile app={draggedApp} isDragging={true} />
        </DragOverlay>
      )}
    </DndContext>
  );
}