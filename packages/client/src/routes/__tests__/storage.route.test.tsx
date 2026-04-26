import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "../storage.$mountId";

const { navigateSpy, refreshSpy } = vi.hoisted(() => ({
  navigateSpy: vi.fn(),
  refreshSpy: vi.fn(async () => ({})),
}));

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-router")>(
    "@tanstack/react-router"
  );
  return {
    ...actual,
    useNavigate: () => navigateSpy,
  };
});

vi.mock("../../stores/toast", () => ({
  useToastStore: () => ({ addToast: vi.fn() }),
}));

vi.mock("../../trpc", () => ({
  useTRPC: () => ({
    storage: {
      getAnalysis: {
        queryOptions: (input?: { mount?: string; fs?: string }, options?: Record<string, unknown>) => ({
          queryKey: ["storage.getAnalysis", input?.mount ?? "", input?.fs ?? ""],
          ...options,
        }),
      },
    },
  }),
  trpcClient: {
    storage: {
      refreshAnalysis: {
        mutate: refreshSpy,
      },
    },
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: vi.fn(async () => {}),
  }),
  useMutation: (opts: { mutationFn: () => Promise<unknown> }) => ({
    isPending: false,
    mutate: () => {
      void opts.mutationFn();
    },
  }),
  useQuery: (arg: unknown) => {
    const maybe = arg as { queryKey?: string[] };
    if (maybe.queryKey?.[0] === "storage.getAnalysis") {
      return {
        data: {
          mount: {
            id: "abc123",
            mount: "/data",
            fs: "/dev/nvme0n1p1",
            filesystemType: "ext4",
            size: 1000,
            used: 500,
            deviceId: 10,
          },
          status: "ready",
          analyzer: "fallback",
          sourceKind: "scan",
          mountKey: "abc123",
          generatedAt: "2026-01-01T00:00:00.000Z",
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:00.000Z",
          freshnessTtlMs: 300000,
          totalSize: 500,
          nodeCount: 3,
          oversized: false,
          refreshing: false,
          error: null,
          fallbackReason: "Filesystem is not btrfs.",
          extensionHistogram: [
            {
              extension: ".log",
              label: "LOG",
              count: 1,
              totalSize: 300,
              color: "#ff7b72",
            },
          ],
          root: {
            path: "/data",
            name: "data",
            type: "directory",
            size: 500,
            extension: null,
            childCount: 2,
            children: [
              {
                path: "/data/logs",
                name: "logs",
                type: "directory",
                size: 300,
                extension: null,
                childCount: 1,
                children: [
                  {
                    path: "/data/logs/app.log",
                    name: "app.log",
                    type: "file",
                    size: 300,
                    extension: ".log",
                    childCount: 0,
                    children: [],
                  },
                ],
              },
              {
                path: "/data/config.yml",
                name: "config.yml",
                type: "file",
                size: 200,
                extension: ".yml",
                childCount: 0,
                children: [],
              },
            ],
          },
        },
        isLoading: false,
        isFetching: false,
      };
    }
    return { data: null, isLoading: false, isFetching: false };
  },
}));

describe("storage route", () => {
  beforeEach(() => {
    navigateSpy.mockReset();
    refreshSpy.mockReset();
    window.history.replaceState({}, "", "/storage/abc123?mount=%2Fdata&fs=%2Fdev%2Fnvme0n1p1");
  });

  it("renders storage analysis context and extension legend", () => {
    const Component = Route.options.component!;
    render(<Component />);

    expect(screen.getByText("Storage Analysis")).toBeInTheDocument();
    expect(screen.getAllByText("/data").length).toBeGreaterThan(0);
    expect(screen.getByText("LOG")).toBeInTheDocument();
    expect(screen.getByText("Filesystem is not btrfs.")).toBeInTheDocument();
  });

  it("updates the selection rail when a block is clicked", () => {
    const Component = Route.options.component!;
    const { container } = render(<Component />);

    const nodes = container.querySelectorAll(".storage-node");
    fireEvent.click(nodes[1] as Element);

    expect(screen.getByText("config.yml")).toBeInTheDocument();
  });
});
