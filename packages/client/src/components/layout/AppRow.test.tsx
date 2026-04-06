import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppRow } from "./AppRow";

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
      getStackStatus: () => ({ containers: [{}, {}] }),
    }),
}));

describe("AppRow", () => {
  it("renders app metadata and status cells", () => {
    const onAction = vi.fn();
    render(
      <table>
        <tbody>
          <AppRow
            app={{
              id: "app-1",
              metadata: {
                name: "Row App",
                icon: "",
                createdAt: "2026-02-01T00:00:00.000Z",
              },
            } as never}
            onAction={onAction}
            isActionPending={() => false}
          />
        </tbody>
      </table>
    );
    expect(screen.getByText("Row App")).toBeInTheDocument();
    expect(screen.getByText("RUNNING")).toBeInTheDocument();
    expect(screen.getByText("2 containers")).toBeInTheDocument();
  });

  it("dispatches start/stop/restart/delete actions", () => {
    const onAction = vi.fn();
    render(
      <table>
        <tbody>
          <AppRow
            app={{
              id: "app-1",
              metadata: {
                name: "Row App",
                icon: "",
                createdAt: "2026-02-01T00:00:00.000Z",
              },
            } as never}
            onAction={onAction}
            isActionPending={() => false}
          />
        </tbody>
      </table>
    );
    fireEvent.click(screen.getByRole("button", { name: "▶" }));
    fireEvent.click(screen.getByRole("button", { name: "■" }));
    fireEvent.click(screen.getByRole("button", { name: "↻" }));
    fireEvent.click(screen.getByRole("button", { name: "✕" }));
    expect(onAction).toHaveBeenCalledTimes(4);
  });
});
