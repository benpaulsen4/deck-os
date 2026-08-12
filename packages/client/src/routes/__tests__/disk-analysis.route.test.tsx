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
        issueCount: 0,
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
        issueCount: 0,
        partial: false,
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
        issueCount: 0,
        partial: false,
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
        issueCount: 0,
        limits: {
          maxWorkers: 4,
          maxPendingDirectories: 1024,
          maxIndexedNodes: 50000,
        },
      },
    };
    state.snapshotEnvelope = null;

    renderWithAppRouter({ initialEntries: ["/disk-analysis?mount=C%3A%5C&fs=ntfs"] });

    // B7 review round 1, finding 1: this used to assert that the page had
    // already called `startScan` by itself on load. It no longer does -- see
    // "never joins a running scan without a click" below -- so the stream this
    // test needs is opened the way a user opens it.
    fireEvent.click(await screen.findByRole("button", { name: "Watch Running Scan" }));

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
        issueCount: 0,
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
        issueCount: 0,
        partial: false,
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
        issueCount: 0,
        partial: false,
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
        issueCount: 1,
        partial: false,
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
        issueCount: manyIssues.length,
        partial: false,
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

  it("never starts a scan on its own when the cache is missing", async () => {
    // DISK-3, client half. B6 removed the server-side auto-start that
    // `getMountState` used to perform; this effect was the other half of it --
    // merely opening the page with no cached snapshot committed the box to a
    // full filesystem walk, and re-committed it on every navigation. Scanning
    // is an explicit action now, so the empty state has to offer it.
    state.mountState = {
      mount: { mount: "C:\\", fs: "ntfs" },
      cache: {
        state: "missing",
      },
      activeJob: null,
    };
    state.snapshotEnvelope = null;

    renderWithAppRouter({ initialEntries: ["/disk-analysis?mount=C%3A%5C&fs=ntfs"] });

    expect(await screen.findByText("No analysis data yet")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(startScanSpy).not.toHaveBeenCalled();
    expect(MockEventSource.instances).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Scan This Mount" }));

    expect(startScanSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
  });

  it("never joins a running scan without a click", async () => {
    // B7 review round 1, finding 1 (CRITICAL). Gating the old attach effect on
    // `mountState.activeJob` described the state at *query* time. A normally
    // completing job clears its `unsettledJobIdByMount` entry the instant
    // `runJob` resolves, so if it finished during the round trip the mutation
    // landed on a server with no job to join -- and `startScan` started a
    // brand-new full filesystem walk, from a page load, on every navigation
    // back. There is now no code path into `startScan` that a click does not
    // begin. Reinstating the effect fails this test on the first two
    // assertions after the render.
    state.mountState = {
      mount: { mount: "C:\\", fs: "ntfs" },
      cache: {
        state: "missing",
      },
      activeJob: {
        ...getActiveJob(),
        phase: "scanning",
      },
    };
    state.snapshotEnvelope = null;

    renderWithAppRouter({ initialEntries: ["/disk-analysis?mount=C%3A%5C&fs=ntfs"] });

    expect(await screen.findByText("A scan is already running")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(startScanSpy).not.toHaveBeenCalled();
    expect(MockEventSource.instances).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Watch Running Scan" }));

    expect(startScanSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
  });

  it("says so when the scan it attached to is not the one it meant to watch", async () => {
    // B7 review round 1, finding 3. Even with the click in place, the job the
    // page meant to join can settle during the round trip and the server can
    // answer with a different, freshly started one. Accepting whatever
    // `streamPath` came back means silently streaming a scan the user did not
    // ask for, presented as the one they clicked to watch.
    state.mountState = {
      mount: { mount: "C:\\", fs: "ntfs" },
      cache: {
        state: "missing",
      },
      activeJob: {
        ...getActiveJob(),
        phase: "scanning",
      },
    };
    state.snapshotEnvelope = null;
    startScanSpy.mockResolvedValueOnce({
      jobId: "22222222-2222-2222-2222-222222222222",
      phase: "queued",
      streamPath:
        "/api/disk-analysis/jobs/22222222-2222-2222-2222-222222222222/events?mount=C%3A%5C&fs=ntfs",
    });

    renderWithAppRouter({ initialEntries: ["/disk-analysis?mount=C%3A%5C&fs=ntfs"] });

    fireEvent.click(await screen.findByRole("button", { name: "Watch Running Scan" }));

    const notice =
      "The scan you asked to watch had already finished - this is a new scan that just started.";
    expect(await screen.findByText(notice)).toBeInTheDocument();
    await waitFor(() => expect(addToastSpy).toHaveBeenCalledWith(notice, "info"));
  });

  it("clears the mismatch notice once the stream it describes ends", async () => {
    // B7 review round 2, finding 4; round 3 found the round-2 fix incomplete.
    // The server emits `snapshot` immediately before the terminal `status`,
    // synchronously on the same connection, for a normally completing scan
    // (`services/diskAnalysis.ts`). The client's `snapshot` handler calls
    // `setStreamPath(null)`, which tears the SSE effect down --
    // `removeEventListener` plus `source.close()` -- before the browser ever
    // dispatches the already-queued `status` event (per the EventSource
    // spec, a queued event only fires while `readyState !== CLOSED`, and
    // `close()` sets that synchronously). So `snapshot` is the event that
    // actually ends the stream for every completed or partial scan; a fix
    // that only cleared the notice in the terminal status/progress branch
    // never fired in that common case, and only cleared it for `cancelled`
    // / `failed` jobs, which skip `snapshot` and go straight to a terminal
    // `status`.
    //
    // `MockEventSource.dispatchMessage` calls listeners synchronously with
    // no task-queue semantics, so dispatching `snapshot` immediately
    // followed by `status` here would not reproduce that teardown
    // faithfully -- both would run against the same closure before React
    // ever gets to tear the effect down, which the mock would tolerate but
    // a real browser would not. So this asserts on the state after
    // `snapshot` alone, which is the event that genuinely ends the stream.
    state.mountState = {
      mount: { mount: "C:\\", fs: "ntfs" },
      cache: {
        state: "missing",
      },
      activeJob: {
        ...getActiveJob(),
        phase: "scanning",
      },
    };
    state.snapshotEnvelope = null;
    const newJobId = "44444444-4444-4444-4444-444444444444";
    startScanSpy.mockResolvedValueOnce({
      jobId: newJobId,
      phase: "queued",
      streamPath: `/api/disk-analysis/jobs/${newJobId}/events?mount=C%3A%5C&fs=ntfs`,
    });

    renderWithAppRouter({ initialEntries: ["/disk-analysis?mount=C%3A%5C&fs=ntfs"] });

    fireEvent.click(await screen.findByRole("button", { name: "Watch Running Scan" }));

    const notice =
      "The scan you asked to watch had already finished - this is a new scan that just started.";
    expect(await screen.findByText(notice)).toBeInTheDocument();

    const eventSource = MockEventSource.latest();
    eventSource.dispatchOpen();
    eventSource.dispatchMessage("snapshot", {
      event: "snapshot",
      job: {
        ...getActiveJob(),
        jobId: newJobId,
        phase: "completed",
      },
      snapshot: {
        mount: { mount: "C:\\", fs: "ntfs" },
        generatedAt: "2026-04-27T02:00:00.000Z",
        root: makeDirectory("C:\\", [makeFile("C:\\done.txt", 128, "txt")]),
        extensionLegend: [
          { extension: "txt", colorToken: "disk-ext-1", count: 1, totalBytes: 128 },
        ],
        totals: {
          totalBytes: 128,
          totalFiles: 1,
          totalDirectories: 1,
        },
        issues: [],
        issueCount: 0,
        partial: false,
      },
    });

    await waitFor(() => expect(screen.queryByText(notice)).not.toBeInTheDocument());
  });

  it("warns that a partial scan's totals are a lower bound", async () => {
    // Driven through the path that actually fires. `getMountState` filters
    // `activeJob` to queued/scanning jobs, so a job in the terminal "partial"
    // phase only ever reaches a client over SSE -- building one into the
    // mount-state fixture asserts a shape the server cannot emit.
    renderWithAppRouter({ initialEntries: ["/disk-analysis?mount=C%3A%5C&fs=ntfs"] });

    fireEvent.click(await screen.findByRole("button", { name: "Live" }));
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));

    const eventSource = MockEventSource.latest();
    eventSource.dispatchOpen();
    const activeJob = getActiveJob();
    eventSource.dispatchMessage("snapshot", {
      event: "snapshot",
      job: {
        ...activeJob,
        phase: "partial",
        issueCount: 12,
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
        issueCount: 12,
        partial: true,
      },
    });

    expect(
      await screen.findByText("12 directories were unreadable - totals are a lower bound.")
    ).toBeInTheDocument();
  });

  it("still warns about a partial scan after the job is gone and only the cache remains", async () => {
    // B7 review round 1, finding 2. The job is pruned ten minutes after it
    // finishes, and `getMountState` never reports a terminal job anyway, so
    // keying the banner on `activeJob.phase` lost the warning on the very next
    // page load. The snapshot carries the fact now.
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
        root: makeDirectory("C:\\", [makeFile("C:\\partial.log", 256, "log")]),
        extensionLegend: [{ extension: "log", colorToken: "disk-ext-1", count: 1, totalBytes: 256 }],
        totals: { totalBytes: 256, totalFiles: 1, totalDirectories: 1 },
        issues: [],
        issueCount: 12,
        partial: true,
      },
    };

    renderWithAppRouter({ initialEntries: ["/disk-analysis?mount=C%3A%5C&fs=ntfs"] });

    expect(
      await screen.findByText("12 directories were unreadable - totals are a lower bound.")
    ).toBeInTheDocument();
  });

  it("still reads sensibly when a partial snapshot reports no issue count", async () => {
    // `issueCount` carries `.default(0)` on the snapshot schema so a file
    // cached before that field existed still loads -- and reports 0, alongside
    // a `partial` flag that is genuinely true. "0 directories were unreadable"
    // next to a lower-bound warning is a contradiction, so the count-free
    // wording has to cover it.
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
        root: makeDirectory("C:\\", [makeFile("C:\\partial.log", 256, "log")]),
        extensionLegend: [{ extension: "log", colorToken: "disk-ext-1", count: 1, totalBytes: 256 }],
        totals: { totalBytes: 256, totalFiles: 1, totalDirectories: 1 },
        issues: [],
        issueCount: 0,
        partial: true,
      },
    };

    renderWithAppRouter({ initialEntries: ["/disk-analysis?mount=C%3A%5C&fs=ntfs"] });

    expect(
      await screen.findByText("Some directories were unreadable - totals are a lower bound.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/0 directories were unreadable/)).not.toBeInTheDocument();
  });

  it("builds the live tree against the server's mount, not the raw search param", async () => {
    // The server resolves the mount before it names the root or any branch;
    // `?mount=` carries whatever was in the URL. `/data//media` and
    // `/data/media` are the same directory to `path.resolve` and different
    // strings to the client, so without adopting the identity off the events
    // no branch matches the root, `buildAncestorChain` walks up to `/`, and
    // the whole tree is re-parented under a chain of phantom directories.
    //
    // B7 review round 2, finding 1: the previous version of this fixture
    // seeded `liveMount` from `mountState.activeJob.mount`, which was
    // *already* the resolved path -- so `liveMount` was correct before any
    // event arrived, and the test passed with or without the adoption line
    // at the SSE handler's entry point. This version starts with no active
    // job at all, the shape the adoption exists for: the seed is the raw,
    // unresolved search param, and only the branch event's `mount` field can
    // make the tree line up.
    //
    // Asserted at the top-left corner of the canvas, where the outermost
    // drawable is: with the fix that is the real `/data/media/videos`; with
    // the phantom chain it is a synthetic `/` wrapping three more levels.
    const serverMount = { mount: "/data/media", fs: "ext4" };
    state.mountState = {
      mount: { mount: "/data//media", fs: "ext4" },
      cache: {
        state: "missing",
      },
      activeJob: null,
    };
    state.snapshotEnvelope = null;
    startScanSpy.mockResolvedValueOnce({
      jobId: "33333333-3333-3333-3333-333333333333",
      phase: "scanning",
      streamPath:
        "/api/disk-analysis/jobs/33333333-3333-3333-3333-333333333333/events?mount=%2Fdata%2F%2Fmedia&fs=ext4",
    });

    renderWithAppRouter({
      initialEntries: ["/disk-analysis?mount=%2Fdata%2F%2Fmedia&fs=ext4"],
    });

    fireEvent.click(await screen.findByRole("button", { name: "Scan This Mount" }));
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));

    const eventSource = MockEventSource.latest();
    eventSource.dispatchOpen();
    eventSource.dispatchMessage("branch", {
      event: "branch",
      jobId: "33333333-3333-3333-3333-333333333333",
      mount: serverMount,
      branch: makeDirectory("/data/media/videos", [
        makeFile("/data/media/videos/clip.mp4", 512, "mp4"),
      ]),
    });

    const treemap = await screen.findByRole("img", { name: "Disk usage treemap" });
    fireEvent.mouseMove(treemap, { clientX: 4, clientY: 4 });

    expect(await screen.findByText("/data/media/videos")).toBeInTheDocument();
    expect(screen.queryByText("/data//media")).not.toBeInTheDocument();
  });

  it("separates a path that cannot be scanned from a scanner that is busy", async () => {
    state.mountState = {
      mount: { mount: "C:\\", fs: "ntfs" },
      cache: {
        state: "missing",
      },
      activeJob: null,
    };
    state.snapshotEnvelope = null;
    startScanSpy.mockRejectedValueOnce({
      message: "Disk analysis refuses to scan C:\\",
      data: { code: "FORBIDDEN" },
    });

    const refused = renderWithAppRouter({
      initialEntries: ["/disk-analysis?mount=C%3A%5C&fs=ntfs"],
    });

    fireEvent.click(await screen.findByRole("button", { name: "Scan This Mount" }));

    await waitFor(() =>
      expect(addToastSpy).toHaveBeenCalledWith(
        "This path cannot be scanned: Disk analysis refuses to scan C:\\",
        "error"
      )
    );
    refused.unmount();

    addToastSpy.mockClear();
    startScanSpy.mockRejectedValueOnce({
      message: "A previous scan of C:\\ is still winding down",
      data: { code: "CONFLICT" },
    });

    renderWithAppRouter({ initialEntries: ["/disk-analysis?mount=C%3A%5C&fs=ntfs"] });

    fireEvent.click(await screen.findByRole("button", { name: "Scan This Mount" }));

    await waitFor(() =>
      expect(addToastSpy).toHaveBeenCalledWith(
        "Something else is scanning right now - try again shortly. A previous scan of C:\\ is still winding down",
        "error"
      )
    );
  });

  it("does not blank the live issues panel on progress ticks", async () => {
    // B5 review round 1, finding 2: progress events carry an empty `issues`
    // array by design (see packages/server/src/services/diskAnalysis.ts --
    // only issueCount travels on the live cadence). Treating status and
    // progress events identically wiped the live issues list on every
    // ~500ms tick, which (via the effect that closes the Scan Issues modal
    // whenever the list is empty) force-closed it out from under a user
    // reading it.
    //
    // The issue is seeded on the base mount state so it is showing the
    // instant the live view renders (before any SSE event), then a single
    // "progress" event is dispatched -- mirroring the "switches from stale
    // cache to live mode" test's dispatch pattern above, which is the
    // pattern proven not to trip the SSE connection effect's unrelated
    // re-subscription behaviour.
    const baseActiveJob = getActiveJob();
    const baseMountState = state.mountState;
    if (!baseMountState) {
      throw new Error("Expected mount state from beforeEach");
    }
    state.mountState = {
      ...baseMountState,
      activeJob: {
        ...baseActiveJob,
        issues: [
          {
            code: "permission-denied",
            path: "C:\\restricted",
            message: "Permission denied: C:\\restricted",
            recoverable: true,
          },
        ],
        issueCount: 1,
      },
    };

    renderWithAppRouter({ initialEntries: ["/disk-analysis?mount=C%3A%5C&fs=ntfs"] });

    fireEvent.click(await screen.findByRole("button", { name: "Live" }));
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const eventSource = MockEventSource.latest();
    eventSource.dispatchOpen();

    await screen.findByRole("button", { name: /View Issues/i });

    eventSource.dispatchMessage("progress", {
      event: "progress",
      job: {
        ...baseActiveJob,
        phase: "scanning",
        issues: [],
        issueCount: 7,
        progress: {
          ...baseActiveJob.progress,
          directoriesCompleted: baseActiveJob.progress.directoriesCompleted + 1,
        },
      },
    });

    // Let the batched flush (a real setTimeout(0) inside the component, see
    // scheduleFlush in disk-analysis.tsx) settle before asserting anything.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // A value that only the progress event carries, proving the flush above
    // actually applied the new job state rather than this being a no-op --
    // and, critically, that the issues button (and the count backing it)
    // survived that same flush instead of being blanked by the progress
    // event's empty `issues` array. The array being wiped is exactly what
    // drives the "close the modal when there are no issues" effect, so a
    // button that is still here is the same signal as a modal that would
    // still be here.
    //
    // Queried via a raw aria-label match rather than a second getByRole
    // accessible-name computation: re-computing the accessible name for this
    // specific button a second time, after the progress-bar width and the
    // directories-completed text have both changed underneath it, trips an
    // unrelated jsdom internal bug in this dependency version (a crash deep
    // in its CSS shorthand-property cloning code, unrelated to this fix).
    expect(screen.getByText("2 / 4 directories")).toBeInTheDocument();
    expect(document.querySelector('[aria-label^="View Issues"]')).not.toBeNull();
  });
});
