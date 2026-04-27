import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useRef, useState, useEffect } from "react";
import { hierarchy, treemap, treemapSquarify } from "d3-hierarchy";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Database,
  HardDrive,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { useTRPC, trpcClient } from "../trpc";
import { Button } from "../components/ui/Button";
import { useToastStore } from "../stores/toast";
import {
  formatRelativeFreshness,
  formatStorageBytes,
  formatStorageTimestamp,
} from "../lib/storageAnalysis";

export const Route = createFileRoute("/storage/$mountId")({
  validateSearch: (search: Record<string, unknown>) => ({
    mount: typeof search.mount === "string" ? search.mount : "",
    fs: typeof search.fs === "string" ? search.fs : "",
  }),
  component: StorageAnalysisPage,
});

type StorageSearch = {
  mount: string;
  fs: string;
};

type StorageMount = {
  id: string;
  mount: string;
  fs: string;
  filesystemType: string;
  size: number;
  used: number;
  deviceId: number | null;
};

type StorageExtensionEntry = {
  extension: string;
  label: string;
  count: number;
  totalSize: number;
  color: string;
};

type StorageNode = {
  path: string;
  name: string;
  type: "directory" | "file" | "symlink" | "other";
  size: number;
  extension: string | null;
  childCount: number;
  children: StorageNode[];
};

type StorageAnalysisView = {
  mount: StorageMount;
  status: "scanning" | "ready" | "stale" | "failed";
  analyzer: "scan" | null;
  sourceKind: "cache-fresh" | "cache-stale" | "scan" | "pending" | null;
  jobId: string | null;
  mountKey: string;
  generatedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  freshnessTtlMs: number;
  totalSize: number | null;
  nodeCount: number | null;
  isPartial: boolean;
  oversized: boolean;
  extensionHistogram: StorageExtensionEntry[];
  root: StorageNode | null;
  refreshing: boolean;
  errorCode: string | null;
  error: string | null;
  warningCode: string | null;
  warning: string | null;
};

type StorageStreamEvent =
  | {
      type: "started";
      job: {
        jobId: string;
        mountKey: string;
        startedAt: string;
        status: "scanning" | "ready" | "failed";
      };
      mount: StorageMount;
    }
  | {
      type: "node";
      node: {
        parentPath: string | null;
        path: string;
        name: string;
        type: "directory" | "file" | "symlink" | "other";
        size: number;
        extension: string | null;
      };
      totalSize: number;
      nodeCount: number;
    }
  | {
      type: "progress";
      totalSize: number;
      nodeCount: number;
      warningCode: string | null;
      warning: string | null;
      extensionHistogram: StorageExtensionEntry[];
    }
  | {
      type: "done";
      completedAt: string;
      totalSize: number;
      nodeCount: number;
      warningCode: string | null;
      warning: string | null;
    }
  | {
      type: "failed";
      errorCode: string;
      error: string;
    };

type LiveNodeRecord = {
  path: string;
  parentPath: string | null;
  name: string;
  type: "directory" | "file" | "symlink" | "other";
  size: number;
  extension: string | null;
  children: Set<string>;
};

function readStorageSearch(): StorageSearch {
  if (typeof window === "undefined") {
    return { mount: "", fs: "" };
  }
  const params = new URLSearchParams(window.location.search);
  return {
    mount: params.get("mount") ?? "",
    fs: params.get("fs") ?? "",
  };
}

function materializeTree(
  rootPath: string | null,
  nodes: Map<string, LiveNodeRecord>
): StorageNode | null {
  if (!rootPath) {
    return null;
  }
  const build = (path: string): StorageNode | null => {
    const record = nodes.get(path);
    if (!record) {
      return null;
    }
    const children = [...record.children]
      .map((childPath) => build(childPath))
      .filter((child): child is StorageNode => child !== null)
      .sort((left, right) => right.size - left.size || left.name.localeCompare(right.name));
    return {
      path: record.path,
      name: record.name,
      type: record.type,
      size: record.size,
      extension: record.extension,
      childCount: children.length,
      children,
    };
  };
  return build(rootPath);
}

function getNodeColor(
  node: {
    type: "directory" | "file" | "symlink" | "other";
    extension: string | null;
  },
  extensionColors: Map<string, string>
) {
  if (node.type === "directory") {
    return "rgba(76, 96, 122, 0.42)";
  }
  return extensionColors.get(node.extension ?? "") ?? "rgba(128, 139, 150, 0.45)";
}

