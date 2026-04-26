import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useRef, useState, useEffect } from "react";
import { hierarchy, treemap, treemapSquarify } from "d3-hierarchy";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Database,
  HardDrive,
  RefreshCw,
  AlertTriangle,
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

function StorageAnalysisPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { addToast } = useToastStore();
  const search = useMemo(() => readStorageSearch(), []);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 1024, height: 640 });

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

  const refreshMutation = useMutation({
    mutationFn: async () =>
      await trpcClient.storage.refreshAnalysis.mutate({
        mount: search.mount,
        fs: search.fs,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: trpc.storage.getAnalysis.queryOptions({
          mount: search.mount,
          fs: search.fs,
        }).queryKey,
      });
    },
    onError: (error: unknown) => {
      addToast(error instanceof Error ? error.message : "Refresh failed", "error");
    },
  });

  const analysis = analysisQuery.data;
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
          <Button
            variant="secondary"
            onClick={() => refreshMutation.mutate()}
            disabled={refreshMutation.isPending}
          >
            <RefreshCw size={14} />
            <span>{refreshMutation.isPending ? "Refreshing..." : "Refresh"}</span>
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
            {analysis?.fallbackReason && (
              <div className="storage-analysis-warning">
                <AlertTriangle size={14} />
                <span>{analysis.fallbackReason}</span>
              </div>
            )}
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
            <div className="panel storage-analysis-empty">
              <span>{analysis.error ?? "Storage analysis failed."}</span>
            </div>
          ) : analysis?.status === "scanning" && !analysis.root ? (
            <div className="panel storage-analysis-empty">
              <span>Scanning the selected disk. Results will appear automatically.</span>
            </div>
          ) : (
            <>
              <div className="storage-analysis-banner">
                <span>{analysis?.mount.filesystemType?.toUpperCase() ?? "UNKNOWN"}</span>
                <span>{analysis?.refreshing ? "Refresh in progress" : "Snapshot ready"}</span>
                {analysis?.oversized && <span>Large result set</span>}
              </div>

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
