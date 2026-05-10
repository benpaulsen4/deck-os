import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
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

const MIN_RENDER_PERCENT = 0.6;
const MIN_NODE_PIXELS = 6;
const MIN_DIRECTORY_LABEL_PIXELS = 20;
const DIRECTORY_TITLE_STRIP_PX = 18;
const LIVE_BRANCH_FLUSH_MS = 120;
const LIVE_PRESENTATION_REFRESH_MS = 350;
type TreemapRenderThreshold = {
  width: number;
  height: number;
  canvasWidth: number;
  canvasHeight: number;
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
  const requestedStreamKeyRef = useRef<string | null>(null);
  const liveRawRootRef = useRef<DiskAnalysisTreemapNode | null>(null);

  useEffect(() => {
    setLiveRoot(null);
    setLiveSnapshot(null);
    setLiveJob(null);
    setStreamPath(null);
    setStreamError(null);
    setHoveredPath(null);
    requestedStreamKeyRef.current = null;
    liveRawRootRef.current = null;
  }, [mountKey]);

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

  useEffect(() => {
    if (!mount || !mountState) {
      return;
    }
    const shouldStartLive =
      mountState.cache.state === "missing" || mountState.activeJob !== null;
    if (!shouldStartLive) {
      return;
    }
    const requestKey = `${mountKey}::${mountState.activeJob?.jobId ?? "pending"}`;
    if (requestedStreamKeyRef.current === requestKey || startScanMutation.isPending) {
      return;
    }
    requestedStreamKeyRef.current = requestKey;
    startScanMutation.mutate(mount);
  }, [
    mount,
    mountKey,
    mountState,
    mountState?.activeJob?.jobId,
    mountState?.cache.state,
    startScanMutation,
  ]);

  useEffect(() => {
    if (cachedSnapshot) {
      setViewMode((current) => {
        if (current === "cached") {
          return current;
        }
        return liveRoot || liveSnapshot ? current : "cached";
      });
      return;
    }
    setViewMode("live");
  }, [cachedSnapshot, liveRoot, liveSnapshot]);

  useEffect(() => {
    if (!streamPath || !mount) {
      return;
    }

    let disposed = false;
    let flushTimer: number | null = null;
    let presentationTimer: number | null = null;
    const pendingBranches = new Map<string, DiskAnalysisTreemapNode>();
    let pendingJob: DiskAnalysisJobState | null = null;
    const source = new EventSource(streamPath);

    const publishPresentation = () => {
      if (disposed) {
        return;
      }
      presentationTimer = null;
      const nextPresentation = createPresentationTree(liveRawRootRef.current, {
        maxDepth: 4,
        maxChildrenPerDirectory: 36,
      });
      startTransition(() => {
        setLiveRoot(nextPresentation);
      });
    };

    const schedulePresentation = (immediate: boolean = false) => {
      if (disposed) {
        return;
      }
      if (immediate) {
        if (presentationTimer !== null) {
          window.clearTimeout(presentationTimer);
          presentationTimer = null;
        }
        publishPresentation();
        return;
      }
      if (presentationTimer !== null) {
        return;
      }
      presentationTimer = window.setTimeout(publishPresentation, LIVE_PRESENTATION_REFRESH_MS);
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
      const hadRawRoot = !!liveRawRootRef.current;
      let nextRoot = liveRawRootRef.current ?? createSyntheticLiveRoot(mount);
      for (const branch of branches) {
        nextRoot = integrateBranchIntoTree(nextRoot, mount, branch);
      }
      liveRawRootRef.current = nextRoot;
      schedulePresentation(!hadRawRoot);
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
      flushTimer = window.setTimeout(flushPending, LIVE_BRANCH_FLUSH_MS);
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
          setLiveJob(parsed.job);
          setLiveSnapshot(parsed.snapshot);
          liveRawRootRef.current = parsed.snapshot.root;
          schedulePresentation(true);
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
      if (presentationTimer !== null) {
        window.clearTimeout(presentationTimer);
      }
      source.removeEventListener("status", handleEvent);
      source.removeEventListener("progress", handleEvent);
      source.removeEventListener("branch", handleEvent);
      source.removeEventListener("snapshot", handleEvent);
      source.close();
    };
  }, [mount, mountStateQueryKey, queryClient, snapshotQueryKey, streamPath]);

  const liveAvailable = !!streamPath || !!liveJob || !!liveRoot || !!liveSnapshot;
  const activeView =
    viewMode === "cached" && cachedSnapshot
      ? "cached"
      : liveAvailable
        ? "live"
        : cachedSnapshot
          ? "cached"
          : ("live" satisfies ViewMode);
  const liveRootForView =
    liveJob?.phase === "queued" || liveJob?.phase === "scanning"
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
    if (activeView === "live" && liveJob) {
      return liveJob.issues;
    }
    return currentSnapshot?.issues ?? cachedSnapshot?.issues ?? [];
  }, [activeView, cachedSnapshot?.issues, currentSnapshot, liveJob]);

  const showViewSwitcher = !!cachedSnapshot && (mountState?.cache.state === "stale" || !!liveJob);
  const generatedAt = currentSnapshot?.generatedAt ?? cachedSnapshot?.generatedAt;
  const totals = currentSnapshot?.totals ?? null;
  const progressPercent = Math.min(
    100,
    liveJob?.progress.directoriesDiscovered
      ? (liveJob.progress.directoriesCompleted / liveJob.progress.directoriesDiscovered) * 100
      : 0
  );
  const cacheStatus =
    mountState?.cache.state === "fresh"
      ? "Fresh"
      : mountState?.cache.state === "stale"
        ? "Stale"
        : "Missing";
  const liveStatus = liveJob
    ? liveJob.phase
    : mountState?.cache.state === "fresh"
      ? "Idle"
      : "Preparing";
  const processedBytes = liveJob?.progress.bytesProcessed ?? totals?.totalBytes ?? 0;

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
          <Button variant="secondary" onClick={() => void navigate({ to: "/settings" })}>
            <ArrowLeft size={14} />
            <span>Back To Settings</span>
          </Button>
        </div>
      </div>

      <div className="page-body disk-analysis-page">
        <div className="disk-analysis-layout">
          <aside className="panel disk-analysis-sidebar">
            {showViewSwitcher ? (
              <div className="disk-analysis-mode-switch">
                <Button
                  variant={activeView === "cached" ? "primary" : "secondary"}
                  onClick={() => setViewMode("cached")}
                >
                  Cached
                </Button>
                <Button
                  variant={activeView === "live" ? "primary" : "secondary"}
                  onClick={() => setViewMode("live")}
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

            {liveJob ? (
              <div className="disk-analysis-progress">
                <div className="disk-analysis-progress__bar">
                  <div
                    className="disk-analysis-progress__fill"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                <div className="disk-analysis-progress__meta">
                  <span>
                    {formatCount(liveJob.progress.directoriesCompleted)} /{" "}
                    {formatCount(liveJob.progress.directoriesDiscovered)} directories
                  </span>
                  <span>{formatCount(liveJob.progress.filesDiscovered)} files</span>
                  <span>{formatBytes(processedBytes)} processed</span>
                </div>
              </div>
            ) : null}

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

            <section className="disk-analysis-sidebar-section">
              <div className="label">Scan Issues</div>
              {issueList.length > 0 ? (
                <div className="disk-analysis-issues__list">
                  {issueList.slice(0, 8).map((issue) => (
                    <div key={`${issue.code}:${issue.path}:${issue.message}`} className="disk-analysis-issue">
                      <div className="disk-analysis-issue__code">{issue.code}</div>
                      <div className="disk-analysis-issue__message">{issue.message}</div>
                      <div className="disk-analysis-issue__path">{issue.path}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="disk-analysis-sidebar-empty">No scan issues reported.</div>
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
                root={currentRoot}
                legendByExtension={legendByExtension}
                onHoverNode={setHoveredPath}
                onOpenNode={openInFiles}
              />
            ) : liveJob ? (
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

function TreemapCanvas({
  root,
  legendByExtension,
  onHoverNode,
  onOpenNode,
}: {
  root: DiskAnalysisTreemapNode;
  legendByExtension: Map<string, DiskAnalysisLegendItem>;
  onHoverNode: (path: string | null) => void;
  onOpenNode: (node: DiskAnalysisTreemapNode) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const nodes = root.children.length > 0 ? root.children : [root];
  const threshold = useMemo<TreemapRenderThreshold>(() => {
    return {
      width: Math.max(
        MIN_RENDER_PERCENT,
        containerSize.width > 0 ? (MIN_NODE_PIXELS / containerSize.width) * 100 : MIN_RENDER_PERCENT
      ),
      height: Math.max(
        MIN_RENDER_PERCENT,
        containerSize.height > 0
          ? (MIN_NODE_PIXELS / containerSize.height) * 100
          : MIN_RENDER_PERCENT
      ),
      canvasWidth: containerSize.width,
      canvasHeight: containerSize.height,
    };
  }, [containerSize.height, containerSize.width]);

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

  return (
    <div ref={containerRef} className="disk-analysis-treemap" role="tree" aria-label="Disk usage treemap">
      {layoutNodes(nodes, { x: 0, y: 0, width: 100, height: 100 }, threshold).map(
        ({ node, rect }) => (
          <TreemapNodeView
            key={node.path}
            node={node}
            rect={rect}
            depth={0}
            legendByExtension={legendByExtension}
            onHoverNode={onHoverNode}
            onOpenNode={onOpenNode}
            threshold={threshold}
          />
        )
      )}
    </div>
  );
}

function TreemapNodeView({
  node,
  rect,
  depth,
  legendByExtension,
  onHoverNode,
  onOpenNode,
  threshold,
}: {
  node: DiskAnalysisTreemapNode;
  rect: TreemapRect;
  depth: number;
  legendByExtension: Map<string, DiskAnalysisLegendItem>;
  onHoverNode: (path: string | null) => void;
  onOpenNode: (node: DiskAnalysisTreemapNode) => void;
  threshold: TreemapRenderThreshold;
}) {
  const hasChildren = node.type === "directory" && node.children.length > 0;
  const nodePixelWidth = (rect.width / 100) * threshold.canvasWidth;
  const nodePixelHeight = (rect.height / 100) * threshold.canvasHeight;
  const showDirectoryLabel =
    node.type === "directory" &&
    nodePixelWidth >= MIN_DIRECTORY_LABEL_PIXELS &&
    nodePixelHeight >= MIN_DIRECTORY_LABEL_PIXELS;
  const stripPercent =
    hasChildren && showDirectoryLabel && nodePixelHeight > 0
      ? Math.min(30, (DIRECTORY_TITLE_STRIP_PX / nodePixelHeight) * 100)
      : 0;
  const nextRect: TreemapRect = {
    x: 0,
    y: stripPercent,
    width: 100,
    height: Math.max(0, 100 - stripPercent),
  };
  const childLayouts =
    hasChildren && nextRect.width > threshold.width && nextRect.height > threshold.height
      ? layoutNodes(node.children, nextRect, threshold)
      : [];
  const color = getNodeColor(node, legendByExtension, depth);

  return (
    <div
      className={`disk-analysis-node disk-analysis-node--${node.type}`}
      style={{
        left: `${rect.x}%`,
        top: `${rect.y}%`,
        width: `${rect.width}%`,
        height: `${rect.height}%`,
      }}
    >
      <div
        role="button"
        tabIndex={0}
        className="disk-analysis-node__surface"
        aria-label={`${node.name} ${getNodeDisplayType(node)} ${formatBytes(node.recursiveSize)}`}
        style={{
          background: color.background,
          borderColor: color.border,
          color: color.text,
        }}
        onMouseEnter={() => onHoverNode(node.path)}
        onMouseLeave={() => onHoverNode(null)}
        onFocus={() => onHoverNode(node.path)}
        onBlur={() => onHoverNode(null)}
        onDoubleClick={() => onOpenNode(node)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpenNode(node);
          }
        }}
      >
        {node.type === "directory" && showDirectoryLabel ? (
          <div className="disk-analysis-node__strip">
            <span className="disk-analysis-node__title">{node.name}</span>
          </div>
        ) : (
          <div className="disk-analysis-node__hover-label">
            <span>{node.name}</span>
            <span>{formatBytes(node.recursiveSize)}</span>
          </div>
        )}
        {node.truncated || node.issues.length > 0 ? (
          <div className="disk-analysis-node__flag">
            {node.truncated ? "Partial" : `${node.issues.length} issue(s)`}
          </div>
        ) : null}
      </div>

      {childLayouts.map(({ node: child, rect: childRect }) => (
        <TreemapNodeView
          key={child.path}
          node={child}
          rect={childRect}
          depth={depth + 1}
          legendByExtension={legendByExtension}
          onHoverNode={onHoverNode}
          onOpenNode={onOpenNode}
          threshold={threshold}
        />
      ))}
    </div>
  );
}

function layoutNodes(
  nodes: DiskAnalysisTreemapNode[],
  rect: TreemapRect,
  threshold: TreemapRenderThreshold
): Array<{ node: DiskAnalysisTreemapNode; rect: TreemapRect }> {
  const filtered = nodes
    .filter((node) => node.recursiveSize > 0)
    .slice()
    .sort((left, right) => right.recursiveSize - left.recursiveSize);
  const total = filtered.reduce((sum, node) => sum + Math.max(node.recursiveSize, 1), 0);
  const totalArea = rect.width * rect.height;
  if (total <= 0 || totalArea <= 0) {
    return [];
  }

  type WeightedNode = { node: DiskAnalysisTreemapNode; area: number };
  const weighted = filtered.map((node) => ({
    node,
    area: (Math.max(node.recursiveSize, 1) / total) * totalArea,
  }));
  const layouts: Array<{ node: DiskAnalysisTreemapNode; rect: TreemapRect }> = [];
  let remainingRect = { ...rect };
  let row: WeightedNode[] = [];
  let remaining = [...weighted];

  const shortSide = (value: TreemapRect) => Math.max(Math.min(value.width, value.height), 0.0001);
  const sumArea = (items: WeightedNode[]) => items.reduce((sum, item) => sum + item.area, 0);
  const worstAspectRatio = (items: WeightedNode[], side: number) => {
    if (items.length === 0) {
      return Number.POSITIVE_INFINITY;
    }
    const totalRowArea = sumArea(items);
    if (totalRowArea <= 0) {
      return Number.POSITIVE_INFINITY;
    }
    const maxArea = Math.max(...items.map((item) => item.area));
    const minArea = Math.min(...items.map((item) => item.area));
    const sideSquared = side * side;
    return Math.max(
      sideSquared * maxArea / (totalRowArea * totalRowArea),
      (totalRowArea * totalRowArea) / (sideSquared * Math.max(minArea, 0.0001))
    );
  };

  const pushRow = (items: WeightedNode[]) => {
    if (items.length === 0) {
      return;
    }
    const rowArea = sumArea(items);
    const horizontalSplit = remainingRect.width >= remainingRect.height;
    if (horizontalSplit) {
      const rowHeight = rowArea / Math.max(remainingRect.width, 0.0001);
      let cursorX = remainingRect.x;
      for (const item of items) {
        const itemWidth = item.area / Math.max(rowHeight, 0.0001);
        layouts.push({
          node: item.node,
          rect: {
            x: cursorX,
            y: remainingRect.y,
            width: itemWidth,
            height: rowHeight,
          },
        });
        cursorX += itemWidth;
      }
      remainingRect = {
        x: remainingRect.x,
        y: remainingRect.y + rowHeight,
        width: remainingRect.width,
        height: Math.max(0, remainingRect.height - rowHeight),
      };
      return;
    }

    const columnWidth = rowArea / Math.max(remainingRect.height, 0.0001);
    let cursorY = remainingRect.y;
    for (const item of items) {
      const itemHeight = item.area / Math.max(columnWidth, 0.0001);
      layouts.push({
        node: item.node,
        rect: {
          x: remainingRect.x,
          y: cursorY,
          width: columnWidth,
          height: itemHeight,
        },
      });
      cursorY += itemHeight;
    }
    remainingRect = {
      x: remainingRect.x + columnWidth,
      y: remainingRect.y,
      width: Math.max(0, remainingRect.width - columnWidth),
      height: remainingRect.height,
    };
  };

  while (remaining.length > 0) {
    const next = remaining[0];
    const currentRow = [...row, next];
    if (
      row.length === 0 ||
      worstAspectRatio(currentRow, shortSide(remainingRect)) <=
        worstAspectRatio(row, shortSide(remainingRect))
    ) {
      row = currentRow;
      remaining.shift();
      continue;
    }
    pushRow(row);
    row = [];
  }
  pushRow(row);

  return layouts.filter(
    (item) => item.rect.width >= threshold.width && item.rect.height >= threshold.height
  );
}

function getNodeColor(
  node: DiskAnalysisTreemapNode,
  legendByExtension: Map<string, DiskAnalysisLegendItem>,
  depth: number
) {
  if (node.type === "file") {
    const legendItem = node.extension ? legendByExtension.get(node.extension) : undefined;
    const base = legendItem ? getLegendColor(legendItem.colorToken) : "#5f6877";
    return {
      background: base,
      border: legendItem ? base : "rgba(122, 132, 155, 0.55)",
      text: "var(--text-primary)",
    };
  }
  const tint = Math.max(34, 74 - depth * 8);
  return {
    background: `rgb(${tint}, ${tint}, ${tint})`,
    border: "rgba(255, 255, 255, 0.16)",
    text: "var(--text-primary)",
  };
}
