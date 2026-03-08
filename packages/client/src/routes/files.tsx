import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState, useEffect, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Folder, FolderOpen, File, Pin, PinOff, ChevronRight, ChevronDown } from "lucide-react";
import { useTRPC, trpcClient } from "../trpc";
import { Button } from "../components/ui/Button";
import { useToastStore } from "../stores/toast";

export const Route = createFileRoute("/files")({
  component: FilesPage,
});

function getRootPath(absolutePath: string): string {
  const windowsRoot = absolutePath.match(/^[A-Za-z]:\\/);
  if (windowsRoot) {
    return windowsRoot[0];
  }
  return "/";
}

function getDisplayName(absolutePath: string): string {
  const normalized = absolutePath.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) {
    return absolutePath;
  }
  return parts[parts.length - 1];
}

function normalizePathForCompare(input: string): string {
  const normalized = input.replace(/\\/g, "/");
  return normalized.toLowerCase();
}

function isSameOrParentPath(parentPath: string, targetPath: string): boolean {
  const normalizedParent = normalizePathForCompare(parentPath).replace(/\/+$/, "");
  const normalizedTarget = normalizePathForCompare(targetPath).replace(/\/+$/, "");
  if (normalizedParent === normalizedTarget) {
    return true;
  }
  return normalizedTarget.startsWith(`${normalizedParent}/`);
}

