import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeftRight, FolderSearch, RefreshCcw } from "lucide-react";
import { Button } from "../components/ui/Button";
import { useToastStore } from "../stores/toast";
import { emitUnauthorizedEvent, fetchAuthStatus } from "../lib/auth";
import {
  collectIssues,
  createSyntheticLiveRoot,
  deriveLegendFromSnapshot,
  deriveLegendFromTree,
  flattenVisibleNodes,
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

const MIN_RENDER_PERCENT = 2.8;

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

  useEffect(() => {
    setLiveRoot(null);
    setLiveSnapshot(null);
    setLiveJob(null);
    setStreamPath(null);
    setStreamError(null);
    setHoveredPath(null);
    requestedStreamKeyRef.current = null;
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
    const source = new EventSource(streamPath);

    const handleEvent = (event: Event) => {
      if (disposed) {
        return;
      }
      try {
        const messageEvent = event as MessageEvent<string>;
        const parsed = DiskAnalysisScanEventSchema.parse(JSON.parse(messageEvent.data));
        if (parsed.event === "status" || parsed.event === "progress") {
          setLiveJob(parsed.job);
          if (
            parsed.job.phase === "completed" ||
            parsed.job.phase === "partial" ||
            parsed.job.phase === "failed" ||
            parsed.job.phase === "cancelled"
          ) {
            setStreamPath(null);
          }
          return;
        }
        if (parsed.event === "branch") {
          setLiveRoot((current) =>
            integrateBranchIntoTree(
              current ?? createSyntheticLiveRoot(mount),
              mount,
              parsed.branch
            )
          );
          return;
        }
        if (parsed.event === "snapshot") {
          setLiveJob(parsed.job);
          setLiveSnapshot(parsed.snapshot);
          setLiveRoot(parsed.snapshot.root);
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
      source.removeEventListener("status", handleEvent);
      source.removeEventListener("progress", handleEvent);
      source.removeEventListener("branch", handleEvent);
      source.removeEventListener("snapshot", handleEvent);
      source.close();
    };
  }, [mount, mountStateQueryKey, queryClient, snapshotQueryKey, streamPath]);

  const liveRootOrSnapshot = liveSnapshot?.root ?? liveRoot;
  const liveAvailable = !!streamPath || !!liveJob || !!liveRootOrSnapshot;
  const activeView =
    viewMode === "cached" && cachedSnapshot
      ? "cached"
      : liveAvailable
        ? "live"
        : cachedSnapshot
          ? "cached"
          : ("live" satisfies ViewMode);
  const currentRoot =
    activeView === "cached" ? cachedSnapshot?.root ?? null : liveRootOrSnapshot;
  const currentSnapshot = activeView === "cached" ? cachedSnapshot : liveSnapshot;
  const legend =
    activeView === "cached"
      ? deriveLegendFromSnapshot(cachedSnapshot)
      : currentSnapshot
        ? deriveLegendFromSnapshot(currentSnapshot)
        : deriveLegendFromTree(currentRoot);
  const legendByExtension = useMemo(
    () => new Map(legend.map((item) => [item.extension, item])),
    [legend]
  );
  const visibleNodes = useMemo(() => flattenVisibleNodes(currentRoot), [currentRoot]);
  const hoveredNode =
    visibleNodes.find((node) => node.path === hoveredPath) ??
    currentRoot ??
    cachedSnapshot?.root ??
    null;
  const issueList = useMemo(() => {
    const currentIssues = currentSnapshot?.issues ?? [];
    const treeIssues = collectIssues(currentRoot);
    const deduped = new Map<string, (typeof currentIssues)[number]>();
    for (const issue of [...currentIssues, ...treeIssues]) {
      const key = `${issue.code}:${issue.path}:${issue.message}`;
      if (!deduped.has(key)) {
        deduped.set(key, issue);
      }
    }
    return [...deduped.values()];
  }, [currentRoot, currentSnapshot]);

  const showViewSwitcher = !!cachedSnapshot && (mountState?.cache.state === "stale" || !!liveJob);
  const generatedAt = currentSnapshot?.generatedAt ?? cachedSnapshot?.generatedAt;
  const totals = currentSnapshot?.totals ?? null;

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
        <div className="disk-analysis-header">
          <div className="disk-analysis-header__eyebrow">Storage Analysis</div>
          <h1 className="page-title">{getMountLabel(mount.mount)}</h1>
          <div className="disk-analysis-header__path">{mount.mount}</div>
        </div>
        <div className="disk-analysis-header__actions">
          <Button variant="secondary" onClick={() => void navigate({ to: "/settings" })}>
            <RefreshCcw size={14} />
            <span>Back To Settings</span>
          </Button>
          <Button
            variant="secondary"
            onClick={() => void navigate({ to: "/files", search: { path: mount.mount } })}
          >
            <FolderSearch size={14} />
            <span>Open Mount In Files</span>
          </Button>
        </div>
      </div>

      <div className="page-body disk-analysis-page">
        <section className="panel disk-analysis-summary">
          <div className="disk-analysis-summary__head">
            <div className="label">Mount Status</div>
            {showViewSwitcher ? (
              <div className="disk-analysis-mode-switch">
                <Button
                  variant={activeView === "cached" ? "primary" : "secondary"}
                  onClick={() => setViewMode("cached")}
                >
                  Cached Snapshot
                </Button>
                <Button
                  variant={activeView === "live" ? "primary" : "secondary"}
                  onClick={() => setViewMode("live")}
                  disabled={!liveAvailable}
                >
                  Live Refresh
                </Button>
              </div>
            ) : null}
          </div>

          <div className="disk-analysis-summary__status">
            <StatusPill
              tone={
                mountState?.cache.state === "fresh"
                  ? "good"
                  : mountState?.cache.state === "stale"
                    ? "warn"
                    : "neutral"
              }
            >
              {mountState?.cache.state === "fresh"
                ? "Fresh cache"
                : mountState?.cache.state === "stale"
                  ? "Stale cache"
                  : "No cache"}
            </StatusPill>
            <StatusPill
              tone={
                liveJob?.phase === "completed"
                  ? "good"
                  : liveJob?.phase === "failed" || liveJob?.phase === "cancelled"
                    ? "bad"
                    : liveJob
                      ? "info"
                      : "neutral"
              }
            >
              {liveJob
                ? `Live job: ${liveJob.phase}`
                : mountState?.cache.state === "fresh"
                  ? "No live scan running"
                  : "Preparing live scan"}
            </StatusPill>
            <StatusPill tone={activeView === "cached" ? "neutral" : "info"}>
              {activeView === "cached" ? "Viewing cached snapshot" : "Viewing live result"}
            </StatusPill>
            {streamError ? <StatusPill tone="bad">{streamError}</StatusPill> : null}
          </div>

          <div className="disk-analysis-summary__grid">
            <SummaryStat label="Filesystem" value={mount.fs} />
            <SummaryStat label="Generated" value={formatRelativeGeneratedAt(generatedAt)} />
            <SummaryStat
              label="Visible Size"
              value={formatBytes(currentRoot?.recursiveSize ?? totals?.totalBytes ?? 0)}
            />
            <SummaryStat
              label="Files"
              value={formatCount(
                totals?.totalFiles ?? visibleNodes.filter((node) => node.type === "file").length
              )}
            />
            <SummaryStat
              label="Folders"
              value={formatCount(
                totals?.totalDirectories ??
                  visibleNodes.filter((node) => node.type === "directory").length
              )}
            />
            <SummaryStat label="Issues" value={formatCount(issueList.length)} />
          </div>

          {liveJob ? (
            <div className="disk-analysis-progress">
              <div className="disk-analysis-progress__bar">
                <div
                  className="disk-analysis-progress__fill"
                  style={{
                    width: `${Math.min(
                      100,
                      liveJob.progress.directoriesDiscovered > 0
                        ? (liveJob.progress.directoriesCompleted /
                            liveJob.progress.directoriesDiscovered) *
                            100
                        : 4
                    )}%`,
                  }}
                />
              </div>
              <div className="disk-analysis-progress__meta">
                <span>
                  {formatCount(liveJob.progress.directoriesCompleted)} /{" "}
                  {formatCount(liveJob.progress.directoriesDiscovered)} directories
                </span>
                <span>{formatCount(liveJob.progress.filesDiscovered)} files</span>
                <span>{formatBytes(liveJob.progress.bytesProcessed)} processed</span>
              </div>
            </div>
          ) : null}
        </section>

        <div className="disk-analysis-layout">
          <section className="panel disk-analysis-treemap-panel">
            <div className="disk-analysis-panel-head">
              <div>
                <div className="label">Treemap</div>
                <div className="disk-analysis-panel-subtitle">
                  Double-click a block to open it in Files. File names appear on hover.
                </div>
              </div>
              <div className="disk-analysis-panel-hint">
                <ArrowLeftRight size={14} />
                <span>{showViewSwitcher ? "Switch cached/live above" : "Live updates appear here"}</span>
              </div>
            </div>

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

          <aside className="disk-analysis-sidebar">
            <section className="panel disk-analysis-details">
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
                  <DetailRow
                    label="Scan Notes"
                    value={
                      hoveredNode.truncated
                        ? "Partial branch"
                        : hoveredNode.issues.length > 0
                          ? `${hoveredNode.issues.length} issue(s)`
                          : "Complete"
                    }
                  />
                </div>
              ) : (
                <div className="disk-analysis-empty__body">
                  Hover or focus a treemap block to inspect its path, size, and scan status.
                </div>
              )}
            </section>

            <section className="panel disk-analysis-legend">
              <div className="label">Extension Legend</div>
              {legend.length > 0 ? (
                <div className="disk-analysis-legend__list">
                  {legend.map((item) => (
                    <LegendRow key={item.extension} item={item} />
                  ))}
                </div>
              ) : (
                <div className="disk-analysis-empty__body">
                  Extension colors appear after file types are discovered.
                </div>
              )}
            </section>

            <section className="panel disk-analysis-issues">
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
                <div className="disk-analysis-empty__body">
                  No permission or traversal issues are currently reported.
                </div>
              )}
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="disk-analysis-stat">
      <span className="disk-analysis-stat__label">{label}</span>
      <span className="disk-analysis-stat__value">{value}</span>
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
      <span className="disk-analysis-legend__count">{formatCount(item.count)}</span>
    </div>
  );
}

