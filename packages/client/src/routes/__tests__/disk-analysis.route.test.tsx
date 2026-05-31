import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithAppRouter } from "../../test/helpers/router";
import {
  MockEventSource,
  installEventSourceMock,
  resetEventSourceMocks,
} from "../../test/helpers/eventSource";
import type {
  DiskAnalysisMountState,
  DiskAnalysisSnapshotEnvelope,
} from "@deckos/contracts";

type QueryDirectoryListing = {
  cwd: string;
  parent: string | null;
  entries: Array<{
    name: string;
    path: string;
    type: "directory" | "file" | "symlink" | "other";
    size: number | null;
    modifiedAt: string;
    createdAt: string;
  }>;
};

type DiskTreeNode = {
  path: string;
  name: string;
  type: "directory" | "file";
  size: number;
  recursiveSize: number;
  extension: string | null;
  childCount: number;
  descendantsScanned: number;
  truncated: boolean;
  issues: [];
  children: DiskTreeNode[];
};

const {
  startScanSpy,
  addToastSpy,
  invalidateQueriesSpy,
  emitUnauthorizedEventSpy,
  fetchAuthStatusSpy,
  state,
} = vi.hoisted(() => ({
  startScanSpy: vi.fn(async () => ({
    jobId: "11111111-1111-1111-1111-111111111111",
    phase: "scanning",
    streamPath:
      "/api/disk-analysis/jobs/11111111-1111-1111-1111-111111111111/events?mount=C%3A%5C&fs=ntfs",
  })),
  addToastSpy: vi.fn(),
  invalidateQueriesSpy: vi.fn(async () => {}),
  emitUnauthorizedEventSpy: vi.fn(),
  fetchAuthStatusSpy: vi.fn(async () => ({ enabled: false, unlocked: true })),
  state: {
    mountState: null as DiskAnalysisMountState | null,
    snapshotEnvelope: null as DiskAnalysisSnapshotEnvelope | null,
    mountStateLoading: false,
    mountStateFetching: false,
    snapshotLoading: false,
    snapshotFetching: false,
    fileLists: {} as Record<string, QueryDirectoryListing>,
  },
}));

vi.mock("../../hooks/useAuthGate", () => ({
  useAuthGate: () => ({
    authChecking: false,
    authEnabled: false,
    authUnlocked: true,
    pin: "",
    setPin: vi.fn(),
    unlockError: null,
    unlocking: false,
    retryAfterMs: null,
    handleUnlock: vi.fn(async () => {}),
    handleLock: vi.fn(),
  }),
}));

vi.mock("../../hooks/useAppStatus", () => ({
  useAppStatus: vi.fn(),
}));

vi.mock("../../components/layout/TopBar", () => ({
  TopBar: () => <div>TOP_BAR</div>,
}));

vi.mock("../../components/layout/ToastContainer", () => ({
  ToastContainer: () => <div>TOASTS</div>,
}));

vi.mock("../../stores/toast", () => ({
  useToastStore: () => ({ addToast: addToastSpy }),
}));

vi.mock("../../lib/auth", () => ({
  emitUnauthorizedEvent: emitUnauthorizedEventSpy,
  fetchAuthStatus: fetchAuthStatusSpy,
  authFetch: vi.fn(),
}));

