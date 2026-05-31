import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, ArrowLeft, ArrowRight, PanelLeft, Play, X } from "lucide-react";
import { Button } from "../components/ui/Button";
import { useToastStore } from "../stores/toast";
import { emitUnauthorizedEvent, fetchAuthStatus } from "../lib/auth";
import {
  createPresentationTree,
  createSyntheticLiveRoot,
  deriveLegendFromSnapshot,
  findNodeByPath,
  formatBytes,
  formatCount,
  formatRelativeGeneratedAt,
  getLegendColor,
  getMountLabel,
  getNodeDisplayType,
  getNodeNavigationSearch,
  integrateBranchIntoTree,
  type DiskAnalysisLegendItem,
} from "../lib/diskAnalysisClient";
import { useTRPC, trpcClient } from "../trpc";
import {
  DiskAnalysisRouteSearchSchema,
  DiskAnalysisScanEventSchema,
  type DiskAnalysisIssue,
  type DiskAnalysisJobState,
  type DiskAnalysisMountIdentity,
  type DiskAnalysisSnapshot,
  type DiskAnalysisTreemapNode,
} from "../../../server/src/lib/diskAnalysisContract.js";

export const Route = createFileRoute("/disk-analysis")({
  validateSearch: (search) => DiskAnalysisRouteSearchSchema.parse(search),
  component: DiskAnalysisPage,
});

type ViewMode = "cached" | "live";
type TreemapRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type TreemapDrawable = {
  node: DiskAnalysisTreemapNode;
  rect: TreemapRect;
  depth: number;
  headerHeight: number;
  headerLabel: string | null;
  showDirectoryChrome: boolean;
  color: ReturnType<typeof getNodeColor>;
};

type IssuesPageState = {
  query: string;
  page: number;
};

const DEFAULT_TREEMAP_WIDTH = 960;
const DEFAULT_TREEMAP_HEIGHT = 640;
const MIN_NODE_PIXELS = 4;
const TREEMAP_NODE_GAP_PX = 1;
const DIRECTORY_HEADER_HEIGHT_PX = 20;
const MIN_DIRECTORY_HEADER_WIDTH_PX = 120;
const MIN_DIRECTORY_HEADER_HEIGHT_PX = 32;
const DIRECTORY_CHROME_MIN_SHARE = 0.01;
const FILE_LABEL_MIN_WIDTH_PX = 84;
const FILE_LABEL_MIN_HEIGHT_PX = 28;
const LIVE_EVENT_BATCH_MS = 0;
const LIVE_MERGE_PUBLISH_MS = 250;
const HOVER_EVENT_COOLDOWN_MS = 40;
const ISSUES_PAGE_SIZE = 100;
const LIVE_PRESENTATION_OPTIONS = {
  maxDepth: 4,
  maxChildrenPerDirectory: 36,
};
const LIVE_SCANNING_PRESENTATION_OPTIONS = {
  maxDepth: 3,
  maxChildrenPerDirectory: 24,
};
const BLOCK_TEXT_COLOR_BY_FILL = new Map<string, string>([
  ["#00ff88", "#03140c"],
  ["#58d5ff", "#07131d"],
  ["#aa44ff", "#f5f7fa"],
  ["#ff8f3d", "#1b0d04"],
  ["#ffe066", "#1f1800"],
  ["#ff5470", "#20050c"],
  ["#53f5c7", "#031512"],
  ["#7aa2ff", "#071324"],
  ["#d68cff", "#16081c"],
  ["#ffb86b", "#1b1002"],
  ["#7df5a6", "#041309"],
  ["#ff7ad9", "#1f0616"],
  ["#9eff6b", "#0d1704"],
  ["#6af2ff", "#04141a"],
  ["#ffd36a", "#181101"],
  ["#8cc8ff", "#07131f"],
  ["#ff9f9f", "#1c0b0b"],
  ["#b8ff7a", "#101802"],
  ["#b18cff", "#12091d"],
  ["#f6ff7a", "#171a02"],
  ["#8aa3e3", "#0a1020"],
]);

function DiskAnalysisPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { addToast } = useToastStore();
  const mount = useMemo(
    () =>
      search.fs
        ? ({
            mount: search.mount,
            fs: search.fs,
          } satisfies DiskAnalysisMountIdentity)
        : null,
    [search.fs, search.mount]
  );
  const mountKey = mount ? `${mount.mount}::${mount.fs}` : "missing-mount";
  const mountStateQueryKey = useMemo(
    () =>
      mount
        ? (["diskAnalysis.getMountState", mount.mount, mount.fs] as const)
        : (["diskAnalysis.getMountState", "", ""] as const),
    [mount]
  );
  const snapshotQueryKey = useMemo(
    () =>
      mount
        ? (["diskAnalysis.getSnapshot", mount.mount, mount.fs] as const)
        : (["diskAnalysis.getSnapshot", "", ""] as const),
    [mount]
  );

  const [viewMode, setViewMode] = useState<ViewMode>("live");
  const [liveRoot, setLiveRoot] = useState<DiskAnalysisTreemapNode | null>(null);
  const [liveSnapshot, setLiveSnapshot] = useState<DiskAnalysisSnapshot | null>(null);
  const [liveJob, setLiveJob] = useState<DiskAnalysisJobState | null>(null);
  const [streamPath, setStreamPath] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [hoveredPath, setHoveredPath] = useState<string | null>(null);
  const [isIssuesModalOpen, setIsIssuesModalOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(true);
  const [isCompactLayout, setIsCompactLayout] = useState(false);
  const [hasRequestedLive, setHasRequestedLive] = useState(false);
  const requestedStreamKeyRef = useRef<string | null>(null);
  const liveRawRootRef = useRef<DiskAnalysisTreemapNode | null>(null);

  useEffect(() => {
    setLiveRoot(null);
    setLiveSnapshot(null);
    setLiveJob(null);
    setStreamPath(null);
    setStreamError(null);
    setHoveredPath(null);
    setIsIssuesModalOpen(false);
    setMobileSidebarOpen(true);
    setHasRequestedLive(false);
    requestedStreamKeyRef.current = null;
    liveRawRootRef.current = null;
  }, [mountKey]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      setIsCompactLayout(false);
      return;
    }
    const mediaQuery = window.matchMedia("(max-width: 1100px)");
    const updateCompactLayout = () => {
      setIsCompactLayout(mediaQuery.matches);
    };
    updateCompactLayout();
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", updateCompactLayout);
      return () => {
        mediaQuery.removeEventListener("change", updateCompactLayout);
      };
    }
    mediaQuery.addListener(updateCompactLayout);
    return () => {
      mediaQuery.removeListener(updateCompactLayout);
    };
  }, []);

  const mountStateQuery = useQuery(
    trpc.diskAnalysis.getMountState.queryOptions(mount ?? { mount: "", fs: "" }, {
      enabled: !!mount,
    })
  );
  const snapshotQuery = useQuery(
    trpc.diskAnalysis.getSnapshot.queryOptions(mount ?? { mount: "", fs: "" }, {
      enabled: !!mount,
    })
  );

  const startScanMutation = useMutation({
    mutationFn: async (input: DiskAnalysisMountIdentity) =>
      await trpcClient.diskAnalysis.startScan.mutate({
        mount: input,
        preferLive: true,
      }),
    onSuccess: (result) => {
      setStreamPath(result.streamPath);
      setStreamError(null);
    },
    onError: (error: unknown) => {
      const message =
        error instanceof Error ? error.message : "Failed to start disk analysis scan";
      setStreamError(message);
      addToast(message, "error");
    },
  });

  const cachedSnapshot = snapshotQuery.data?.snapshot ?? null;
  const mountState = mountStateQuery.data ?? null;
  const activeJob = liveJob ?? mountState?.activeJob ?? null;

  const resetLiveState = () => {
    setLiveRoot(null);
    setLiveSnapshot(null);
    setLiveJob(null);
    setStreamError(null);
    requestedStreamKeyRef.current = null;
    liveRawRootRef.current = null;
  };

  const requestLiveStream = (options?: { resetLiveState?: boolean }) => {
    if (!mount || startScanMutation.isPending) {
      return;
    }
    if (options?.resetLiveState) {
      resetLiveState();
    }
    const requestKey = `${mountKey}::${mountState?.activeJob?.jobId ?? "pending"}`;
    if (requestedStreamKeyRef.current === requestKey) {
      return;
    }
    requestedStreamKeyRef.current = requestKey;
    startScanMutation.mutate(mount);
  };

  const openLiveView = () => {
    setHasRequestedLive(true);
    setViewMode("live");
    if (!mount) {
      return;
    }
    if (streamPath) {
      return;
    }
    if (!mountState?.activeJob && (liveSnapshot || liveRoot)) {
      return;
    }
    requestLiveStream({
      resetLiveState: mountState?.activeJob ? liveJob?.jobId !== mountState.activeJob.jobId : true,
    });
  };

  const showCachedView = () => {
    setViewMode("cached");
    if (streamPath) {
      requestedStreamKeyRef.current = null;
      setStreamPath(null);
    }
  };

  const startManualScan = () => {
    setHasRequestedLive(true);
    setViewMode("live");
    requestLiveStream({
      resetLiveState: true,
    });
  };

  const hasTerminalLiveResult =
    !!liveSnapshot ||
    !!liveRoot ||
    liveJob?.phase === "completed" ||
    liveJob?.phase === "partial" ||
    liveJob?.phase === "failed" ||
    liveJob?.phase === "cancelled";

  useEffect(() => {
    if (!mount || !mountState) {
      return;
    }
    if (mountState.cache.state !== "missing") {
      return;
    }
    if (hasRequestedLive) {
      return;
    }
    if (hasTerminalLiveResult) {
      return;
    }
    setHasRequestedLive(true);
    setViewMode("live");
    requestLiveStream({
      resetLiveState: true,
    });
  }, [
    mount,
    mountState,
    mountState?.cache.state,
    mountState?.activeJob?.jobId,
    mountKey,
    streamPath,
    hasRequestedLive,
    hasTerminalLiveResult,
  ]);

  useEffect(() => {
    if (cachedSnapshot) {
      setViewMode((current) => {
        if (current === "cached" || (current === "live" && hasRequestedLive)) {
          return current;
        }
        return "cached";
      });
      return;
    }
    setViewMode("live");
  }, [cachedSnapshot, hasRequestedLive]);

  useEffect(() => {
    if (viewMode === "live" || !streamPath) {
      return;
    }
    requestedStreamKeyRef.current = null;
    setStreamPath(null);
  }, [streamPath, viewMode]);

  useEffect(() => {
    if (!activeJob || liveSnapshot || !cachedSnapshot) {
      return;
    }
    if (activeJob.phase !== "completed" && activeJob.phase !== "partial") {
      return;
    }
    if (mountState?.cache.state !== "fresh") {
      return;
    }
    if (mountState.cache.generatedAt !== cachedSnapshot.generatedAt) {
      return;
    }

    liveRawRootRef.current = cachedSnapshot.root;
    setLiveSnapshot(cachedSnapshot);
    setLiveRoot(createPresentationTree(cachedSnapshot.root, LIVE_PRESENTATION_OPTIONS));
  }, [activeJob, cachedSnapshot, liveSnapshot, mountState]);
  const livePresentationOptions =
    activeJob?.phase === "queued" || activeJob?.phase === "scanning"
      ? LIVE_SCANNING_PRESENTATION_OPTIONS
      : LIVE_PRESENTATION_OPTIONS;

  useEffect(() => {
    if (!streamPath || !mount) {
      return;
    }

    let disposed = false;
    let flushTimer: number | null = null;
    let mergeTimer: number | null = null;
    const pendingBranches = new Map<string, DiskAnalysisTreemapNode>();
    const queuedBranches: DiskAnalysisTreemapNode[] = [];
    let pendingJob: DiskAnalysisJobState | null = null;
    let mergeRoot = liveRawRootRef.current;
    let lastPublishedAtMs = 0;
    const source = new EventSource(streamPath);

    const publishPresentation = (root: DiskAnalysisTreemapNode | null) => {
      const nextPresentation = createPresentationTree(root, livePresentationOptions);
      startTransition(() => {
        setLiveRoot(nextPresentation);
      });
    };

    const scheduleMerge = () => {
      if (disposed || mergeTimer !== null) {
        return;
      }
      mergeTimer = window.setTimeout(() => {
        mergeTimer = null;
        if (disposed) {
          return;
        }
        if (queuedBranches.length === 0) {
          if (mergeRoot !== liveRawRootRef.current) {
            liveRawRootRef.current = mergeRoot;
            publishPresentation(mergeRoot);
          }
          return;
        }

        const mergeStartedAt = performance.now();
        let nextRoot = mergeRoot ?? createSyntheticLiveRoot(mount);
        while (queuedBranches.length > 0) {
          const branch = queuedBranches.shift();
          if (!branch) {
            continue;
          }
          nextRoot = integrateBranchIntoTree(nextRoot, mount, branch);
          if (performance.now() - mergeStartedAt >= 12) {
            break;
          }
        }
        mergeRoot = nextRoot;
        liveRawRootRef.current = nextRoot;
        if (queuedBranches.length > 0) {
          if (performance.now() - lastPublishedAtMs >= LIVE_MERGE_PUBLISH_MS) {
            lastPublishedAtMs = performance.now();
            publishPresentation(nextRoot);
          }
          scheduleMerge();
          return;
        }
        lastPublishedAtMs = performance.now();
        publishPresentation(nextRoot);
      }, 0);
    };

    const flushPending = () => {
      if (disposed) {
        return;
      }
      flushTimer = null;
      const nextJob = pendingJob;
      pendingJob = null;
      const branches = [...pendingBranches.values()];
      pendingBranches.clear();

      if (nextJob) {
        setLiveJob(nextJob);
      }
      if (branches.length === 0) {
        return;
      }
      queuedBranches.push(...branches);
      scheduleMerge();
    };

    const scheduleFlush = (immediate: boolean = false) => {
      if (disposed) {
        return;
      }
      if (immediate) {
        if (flushTimer !== null) {
          window.clearTimeout(flushTimer);
          flushTimer = null;
        }
        flushPending();
        return;
      }
      if (flushTimer !== null) {
        return;
      }
      flushTimer = window.setTimeout(flushPending, LIVE_EVENT_BATCH_MS);
    };

    const handleEvent = (event: Event) => {
      if (disposed) {
        return;
      }
      try {
        const messageEvent = event as MessageEvent<string>;
        const parsed = DiskAnalysisScanEventSchema.parse(JSON.parse(messageEvent.data));
        if (parsed.event === "status" || parsed.event === "progress") {
          pendingJob = parsed.job;
          if (
            parsed.job.phase === "completed" ||
            parsed.job.phase === "partial" ||
            parsed.job.phase === "failed" ||
            parsed.job.phase === "cancelled"
          ) {
            scheduleFlush(true);
            requestedStreamKeyRef.current = null;
            if (parsed.job.phase === "completed" || parsed.job.phase === "partial") {
              void queryClient.invalidateQueries({
                queryKey: mountStateQueryKey,
              });
              void queryClient.invalidateQueries({
                queryKey: snapshotQueryKey,
              });
            }
            setStreamPath(null);
            return;
          }
          scheduleFlush();
          return;
        }
        if (parsed.event === "branch") {
          pendingBranches.set(parsed.branch.path, parsed.branch);
          scheduleFlush();
          return;
        }
        if (parsed.event === "snapshot") {
          scheduleFlush(true);
          if (mergeTimer !== null) {
            window.clearTimeout(mergeTimer);
            mergeTimer = null;
          }
          queuedBranches.length = 0;
          setLiveJob(parsed.job);
          setLiveSnapshot(parsed.snapshot);
          mergeRoot = parsed.snapshot.root;
          liveRawRootRef.current = parsed.snapshot.root;
          lastPublishedAtMs = performance.now();
          publishPresentation(parsed.snapshot.root);
          requestedStreamKeyRef.current = null;
          setStreamPath(null);
          void queryClient.invalidateQueries({
            queryKey: mountStateQueryKey,
          });
          void queryClient.invalidateQueries({
            queryKey: snapshotQueryKey,
          });
        }
      } catch (error) {
        console.error("Failed to handle disk analysis SSE event:", error);
      }
    };

    source.onopen = () => {
      setStreamError(null);
    };
    source.onerror = () => {
      if (disposed) {
        return;
      }
      setStreamError("Live scan stream disconnected.");
      requestedStreamKeyRef.current = null;
      setStreamPath(null);
      source.close();
      void fetchAuthStatus()
        .then((status) => {
          if (status.enabled && !status.unlocked) {
            emitUnauthorizedEvent();
          }
        })
        .catch(() => undefined);
    };

    source.addEventListener("status", handleEvent);
    source.addEventListener("progress", handleEvent);
    source.addEventListener("branch", handleEvent);
    source.addEventListener("snapshot", handleEvent);

    return () => {
      disposed = true;
      if (flushTimer !== null) {
        window.clearTimeout(flushTimer);
      }
      if (mergeTimer !== null) {
        window.clearTimeout(mergeTimer);
      }
      source.removeEventListener("status", handleEvent);
      source.removeEventListener("progress", handleEvent);
      source.removeEventListener("branch", handleEvent);
      source.removeEventListener("snapshot", handleEvent);
      source.close();
    };
  }, [livePresentationOptions, mount, mountStateQueryKey, queryClient, snapshotQueryKey, streamPath]);

  const liveAvailable =
    !!mountState?.activeJob || !!streamPath || !!liveJob || !!liveRoot || !!liveSnapshot;
  const activeView =
    viewMode === "cached" && cachedSnapshot
      ? "cached"
      : liveAvailable
        ? "live"
        : cachedSnapshot
          ? "cached"
          : ("live" satisfies ViewMode);
  const liveRootForView =
    activeJob?.phase === "queued" || activeJob?.phase === "scanning"
      ? liveRoot
      : liveSnapshot?.root ?? liveRoot;
  const currentRoot = activeView === "cached" ? cachedSnapshot?.root ?? null : liveRootForView;
  const currentSnapshot = activeView === "cached" ? cachedSnapshot : liveSnapshot;
  const legend =
    activeView === "cached"
      ? deriveLegendFromSnapshot(cachedSnapshot)
      : currentSnapshot
        ? deriveLegendFromSnapshot(currentSnapshot)
        : deriveLegendFromSnapshot(cachedSnapshot);
  const legendByExtension = useMemo(
    () => new Map(legend.map((item) => [item.extension, item])),
    [legend]
  );
  const hoveredNode = useMemo(
    () =>
      findNodeByPath(activeView === "live" ? liveRawRootRef.current : currentRoot, hoveredPath) ??
      currentRoot ??
      cachedSnapshot?.root ??
      null,
    [activeView, cachedSnapshot?.root, currentRoot, hoveredPath]
  );
  const issueList = useMemo(() => {
    if (activeView === "live" && activeJob) {
      return activeJob.issues;
    }
    return currentSnapshot?.issues ?? cachedSnapshot?.issues ?? [];
  }, [activeJob, activeView, cachedSnapshot?.issues, currentSnapshot]);

  useEffect(() => {
    if (issueList.length === 0) {
      setIsIssuesModalOpen(false);
    }
  }, [issueList.length]);

  const showViewSwitcher =
    !!cachedSnapshot && (mountState?.cache.state === "stale" || liveAvailable);
  const generatedAt = currentSnapshot?.generatedAt ?? cachedSnapshot?.generatedAt;
  const totals = currentSnapshot?.totals ?? null;
  const progressPercent = Math.min(
    100,
    activeJob?.progress.directoriesDiscovered
      ? (activeJob.progress.directoriesCompleted / activeJob.progress.directoriesDiscovered) * 100
      : 0
  );
  const cacheStatus =
    mountState?.cache.state === "fresh"
      ? "Fresh"
      : mountState?.cache.state === "stale"
        ? "Stale"
        : "Missing";
  const liveStatus = activeJob
    ? activeJob.phase
    : mountState?.cache.state === "fresh"
      ? "Idle"
      : "Preparing";
  const processedBytes = activeJob?.progress.bytesProcessed ?? totals?.totalBytes ?? 0;
  const canStartManualScan =
    !!mount && !mountStateQuery.isLoading && !snapshotQuery.isLoading && !mountState?.activeJob;
  const manualScanLabel = cachedSnapshot ? "Start New Scan" : "Start Scan";
  const showToolbarActions = canStartManualScan || issueList.length > 0;

  const openInFiles = (node: DiskAnalysisTreemapNode) => {
    void navigate({
      to: "/files",
      search: getNodeNavigationSearch(node),
    });
  };

  if (!mount) {
    return (
      <div className="page-container page-container--viewport">
        <div className="page-header">
          <h1 className="page-title">Disk Analysis</h1>
        </div>
        <div className="page-body">
          <div className="panel disk-analysis-empty">
            <div className="disk-analysis-empty__title">Mount metadata missing</div>
            <div className="disk-analysis-empty__body">
              Open disk analysis from `Settings` so the mount and filesystem identity are
              included in the route.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container page-container--viewport">
      <div className="page-header">
        <div className="disk-analysis-toolbar">
          <div className="disk-analysis-toolbar__primary-row">
            <Button
              variant="secondary"
              className="disk-analysis-toolbar__back-button"
              aria-label="Back To Settings"
              onClick={() => void navigate({ to: "/settings" })}
            >
              <ArrowLeft size={14} />
              <span className="disk-analysis-toolbar__label disk-analysis-toolbar__label--full">
                Back To Settings
              </span>
              <span className="disk-analysis-toolbar__label disk-analysis-toolbar__label--compact">
                Back
              </span>
            </Button>
            {showToolbarActions ? (
              <div className="disk-analysis-toolbar__actions">
                {canStartManualScan ? (
                  <Button
                    aria-label={startScanMutation.isPending ? "Starting Scan" : manualScanLabel}
                    onClick={startManualScan}
                    disabled={startScanMutation.isPending}
                  >
                    <Play size={14} />
                    <span className="disk-analysis-toolbar__label disk-analysis-toolbar__label--full">
                      {startScanMutation.isPending ? "STARTING..." : manualScanLabel}
                    </span>
                    <span className="disk-analysis-toolbar__label disk-analysis-toolbar__label--compact">
                      {startScanMutation.isPending ? "..." : "Scan"}
                    </span>
                  </Button>
                ) : null}
                {issueList.length > 0 ? (
                  <Button
                    variant="secondary"
                    aria-label={`View Issues (${formatCount(issueList.length)})`}
                    onClick={() => setIsIssuesModalOpen(true)}
                  >
                    <AlertTriangle size={14} />
                    <span className="disk-analysis-toolbar__label disk-analysis-toolbar__label--full">
                      View Issues
                    </span>
                    <span className="disk-analysis-toolbar__label disk-analysis-toolbar__label--compact">
                      Issues
                    </span>
                    <span className="disk-analysis-toolbar__issues-count">
                      ({formatCount(issueList.length)})
                    </span>
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
          <div
            className="disk-analysis-toolbar__mobile-toggle"
            role="group"
            aria-label="Disk analysis mobile view"
          >
            <Button
              type="button"
              className="disk-analysis-toolbar__mobile-toggle-button"
              variant={mobileSidebarOpen ? "primary" : "secondary"}
              aria-pressed={mobileSidebarOpen}
              onClick={() => setMobileSidebarOpen(true)}
            >
              <PanelLeft size={14} />
              <span>Details</span>
            </Button>
            <Button
              type="button"
              className="disk-analysis-toolbar__mobile-toggle-button"
              variant={mobileSidebarOpen ? "secondary" : "primary"}
              aria-pressed={!mobileSidebarOpen}
              onClick={() => setMobileSidebarOpen(false)}
            >
              <span>Treemap</span>
            </Button>
          </div>
        </div>
      </div>

      <div className="page-body disk-analysis-page">
        <div
          className={`disk-analysis-layout${mobileSidebarOpen ? " disk-analysis-layout--mobile-sidebar-open" : ""}`}
        >
          <aside className="panel disk-analysis-sidebar">
            {showViewSwitcher ? (
              <div className="disk-analysis-mode-switch">
                <Button
                  variant={activeView === "cached" ? "primary" : "secondary"}
                  onClick={showCachedView}
                >
                  Cached
                </Button>
                <Button
                  variant={activeView === "live" ? "primary" : "secondary"}
                  onClick={openLiveView}
                  disabled={!liveAvailable}
                >
                  Live
                </Button>
              </div>
            ) : null}

            <div className="disk-analysis-meta">
              <SidebarStat label="Mount" value={getMountLabel(mount.mount)} />
              <SidebarStat label="Cache" value={cacheStatus} />
              <SidebarStat label="Job" value={liveStatus} />
              <SidebarStat label="Generated" value={formatRelativeGeneratedAt(generatedAt)} />
              {streamError ? <SidebarStat label="Stream" value={streamError} tone="bad" /> : null}
            </div>

            {activeJob ? (
              <div className="disk-analysis-progress">
                <div className="disk-analysis-progress__bar">
                  <div
                    className="disk-analysis-progress__fill"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                <div className="disk-analysis-progress__meta">
                  <span>
                    {formatCount(activeJob.progress.directoriesCompleted)} /{" "}
                    {formatCount(activeJob.progress.directoriesDiscovered)} directories
                  </span>
                  <span>{formatCount(activeJob.progress.filesDiscovered)} files</span>
                  <span>{formatBytes(processedBytes)} processed</span>
                </div>
              </div>
            ) : null}

            {!isCompactLayout ? (
              <section className="disk-analysis-sidebar-section">
                <div className="label">Hover Details</div>
                {hoveredNode ? (
                  <div className="disk-analysis-details__content">
                    <div className="disk-analysis-details__name">{hoveredNode.name}</div>
                    <div className="disk-analysis-details__type">
                      {getNodeDisplayType(hoveredNode)}
                    </div>
                    <div className="disk-analysis-details__path">{hoveredNode.path}</div>
                    <DetailRow label="Recursive Size" value={formatBytes(hoveredNode.recursiveSize)} />
                    <DetailRow label="Children" value={formatCount(hoveredNode.childCount)} />
                  </div>
                ) : (
                  <div className="disk-analysis-sidebar-empty">Hover a block to inspect it.</div>
                )}
              </section>
            ) : null}

            <section className="disk-analysis-sidebar-section">
              <div className="label">Extension Legend</div>
              {legend.length > 0 ? (
                <div className="disk-analysis-legend__list">
                  {legend.map((item) => (
                    <LegendRow key={item.extension} item={item} />
                  ))}
                </div>
              ) : (
                <div className="disk-analysis-sidebar-empty">Legend data will appear after scanning.</div>
              )}
            </section>
          </aside>

          <section className="panel disk-analysis-treemap-panel">

            {mountStateQuery.isLoading || snapshotQuery.isLoading ? (
              <div className="disk-analysis-empty">
                <div className="disk-analysis-empty__title">Loading analysis state</div>
                <div className="disk-analysis-empty__body">
                  Reading cached data and active scan status for this mount.
                </div>
              </div>
            ) : mountStateQuery.error || snapshotQuery.error ? (
              <div className="disk-analysis-empty disk-analysis-empty--error">
                <div className="disk-analysis-empty__title">Disk analysis unavailable</div>
                <div className="disk-analysis-empty__body">
                  {mountStateQuery.error?.message ?? snapshotQuery.error?.message}
                </div>
              </div>
            ) : currentRoot ? (
              <TreemapCanvas
                key={mobileSidebarOpen ? "treemap-hidden" : "treemap-visible"}
                root={currentRoot}
                legendByExtension={legendByExtension}
                compactMode={isCompactLayout}
                onHoverNode={setHoveredPath}
                onOpenNode={openInFiles}
              />
            ) : activeJob ? (
              <div className="disk-analysis-empty">
                <div className="disk-analysis-empty__title">Assembling live tree</div>
                <div className="disk-analysis-empty__body">
                  Streamed directory branches will appear here as workers complete them.
                </div>
              </div>
            ) : (
              <div className="disk-analysis-empty">
                <div className="disk-analysis-empty__title">No analysis data available</div>
                <div className="disk-analysis-empty__body">
                  Start a scan from Settings or refresh the page to request the latest mount
                  status.
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
      <ScanIssuesModal
        isOpen={isIssuesModalOpen}
        issues={issueList}
        onClose={() => setIsIssuesModalOpen(false)}
      />
    </div>
  );
}

function SidebarStat({
  label,
  value,
  mono = false,
  tone = "default",
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: "default" | "bad";
}) {
  return (
    <div className="disk-analysis-meta__row">
      <span className="disk-analysis-meta__label">{label}</span>
      <span
        className={`disk-analysis-meta__value${mono ? " disk-analysis-meta__value--mono" : ""}${
          tone === "bad" ? " disk-analysis-meta__value--bad" : ""
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="disk-analysis-detail-row">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function LegendRow({ item }: { item: DiskAnalysisLegendItem }) {
  return (
    <div className="disk-analysis-legend__row">
      <span
        className="disk-analysis-legend__swatch"
        style={{ background: getLegendColor(item.colorToken) }}
      />
      <span className="disk-analysis-legend__label">.{item.extension}</span>
      <span className="disk-analysis-legend__count">
        {formatBytes(item.totalBytes)} ({formatCount(item.count)})
      </span>
    </div>
  );
}

function ScanIssuesModal({
  isOpen,
  issues,
  onClose,
}: {
  isOpen: boolean;
  issues: DiskAnalysisIssue[];
  onClose: () => void;
}) {
  const [pageState, setPageState] = useState<IssuesPageState>({
    query: "",
    page: 1,
  });

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) {
      setPageState({
        query: "",
        page: 1,
      });
    }
  }, [isOpen]);

  const filteredIssues = useMemo(() => {
    const query = pageState.query.trim().toLowerCase();
    if (!query) {
      return issues;
    }
    return issues.filter((issue) =>
      [issue.code, issue.message, issue.path].some((value) => value.toLowerCase().includes(query))
    );
  }, [issues, pageState.query]);
  const totalPages = Math.max(1, Math.ceil(filteredIssues.length / ISSUES_PAGE_SIZE));
  const currentPage = Math.min(pageState.page, totalPages);
  const pagedIssues = filteredIssues.slice(
    (currentPage - 1) * ISSUES_PAGE_SIZE,
    currentPage * ISSUES_PAGE_SIZE
  );

  useEffect(() => {
    setPageState((current) =>
      current.page === currentPage ? current : { ...current, page: currentPage }
    );
  }, [currentPage]);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="disk-analysis-modal" role="presentation">
      <button
        type="button"
        className="disk-analysis-modal__backdrop"
        aria-label="Close scan issues dialog"
        onClick={onClose}
      />
      <div className="disk-analysis-modal__dialog" role="dialog" aria-modal="true">
        <div className="disk-analysis-modal__header">
          <div>
            <div className="label">Disk Analysis</div>
            <h2 className="disk-analysis-modal__title">
              Scan Issues ({formatCount(issues.length)})
            </h2>
          </div>
          <Button variant="icon" onClick={onClose} aria-label="Close scan issues dialog">
            <X size={16} />
          </Button>
        </div>
        <div className="disk-analysis-modal__body">
          <div className="disk-analysis-modal__toolbar">
            <label className="disk-analysis-modal__search">
              <span className="label">Search Issues</span>
              <input
                type="search"
                value={pageState.query}
                onChange={(event) =>
                  setPageState({
                    query: event.target.value,
                    page: 1,
                  })
                }
                placeholder="Search code, path, or message"
              />
            </label>
            <div className="disk-analysis-modal__pagination">
              <span className="disk-analysis-modal__pagination-summary">
                {filteredIssues.length > 0
                  ? `${formatCount((currentPage - 1) * ISSUES_PAGE_SIZE + 1)}-${formatCount(
                      Math.min(currentPage * ISSUES_PAGE_SIZE, filteredIssues.length)
                    )} of ${formatCount(filteredIssues.length)}`
                  : "0 results"}
              </span>
              <Button
                variant="secondary"
                onClick={() =>
                  setPageState((current) => ({
                    ...current,
                    page: Math.max(1, current.page - 1),
                  }))
                }
                disabled={currentPage <= 1}
              >
                Prev
              </Button>
              <Button
                variant="secondary"
                onClick={() =>
                  setPageState((current) => ({
                    ...current,
                    page: Math.min(totalPages, current.page + 1),
                  }))
                }
                disabled={currentPage >= totalPages}
              >
                Next
              </Button>
            </div>
          </div>
          {issues.length > 0 ? (
            <div className="disk-analysis-issues__list">
              {pagedIssues.map((issue) => (
                <div
                  key={`${issue.code}:${issue.path}:${issue.message}`}
                  className="disk-analysis-issue"
                >
                  <div className="disk-analysis-issue__code">{issue.code}</div>
                  <div className="disk-analysis-issue__message">{issue.message}</div>
                  <div className="disk-analysis-issue__path">{issue.path}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="disk-analysis-sidebar-empty">No scan issues reported.</div>
          )}
          {issues.length > 0 && filteredIssues.length === 0 ? (
            <div className="disk-analysis-sidebar-empty">
              No scan issues match the current search.
            </div>
          ) : (
            filteredIssues.length > ISSUES_PAGE_SIZE ? (
              <div className="disk-analysis-modal__page-indicator">
                Page {formatCount(currentPage)} of {formatCount(totalPages)}
              </div>
            ) : null
          )}
        </div>
      </div>
    </div>
  );
}

function TreemapCanvas({
  root,
  legendByExtension,
  compactMode,
  onHoverNode,
  onOpenNode,
}: {
  root: DiskAnalysisTreemapNode;
  legendByExtension: Map<string, DiskAnalysisLegendItem>;
  compactMode: boolean;
  onHoverNode: (path: string | null) => void;
  onOpenNode: (node: DiskAnalysisTreemapNode) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hoveredNodeRef = useRef<DiskAnalysisTreemapNode | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const pendingHoverPointRef = useRef<{ x: number; y: number } | null>(null);
  const lastHoverUpdateAtRef = useRef(0);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [hoveredPath, setHoveredPath] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<DiskAnalysisTreemapNode | null>(null);
  const canvasWidth = containerSize.width > 0 ? containerSize.width : DEFAULT_TREEMAP_WIDTH;
  const canvasHeight = containerSize.height > 0 ? containerSize.height : DEFAULT_TREEMAP_HEIGHT;
  const drawables = useMemo(
    () => buildTreemapDrawables(root, legendByExtension, canvasWidth, canvasHeight),
    [canvasHeight, canvasWidth, legendByExtension, root]
  );

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }
    const updateSize = () => {
      setContainerSize({
        width: element.clientWidth,
        height: element.clientHeight,
      });
    };
    updateSize();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateSize);
      return () => {
        window.removeEventListener("resize", updateSize);
      };
    }
    const observer = new ResizeObserver(() => {
      updateSize();
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    drawTreemapCanvas(canvasRef.current, drawables, canvasWidth, canvasHeight, hoveredPath);
  }, [canvasHeight, canvasWidth, drawables, hoveredPath]);

  useEffect(() => {
    if (!compactMode) {
      setSelectedNode(null);
    }
  }, [compactMode]);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
      }
      onHoverNode(null);
    };
  }, [onHoverNode]);

  const updateHoveredNode = (node: DiskAnalysisTreemapNode | null) => {
    hoveredNodeRef.current = node;
    const nextPath = node?.path ?? null;
    setHoveredPath((current) => (current === nextPath ? current : nextPath));
    onHoverNode(nextPath);
  };

  const resolveNodeFromPointer = (
    event:
      | React.MouseEvent<HTMLCanvasElement>
      | React.KeyboardEvent<HTMLCanvasElement>
      | React.FocusEvent<HTMLCanvasElement>
  ) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return null;
    }
    const bounds = canvas.getBoundingClientRect();
    const pointerEvent = "clientX" in event ? event : null;
    const x =
      pointerEvent && bounds.width > 0 ? pointerEvent.clientX - bounds.left : canvasWidth / 2;
    const y =
      pointerEvent && bounds.height > 0 ? pointerEvent.clientY - bounds.top : canvasHeight / 2;
    return findDrawableAtPoint(drawables, x, y)?.node ?? null;
  };

  const resolveNodeFromPoint = (x: number, y: number) => findDrawableAtPoint(drawables, x, y)?.node ?? null;

  const flushQueuedHover = () => {
    hoverTimerRef.current = null;
    const point = pendingHoverPointRef.current;
    pendingHoverPointRef.current = null;
    lastHoverUpdateAtRef.current = performance.now();
    updateHoveredNode(point ? resolveNodeFromPoint(point.x, point.y) : null);
  };

  const queueHoverUpdate = (x: number, y: number) => {
    pendingHoverPointRef.current = { x, y };
    const elapsedMs = performance.now() - lastHoverUpdateAtRef.current;
    if (elapsedMs >= HOVER_EVENT_COOLDOWN_MS && hoverTimerRef.current === null) {
      flushQueuedHover();
      return;
    }
    if (hoverTimerRef.current !== null) {
      return;
    }
    hoverTimerRef.current = window.setTimeout(
      flushQueuedHover,
      Math.max(0, HOVER_EVENT_COOLDOWN_MS - elapsedMs)
    );
  };

  return (
    <div ref={containerRef} className="disk-analysis-treemap">
      <canvas
        ref={canvasRef}
        className="disk-analysis-treemap__canvas"
        role="img"
        aria-label="Disk usage treemap"
        tabIndex={0}
        onMouseMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          queueHoverUpdate(event.clientX - bounds.left, event.clientY - bounds.top);
        }}
        onMouseLeave={() => {
          if (hoverTimerRef.current !== null) {
            window.clearTimeout(hoverTimerRef.current);
            hoverTimerRef.current = null;
          }
          pendingHoverPointRef.current = null;
          updateHoveredNode(null);
        }}
        onDoubleClick={(event) => {
          const node = resolveNodeFromPointer(event);
          if (node) {
            onOpenNode(node);
          }
        }}
        onClick={(event) => {
          if (!compactMode) {
            return;
          }
          const node = resolveNodeFromPointer(event);
          setSelectedNode(node);
        }}
        onFocus={(event) => {
          updateHoveredNode(resolveNodeFromPointer(event));
        }}
        onBlur={() => {
          updateHoveredNode(null);
        }}
        onKeyDown={(event) => {
          if ((event.key === "Enter" || event.key === " ") && hoveredNodeRef.current) {
            event.preventDefault();
            onOpenNode(hoveredNodeRef.current);
          }
        }}
      />
      {!compactMode ? (
        <div className="disk-analysis-treemap__hint">Double-click a block to open it in Files.</div>
      ) : null}
      {compactMode && selectedNode ? (
        <div className="disk-analysis-treemap__popover" role="dialog" aria-label="Selected block details">
          <div className="disk-analysis-treemap__popover-header">
            <div className="disk-analysis-treemap__popover-title">{selectedNode.name}</div>
            <Button
              type="button"
              variant="icon"
              onClick={() => setSelectedNode(null)}
              aria-label="Close selected block details"
            >
              <X size={14} />
            </Button>
          </div>
          <div className="disk-analysis-details__type">{getNodeDisplayType(selectedNode)}</div>
          <div className="disk-analysis-details__path">{selectedNode.path}</div>
          <div className="disk-analysis-treemap__popover-stats">
            <DetailRow label="Recursive Size" value={formatBytes(selectedNode.recursiveSize)} />
            <DetailRow label="Children" value={formatCount(selectedNode.childCount)} />
          </div>
          <div className="disk-analysis-treemap__popover-actions">
            <Button
              type="button"
              onClick={() => {
                onOpenNode(selectedNode);
              }}
            >
              <ArrowRight size={14} />
              <span>Open In Files</span>
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function layoutNodes(
  nodes: DiskAnalysisTreemapNode[],
  rect: TreemapRect,
  minNodePixels: number
): Array<{ node: DiskAnalysisTreemapNode; rect: TreemapRect }> {
  const weighted = nodes
    .filter((node) => node.recursiveSize > 0)
    .slice()
    .sort((left, right) => right.recursiveSize - left.recursiveSize)
    .map((node) => ({
      node,
      weight: Math.max(node.recursiveSize, 1),
    }));
  const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0 || rect.width <= 0 || rect.height <= 0) {
    return [];
  }

  const layouts: Array<{ node: DiskAnalysisTreemapNode; rect: TreemapRect }> = [];
  const sumWeight = (items: Array<{ node: DiskAnalysisTreemapNode; weight: number }>) =>
    items.reduce((sum, item) => sum + item.weight, 0);
  const recurse = (
    items: Array<{ node: DiskAnalysisTreemapNode; weight: number }>,
    nextRect: TreemapRect
  ) => {
    if (items.length === 0 || nextRect.width < minNodePixels || nextRect.height < minNodePixels) {
      return;
    }
    if (items.length === 1) {
      layouts.push({
        node: items[0].node,
        rect: nextRect,
      });
      return;
    }

    const itemsTotalWeight = sumWeight(items);
    const splitTarget = itemsTotalWeight / 2;
    const firstGroup: Array<{ node: DiskAnalysisTreemapNode; weight: number }> = [];
    const secondGroup: Array<{ node: DiskAnalysisTreemapNode; weight: number }> = [];
    let runningWeight = 0;

    for (const item of items) {
      const nextWeight = runningWeight + item.weight;
      if (
        firstGroup.length === 0 ||
        (nextWeight <= splitTarget && secondGroup.length === 0)
      ) {
        firstGroup.push(item);
        runningWeight = nextWeight;
      } else {
        secondGroup.push(item);
      }
    }

    if (secondGroup.length === 0) {
      secondGroup.push(firstGroup.pop()!);
    }

    const firstWeight = sumWeight(firstGroup);
    const splitHorizontal = nextRect.width >= nextRect.height;
    if (splitHorizontal) {
      const leftWidth = nextRect.width * (firstWeight / itemsTotalWeight);
      recurse(firstGroup, {
        x: nextRect.x,
        y: nextRect.y,
        width: leftWidth,
        height: nextRect.height,
      });
      recurse(secondGroup, {
        x: nextRect.x + leftWidth,
        y: nextRect.y,
        width: Math.max(0, nextRect.width - leftWidth),
        height: nextRect.height,
      });
      return;
    }

    const topHeight = nextRect.height * (firstWeight / itemsTotalWeight);
    recurse(firstGroup, {
      x: nextRect.x,
      y: nextRect.y,
      width: nextRect.width,
      height: topHeight,
    });
    recurse(secondGroup, {
      x: nextRect.x,
      y: nextRect.y + topHeight,
      width: nextRect.width,
      height: Math.max(0, nextRect.height - topHeight),
    });
  };
  recurse(weighted, rect);

  return layouts.filter(
    (item) => item.rect.width >= minNodePixels && item.rect.height >= minNodePixels
  );
}

function buildTreemapDrawables(
  root: DiskAnalysisTreemapNode,
  legendByExtension: Map<string, DiskAnalysisLegendItem>,
  canvasWidth: number,
  canvasHeight: number
): TreemapDrawable[] {
  const visibleNodes = root.children.length > 0 ? root.children : [root];
  const totalBytes = Math.max(root.recursiveSize, 1);
  const drawables: TreemapDrawable[] = [];

  const visitNode = (node: DiskAnalysisTreemapNode, rect: TreemapRect, depth: number) => {
    if (rect.width < MIN_NODE_PIXELS || rect.height < MIN_NODE_PIXELS) {
      return;
    }

    const sizeShare = node.recursiveSize / totalBytes;
    const showDirectoryChrome =
      node.type === "directory" && sizeShare >= DIRECTORY_CHROME_MIN_SHARE;
    const headerLabel =
      node.type === "directory" &&
      showDirectoryChrome &&
      rect.width >= MIN_DIRECTORY_HEADER_WIDTH_PX &&
      rect.height >= MIN_DIRECTORY_HEADER_HEIGHT_PX
        ? `${node.name} (${formatBytes(node.recursiveSize)})`
        : null;
    const headerHeight =
      node.type === "directory" && headerLabel
        ? Math.min(DIRECTORY_HEADER_HEIGHT_PX, Math.max(0, rect.height * 0.3))
        : 0;
    drawables.push({
      node,
      rect,
      depth,
      headerHeight,
      headerLabel,
      showDirectoryChrome,
      color: getNodeColor(node, legendByExtension, depth),
    });

    if (node.type !== "directory" || node.children.length === 0) {
      return;
    }

    const inset = showDirectoryChrome ? TREEMAP_NODE_GAP_PX : 0;
    const childRect = {
      x: rect.x + inset,
      y: rect.y + headerHeight + inset,
      width: Math.max(0, rect.width - inset * 2),
      height: Math.max(0, rect.height - headerHeight - inset * 2),
    };
    if (childRect.width < MIN_NODE_PIXELS || childRect.height < MIN_NODE_PIXELS) {
      return;
    }

    for (const childLayout of layoutNodes(node.children, childRect, MIN_NODE_PIXELS)) {
      visitNode(childLayout.node, childLayout.rect, depth + 1);
    }
  };

  for (const childLayout of layoutNodes(
    visibleNodes,
    {
      x: 0,
      y: 0,
      width: canvasWidth,
      height: canvasHeight,
    },
    MIN_NODE_PIXELS
  )) {
    visitNode(childLayout.node, insetTreemapRect(childLayout.rect, TREEMAP_NODE_GAP_PX), 0);
  }

  return drawables;
}

function insetTreemapRect(rect: TreemapRect, amount: number): TreemapRect {
  if (amount <= 0) {
    return rect;
  }
  const insetX = Math.min(amount / 2, rect.width / 4);
  const insetY = Math.min(amount / 2, rect.height / 4);
  return {
    x: rect.x + insetX,
    y: rect.y + insetY,
    width: Math.max(0, rect.width - insetX * 2),
    height: Math.max(0, rect.height - insetY * 2),
  };
}

function findDrawableAtPoint(drawables: TreemapDrawable[], x: number, y: number): TreemapDrawable | null {
  for (let index = drawables.length - 1; index >= 0; index -= 1) {
    const drawable = drawables[index];
    if (
      x >= drawable.rect.x &&
      x <= drawable.rect.x + drawable.rect.width &&
      y >= drawable.rect.y &&
      y <= drawable.rect.y + drawable.rect.height
    ) {
      return drawable;
    }
  }
  return null;
}

function drawTreemapCanvas(
  canvas: HTMLCanvasElement | null,
  drawables: TreemapDrawable[],
  width: number,
  height: number,
  hoveredPath: string | null
) {
  if (!canvas || width <= 0 || height <= 0) {
    return;
  }
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);

  const styles = getComputedStyle(canvas);
  const textPrimary = styles.getPropertyValue("--text-primary").trim() || "#f5f7fa";
  const textMuted = styles.getPropertyValue("--text-muted").trim() || "rgba(255, 255, 255, 0.72)";
  const accent = styles.getPropertyValue("--accent-primary").trim() || "#00ff88";

  for (const drawable of drawables) {
    context.fillStyle = drawable.color.background;
    context.fillRect(drawable.rect.x, drawable.rect.y, drawable.rect.width, drawable.rect.height);

    if (drawable.node.type === "file" || drawable.showDirectoryChrome) {
      context.strokeStyle = drawable.color.border;
      context.lineWidth = 1;
      context.strokeRect(
        drawable.rect.x + 0.5,
        drawable.rect.y + 0.5,
        Math.max(0, drawable.rect.width - 1),
        Math.max(0, drawable.rect.height - 1)
      );
    }

    if (drawable.headerLabel && drawable.headerHeight > 0) {
      context.fillStyle = "rgba(0, 0, 0, 0.3)";
      context.fillRect(drawable.rect.x, drawable.rect.y, drawable.rect.width, drawable.headerHeight);
      context.fillStyle = textPrimary;
      context.font = "500 10px monospace";
      context.textBaseline = "middle";
      const label = truncateCanvasText(
        context,
        drawable.headerLabel,
        Math.max(24, drawable.rect.width - 12)
      );
      context.fillText(label, drawable.rect.x + 6, drawable.rect.y + drawable.headerHeight / 2);
    } else if (
      drawable.node.type === "file" &&
      drawable.rect.width >= FILE_LABEL_MIN_WIDTH_PX &&
      drawable.rect.height >= FILE_LABEL_MIN_HEIGHT_PX
    ) {
      context.fillStyle = resolveCanvasColor(drawable.color.text, textPrimary) ?? textMuted;
      context.font = "500 11px monospace";
      context.textBaseline = "middle";
      const label = truncateCanvasText(
        context,
        drawable.node.name,
        Math.max(24, drawable.rect.width - 12)
      );
      context.fillText(label, drawable.rect.x + 6, drawable.rect.y + drawable.rect.height / 2);
    }

  }

  if (!hoveredPath) {
    return;
  }
  const hoveredDrawable = drawables.find((drawable) => drawable.node.path === hoveredPath);
  if (!hoveredDrawable) {
    return;
  }
  context.strokeStyle = accent;
  context.lineWidth = 2;
  context.strokeRect(
    hoveredDrawable.rect.x + 1,
    hoveredDrawable.rect.y + 1,
    Math.max(0, hoveredDrawable.rect.width - 2),
    Math.max(0, hoveredDrawable.rect.height - 2)
  );
}

function truncateCanvasText(
  context: CanvasRenderingContext2D,
  value: string,
  maxWidth: number
): string {
  if (maxWidth <= 0 || context.measureText(value).width <= maxWidth) {
    return value;
  }
  const ellipsis = "...";
  let endIndex = value.length;
  while (endIndex > 0) {
    const candidate = `${value.slice(0, endIndex)}${ellipsis}`;
    if (context.measureText(candidate).width <= maxWidth) {
      return candidate;
    }
    endIndex -= 1;
  }
  return ellipsis;
}

function resolveCanvasColor(value: string, fallback: string): string {
  const match = value.match(/^var\((--[^)]+)\)$/);
  if (!match) {
    return value || fallback;
  }
  const resolved = getComputedStyle(document.documentElement).getPropertyValue(match[1]).trim();
  return resolved || fallback;
}

function getCanvasTextColorForFill(fill: string, fallback: string): string {
  const normalizedFill = fill.trim().toLowerCase();
  return BLOCK_TEXT_COLOR_BY_FILL.get(normalizedFill) ?? fallback;
}

function getNodeColor(
  node: DiskAnalysisTreemapNode,
  legendByExtension: Map<string, DiskAnalysisLegendItem>,
  depth: number
) {
  if (node.path.endsWith("__deckos_other_entries__")) {
    return {
      background: "#8aa3e3",
      border: "#abc0f5",
      text: getCanvasTextColorForFill("#8aa3e3", "#0a1020"),
    };
  }
  if (node.type === "file") {
    const legendItem = node.extension ? legendByExtension.get(node.extension) : undefined;
    const base = legendItem ? getLegendColor(legendItem.colorToken) : "#5f6877";
    return {
      background: base,
      border: legendItem ? base : "rgba(122, 132, 155, 0.55)",
      text: getCanvasTextColorForFill(base, "#f5f7fa"),
    };
  }
  const tint = Math.max(34, 74 - depth * 8);
  return {
    background: `rgb(${tint}, ${tint}, ${tint})`,
    border: "rgba(255, 255, 255, 0.16)",
    text: "var(--text-primary)",
  };
}