function StatusPill({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "good" | "warn" | "bad" | "info" | "neutral";
}) {
  return <span className={`disk-analysis-pill disk-analysis-pill--${tone}`}>{children}</span>;
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
  const nodes = root.children.length > 0 ? root.children : [root];

  return (
    <div className="disk-analysis-treemap" role="tree" aria-label="Disk usage treemap">
      {layoutNodes(nodes, { x: 0, y: 0, width: 100, height: 100 }, true).map(
        ({ node, rect, vertical }) => (
          <TreemapNodeView
            key={node.path}
            node={node}
            rect={rect}
            depth={0}
            vertical={vertical}
            legendByExtension={legendByExtension}
            onHoverNode={onHoverNode}
            onOpenNode={onOpenNode}
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
  vertical,
  legendByExtension,
  onHoverNode,
  onOpenNode,
}: {
  node: DiskAnalysisTreemapNode;
  rect: TreemapRect;
  depth: number;
  vertical: boolean;
  legendByExtension: Map<string, DiskAnalysisLegendItem>;
  onHoverNode: (path: string | null) => void;
  onOpenNode: (node: DiskAnalysisTreemapNode) => void;
}) {
  const hasChildren = node.type === "directory" && node.children.length > 0;
  const stripPercent =
    hasChildren && rect.height > 10 ? Math.min(24, Math.max(10, rect.height * 0.16)) : 0;
  const nextRect: TreemapRect = {
    x: 0,
    y: stripPercent,
    width: 100,
    height: Math.max(0, 100 - stripPercent),
  };
  const childLayouts =
    hasChildren && nextRect.width > MIN_RENDER_PERCENT && nextRect.height > MIN_RENDER_PERCENT
      ? layoutNodes(node.children, nextRect, !vertical)
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
        {node.type === "directory" ? (
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

      {childLayouts.map(({ node: child, rect: childRect, vertical: childVertical }) => (
        <TreemapNodeView
          key={child.path}
          node={child}
          rect={childRect}
          depth={depth + 1}
          vertical={childVertical}
          legendByExtension={legendByExtension}
          onHoverNode={onHoverNode}
          onOpenNode={onOpenNode}
        />
      ))}
    </div>
  );
}

function layoutNodes(
  nodes: DiskAnalysisTreemapNode[],
  rect: TreemapRect,
  vertical: boolean
): Array<{ node: DiskAnalysisTreemapNode; rect: TreemapRect; vertical: boolean }> {
  const total = nodes.reduce((sum, node) => sum + Math.max(node.recursiveSize, 1), 0);
  let cursor = 0;

  return nodes
    .filter((node) => node.recursiveSize > 0)
    .map((node, index, filtered) => {
      const ratio = Math.max(node.recursiveSize, 1) / total;
      const remaining = vertical ? rect.width - cursor : rect.height - cursor;
      const span =
        index === filtered.length - 1
          ? remaining
          : Math.max(0, (vertical ? rect.width : rect.height) * ratio);
      const nodeRect: TreemapRect = vertical
        ? {
            x: rect.x + cursor,
            y: rect.y,
            width: span,
            height: rect.height,
          }
        : {
            x: rect.x,
            y: rect.y + cursor,
            width: rect.width,
            height: span,
          };
      cursor += span;
      return {
        node,
        rect: nodeRect,
        vertical,
      };
    })
    .filter(
      (item) =>
        item.rect.width >= MIN_RENDER_PERCENT && item.rect.height >= MIN_RENDER_PERCENT
    );
}

function getNodeColor(
  node: DiskAnalysisTreemapNode,
  legendByExtension: Map<string, DiskAnalysisLegendItem>,
  depth: number
) {
  if (node.type === "file") {
    const legendItem = node.extension ? legendByExtension.get(node.extension) : undefined;
    const base = legendItem ? getLegendColor(legendItem.colorToken) : "rgba(122, 132, 155, 0.5)";
    return {
      background: `linear-gradient(180deg, ${base} 0%, rgba(10, 10, 10, 0.26) 100%)`,
      border: legendItem ? base : "rgba(122, 132, 155, 0.55)",
      text: "var(--text-primary)",
    };
  }
  const tint = Math.max(0.16, 0.34 - depth * 0.035);
  return {
    background: `linear-gradient(180deg, rgba(255, 255, 255, ${tint}) 0%, rgba(0, 0, 0, 0.18) 100%)`,
    border: "rgba(255, 255, 255, 0.16)",
    text: "var(--text-primary)",
  };
}