function formatDate(value: string | null): string {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatSize(size: number | null): string {
  if (size === null) {
    return "-";
  }
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function FilesPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { addToast } = useToastStore();
  const [requestedPath, setRequestedPath] = useState("");
  const [pathInput, setPathInput] = useState("");
  const [showHidden, setShowHidden] = useState(false);

  const listQuery = useQuery(
    trpc.files.list.queryOptions({
      path: requestedPath,
      showHidden,
    })
  );
  const pinsQuery = useQuery(trpc.files.getPins.queryOptions());

  const setPinsMutation = useMutation({
    mutationFn: async (items: string[]) => await trpcClient.files.setPins.mutate({ items }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: trpc.files.getPins.queryOptions().queryKey,
      });
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : "Unknown error";
      addToast(`Failed to update pins: ${message}`, "error");
    },
  });

  useEffect(() => {
    if (listQuery.data?.cwd) {
      setPathInput(listQuery.data.cwd);
    }
  }, [listQuery.data?.cwd]);

  const currentPath = listQuery.data?.cwd ?? requestedPath;
  const pinned = pinsQuery.data?.items ?? [];
  const parentPath = listQuery.data?.parent ?? null;
  const isPinned = currentPath.length > 0 && pinned.includes(currentPath);
  const entries = listQuery.data?.entries ?? [];

  const handleNavigate = (nextPath: string) => {
    setRequestedPath(nextPath);
  };

  const handlePathSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = pathInput.trim();
    if (!trimmed) {
      return;
    }
    handleNavigate(trimmed);
  };

  const togglePin = () => {
    if (!currentPath) {
      return;
    }
    const nextPins = isPinned
      ? pinned.filter((item) => item !== currentPath)
      : [...pinned, currentPath];
    setPinsMutation.mutate(nextPins);
  };

  return (
    <div className="page-container page-container--viewport">
      <div className="page-header">
        <h1 className="page-title">Files</h1>
      </div>
      <div className="page-body files-layout">
        <aside className="panel files-sidebar">
          <div className="files-sidebar-section">
            <div className="files-section-title">Pinned</div>
            <div className="files-pins-list">
              {pinned.length > 0 ? (
                pinned.map((pinPath) => (
                  <button
                    key={pinPath}
                    className="files-link-button"
                    onClick={() => handleNavigate(pinPath)}
                  >
                    <Pin size={14} />
                    <span>{pinPath}</span>
                  </button>
                ))
              ) : (
                <div className="files-empty">No pinned directories</div>
              )}
            </div>
          </div>
          <div className="files-sidebar-section files-sidebar-tree">
            <div className="files-section-title">Tree</div>
            {currentPath ? (
              <TreeNode
                nodePath={getRootPath(currentPath)}
                showHidden={showHidden}
                currentPath={currentPath}
                onNavigate={handleNavigate}
                depth={0}
              />
            ) : (
              <div className="files-empty">Loading tree…</div>
            )}
          </div>
        </aside>

        <section className="panel files-main">
          <div className="files-toolbar">
            <form className="files-path-form" onSubmit={handlePathSubmit}>
              <label className="label" htmlFor="files-path-input">
                Path
              </label>
              <input
                id="files-path-input"
                className="files-path-input"
                value={pathInput}
                onChange={(event) => setPathInput(event.target.value)}
              />
              <Button type="submit" variant="secondary">
                Go
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => parentPath && handleNavigate(parentPath)}
                disabled={!parentPath}
              >
                Up
              </Button>
            </form>
            <div className="files-toolbar-actions">
              <Button type="button" variant="secondary" onClick={() => setShowHidden((v) => !v)}>
                {showHidden ? "Hide Hidden" : "Show Hidden"}
              </Button>
              <Button type="button" variant="secondary" onClick={togglePin} disabled={!currentPath}>
                {isPinned ? (
                  <>
                    <PinOff size={14} />
                    <span>Unpin</span>
                  </>
                ) : (
                  <>
                    <Pin size={14} />
                    <span>Pin</span>
                  </>
                )}
              </Button>
            </div>
          </div>

          {listQuery.error ? (
            <div className="files-error">
              <span>{listQuery.error.message}</span>
            </div>
          ) : (
            <div className="files-table-wrap">
              <table className="deckos-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Size</th>
                    <th>Modified</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {listQuery.isLoading || listQuery.isFetching ? (
                    <tr>
                      <td colSpan={5} className="files-loading-cell">
                        Loading directory…
                      </td>
                    </tr>
                  ) : entries.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="files-loading-cell">
                        Empty directory
                      </td>
                    </tr>
                  ) : (
                    entries.map((entry) => (
                      <tr key={entry.path}>
                        <td>
                          <button
                            className="files-entry-button"
                            onClick={() => entry.type === "directory" && handleNavigate(entry.path)}
                          >
                            {entry.type === "directory" ? (
                              <Folder size={14} />
                            ) : (
                              <File size={14} />
                            )}
                            <span>{entry.name}</span>
                          </button>
                        </td>
                        <td>{entry.type}</td>
                        <td>{formatSize(entry.size)}</td>
                        <td>{formatDate(entry.modifiedAt)}</td>
                        <td>{formatDate(entry.createdAt)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}

        </section>
      </div>
    </div>
  );
}

interface TreeNodeProps {
  nodePath: string;
  showHidden: boolean;
  currentPath: string;
  onNavigate: (path: string) => void;
  depth: number;
}

function TreeNode({ nodePath, showHidden, currentPath, onNavigate, depth }: TreeNodeProps) {
  const trpc = useTRPC();
  const [expanded, setExpanded] = useState(depth === 0);
  const shouldBeExpanded = isSameOrParentPath(nodePath, currentPath);

  useEffect(() => {
    if (shouldBeExpanded) {
      setExpanded(true);
    }
  }, [shouldBeExpanded]);

  const nodeQuery = useQuery(
    trpc.files.list.queryOptions(
      {
        path: nodePath,
        showHidden,
      },
      {
        enabled: expanded,
      }
    )
  );

  const children = useMemo(
    () => (nodeQuery.data?.entries ?? []).filter((entry) => entry.type === "directory"),
    [nodeQuery.data?.entries]
  );

  const isActive = currentPath === nodePath;

  return (
    <div>
      <button
        className={`files-tree-node ${isActive ? "files-tree-node--active" : ""}`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => onNavigate(nodePath)}
      >
        <span className="files-tree-toggle">
          <span
            onClick={(event) => {
              event.stopPropagation();
              setExpanded((value) => !value);
            }}
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        </span>
        {expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
        <span>{getDisplayName(nodePath)}</span>
      </button>
      {expanded && (
        <div>
          {nodeQuery.isLoading && !nodeQuery.data ? (
            <div className="files-tree-loading" style={{ paddingLeft: `${depth * 12 + 30}px` }}>
              Loading…
            </div>
          ) : (
            children.map((entry) => (
              <TreeNode
                key={entry.path}
                nodePath={entry.path}
                showHidden={showHidden}
                currentPath={currentPath}
                onNavigate={onNavigate}
                depth={depth + 1}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
