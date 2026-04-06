import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "../apps/index";

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual("@tanstack/react-router");
  return {
    ...actual,
    Link: (props: { children: unknown }) => <span>{props.children as string}</span>,
  };
});

const { startSpy, stopSpy, restartSpy, deleteSpy, appsData } = vi.hoisted(() => ({
  startSpy: vi.fn(async () => ({})),
  stopSpy: vi.fn(async () => ({})),
  restartSpy: vi.fn(async () => ({})),
  deleteSpy: vi.fn(async () => ({})),
  appsData: [{ id: "app-1", name: "One" }],
}));

vi.mock("../../trpc", () => ({
  useTRPC: () => ({
    apps: {
      list: { queryOptions: () => ({ queryKey: ["apps.list"] }) },
    },
  }),
  trpcClient: {
    docker: {
      start: { mutate: startSpy },
      stop: { mutate: stopSpy },
      restart: { mutate: restartSpy },
    },
    apps: {
      delete: { mutate: deleteSpy },
    },
  },
}));

vi.mock("../../stores/toast", () => ({
  useToastStore: () => ({ addToast: vi.fn() }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: vi.fn(async () => {}),
  }),
  useQuery: () => ({ data: appsData }),
  useMutation: (opts: { mutationFn: (appId: string) => Promise<unknown> }) => ({
    isPending: false,
    variables: undefined,
    mutate: (appId: string) => {
      void opts.mutationFn(appId);
    },
  }),
}));

vi.mock("../../components/layout/AppRow", () => ({
  AppRow: (props: { app: { id: string }; onAction: (...args: unknown[]) => void }) => (
    <tr>
      <td>ROW</td>
      <td>
        <button
          onClick={() =>
            props.onAction(props.app.id, "start", { preventDefault() {}, stopPropagation() {} })
          }
        >
          START
        </button>
        <button
          onClick={() =>
            props.onAction(props.app.id, "delete", { preventDefault() {}, stopPropagation() {} })
          }
        >
          DELETE_ACTION
        </button>
      </td>
    </tr>
  ),
}));

describe("apps list route", () => {
  beforeEach(() => {
    appsData.splice(0, appsData.length, { id: "app-1", name: "One" });
    startSpy.mockReset();
    stopSpy.mockReset();
    restartSpy.mockReset();
    deleteSpy.mockReset();
  });

  it("dispatches start action mutation", () => {
    const Component = Route.options.component!;
    render(<Component />);
    fireEvent.click(screen.getByText("START"));
    expect(startSpy).toHaveBeenCalledWith({ appId: "app-1" });
    expect(stopSpy).not.toHaveBeenCalled();
    expect(restartSpy).not.toHaveBeenCalled();
  });

  it("opens delete confirmation and deletes only after confirm", () => {
    const Component = Route.options.component!;
    render(<Component />);
    fireEvent.click(screen.getByText("DELETE_ACTION"));
    expect(deleteSpy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "CONFIRM" }));
    expect(deleteSpy).toHaveBeenCalledWith({ id: "app-1" });
  });

  it("navigates users to template and custom creation links", () => {
    const Component = Route.options.component!;
    render(<Component />);
    expect(screen.getByText("+ TEMPLATED APP")).toBeInTheDocument();
    expect(screen.getByText("+ CUSTOM APP")).toBeInTheDocument();
  });
});