vi.mock("../../trpc", () => ({
  TRPCProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useTRPC: () => ({
    diskAnalysis: {
      getMountState: {
        queryOptions: (input?: { mount?: string; fs?: string }) => ({
          queryKey: ["diskAnalysis.getMountState", input?.mount ?? "", input?.fs ?? ""],
        }),
      },
      getSnapshot: {
        queryOptions: (input?: { mount?: string; fs?: string }) => ({
          queryKey: ["diskAnalysis.getSnapshot", input?.mount ?? "", input?.fs ?? ""],
        }),
      },
    },
    files: {
      list: {
        queryOptions: (input?: { directoriesOnly?: boolean; path?: string }) => ({
          queryKey: ["files.list", input?.path ?? "", Boolean(input?.directoriesOnly)],
        }),
      },
      getPins: { queryOptions: () => ({ queryKey: ["files.getPins"] }) },
      getMeta: { queryOptions: () => ({ queryKey: ["files.getMeta"] }) },
      readText: { queryOptions: () => ({ queryKey: ["files.readText"] }) },
    },
  }),
  trpcClient: {
    diskAnalysis: {
      startScan: { mutate: startScanSpy },
    },
    files: {
      setPins: { mutate: vi.fn(async () => ({})) },
      mkdir: { mutate: vi.fn(async () => ({})) },
      rename: { mutate: vi.fn(async () => ({})) },
      copy: { mutate: vi.fn(async () => ({})) },
      move: { mutate: vi.fn(async () => ({})) },
      delete: { mutate: vi.fn(async () => ({})) },
      writeText: { mutate: vi.fn(async () => ({})) },
    },
  },
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>(
    "@tanstack/react-query"
  );
  return {
    ...actual,
    useQueryClient: () => ({
      invalidateQueries: invalidateQueriesSpy,
    }),
    useMutation: (opts: {
      mutationFn: (...args: unknown[]) => Promise<unknown>;
      onSuccess?: (...args: unknown[]) => void;
      onError?: (...args: unknown[]) => void;
    }) => ({
      isPending: false,
      mutate: async (...args: unknown[]) => {
        try {
          const result = await opts.mutationFn(...args);
          opts.onSuccess?.(result, ...args);
        } catch (error) {
          opts.onError?.(error, ...args);
        }
      },
    }),
    useQuery: (arg: unknown) => {
      const maybe = arg as { queryKey?: unknown[] };
      const key = maybe.queryKey?.[0];
      if (key === "diskAnalysis.getMountState") {
        return {
          data: state.mountState,
          isLoading: state.mountStateLoading,
          isFetching: state.mountStateFetching,
        };
      }
      if (key === "diskAnalysis.getSnapshot") {
        return {
          data: state.snapshotEnvelope,
          isLoading: state.snapshotLoading,
          isFetching: state.snapshotFetching,
        };
      }
      if (key === "files.list") {
        const requestedPath = String(maybe.queryKey?.[1] ?? "");
        return {
          data: state.fileLists[requestedPath] ?? state.fileLists[""],
          isLoading: false,
          isFetching: false,
          dataUpdatedAt: Date.now(),
        };
      }
      if (key === "files.getPins") {
        return { data: { items: [] } };
      }
      if (key === "files.getMeta") {
        return { data: null, isLoading: false };
      }
      if (key === "files.readText") {
        return { data: null, isLoading: false };
      }
      return { data: null, isLoading: false, isFetching: false, dataUpdatedAt: Date.now() };
    },
  };
});

function makeFile(path: string, size: number, extension: string | null = null): DiskTreeNode {
  const name = path.split(/[\\/]/).at(-1) ?? path;
  return {
    path,
    name,
    type: "file" as const,
    size,
    recursiveSize: size,
    extension,
    childCount: 0,
    descendantsScanned: 0,
    truncated: false,
    issues: [],
    children: [],
  };
}

function makeDirectory(path: string, children: DiskTreeNode[]): DiskTreeNode {
  const name = path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || path;
  const recursiveSize = children.reduce((sum, child) => sum + child.recursiveSize, 0);
  return {
    path,
    name,
    type: "directory" as const,
    size: 0,
    recursiveSize,
    extension: null,
    childCount: children.length,
    descendantsScanned: children.filter((child) => child.type === "directory").length,
    truncated: false,
    issues: [],
    children,
  };
}

function getActiveJob() {
  const activeJob = state.mountState?.activeJob;
  if (!activeJob) {
    throw new Error("Expected active disk analysis job");
  }
  return activeJob;
}

describe("disk analysis route", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }))
    );
    window.scrollTo = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () =>
        ({
          setTransform: vi.fn(),
          clearRect: vi.fn(),
          fillRect: vi.fn(),
          strokeRect: vi.fn(),
          fillText: vi.fn(),
          measureText: (value: string) => ({ width: value.length * 6 }),
          font: "10px monospace",
          fillStyle: "",
          strokeStyle: "",
          lineWidth: 1,
          textBaseline: "middle",
        }) as unknown as CanvasRenderingContext2D
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 960,
          bottom: 640,
          width: 960,
          height: 640,
          toJSON: () => ({}),
        }) as DOMRect
    );
    installEventSourceMock();
    resetEventSourceMocks();
    startScanSpy.mockClear();
    addToastSpy.mockClear();
    invalidateQueriesSpy.mockClear();
    emitUnauthorizedEventSpy.mockClear();
    fetchAuthStatusSpy.mockClear();
    fetchAuthStatusSpy.mockResolvedValue({ enabled: false, unlocked: true });
    state.mountStateLoading = false;
    state.mountStateFetching = false;
    state.snapshotLoading = false;
    state.snapshotFetching = false;

    state.mountState = {
      mount: { mount: "C:\\", fs: "ntfs" },
      cache: {
        state: "stale",
        generatedAt: "2026-04-20T00:00:00.000Z",
        staleAt: "2026-04-21T00:00:00.000Z",
      },
      activeJob: {
        jobId: "11111111-1111-1111-1111-111111111111",
        mount: { mount: "C:\\", fs: "ntfs" },
        phase: "scanning",
        startedAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-27T00:00:00.000Z",
        progress: {
          directoriesDiscovered: 4,
          directoriesCompleted: 1,
          filesDiscovered: 1,
          bytesProcessed: 128,
        },
        issues: [],
        limits: {
          maxWorkers: 4,
          maxPendingDirectories: 1024,
          maxIndexedNodes: 50000,
        },
      },
    };
    state.snapshotEnvelope = {
      mount: { mount: "C:\\", fs: "ntfs" },
      cache: {
        state: "stale",
        generatedAt: "2026-04-20T00:00:00.000Z",
        staleAt: "2026-04-21T00:00:00.000Z",
      },
      snapshot: {
        mount: { mount: "C:\\", fs: "ntfs" },
        generatedAt: "2026-04-20T00:00:00.000Z",
        root: makeDirectory("C:\\", [
          makeDirectory("C:\\cache", [makeFile("C:\\cache\\old.tmp", 64, "tmp")]),
        ]),
        extensionLegend: [{ extension: "tmp", colorToken: "disk-ext-1", count: 1, totalBytes: 64 }],
        totals: {
          totalBytes: 64,
          totalFiles: 1,
          totalDirectories: 2,
        },
        issues: [],
      },
    };
    state.fileLists = {
      "": {
        cwd: "C:\\",
        parent: null,
        entries: [],
      },
      "C:\\media": {
        cwd: "C:\\media",
        parent: "C:\\",
        entries: [
          {
            name: "clip.mp4",
            path: "C:\\media\\clip.mp4",
            type: "file",
            size: 512,
            modifiedAt: "2026-04-27T00:00:00.000Z",
            createdAt: "2026-04-27T00:00:00.000Z",
          },
        ],
      },
      "C:\\reports": {
        cwd: "C:\\reports",
        parent: "C:\\",
        entries: [
          {
            name: "archive.log",
            path: "C:\\reports\\archive.log",
            type: "file",
            size: 256,
            modifiedAt: "2026-04-27T00:00:00.000Z",
            createdAt: "2026-04-27T00:00:00.000Z",
          },
        ],
      },
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("switches from stale cache to live mode and assembles streamed branches incrementally", async () => {
    renderWithAppRouter({ initialEntries: ["/disk-analysis?mount=C%3A%5C&fs=ntfs"] });

    expect(await screen.findByRole("button", { name: "Cached" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Live" })).toBeEnabled();
    expect(startScanSpy).not.toHaveBeenCalled();
    expect(MockEventSource.instances).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Live" }));

    expect(startScanSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const eventSource = MockEventSource.latest();
    const initialEventSourceCount = MockEventSource.instances.length;
    eventSource.dispatchOpen();
    const activeJob = getActiveJob();
    eventSource.dispatchMessage("progress", {
      event: "progress",
      job: {
        ...activeJob,
        progress: {
          directoriesDiscovered: 5,
          directoriesCompleted: 2,
          filesDiscovered: 2,
          bytesProcessed: 640,
        },
      },
    });
    eventSource.dispatchMessage("branch", {
      event: "branch",
      jobId: "11111111-1111-1111-1111-111111111111",
      mount: { mount: "C:\\", fs: "ntfs" },
      branch: makeDirectory("C:\\media\\videos", [makeFile("C:\\media\\videos\\clip.mp4", 512, "mp4")]),
    });

    expect(MockEventSource.instances).toHaveLength(initialEventSourceCount);
    const treemap = await screen.findByRole("img", { name: "Disk usage treemap" });
    fireEvent.mouseMove(treemap, { clientX: 480, clientY: 10 });
    await waitFor(() => expect(screen.getByText("media")).toBeInTheDocument());
    fireEvent.doubleClick(treemap, { clientX: 480, clientY: 10 });
    await waitFor(() =>
      expect(screen.getByDisplayValue("C:\\media")).toBeInTheDocument()
    );
  });

  it("keeps a fresh cached scan idle until the user explicitly starts a new scan", async () => {
    state.mountState = {
      mount: { mount: "C:\\", fs: "ntfs" },
      cache: {
        state: "fresh",
        generatedAt: "2026-04-27T00:00:00.000Z",
        staleAt: "2026-04-28T00:00:00.000Z",
      },
      activeJob: null,
    };
    state.snapshotEnvelope = {
      mount: { mount: "C:\\", fs: "ntfs" },
      cache: {
        state: "fresh",
        generatedAt: "2026-04-27T00:00:00.000Z",
        staleAt: "2026-04-28T00:00:00.000Z",
      },
      snapshot: {
        mount: { mount: "C:\\", fs: "ntfs" },
        generatedAt: "2026-04-27T00:00:00.000Z",
        root: makeDirectory("C:\\", [
          makeDirectory("C:\\reports", [makeFile("C:\\reports\\archive.log", 256, "log")]),
        ]),
        extensionLegend: [{ extension: "log", colorToken: "disk-ext-1", count: 1, totalBytes: 256 }],
        totals: {
          totalBytes: 256,
          totalFiles: 1,
          totalDirectories: 2,
        },
        issues: [],
      },
    };

    renderWithAppRouter({ initialEntries: ["/disk-analysis?mount=C%3A%5C&fs=ntfs"] });

    expect(await screen.findByRole("button", { name: "Start New Scan" })).toBeInTheDocument();
    expect(startScanSpy).not.toHaveBeenCalled();
    expect(MockEventSource.instances).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Start New Scan" }));

    expect(startScanSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
  });

  it("does not auto-start while the snapshot query is still loading", async () => {
    state.mountState = {
      mount: { mount: "C:\\", fs: "ntfs" },
      cache: {
        state: "missing",
      },
      activeJob: null,
    };
    state.snapshotEnvelope = null;
    state.snapshotLoading = true;
    state.snapshotFetching = true;

    renderWithAppRouter({ initialEntries: ["/disk-analysis?mount=C%3A%5C&fs=ntfs"] });

    expect(await screen.findByText("Loading analysis state")).toBeInTheDocument();
    expect(startScanSpy).not.toHaveBeenCalled();
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it("refreshes cached queries when a live scan ends with status before snapshot", async () => {
    renderWithAppRouter({ initialEntries: ["/disk-analysis?mount=C%3A%5C&fs=ntfs"] });

    fireEvent.click(await screen.findByRole("button", { name: "Live" }));
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));

    const eventSource = MockEventSource.latest();
    eventSource.dispatchOpen();
    const activeJob = getActiveJob();
    eventSource.dispatchMessage("status", {
      event: "status",
      job: {
        ...activeJob,
        phase: "completed",
      },
    });

    await waitFor(() =>
      expect(invalidateQueriesSpy).toHaveBeenCalledWith({
        queryKey: ["diskAnalysis.getMountState", "C:\\", "ntfs"],
      })
    );
    expect(invalidateQueriesSpy).toHaveBeenCalledWith({
      queryKey: ["diskAnalysis.getSnapshot", "C:\\", "ntfs"],
    });
    expect(startScanSpy).toHaveBeenCalledTimes(1);
  });

  it("surfaces transient stream disconnects without starting a new scan", async () => {
    fetchAuthStatusSpy.mockResolvedValue({ enabled: true, unlocked: false });
    renderWithAppRouter({ initialEntries: ["/disk-analysis?mount=C%3A%5C&fs=ntfs"] });

    fireEvent.click(await screen.findByRole("button", { name: "Live" }));
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));

    const eventSource = MockEventSource.latest();
    eventSource.dispatchOpen();
    eventSource.dispatchError(new Error("disconnected"));

    expect(await screen.findByText("Live scan stream disconnected.")).toBeInTheDocument();
    await waitFor(() => expect(fetchAuthStatusSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(emitUnauthorizedEventSpy).toHaveBeenCalledTimes(1));
    expect(startScanSpy).toHaveBeenCalledTimes(1);
    expect(MockEventSource.latest().url).toBe(eventSource.url);
  });

  it("does not auto-start a second scan after a missing-cache live scan completes", async () => {
    state.mountState = {
      mount: { mount: "C:\\", fs: "ntfs" },
      cache: {
        state: "missing",
      },
      activeJob: {
        jobId: "11111111-1111-1111-1111-111111111111",
        mount: { mount: "C:\\", fs: "ntfs" },
        phase: "scanning",
        startedAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-27T00:00:00.000Z",
        progress: {
          directoriesDiscovered: 4,
          directoriesCompleted: 2,
          filesDiscovered: 10,
          bytesProcessed: 1024,
        },
        issues: [],
        limits: {
          maxWorkers: 4,
          maxPendingDirectories: 1024,
          maxIndexedNodes: 50000,
        },
      },
    };
    state.snapshotEnvelope = null;

    renderWithAppRouter({ initialEntries: ["/disk-analysis?mount=C%3A%5C&fs=ntfs"] });

    await waitFor(() => expect(startScanSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));

    const eventSource = MockEventSource.latest();
    eventSource.dispatchOpen();
    const activeJob = getActiveJob();
    eventSource.dispatchMessage("snapshot", {
      event: "snapshot",
      job: {
        ...activeJob,
        phase: "completed",
      },
      snapshot: {
        mount: { mount: "C:\\", fs: "ntfs" },
        generatedAt: "2026-04-27T01:00:00.000Z",
        root: makeDirectory("C:\\", [makeFile("C:\\done.txt", 128, "txt")]),
        extensionLegend: [{ extension: "txt", colorToken: "disk-ext-1", count: 1, totalBytes: 128 }],
        totals: {
          totalBytes: 128,
          totalFiles: 1,
          totalDirectories: 1,
        },
        issues: [],
      },
    });

    await waitFor(() => expect(screen.getByRole("img", { name: "Disk usage treemap" })).toBeInTheDocument());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(startScanSpy).toHaveBeenCalledTimes(1);
  });

  it("double-clicks a file block to reveal it in Files", async () => {
    state.mountState = {
      mount: { mount: "C:\\", fs: "ntfs" },
      cache: {
        state: "fresh",
        generatedAt: "2026-04-27T00:00:00.000Z",
        staleAt: "2026-04-28T00:00:00.000Z",
      },
      activeJob: null,
    };
    state.snapshotEnvelope = {
      mount: { mount: "C:\\", fs: "ntfs" },
      cache: {
        state: "fresh",
        generatedAt: "2026-04-27T00:00:00.000Z",
        staleAt: "2026-04-28T00:00:00.000Z",
      },
      snapshot: {
        mount: { mount: "C:\\", fs: "ntfs" },
        generatedAt: "2026-04-27T00:00:00.000Z",
        root: makeDirectory("C:\\", [
          makeDirectory("C:\\reports", [makeFile("C:\\reports\\archive.log", 256, "log")]),
        ]),
        extensionLegend: [{ extension: "log", colorToken: "disk-ext-1", count: 1, totalBytes: 256 }],
        totals: {
          totalBytes: 256,
          totalFiles: 1,
          totalDirectories: 2,
        },
        issues: [],
      },
    };

    renderWithAppRouter({ initialEntries: ["/disk-analysis?mount=C%3A%5C&fs=ntfs"] });

    const treemap = await screen.findByRole("img", { name: "Disk usage treemap" });
    fireEvent.mouseMove(treemap, { clientX: 480, clientY: 340 });
    await waitFor(() => expect(screen.getByText("archive.log")).toBeInTheDocument());
    fireEvent.doubleClick(treemap, { clientX: 480, clientY: 340 });

    await waitFor(() =>
      expect(screen.getByDisplayValue("C:\\reports")).toBeInTheDocument()
    );
    expect(await screen.findByText("archive.log")).toBeInTheDocument();
  });

  it("toggles between treemap and details views for compact layouts", async () => {
    state.mountState = {
      mount: { mount: "C:\\", fs: "ntfs" },
      cache: {
        state: "fresh",
        generatedAt: "2026-04-27T00:00:00.000Z",
        staleAt: "2026-04-28T00:00:00.000Z",
      },
      activeJob: null,
    };
    state.snapshotEnvelope = {
      mount: { mount: "C:\\", fs: "ntfs" },
      cache: {
        state: "fresh",
        generatedAt: "2026-04-27T00:00:00.000Z",
        staleAt: "2026-04-28T00:00:00.000Z",
      },
      snapshot: {
        mount: { mount: "C:\\", fs: "ntfs" },
        generatedAt: "2026-04-27T00:00:00.000Z",
        root: makeDirectory("C:\\", [
          makeDirectory("C:\\reports", [makeFile("C:\\reports\\archive.log", 256, "log")]),
        ]),
        extensionLegend: [{ extension: "log", colorToken: "disk-ext-1", count: 1, totalBytes: 256 }],
        totals: {
          totalBytes: 256,
          totalFiles: 1,
          totalDirectories: 2,
        },
        issues: [],
      },
    };

    renderWithAppRouter({ initialEntries: ["/disk-analysis?mount=C%3A%5C&fs=ntfs"] });

    const treemapToggle = await screen.findByRole("button", { name: "Treemap" });
    const detailsToggle = screen.getByRole("button", { name: "Details" });
    const layout = document.querySelector(".disk-analysis-layout");

    expect(layout).not.toBeNull();
    expect(detailsToggle).toHaveAttribute("aria-pressed", "true");
    expect(treemapToggle).toHaveAttribute("aria-pressed", "false");
    expect(layout).toHaveClass("disk-analysis-layout--mobile-sidebar-open");

    fireEvent.click(treemapToggle);

    expect(layout).not.toHaveClass("disk-analysis-layout--mobile-sidebar-open");
    expect(detailsToggle).toHaveAttribute("aria-pressed", "false");
    expect(treemapToggle).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(detailsToggle);

    expect(layout).toHaveClass("disk-analysis-layout--mobile-sidebar-open");
    expect(detailsToggle).toHaveAttribute("aria-pressed", "true");
    expect(treemapToggle).toHaveAttribute("aria-pressed", "false");
  });

  it("shows compact treemap details in a popover on single click", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches: query === "(max-width: 1100px)",
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }))
    );
    state.mountState = {
      mount: { mount: "C:\\", fs: "ntfs" },
      cache: {
        state: "fresh",
        generatedAt: "2026-04-27T00:00:00.000Z",
        staleAt: "2026-04-28T00:00:00.000Z",
      },
      activeJob: null,
    };
    state.snapshotEnvelope = {
      mount: { mount: "C:\\", fs: "ntfs" },
      cache: {
        state: "fresh",
        generatedAt: "2026-04-27T00:00:00.000Z",
        staleAt: "2026-04-28T00:00:00.000Z",
      },
      snapshot: {
        mount: { mount: "C:\\", fs: "ntfs" },
        generatedAt: "2026-04-27T00:00:00.000Z",
        root: makeDirectory("C:\\", [
          makeDirectory("C:\\reports", [makeFile("C:\\reports\\archive.log", 256, "log")]),
        ]),
        extensionLegend: [{ extension: "log", colorToken: "disk-ext-1", count: 1, totalBytes: 256 }],
        totals: {
          totalBytes: 256,
          totalFiles: 1,
          totalDirectories: 2,
        },
        issues: [{ code: "permission-denied", path: "C:\\restricted", message: "Denied", recoverable: true }],
      },
    };

    renderWithAppRouter({ initialEntries: ["/disk-analysis?mount=C%3A%5C&fs=ntfs"] });

    expect(await screen.findByRole("button", { name: /Back/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Scan/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Issues/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Treemap" }));

    const treemap = await screen.findByRole("img", { name: "Disk usage treemap" });
    fireEvent.click(treemap, { clientX: 480, clientY: 340 });

    expect(await screen.findByRole("dialog", { name: "Selected block details" })).toBeInTheDocument();
    expect(screen.getByText("archive.log")).toBeInTheDocument();
    expect(screen.getByText("C:\\reports\\archive.log")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open In Files" }));
    await waitFor(() =>
      expect(screen.getByDisplayValue("C:\\reports")).toBeInTheDocument()
    );
  });

  it("moves scan issues into a header modal", async () => {
    const manyIssues = Array.from({ length: 205 }, (_, index) => ({
      code: "permission-denied" as const,
      path: `C:\\restricted\\folder-${index}`,
      message: `Permission denied: C:\\restricted\\folder-${index}`,
      recoverable: true,
    }));
    state.mountState = {
      mount: { mount: "C:\\", fs: "ntfs" },
      cache: {
        state: "fresh",
        generatedAt: "2026-04-27T00:00:00.000Z",
        staleAt: "2026-04-28T00:00:00.000Z",
      },
      activeJob: null,
    };
    state.snapshotEnvelope = {
      mount: { mount: "C:\\", fs: "ntfs" },
      cache: {
        state: "fresh",
        generatedAt: "2026-04-27T00:00:00.000Z",
        staleAt: "2026-04-28T00:00:00.000Z",
      },
      snapshot: {
        mount: { mount: "C:\\", fs: "ntfs" },
        generatedAt: "2026-04-27T00:00:00.000Z",
        root: makeDirectory("C:\\", [makeFile("C:\\error.log", 256, "log")]),
        extensionLegend: [{ extension: "log", colorToken: "disk-ext-1", count: 1, totalBytes: 256 }],
        totals: {
          totalBytes: 256,
          totalFiles: 1,
          totalDirectories: 1,
        },
        issues: manyIssues,
      },
    };

    renderWithAppRouter({ initialEntries: ["/disk-analysis?mount=C%3A%5C&fs=ntfs"] });

    expect(screen.queryByText("Scan Issues")).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /View Issues/i }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("1-100 of 205")).toBeInTheDocument();
    expect(
      screen.getByText("Permission denied: C:\\restricted\\folder-0")
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("101-200 of 205")).toBeInTheDocument();
    expect(
      screen.getByText("Permission denied: C:\\restricted\\folder-100")
    ).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Search code, path, or message"), {
      target: { value: "folder-204" },
    });
    expect(await screen.findByText("1-1 of 1")).toBeInTheDocument();
    expect(
      screen.getByText("Permission denied: C:\\restricted\\folder-204")
    ).toBeInTheDocument();
  });
});