function getFailureCopy(errorCode: string | null | undefined, error: string | null | undefined) {
  switch (errorCode) {
    case "permission-denied":
      return {
        title: "Permission Required",
        description:
          error ?? "DeckOS does not currently have permission to inspect this mount.",
      };
    case "unsupported":
      return {
        title: "Mount Not Supported",
        description:
          error ?? "DeckOS could not resolve this mount safely enough to analyze it.",
      };
    default:
      return {
        title: "Analysis Failed",
        description: error ?? "Storage analysis failed unexpectedly.",
      };
  }
}

function StorageAnalysisPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { addToast } = useToastStore();
  const search = useMemo(() => readStorageSearch(), []);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 1024, height: 640 });
  const [liveAnalysis, setLiveAnalysis] = useState<StorageAnalysisView | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const liveNodesRef = useRef<Map<string, LiveNodeRecord>>(new Map());
  const liveRootPathRef = useRef<string | null>(null);
  const liveJobIdRef = useRef<string | null>(null);
  const lastEventIdRef = useRef<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const liveAnalysisRef = useRef<StorageAnalysisView | null>(null);
  const snapshotAnalysisRef = useRef<StorageAnalysisView | undefined>(undefined);
  const autoStartLockRef = useRef<{ key: string | null; inFlight: boolean; settled: boolean }>({
    key: null,
    inFlight: false,
    settled: false,
  });

  useEffect(() => {
    const update = () => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      setCanvasSize({
        width: Math.max(320, Math.floor(rect.width)),
        height: Math.max(360, Math.floor(rect.height)),
      });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const analysisQuery = useQuery(
    trpc.storage.getAnalysis.queryOptions(
      { mount: search.mount, fs: search.fs },
      {
        enabled: Boolean(search.mount && search.fs),
        refetchInterval: 2000,
      }
    )
  );

  const startMutation = useMutation({
    mutationFn: async (force = false) =>
      await trpcClient.storage.startAnalysis.mutate({
        mount: search.mount,
        fs: search.fs,
        force,
      }),
    onSuccess: (result) => {
      liveNodesRef.current = new Map();
      liveRootPathRef.current = null;
      liveJobIdRef.current = result.job.jobId;
      lastEventIdRef.current = null;
      setActiveJobId(result.job.jobId);
      closeStream();
    },
    onError: (error: unknown) => {
      addToast(error instanceof Error ? error.message : "Failed to start storage analysis", "error");
    },
  });

  const resetLiveState = () => {
    liveNodesRef.current = new Map();
    liveRootPathRef.current = null;
    liveJobIdRef.current = null;
    lastEventIdRef.current = null;
    autoStartLockRef.current = {
      key: null,
      inFlight: false,
      settled: false,
    };
    setActiveJobId(null);
    setLiveAnalysis(null);
  };

  const closeStream = () => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  };

  const applyNodePatch = (event: Extract<StorageStreamEvent, { type: "node" }>) => {
    const { node } = event;
    const existing = liveNodesRef.current.get(node.path);
    const record: LiveNodeRecord = existing ?? {
      path: node.path,
      parentPath: node.parentPath,
      name: node.name,
      type: node.type,
      size: node.size,
      extension: node.extension,
      children: new Set<string>(),
    };
    record.parentPath = node.parentPath;
    record.name = node.name;
    record.type = node.type;
    record.size = node.size;
    record.extension = node.extension;
    liveNodesRef.current.set(node.path, record);
    if (node.parentPath) {
      const parent =
        liveNodesRef.current.get(node.parentPath) ??
        ({
          path: node.parentPath,
          parentPath: null,
          name: node.parentPath,
          type: "directory",
          size: 0,
          extension: null,
          children: new Set<string>(),
        } satisfies LiveNodeRecord);
      parent.children.add(node.path);
      liveNodesRef.current.set(node.parentPath, parent);
    } else {
      liveRootPathRef.current = node.path;
    }
  };

  const syncLiveTree = (
    base: StorageAnalysisView | null,
    patch: Pick<
      StorageAnalysisView,
      | "status"
      | "startedAt"
      | "completedAt"
      | "totalSize"
      | "nodeCount"
      | "extensionHistogram"
      | "warningCode"
      | "warning"
      | "errorCode"
      | "error"
      | "refreshing"
      | "sourceKind"
      | "isPartial"
    >
  ) => {
    const root = materializeTree(liveRootPathRef.current, liveNodesRef.current);
    const fallbackMount =
      base?.mount ??
      ({
        id: "",
        mount: search.mount,
        fs: search.fs,
        filesystemType: "unknown",
        size: 0,
        used: 0,
        deviceId: null,
      } satisfies StorageMount);
    setLiveAnalysis({
      mount: fallbackMount,
      status: patch.status,
      analyzer: "scan",
      sourceKind: patch.sourceKind,
      jobId: activeJobId,
      mountKey: base?.mountKey ?? liveJobIdRef.current ?? "",
      generatedAt: patch.completedAt,
      startedAt: patch.startedAt,
      completedAt: patch.completedAt,
      freshnessTtlMs: base?.freshnessTtlMs ?? 300000,
      totalSize: patch.totalSize,
      nodeCount: patch.nodeCount,
      isPartial: patch.isPartial,
      oversized: base?.oversized ?? false,
      extensionHistogram: patch.extensionHistogram,
      root,
      refreshing: patch.refreshing,
      errorCode: patch.errorCode,
      error: patch.error,
      warningCode: patch.warningCode,
      warning: patch.warning,
    });
  };

  useEffect(() => {
    resetLiveState();
  }, [search.fs, search.mount]);

  useEffect(() => {
    return () => {
      closeStream();
    };
  }, []);

  const analysis = liveAnalysis ?? (analysisQuery.data as StorageAnalysisView | undefined);

  useEffect(() => {
    liveAnalysisRef.current = liveAnalysis;
  }, [liveAnalysis]);

  useEffect(() => {
    snapshotAnalysisRef.current = analysisQuery.data as StorageAnalysisView | undefined;
  }, [analysisQuery.data]);

  useEffect(() => {
    if (!search.mount || !search.fs) {
      return;
    }
    const autoStartKey = `${search.mount}::${search.fs}`;
    const queryAnalysis = analysisQuery.data as StorageAnalysisView | undefined;
    if (activeJobId || queryAnalysis?.jobId) {
      return;
    }
    const shouldAutoStart = !queryAnalysis || queryAnalysis.status === "scanning";
    const lock = autoStartLockRef.current;
    if (
      !shouldAutoStart ||
      startMutation.isPending ||
      (lock.key === autoStartKey && (lock.inFlight || lock.settled))
    ) {
      return;
    }
    autoStartLockRef.current = {
      key: autoStartKey,
      inFlight: true,
      settled: false,
    };
    void startMutation
      .mutateAsync(false)
      .then(() => {
        autoStartLockRef.current = {
          key: autoStartKey,
          inFlight: false,
          settled: true,
        };
      })
      .catch(() => {
        autoStartLockRef.current = {
          key: autoStartKey,
          inFlight: false,
          settled: false,
        };
      });
  }, [activeJobId, analysisQuery.data, search.fs, search.mount, startMutation.isPending]);

  useEffect(() => {
    const queryAnalysis = analysisQuery.data as StorageAnalysisView | undefined;
    if (activeJobId || !queryAnalysis?.jobId) {
      return;
    }
    autoStartLockRef.current = {
      key: `${search.mount}::${search.fs}`,
      inFlight: false,
      settled: true,
    };
    liveJobIdRef.current = queryAnalysis.jobId;
    setActiveJobId(queryAnalysis.jobId);
  }, [activeJobId, analysisQuery.data, search.fs, search.mount]);

  useEffect(() => {
    const jobId = activeJobId;
    const streamUrl = jobId
      ? `/api/storage/analysis/${encodeURIComponent(jobId)}/events${
          lastEventIdRef.current ? `?after=${encodeURIComponent(lastEventIdRef.current)}` : ""
        }`
      : null;
    if (!jobId || !streamUrl || eventSourceRef.current?.url === streamUrl) {
      return;
    }
    closeStream();
    const source = new EventSource(streamUrl);
    eventSourceRef.current = source;

    source.addEventListener("storage-analysis", (rawEvent) => {
      const event = JSON.parse((rawEvent as MessageEvent<string>).data) as StorageStreamEvent;
      const eventId = (rawEvent as MessageEvent<string>).lastEventId;
      if (eventId) {
        lastEventIdRef.current = eventId;
      }

      if (event.type === "started") {
        liveJobIdRef.current = event.job.jobId;
        setLiveAnalysis((current) => ({
          mount: event.mount,
          status: "scanning",
          analyzer: "scan",
          sourceKind: "scan",
          jobId: event.job.jobId,
          mountKey: event.job.mountKey,
          generatedAt: null,
          startedAt: event.job.startedAt,
          completedAt: null,
          freshnessTtlMs: current?.freshnessTtlMs ?? 300000,
          totalSize: current?.totalSize ?? 0,
          nodeCount: current?.nodeCount ?? 0,
          isPartial: true,
          oversized: current?.oversized ?? false,
          extensionHistogram: current?.extensionHistogram ?? [],
          root: current?.root ?? null,
          refreshing: true,
          errorCode: null,
          error: null,
          warningCode: current?.warningCode ?? null,
          warning: current?.warning ?? null,
        }));
        return;
      }

      if (event.type === "node") {
        applyNodePatch(event);
        return;
      }

      if (event.type === "progress") {
        syncLiveTree(liveAnalysisRef.current, {
          status: "scanning",
          startedAt: liveAnalysisRef.current?.startedAt ?? startMutation.data?.job.startedAt ?? null,
          completedAt: null,
          totalSize: event.totalSize,
          nodeCount: event.nodeCount,
          extensionHistogram: event.extensionHistogram,
          warningCode: event.warningCode,
          warning: event.warning,
          errorCode: null,
          error: null,
          refreshing: true,
          sourceKind: "scan",
          isPartial: true,
        });
        return;
      }

      if (event.type === "done") {
        syncLiveTree(liveAnalysisRef.current, {
          status: "ready",
          startedAt: liveAnalysisRef.current?.startedAt ?? startMutation.data?.job.startedAt ?? null,
          completedAt: event.completedAt,
          totalSize: event.totalSize,
          nodeCount: event.nodeCount,
          extensionHistogram: liveAnalysisRef.current?.extensionHistogram ?? [],
          warningCode: event.warningCode,
          warning: event.warning,
          errorCode: null,
          error: null,
          refreshing: false,
          sourceKind: "scan",
          isPartial: false,
        });
        closeStream();
        liveJobIdRef.current = null;
        setActiveJobId(null);
        void queryClient.invalidateQueries({
          queryKey: trpc.storage.getAnalysis.queryOptions({
            mount: search.mount,
            fs: search.fs,
          }).queryKey,
        });
        return;
      }

      setLiveAnalysis((current) => ({
        ...(current ?? {
          mount:
            snapshotAnalysisRef.current?.mount ?? {
              id: "",
              mount: search.mount,
              fs: search.fs,
              filesystemType: "unknown",
              size: 0,
              used: 0,
              deviceId: null,
            },
          analyzer: null,
          sourceKind: "pending",
          jobId: activeJobId,
          mountKey: liveJobIdRef.current ?? "",
          generatedAt: null,
          startedAt: startMutation.data?.job.startedAt ?? null,
          completedAt: null,
          freshnessTtlMs: 300000,
          totalSize: null,
          nodeCount: null,
          isPartial: false,
          oversized: false,
          extensionHistogram: [],
          root: null,
          refreshing: false,
          warningCode: null,
          warning: null,
        }),
        status: "failed",
        errorCode: event.errorCode,
        error: event.error,
        refreshing: false,
      }));
      closeStream();
      liveJobIdRef.current = null;
      setActiveJobId(null);
    });

    source.addEventListener("keepalive", () => {});
    source.onerror = () => {};

    return () => {
      if (eventSourceRef.current === source) {
        closeStream();
      }
    };
  }, [
    activeJobId,
    queryClient,
    search.fs,
    search.mount,
    startMutation.data,
    trpc.storage,
  ]);
  const extensionColors = useMemo(
    () =>
      new Map((analysis?.extensionHistogram ?? []).map((entry) => [entry.extension, entry.color])),
    [analysis?.extensionHistogram]
  );

  const treeLayout = useMemo(() => {
    if (!analysis?.root) {
      return null;
    }
    const root = hierarchy(analysis.root)
      .sum((node) => Math.max(node.size, 0))
      .sort((left, right) => right.value! - left.value!);
    return treemap<typeof analysis.root>()
      .tile(treemapSquarify)
      .size([canvasSize.width, canvasSize.height])
      .paddingInner(1)
      .paddingOuter(0)
      .paddingTop((node) => (node.depth > 0 && node.data.type === "directory" ? 18 : 0))(root);
  }, [analysis?.root, canvasSize.height, canvasSize.width]);

  const layoutNodes = useMemo(() => {
    if (!treeLayout) {
      return [];
    }
    return treeLayout
      .descendants()
      .slice(1)
      .sort((left, right) => left.depth - right.depth);
  }, [treeLayout]);

  const selectedNode =
    analysis?.root && selectedPath
      ? layoutNodes.find((node) => node.data.path === selectedPath)?.data ?? null
      : null;

  const handleOpenInFiles = (target: {
    path: string;
    type: "directory" | "file" | "symlink" | "other";
  }) => {
    if (target.type === "directory") {
      const url = new URL(window.location.origin + "/files");
      url.searchParams.set("path", target.path);
      window.location.assign(url.toString());
      return;
    }
    const parentPath = target.path.replace(/[\\/][^\\/]+$/, "") || target.path;
    const url = new URL(window.location.origin + "/files");
    url.searchParams.set("path", parentPath);
    url.searchParams.set("select", target.path);
    url.searchParams.set("open", "true");
    window.location.assign(url.toString());
  };

  if (!search.mount || !search.fs) {
    return (
      <div className="page-container page-container--viewport">
        <div className="page-header">
          <h1 className="page-title">Storage Analysis</h1>
        </div>
        <div className="page-body panel storage-analysis-empty">
          <span>Missing disk context. Open this page from Settings.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container page-container--viewport">
      <div className="page-header storage-analysis-header">
        <div>
          <h1 className="page-title">Storage Analysis</h1>
          <div className="storage-analysis-subtitle">
            <span>{analysis?.mount.mount ?? search.mount}</span>
            <span>{analysis?.mount.fs ?? search.fs}</span>
          </div>
        </div>
        <div className="storage-analysis-actions">
          {analysis?.status === "scanning" && (
            <div className="storage-analysis-inline-status" aria-live="polite" role="status">
              <LoaderCircle size={14} className="storage-analysis-inline-status-icon" />
              <span>Scanning</span>
            </div>
          )}
          <Button
            variant="secondary"
            onClick={() => startMutation.mutate(true)}
            disabled={startMutation.isPending}
          >
            <RefreshCw size={14} />
            <span>{startMutation.isPending ? "Refreshing..." : "Refresh"}</span>
          </Button>
        </div>
      </div>

      <div className="page-body storage-analysis-page">
        <aside className="storage-analysis-rail">
          <div className="storage-analysis-rail-section">
            <div className="label">Disk</div>
            <div className="storage-analysis-kv">
              <span className="storage-analysis-k">Mount</span>
              <span className="storage-analysis-v">{analysis?.mount.mount ?? search.mount}</span>
              <span className="storage-analysis-k">Device</span>
              <span className="storage-analysis-v">{analysis?.mount.fs ?? search.fs}</span>
              <span className="storage-analysis-k">Filesystem</span>
              <span className="storage-analysis-v">
                {analysis?.mount.filesystemType?.toUpperCase() ?? "UNKNOWN"}
              </span>
            </div>
          </div>

          <div className="storage-analysis-rail-section">
            <div className="label">Status</div>
            <div className="storage-analysis-statline">
              <HardDrive size={14} />
              <span>{analysis?.status?.toUpperCase() ?? "LOADING"}</span>
            </div>
            <div className="storage-analysis-statline">
              <Database size={14} />
              <span>{analysis?.analyzer?.toUpperCase() ?? "PENDING"}</span>
            </div>
            <div className="storage-analysis-statline">
              <Activity size={14} />
              <span>
                {analysis
                  ? formatRelativeFreshness(analysis.completedAt, analysis.freshnessTtlMs)
                  : "Pending"}
              </span>
            </div>
          </div>

          <div className="storage-analysis-rail-section">
            <div className="label">Snapshot</div>
            <div className="storage-analysis-kv">
              <span className="storage-analysis-k">Total</span>
              <span className="storage-analysis-v">{formatStorageBytes(analysis?.totalSize ?? null)}</span>
              <span className="storage-analysis-k">Nodes</span>
              <span className="storage-analysis-v">{analysis?.nodeCount ?? "Pending"}</span>
              <span className="storage-analysis-k">Updated</span>
              <span className="storage-analysis-v">
                {formatStorageTimestamp(analysis?.completedAt ?? null)}
              </span>
            </div>
            {analysis?.warning && (
              <div className="storage-analysis-note">{analysis.warning}</div>
            )}
          </div>

          <div className="storage-analysis-rail-section storage-analysis-rail-section--grow">
            <div className="label">Extensions</div>
            <div className="storage-analysis-legend">
              {(analysis?.extensionHistogram ?? []).map((entry) => (
                <div className="storage-analysis-legend-item" key={entry.extension}>
                  <span
                    className="storage-analysis-legend-swatch"
                    style={{ background: entry.color }}
                  />
                  <span className="storage-analysis-legend-label">{entry.label}</span>
                  <span className="storage-analysis-legend-meta">{entry.count}</span>
                </div>
              ))}
              {(analysis?.extensionHistogram?.length ?? 0) === 0 && (
                <div className="storage-analysis-legend-empty">No extension histogram yet.</div>
              )}
            </div>
          </div>

          <div className="storage-analysis-rail-section">
            <div className="label">Selection</div>
            {selectedNode ? (
              <div className="storage-analysis-kv">
                <span className="storage-analysis-k">Name</span>
                <span className="storage-analysis-v">{selectedNode.name}</span>
                <span className="storage-analysis-k">Type</span>
                <span className="storage-analysis-v">{selectedNode.type.toUpperCase()}</span>
                <span className="storage-analysis-k">Size</span>
                <span className="storage-analysis-v">
                  {formatStorageBytes(selectedNode.size)}
                </span>
                <span className="storage-analysis-k">Path</span>
                <span className="storage-analysis-v storage-analysis-v--mono">
                  {selectedNode.path}
                </span>
              </div>
            ) : (
              <div className="storage-analysis-legend-empty">
                Select a block to inspect it.
              </div>
            )}
          </div>
        </aside>

        <section className="storage-analysis-main">
          {analysisQuery.isLoading || (!analysis && analysisQuery.isFetching) ? (
            <div className="panel storage-analysis-empty">
              <span>Preparing storage analysis…</span>
            </div>
          ) : analysis?.status === "failed" ? (
            <div className="panel storage-analysis-empty storage-analysis-empty--stack">
              <strong>{getFailureCopy(analysis.errorCode, analysis.error).title}</strong>
              <span>{getFailureCopy(analysis.errorCode, analysis.error).description}</span>
              <span className="storage-analysis-empty-meta">
                You can return to Settings or retry after correcting the mount state.
              </span>
            </div>
          ) : analysis?.status === "scanning" && !analysis.root ? (
            <div className="panel storage-analysis-empty">
              <span>Starting scan. The treemap will appear automatically.</span>
            </div>
          ) : (
            <>
              <div className="panel storage-analysis-canvas-shell">
                <div className="storage-analysis-canvas" ref={canvasRef}>
                  {layoutNodes.map((node) => {
                    const width = Math.max(0, node.x1 - node.x0);
                    const height = Math.max(0, node.y1 - node.y0);
                    if (width < 4 || height < 4) {
                      return null;
                    }
                    const isDirectory = node.data.type === "directory";
                    const interactive = width * height >= 72;
                    return (
                      <button
                        key={node.data.path}
                        type="button"
                        className={`storage-node ${isDirectory ? "storage-node--directory" : "storage-node--file"} ${
                          selectedPath === node.data.path ? "storage-node--selected" : ""
                        }`}
                        style={{
                          left: node.x0,
                          top: node.y0,
                          width,
                          height,
                          background: getNodeColor(node.data, extensionColors),
                          zIndex: node.depth,
                          cursor: interactive ? "pointer" : "default",
                        }}
                        title={
                          isDirectory
                            ? undefined
                            : `${node.data.name}\n${node.data.path}\n${formatStorageBytes(node.data.size)}`
                        }
                        onClick={() => {
                          if (!interactive) {
                            return;
                          }
                          setSelectedPath(node.data.path);
                        }}
                        onDoubleClick={() => {
                          if (!interactive) {
                            return;
                          }
                          handleOpenInFiles(node.data);
                        }}
                      >
                        {isDirectory && height >= 18 && (
                          <div className="storage-node-header">{node.data.name}</div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="storage-analysis-footer">
                <div className="storage-analysis-footer-copy">
                  Double-click a directory or file block to continue in Files.
                </div>
                <div className="storage-analysis-footer-copy">
                  Source: {analysis?.sourceKind?.replace(/-/g, " ") ?? "pending"}
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
