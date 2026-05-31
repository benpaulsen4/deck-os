import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "../apps/$appId";

const { addToastSpy, navigateSpy, deleteSpy, removeContainerSpy, state } = vi.hoisted(() => ({
  addToastSpy: vi.fn(),
  navigateSpy: vi.fn(),
  deleteSpy: vi.fn(async () => ({})),
  removeContainerSpy: vi.fn(async () => ({})),
  state: {
    appData: undefined as
    | undefined
    | {
        id: string;
        metadata: { name: string; description: string; icon: string; url: string };
      },
    stackData: { running: 0, containers: [] } as {
      running: number;
      containers: Array<{
        id: string;
        names: string[];
        image: string;
        imageId: string;
        created: number;
        state: {
          status: string;
          running: boolean;
          paused: boolean;
          restarting: boolean;
          dead: boolean;
          pid: number;
        };
        status: string;
      }>;
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
      getStatus: { query: vi.fn(async () => state.stackData) },
      removeContainer: { mutate: removeContainerSpy },
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
  useToastStore: () => ({ addToast: addToastSpy }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: vi.fn(async () => {}),
  }),
  useQuery: (input: unknown) => {
    const maybe = input as { queryKey?: unknown[] };
    if (Array.isArray(maybe.queryKey) && maybe.queryKey[0] === "stackStatus") {
      return { data: state.stackData, isLoading: false };
    }
    return { data: state.appData, isLoading: false, error: null, isError: false };
  },
  useMutation: (opts: {
    mutationFn: (...args: unknown[]) => Promise<unknown>;
    onSuccess?: (...args: unknown[]) => void;
    onError?: (...args: unknown[]) => void;
    onSettled?: (...args: unknown[]) => void;
  }) => ({
    isPending: false,
    mutate: async (...args: unknown[]) => {
      try {
        const result = await opts.mutationFn(...args);
        opts.onSuccess?.(result, ...args);
      } catch (error) {
        opts.onError?.(error, ...args);
      } finally {
        opts.onSettled?.();
      }
    },
  }),
}));

function getRouteComponent() {
  const component = Route.options.component;
  if (!component) {
    throw new Error("Route component is not defined");
  }
  return component;
}

describe("apps detail route", () => {
  beforeEach(() => {
    addToastSpy.mockReset();
    navigateSpy.mockReset();
    deleteSpy.mockReset();
    removeContainerSpy.mockReset();
    state.appData = undefined;
    state.stackData = { running: 0, containers: [] };
  });

  it("shows not found state safely", () => {
    vi.spyOn(Route, "useParams").mockReturnValue({ appId: "missing-app" } as never);
    const Component = getRouteComponent();
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
    const Component = getRouteComponent();
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
    const Component = getRouteComponent();
    render(<Component />);
    fireEvent.click(screen.getByRole("button", { name: "DELETE" }));
    expect(deleteSpy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "CONFIRM" }));
    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith({ id: "missing-app" }));
    expect(navigateSpy).toHaveBeenCalledWith({ to: "/apps" });
  });

  it("shows remove only for unknown containers and removes them after confirmation", async () => {
    state.appData = {
      id: "app-1",
      metadata: {
        name: "A",
        description: "D",
        icon: "",
        url: "https://example.com",
      },
    };
    state.stackData = {
      running: 0,
      containers: [
        {
          id: "cid-unknown",
          names: ["/orphaned-web"],
          image: "nginx:latest",
          imageId: "img-1",
          created: 1,
          state: {
            status: "created",
            running: false,
            paused: false,
            restarting: false,
            dead: false,
            pid: 0,
          },
          status: "Created",
        },
        {
          id: "cid-stopped",
          names: ["/known-web"],
          image: "nginx:latest",
          imageId: "img-2",
          created: 1,
          state: {
            status: "exited",
            running: false,
            paused: false,
            restarting: false,
            dead: false,
            pid: 0,
          },
          status: "Exited (0)",
        },
      ],
    };

    const Component = getRouteComponent();
    render(<Component />);

    expect(screen.getAllByRole("button", { name: "REMOVE" })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "REMOVE" }));
    expect(
      screen.getByText(
        "Remove orphaned-web? This only deletes the selected unknown container, not the full app stack."
      )
    ).toBeInTheDocument();

    const removeButtons = screen.getAllByRole("button", { name: "REMOVE" });
    const confirmRemoveButton = removeButtons[1];
    if (!confirmRemoveButton) {
      throw new Error("Expected remove confirmation button");
    }
    fireEvent.click(confirmRemoveButton);

    await waitFor(() =>
      expect(removeContainerSpy).toHaveBeenCalledWith({
        appId: "missing-app",
        containerId: "cid-unknown",
      })
    );
    expect(addToastSpy).toHaveBeenCalledWith("Unknown container removed", "success");
  });
});
