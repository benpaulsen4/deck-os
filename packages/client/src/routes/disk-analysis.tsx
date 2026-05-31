import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, ArrowLeft, PanelLeft, Play } from "lucide-react";
import { Button } from "../components/ui/Button";
import { useToastStore } from "../stores/toast";
import { emitUnauthorizedEvent, fetchAuthStatus } from "../lib/auth";
import {
  DiskAnalysisRouteSearchSchema,
  DiskAnalysisScanEventSchema,
  type DiskAnalysisJobState,
  type DiskAnalysisMountIdentity,
  type DiskAnalysisSnapshot,
  type DiskAnalysisTreemapNode,
} from "@deckos/contracts";
import {
  createPresentationTree,
  createSyntheticLiveRoot,
  deriveLegendFromSnapshot,
  formatBytes,
  formatCount,
  formatRelativeGeneratedAt,
  getMountLabel,
  getNodeNavigationSearch,
  integrateBranchIntoTree,
  resolveHoveredNode,
} from "../lib/diskAnalysisClient";
import { useTRPC, trpcClient } from "../trpc";
import { HoverDetails, LegendRow, ScanIssuesModal, SidebarStat } from "./disk-analysis.components";
import { TreemapCanvas } from "./disk-analysis.treemap";

export const Route = createFileRoute("/disk-analysis")({
  validateSearch: (search) => DiskAnalysisRouteSearchSchema.parse(search),
  component: DiskAnalysisPage,
});

type ViewMode = "cached" | "live";
const LIVE_EVENT_BATCH_MS = 0;
const LIVE_MERGE_PUBLISH_MS = 250;
const LIVE_PRESENTATION_OPTIONS = {
  maxDepth: 4,
  maxChildrenPerDirectory: 36,
};
const LIVE_SCANNING_PRESENTATION_OPTIONS = {
  maxDepth: 3,
  maxChildrenPerDirectory: 24,
};

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
      resolveHoveredNode(
        currentRoot,
        activeView === "live" ? liveRawRootRef.current : currentRoot,
        hoveredPath,
        cachedSnapshot?.root ?? null
      ),
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
                <HoverDetails hoveredNode={hoveredNode} />
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
