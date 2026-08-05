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
            isActionDisabled={() => false}
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
            isActionDisabled={() => false}
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

  it("disables the whole action group while the app is busy", () => {
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
            isActionDisabled={(appId) => appId === "app-1"}
          />
        </tbody>
      </table>
    );

    for (const label of ["▶", "■", "↻", "✕"]) {
      const button = screen.getByRole("button", { name: label });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("title", "Busy - another operation is still running");
      fireEvent.click(button);
    }

    // The point of the group disable: a click landing mid-operation must not
    // reach the server at all, rather than being rejected as CONFLICT.
    expect(onAction).not.toHaveBeenCalled();
  });

  it("leaves other rows enabled - the lock is per app", () => {
    const onAction = vi.fn();
    render(
      <table>
        <tbody>
          <AppRow
            app={{
              id: "app-2",
              metadata: {
                name: "Other App",
                icon: "",
                createdAt: "2026-02-01T00:00:00.000Z",
              },
            } as never}
            onAction={onAction}
            isActionDisabled={(appId) => appId === "app-1"}
          />
        </tbody>
      </table>
    );

    const start = screen.getByRole("button", { name: "▶" });
    expect(start).toBeEnabled();
    expect(start).toHaveAttribute("title", "Start");
    fireEvent.click(start);
    expect(onAction).toHaveBeenCalledWith("app-2", "start", expect.anything());
  });
});
