import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "../index";

const { reorderSpy, addToastSpy, setQueryDataSpy, appsData } = vi.hoisted(() => ({
  reorderSpy: vi.fn(async () => ({})),
  addToastSpy: vi.fn(),
  setQueryDataSpy: vi.fn(),
  appsData: [{ id: "a", name: "A" }],
}));

vi.mock("../../trpc", () => ({
  useTRPC: () => ({
    apps: {
      list: {
        queryOptions: () => ({ queryKey: ["apps.list"] }),
      },
    },
  }),
  trpcClient: {
    apps: {
      reorder: {
        mutate: reorderSpy,
      },
    },
  },
}));

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual("@tanstack/react-router");
  return {
    ...actual,
    Link: (props: { children: unknown }) => <span>{props.children as string}</span>,
  };
});

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    cancelQueries: vi.fn(async () => {}),
    getQueryData: vi.fn(() => appsData),
    setQueryData: setQueryDataSpy,
    invalidateQueries: vi.fn(async () => {}),
  }),
  useMutation: (opts: {
    mutationFn: (arg: string[]) => Promise<unknown>;
    onMutate?: (arg: string[]) => Promise<unknown>;
    onError?: (err: unknown, arg: string[], ctx: unknown) => void;
    onSettled?: () => void;
  }) => ({
    mutate: async (arg: string[]) => {
      let context: unknown;
      if (opts.onMutate) {
        context = await opts.onMutate(arg);
      }
      try {
        await opts.mutationFn(arg);
      } catch (error) {
        opts.onError?.(error, arg, context);
      } finally {
        opts.onSettled?.();
      }
    },
  }),
  useQuery: () => ({ data: appsData }),
}));

vi.mock("../../hooks/useMetricsStream", () => ({
  useMetricsStream: () => ({ metrics: null }),
}));

vi.mock("../../stores/toast", () => ({
  useToastStore: () => ({ addToast: addToastSpy }),
}));

vi.mock("../../components/layout/SystemInfoBar", () => ({
  SystemInfoBar: () => <div>SYSTEM_INFO</div>,
}));

vi.mock("../../components/layout/MetricsCard", () => ({
  MetricsCard: () => <div>METRIC_CARD</div>,
}));

vi.mock("../../components/layout/AppLauncherGrid", () => ({
  AppLauncherGrid: (props: { onReorder: (orderedIds: string[]) => void }) => (
    <button onClick={() => props.onReorder(["a"])}>REORDER</button>
  ),
}));

describe("dashboard route", () => {
  beforeEach(() => {
    appsData.splice(0, appsData.length, { id: "a", name: "A" });
    reorderSpy.mockReset();
    addToastSpy.mockReset();
    setQueryDataSpy.mockReset();
  });

  it("invokes reorder mutation from app launcher", async () => {
    const Component = Route.options.component;
    render(<Component />);
    fireEvent.click(screen.getByText("REORDER"));
    await waitFor(() => expect(reorderSpy).toHaveBeenCalledWith({ orderedIds: ["a"] }));
  });

  it("shows empty-state CTA to /apps/templates when no apps", () => {
    appsData.splice(0, appsData.length);
    const Component = Route.options.component;
    render(<Component />);
    expect(screen.getByText("BROWSE TEMPLATES")).toBeInTheDocument();
    expect(screen.getByText("NO APPS INSTALLED")).toBeInTheDocument();
  });

  it("rolls back optimistic reorder on mutation error", async () => {
    reorderSpy.mockRejectedValueOnce(new Error("network failed"));
    const Component = Route.options.component;
    render(<Component />);
    fireEvent.click(screen.getByText("REORDER"));
    await waitFor(() => expect(addToastSpy).toHaveBeenCalled());
    expect(setQueryDataSpy).toHaveBeenCalled();
  });
});
