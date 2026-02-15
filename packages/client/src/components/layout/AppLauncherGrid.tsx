import { useState, useCallback } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  closestCenter,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type { App } from "../../../../server/src/lib/schema.js";
import { AppTile } from "./AppTile";

export interface AppLauncherGridProps {
  apps: App[];
  onReorder?: (orderedIds: string[]) => void;
}

interface DraggableAppTileProps {
  app: App;
  isDragging: boolean;
}

function DraggableAppTile({ app, isDragging }: DraggableAppTileProps) {
  const {
    attributes,
    listeners,
    setNodeRef: setDraggableNodeRef,
    transform,
  } = useDraggable({
    id: app.id,
  });
  const { setNodeRef: setDroppableNodeRef } = useDroppable({
    id: app.id,
  });

  const setNodeRef = useCallback(
    (node: HTMLDivElement | null) => {
      setDraggableNodeRef(node);
      setDroppableNodeRef(node);
    },
    [setDraggableNodeRef, setDroppableNodeRef],
  );

  return (
    <AppTile
      app={app}
      rootRef={setNodeRef}
      rootProps={{
        ...attributes,
        ...listeners,
      }}
      style={{
        opacity: isDragging ? 0.5 : 1,
        cursor: "grab",
        userSelect: "none",
        touchAction: "none",
        transform: transform
          ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
          : undefined,
      }}
    />
  );
}

export function AppLauncherGrid({ apps, onReorder }: AppLauncherGridProps) {
  const [draggedApp, setDraggedApp] = useState<App | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5,
      },
    }),
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const { active } = event;
      const activeId = String(active.id);
      const app = apps.find((a) => a.id === activeId);
      if (app) {
        setDraggedApp(app);
      }
    },
    [apps],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;

      setDraggedApp(null);

      if (!over || active.id === over.id) {
        return;
      }

      const activeId = String(active.id);
      const overId = String(over.id);

      const oldIndex = apps.findIndex((a) => a.id === activeId);
      const newIndex = apps.findIndex((a) => a.id === overId);

      if (oldIndex === -1 || newIndex === -1) {
        return;
      }

      const newApps = [...apps];
      const [movedApp] = newApps.splice(oldIndex, 1);
      newApps.splice(newIndex, 0, movedApp);

      const orderedIds = newApps.map((a) => a.id);
      onReorder?.(orderedIds);
    },
    [apps, onReorder],
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div
        className="app-launcher-grid"
        style={{ minHeight: draggedApp ? "140px" : "auto" }}
      >
        {apps.map((app) => (
          <DraggableAppTile
            key={app.id}
            app={app}
            isDragging={draggedApp?.id === app.id}
          />
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
