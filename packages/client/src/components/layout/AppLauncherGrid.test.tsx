import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppLauncherGrid } from "./AppLauncherGrid";

const state = vi.hoisted(() => ({
  startId: "a",
  overId: "b",
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: (props: {
    children: unknown;
    onDragStart: (event: { active: { id: string } }) => void;
    onDragEnd: (event: { active: { id: string }; over: { id: string } | null }) => void;
  }) => (
    <div>
      <button onClick={() => props.onDragStart({ active: { id: state.startId } })}>DRAG_START</button>
      <button
        onClick={() =>
          props.onDragEnd({
            active: { id: state.startId },
            over: state.overId ? { id: state.overId } : null,
          })
        }
      >
        DRAG_END
      </button>
      {props.children}
    </div>
  ),
  DragOverlay: (props: { children: unknown }) => <div>{props.children as never}</div>,
  MouseSensor: function MouseSensor() {},
  TouchSensor: function TouchSensor() {},
  useSensor: () => ({}),
  useSensors: () => [],
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
  }),
  useDroppable: () => ({ setNodeRef: vi.fn() }),
  closestCenter: vi.fn(),
}));

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual("@tanstack/react-router");
  return {
    ...actual,
    Link: (props: { children: unknown }) => <a>{props.children as string}</a>,
  };
});

vi.mock("../../stores/appStatus", () => ({
  useAppStatusStore: (selector: (state: unknown) => unknown) =>
    selector({
      getResolvedStatus: () => "running",
      flashStates: {},
    }),
}));

describe("AppLauncherGrid", () => {
  it("renders all app tiles", () => {
    render(
      <AppLauncherGrid
        apps={[
          { id: "a", metadata: { name: "Alpha", icon: "", url: "" } },
          { id: "b", metadata: { name: "Beta", icon: "", url: "" } },
        ] as never}
      />
    );
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("reorders apps when drag end lands on a different target", () => {
    const onReorder = vi.fn();
    render(
      <AppLauncherGrid
        apps={[
          { id: "a", metadata: { name: "Alpha", icon: "", url: "" } },
          { id: "b", metadata: { name: "Beta", icon: "", url: "" } },
        ] as never}
        onReorder={onReorder}
      />
    );
    fireEvent.click(screen.getByText("DRAG_START"));
    fireEvent.click(screen.getByText("DRAG_END"));
    expect(onReorder).toHaveBeenCalledWith(["b", "a"]);
  });
});
