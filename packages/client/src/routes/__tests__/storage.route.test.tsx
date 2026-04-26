import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "../storage.$mountId";

const { refreshSpy, queryState } = vi.hoisted(() => ({
  refreshSpy: vi.fn(async () => ({})),
  queryState: {
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
    analyzer: "scan",
    sourceKind: "scan",
    mountKey: "abc123",
    generatedAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.000Z",
    freshnessTtlMs: 300000,
    totalSize: 500,
    nodeCount: 3,
    isPartial: false,
    oversized: false,
    refreshing: false,
    error: null,
    errorCode: null,
    warningCode: "partial-permissions",
    warning: "Skipped 1 path because DeckOS did not have permission to read it.",
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
}));

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
        data: queryState,
        isLoading: false,
        isFetching: false,
      };
    }
    return { data: null, isLoading: false, isFetching: false };
  },
}));

describe("storage route", () => {
  beforeEach(() => {
    refreshSpy.mockReset();
    Object.assign(queryState, {
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
      analyzer: "scan",
      sourceKind: "scan",
      mountKey: "abc123",
      generatedAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:00.000Z",
      freshnessTtlMs: 300000,
      totalSize: 500,
      nodeCount: 3,
      isPartial: false,
      oversized: false,
      refreshing: false,
      error: null,
      errorCode: null,
      warningCode: "partial-permissions",
      warning: "Skipped 1 path because DeckOS did not have permission to read it.",
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
    });
    window.history.replaceState({}, "", "/storage/abc123?mount=%2Fdata&fs=%2Fdev%2Fnvme0n1p1");
  });

  it("renders storage analysis context and extension legend", () => {
    const Component = Route.options.component!;
    render(<Component />);

    expect(screen.getByText("Storage Analysis")).toBeInTheDocument();
    expect(screen.getAllByText("/data").length).toBeGreaterThan(0);
    expect(screen.getByText("LOG")).toBeInTheDocument();
    expect(screen.getByText(/Skipped 1 path/)).toBeInTheDocument();
    expect(screen.getByText("Scan complete")).toBeInTheDocument();
  });

  it("updates the selection rail when a block is clicked", () => {
    const Component = Route.options.component!;
    const { container } = render(<Component />);

    const nodes = container.querySelectorAll(".storage-node");
    fireEvent.click(nodes[1] as Element);

    expect(screen.getByText("config.yml")).toBeInTheDocument();
  });

  it("shows a dedicated permission-denied state", () => {
    Object.assign(queryState, {
      mount: {
        id: "abc123",
        mount: "/data",
        fs: "/dev/nvme0n1p1",
        filesystemType: "ext4",
        size: 1000,
        used: 500,
        deviceId: null,
      },
      status: "failed",
      analyzer: null,
      sourceKind: "pending",
      generatedAt: null,
      startedAt: null,
      completedAt: null,
      totalSize: null,
      nodeCount: null,
      isPartial: false,
      errorCode: "permission-denied",
      error: "DeckOS cannot read this mount. Check filesystem permissions and try again.",
      warningCode: null,
      warning: null,
      extensionHistogram: [],
      root: null,
    });
    const Component = Route.options.component!;
    render(<Component />);

    expect(screen.getByText("Permission Required")).toBeInTheDocument();
    expect(screen.getByText(/cannot read this mount/i)).toBeInTheDocument();
  });

  it("makes active scanning unmistakable", () => {
    Object.assign(queryState, {
      status: "scanning",
      refreshing: true,
      isPartial: true,
      totalSize: 1200,
      nodeCount: 8,
    });
    const Component = Route.options.component!;
    render(<Component />);

    expect(screen.getByText("Scanning in progress")).toBeInTheDocument();
    expect(
      screen.getByText(/Showing partial results\. Totals will continue growing/)
    ).toBeInTheDocument();
    expect(screen.getByText("Live partial snapshot")).toBeInTheDocument();
    expect(screen.getByText("Totals not final")).toBeInTheDocument();
  });
});
