import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "../apps/$appId";

const { navigateSpy, deleteSpy, state } = vi.hoisted(() => ({
  navigateSpy: vi.fn(),
  deleteSpy: vi.fn(async () => ({})),
  state: {
    appData: undefined as
    | undefined
    | {
        id: string;
        metadata: { name: string; description: string; icon: string; url: string };
      },
  },
}));

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual("@tanstack/react-router");
  return {
    ...actual,
    useParams: () => ({ appId: "missing-app" }),
    useNavigate: () => navigateSpy,
    Link: (props: { children: unknown }) => <span>{props.children as string}</span>,
  };
});

vi.mock("../../trpc", () => ({
  useTRPC: () => ({
    apps: {
      get: { queryOptions: () => ({ queryKey: ["apps.get"] }) },
      list: { queryOptions: () => ({ queryKey: ["apps.list"] }) },
    },
  }),
  trpcClient: {
    docker: {
      getStatus: { query: vi.fn(async () => ({ running: 0, containers: [] })) },
      start: { mutate: vi.fn(async () => ({})) },
      stop: { mutate: vi.fn(async () => ({})) },
      restart: { mutate: vi.fn(async () => ({})) },
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
  useQuery: (input: unknown) => {
    const maybe = input as { queryKey?: unknown[] };
    if (Array.isArray(maybe.queryKey) && maybe.queryKey[0] === "stackStatus") {
      return { data: { running: 0, containers: [] }, isLoading: false };
    }
    return { data: state.appData, isLoading: false, error: null, isError: false };
  },
  useMutation: (opts: {
    mutationFn: (...args: unknown[]) => Promise<unknown>;
    onSuccess?: (...args: unknown[]) => void;
  }) => ({
    isPending: false,
    mutate: async (...args: unknown[]) => {
      const result = await opts.mutationFn(...args);
      opts.onSuccess?.(result, ...args);
    },
  }),
}));

describe("apps detail route", () => {
  beforeEach(() => {
    navigateSpy.mockReset();
    deleteSpy.mockReset();
    state.appData = undefined;
  });

  it("shows not found state safely", () => {
    vi.spyOn(Route, "useParams").mockReturnValue({ appId: "missing-app" } as never);
    const Component = Route.options.component!;
    render(<Component />);
    expect(screen.getByText("App not found")).toBeInTheDocument();
  });

  it("guards external OPEN links to http/https", () => {
    state.appData = {
      id: "app-1",
      metadata: {
        name: "A",
        description: "D",
        icon: "",
        url: "javascript:alert(1)",
      },
    };
    const Component = Route.options.component!;
    const { rerender } = render(<Component />);
    expect(screen.queryByText("OPEN")).not.toBeInTheDocument();

    state.appData = {
      id: "app-1",
      metadata: {
        name: "A",
        description: "D",
        icon: "",
        url: "https://example.com",
      },
    };
    rerender(<Component />);
    expect(screen.getByText("OPEN")).toBeInTheDocument();
  });

  it("deletes app only after confirmation and navigates to /apps", async () => {
    state.appData = {
      id: "app-1",
      metadata: {
        name: "A",
        description: "D",
        icon: "",
        url: "https://example.com",
      },
    };
    const Component = Route.options.component!;
    render(<Component />);
    fireEvent.click(screen.getByRole("button", { name: "DELETE" }));
    expect(deleteSpy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "CONFIRM" }));
    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith({ id: "missing-app" }));
    expect(navigateSpy).toHaveBeenCalledWith({ to: "/apps" });
  });
});
