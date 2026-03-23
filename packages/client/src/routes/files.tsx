import { createFileRoute } from "@tanstack/react-router";
import {
  useMemo,
  useState,
  useEffect,
  useRef,
  type FormEvent,
  type ChangeEvent,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Folder,
  FolderOpen,
  File,
  FileText,
  FileCode,
  Image as ImageIcon,
  Video,
  Music,
  Pin,
  PinOff,
  ChevronRight,
  ChevronDown,
  Upload,
  Download,
  FolderPlus,
  Pencil,
  Copy,
  Scissors,
  Trash2,
  LayoutGrid,
  Table,
  Clipboard,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Eye,
  EyeOff,
  Save,
  PanelLeft,
  X,
} from "lucide-react";
import { useTRPC, trpcClient } from "../trpc";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { CodeEditor } from "../components/ui/CodeEditor";
import { useToastStore } from "../stores/toast";
import { authFetch } from "../lib/auth";

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

function joinChildPath(parentPath: string, childName: string): string {
  if (parentPath.endsWith("\\") || parentPath.endsWith("/")) {
    return `${parentPath}${childName}`;
  }
  const separator = parentPath.includes("\\") ? "\\" : "/";
  return `${parentPath}${separator}${childName}`;
}

type ViewMode = "table" | "grid";
type SortBy = "name" | "size" | "modifiedAt" | "createdAt";
type SortDirection = "asc" | "desc";
type FileActionMode = "mkdir" | "rename" | null;
type ClipboardState = { mode: "copy" | "cut"; paths: string[] } | null;
type ViewerMode = "text" | "image" | "audio" | "video" | "pdf" | "binary";
type EditorLanguage =
  | "yaml"
  | "javascript"
  | "typescript"
  | "css"
  | "html"
  | "xml"
  | "markdown"
  | "python"
  | "sql"
  | "shell"
  | "powershell"
  | "plain";

function getViewerMode(mimeType: string): ViewerMode {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType === "application/pdf") return "pdf";
  if (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml" ||
    mimeType === "application/yaml"
  ) {
    return "text";
  }
  return "binary";
}

function getEditorLanguage(filePath: string, mimeType: string): EditorLanguage {
  const extension = filePath.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "yml" || extension === "yaml" || mimeType === "application/yaml")
    return "yaml";
  if (extension === "json" || extension === "jsonc" || mimeType === "application/json")
    return "javascript";
  if (
    extension === "js" ||
    extension === "mjs" ||
    extension === "cjs" ||
    extension === "jsx"
  )
    return "javascript";
  if (extension === "ts" || extension === "tsx") return "typescript";
  if (extension === "css" || extension === "scss" || extension === "less") return "css";
  if (extension === "html" || extension === "htm") return "html";
  if (extension === "xml" || extension === "svg" || mimeType === "application/xml")
    return "xml";
  if (extension === "md" || extension === "markdown" || extension === "mdx")
    return "markdown";
  if (extension === "py") return "python";
  if (extension === "sql") return "sql";
  if (
    extension === "sh" ||
    extension === "bash" ||
    extension === "zsh" ||
    extension === "cmd" ||
    extension === "bat"
  )
    return "shell";
  if (
    extension === "ps1" ||
    extension === "psm1" ||
    extension === "psd1" ||
    extension === "ps1xml"
  )
    return "powershell";
  return "plain";
}

function getPreviewTypeLabel(pathValue: string, mimeType: string): string {
  if (mimeType !== "application/octet-stream") {
    return mimeType;
  }
  const extension = pathValue.split(".").pop()?.toLowerCase();
  if (!extension) {
    return "Unknown binary";
  }
  return `${extension.toUpperCase()} file`;
}

type FileListEntry = {
  name: string;
  type: "directory" | "file" | "symlink" | "other";
  mimeType: string | null;
};

type FileVisualKind =
  | "directory"
  | "document"
  | "image"
  | "video"
  | "audio"
  | "code"
  | "generic";

function getExtensionLabel(fileName: string): string {
  const extension = fileName.split(".").pop()?.trim().toUpperCase();
  return extension && extension !== fileName.toUpperCase() ? extension : "";
}

function getMimeSubtypeLabel(mimeType: string): string {
  if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return "DOCX";
  }
  if (mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
    return "XLSX";
  }
  if (
    mimeType ===
    "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  ) {
    return "PPTX";
  }
  if (mimeType === "application/msword") {
    return "DOC";
  }
  if (mimeType === "application/vnd.ms-excel") {
    return "XLS";
  }
  if (mimeType === "application/vnd.ms-powerpoint") {
    return "PPT";
  }
  const subtype = mimeType.split("/")[1] ?? "";
  if (!subtype) {
    return mimeType;
  }
  const normalized = subtype
    .split(";")[0]
    .replace(/^vnd\./, "")
    .replace(/^x-/, "")
    .replace(/\+xml$/, " xml")
    .replace(/[.+_-]/g, " ")
    .trim();
  return normalized
    .split(" ")
    .filter(Boolean)
    .map((part) => part.toUpperCase())
    .join(" ");
}

function getFileVisualKind(entry: FileListEntry): FileVisualKind {
  if (entry.type === "directory") return "directory";
  const extension = entry.name.split(".").pop()?.toLowerCase() ?? "";
  const mimeType = entry.mimeType ?? "application/octet-stream";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (
    extension === "js" ||
    extension === "mjs" ||
    extension === "cjs" ||
    extension === "jsx" ||
    extension === "ts" ||
    extension === "tsx" ||
    extension === "json" ||
    extension === "jsonc" ||
    extension === "yaml" ||
    extension === "yml" ||
    extension === "py" ||
    extension === "sql" ||
    extension === "css" ||
    extension === "scss" ||
    extension === "less" ||
    extension === "xml" ||
    extension === "html" ||
    extension === "htm" ||
    extension === "sh" ||
    extension === "bash" ||
    extension === "zsh" ||
    extension === "ps1" ||
    extension === "psm1" ||
    extension === "psd1" ||
    extension === "ps1xml" ||
    extension === "bat" ||
    extension === "cmd"
  ) {
    return "code";
  }
  if (mimeType.startsWith("text/")) return "document";
  if (
    mimeType === "application/pdf" ||
    mimeType === "application/msword" ||
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mimeType === "application/vnd.ms-excel" ||
    mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mimeType === "application/vnd.ms-powerpoint" ||
    mimeType ===
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  ) {
    return "document";
  }
  return "generic";
}

function getEntryTypeLabel(entry: FileListEntry): string {
  const visualKind = getFileVisualKind(entry);
  if (visualKind === "directory") {
    return "Directory";
  }
  if (entry.mimeType) {
    const subtype = getMimeSubtypeLabel(entry.mimeType);
    if (visualKind === "image") return `Image (${subtype})`;
    if (visualKind === "video") return `Video (${subtype})`;
    if (visualKind === "audio") return `Audio (${subtype})`;
    if (visualKind === "code") return `Code (${subtype})`;
    if (visualKind === "document") return `Document (${subtype})`;
  }
  const extension = getExtensionLabel(entry.name);
  if (visualKind === "code") return extension ? `Code (${extension})` : "Code";
  if (visualKind === "document")
    return extension ? `Document (${extension})` : "Document";
  return extension ? `File (${extension})` : "File";
}

function renderEntryIcon(entry: FileListEntry, size: number) {
  const visualKind = getFileVisualKind(entry);
  if (visualKind === "directory") return <Folder size={size} />;
  if (visualKind === "image") return <ImageIcon size={size} />;
  if (visualKind === "video") return <Video size={size} />;
  if (visualKind === "audio") return <Music size={size} />;
  if (visualKind === "code") return <FileCode size={size} />;
  if (visualKind === "document") return <FileText size={size} />;
  return <File size={size} />;
}

function FilesPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { addToast } = useToastStore();
  const [requestedPath, setRequestedPath] = useState("");
  const [pathInput, setPathInput] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("table");
  const [sortBy, setSortBy] = useState<SortBy>("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [selectionAnchorPath, setSelectionAnchorPath] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [actionMode, setActionMode] = useState<FileActionMode>(null);
  const [actionInputValue, setActionInputValue] = useState("");
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [clipboard, setClipboard] = useState<ClipboardState>(null);
  const [viewerPath, setViewerPath] = useState<string | null>(null);
  const [forceEditable, setForceEditable] = useState(false);
  const [editorContent, setEditorContent] = useState("");
  const [editorBaseline, setEditorBaseline] = useState("");
  const [editorDirty, setEditorDirty] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const tableScrollRef = useRef<HTMLDivElement | null>(null);
  const gridScrollRef = useRef<HTMLDivElement | null>(null);
  const savedListScrollTopRef = useRef(0);
  const shouldRestoreScrollRef = useRef(false);
  const restoreIntervalRef = useRef<number | null>(null);

  const listQuery = useQuery(
    trpc.files.list.queryOptions(
      {
        path: requestedPath,
        showHidden,
        directoriesOnly: false,
      },
      {
        refetchOnMount: false,
        placeholderData: (previous) => previous,
      }
    )
  );
  const pinsQuery = useQuery(trpc.files.getPins.queryOptions());

  const setPinsMutation = useMutation({
    mutationFn: async (items: string[]) =>
      await trpcClient.files.setPins.mutate({ items }),
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

  const mkdirMutation = useMutation({
    mutationFn: async (targetPath: string) =>
      await trpcClient.files.mkdir.mutate({ path: targetPath }),
  });
  const renameMutation = useMutation({
    mutationFn: async ({
      sourcePath,
      targetPath,
    }: {
      sourcePath: string;
      targetPath: string;
    }) => await trpcClient.files.rename.mutate({ sourcePath, targetPath }),
  });
  const copyMutation = useMutation({
    mutationFn: async ({
      sourcePath,
      targetPath,
    }: {
      sourcePath: string;
      targetPath: string;
    }) => await trpcClient.files.copy.mutate({ sourcePath, targetPath }),
  });
  const moveMutation = useMutation({
    mutationFn: async ({
      sourcePath,
      targetPath,
    }: {
      sourcePath: string;
      targetPath: string;
    }) => await trpcClient.files.move.mutate({ sourcePath, targetPath }),
  });
  const deleteMutation = useMutation({
    mutationFn: async (targetPath: string) =>
      await trpcClient.files.delete.mutate({ path: targetPath }),
  });
  const writeTextMutation = useMutation({
    mutationFn: async ({ path, content }: { path: string; content: string }) =>
      await trpcClient.files.writeText.mutate({ path, content }),
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

  useEffect(() => {
    setSelectedPaths([]);
    setSelectionAnchorPath(null);
  }, [currentPath]);

  useEffect(() => {
    setForceEditable(false);
    setEditorContent("");
    setEditorBaseline("");
    setEditorDirty(false);
  }, [viewerPath]);

  const sortedEntries = useMemo(() => {
    const value = [...entries];
    const sortMultiplier = sortDirection === "asc" ? 1 : -1;
    value.sort((a, b) => {
      if (a.type === "directory" && b.type !== "directory") return -1;
      if (a.type !== "directory" && b.type === "directory") return 1;

      if (sortBy === "name") {
        return (
          a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) *
          sortMultiplier
        );
      }
      if (sortBy === "size") {
        return ((a.size ?? -1) - (b.size ?? -1)) * sortMultiplier;
      }
      const left = a[sortBy] ? Date.parse(a[sortBy] as string) : -1;
      const right = b[sortBy] ? Date.parse(b[sortBy] as string) : -1;
      return (left - right) * sortMultiplier;
    });
    return value;
  }, [entries, sortBy, sortDirection]);
  const selectedPathSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);

  const selectedEntries = useMemo(
    () => sortedEntries.filter((entry) => selectedPathSet.has(entry.path)),
    [sortedEntries, selectedPathSet]
  );
  const selectedEntry = selectedEntries.length === 1 ? selectedEntries[0] : null;
  const canUseSelectionActions = selectedEntries.length > 0;
  const canRename = selectedEntries.length === 1;
  const canDownloadSelectedFile =
    selectedEntries.length === 1 && selectedEntries[0]?.type === "file";
  const fileMetaQuery = useQuery(
    trpc.files.getMeta.queryOptions(
      { path: viewerPath ?? "" },
      {
        enabled: !!viewerPath,
      }
    )
  );
  const viewerMode = fileMetaQuery.data
    ? getViewerMode(fileMetaQuery.data.mimeType)
    : null;
  const readTextQuery = useQuery(
    trpc.files.readText.queryOptions(
      { path: viewerPath ?? "", forceEditable },
      {
        enabled: !!viewerPath && viewerMode === "text",
      }
    )
  );

  useEffect(() => {
    if (readTextQuery.data) {
      setEditorContent(readTextQuery.data.content);
      setEditorBaseline(readTextQuery.data.content);
      setEditorDirty(false);
    }
  }, [readTextQuery.data]);

  useEffect(() => {
    const restore = () => {
      const target =
        viewMode === "table"
          ? tableScrollRef.current
          : viewMode === "grid"
            ? gridScrollRef.current
            : null;
      if (target) {
        target.scrollTop = savedListScrollTopRef.current;
      }
    };
    if (!viewerPath && shouldRestoreScrollRef.current) {
      let attempts = 0;
      requestAnimationFrame(restore);
      restoreIntervalRef.current = window.setInterval(() => {
        restore();
        attempts += 1;
        if (attempts >= 16 && !listQuery.isFetching) {
          if (restoreIntervalRef.current !== null) {
            window.clearInterval(restoreIntervalRef.current);
            restoreIntervalRef.current = null;
          }
          shouldRestoreScrollRef.current = false;
        }
      }, 40);
      return () => {
        if (restoreIntervalRef.current !== null) {
          window.clearInterval(restoreIntervalRef.current);
          restoreIntervalRef.current = null;
        }
      };
    }
  }, [viewerPath, viewMode, listQuery.isFetching, listQuery.dataUpdatedAt]);

  const refreshDirectory = async () => {
    await queryClient.invalidateQueries({
      queryKey: trpc.files.list.queryOptions({ path: requestedPath, showHidden })
        .queryKey,
    });
  };

  const handleNavigate = (nextPath: string) => {
    setMobileSidebarOpen(false);
    setRequestedPath(nextPath);
  };

  const handleItemClick = (
    entry: {
      path: string;
      type: "directory" | "file" | "symlink" | "other";
    },
    event: React.MouseEvent
  ) => {
    const targetPath = entry.path;
    if (event.shiftKey) {
      const anchorPath =
        selectionAnchorPath ?? selectedPaths[selectedPaths.length - 1] ?? targetPath;
      const targetIndex = sortedEntries.findIndex((entry) => entry.path === targetPath);
      const anchorIndex = sortedEntries.findIndex((entry) => entry.path === anchorPath);
      if (targetIndex === -1 || anchorIndex === -1) {
        setSelectedPaths([targetPath]);
        setSelectionAnchorPath(targetPath);
        return;
      }
      const start = Math.min(anchorIndex, targetIndex);
      const end = Math.max(anchorIndex, targetIndex);
      const rangePaths = sortedEntries.slice(start, end + 1).map((entry) => entry.path);
      setSelectedPaths(rangePaths);
      if (!selectionAnchorPath) {
        setSelectionAnchorPath(anchorPath);
      }
      return;
    }

    if (event.ctrlKey || event.metaKey) {
      setSelectedPaths((previous) => {
        if (previous.includes(targetPath)) {
          return previous.filter((item) => item !== targetPath);
        }
        return [...previous, targetPath];
      });
      setSelectionAnchorPath(targetPath);
      return;
    }

    if (selectedPaths.length === 1 && selectedPaths[0] === targetPath) {
      if (entry.type === "directory") {
        handleNavigate(targetPath);
      } else {
        openFileViewer(targetPath);
      }
      return;
    }

    setSelectedPaths([targetPath]);
    setSelectionAnchorPath(targetPath);
  };

  const withOperationErrorToast = (error: unknown, fallbackMessage: string) => {
    const message = error instanceof Error ? error.message : fallbackMessage;
    addToast(message, "error");
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

  const handleCreateFolder = async () => {
    setActionMode("mkdir");
    setActionInputValue("");
  };

  const handleRename = async () => {
    if (!selectedEntry) {
      return;
    }
    setActionMode("rename");
    setActionInputValue(selectedEntry.name);
  };

  const handleStageClipboard = (mode: "copy" | "cut") => {
    if (selectedPaths.length === 0) {
      return;
    }
    setClipboard({ mode, paths: [...selectedPaths] });
    addToast(
      `${mode === "copy" ? "Copied" : "Cut"} ${selectedPaths.length} to clipboard`,
      "success"
    );
  };

  const submitActionDialog = async () => {
    const trimmed = actionInputValue.trim();
    if (!trimmed) {
      addToast("Value is required", "error");
      return;
    }
    try {
      if (actionMode === "mkdir") {
        const targetPath = joinChildPath(currentPath, trimmed);
        await mkdirMutation.mutateAsync(targetPath);
        addToast("Folder created", "success");
      } else if (actionMode === "rename" && selectedEntry) {
        const targetPath = joinChildPath(currentPath, trimmed);
        await renameMutation.mutateAsync({ sourcePath: selectedEntry.path, targetPath });
        addToast("Renamed", "success");
      }
      setActionMode(null);
      setActionInputValue("");
      await refreshDirectory();
    } catch (error) {
      withOperationErrorToast(error, "Action failed");
    }
  };

  const handleDelete = async () => {
    if (selectedPaths.length === 0) {
      return;
    }
    try {
      for (const targetPath of selectedPaths) {
        await deleteMutation.mutateAsync(targetPath);
      }
      addToast(`Deleted ${selectedPaths.length} item(s)`, "success");
      setSelectedPaths([]);
      setDeleteConfirmOpen(false);
      await refreshDirectory();
    } catch (error) {
      withOperationErrorToast(error, "Failed to delete");
    }
  };

  const handleDownload = () => {
    if (!selectedEntry) {
      return;
    }
    if (selectedEntry.type === "directory") {
      return;
    }
    const url = `/api/files/download?path=${encodeURIComponent(selectedEntry.path)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const handlePasteClipboard = async () => {
    if (!clipboard || !currentPath) {
      return;
    }
    let pastedCount = 0;
    for (const sourcePath of clipboard.paths) {
      const targetPath = joinChildPath(currentPath, getDisplayName(sourcePath));
      if (normalizePathForCompare(targetPath) === normalizePathForCompare(sourcePath)) {
        continue;
      }
      if (clipboard.mode === "copy") {
        await copyMutation.mutateAsync({ sourcePath, targetPath });
      } else {
        await moveMutation.mutateAsync({ sourcePath, targetPath });
      }
      pastedCount += 1;
    }
    if (clipboard.mode === "cut") {
      setClipboard(null);
    }
    setSelectedPaths([]);
    addToast(`Pasted ${pastedCount} item(s)`, "success");
    await refreshDirectory();
  };

  const handleSaveText = async () => {
    if (!viewerPath) {
      return;
    }
    try {
      await writeTextMutation.mutateAsync({ path: viewerPath, content: editorContent });
      setEditorBaseline(editorContent);
      setEditorDirty(false);
      addToast("Saved", "success");
      await queryClient.invalidateQueries({
        queryKey: trpc.files.readText.queryOptions({ path: viewerPath, forceEditable })
          .queryKey,
      });
    } catch (error) {
      withOperationErrorToast(error, "Failed to save file");
    }
  };

  const openFileViewer = (targetPath: string) => {
    if (restoreIntervalRef.current !== null) {
      window.clearInterval(restoreIntervalRef.current);
      restoreIntervalRef.current = null;
    }
    shouldRestoreScrollRef.current = false;
    const scrollContainer =
      viewMode === "table" ? tableScrollRef.current : gridScrollRef.current;
    savedListScrollTopRef.current = scrollContainer?.scrollTop ?? 0;
    setViewerPath(targetPath);
  };

  const closeFileViewer = () => {
    shouldRestoreScrollRef.current = true;
    setViewerPath(null);
  };

  const uploadFiles = async (files: File[]) => {
    if (!currentPath || files.length === 0) return;
    const formData = new FormData();
    for (const file of files) {
      formData.append("files", file);
    }
    try {
      const response = await authFetch(
        `/api/files/upload?path=${encodeURIComponent(currentPath)}`,
        {
          method: "POST",
          body: formData,
        }
      );
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(payload?.error || "Upload failed");
      }
      addToast("Upload complete", "success");
      await refreshDirectory();
    } catch (error) {
      withOperationErrorToast(error, "Failed to upload files");
    }
  };

  const handleUploadInputChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? Array.from(event.target.files) : [];
    await uploadFiles(files);
    event.target.value = "";
  };

  if (viewerPath) {
    const sourceUrl = `/api/files/content?path=${encodeURIComponent(viewerPath)}`;
    const readOnlySuggested = !!readTextQuery.data?.readOnlySuggested;
    const isTextReadonly = readOnlySuggested && !forceEditable;
    const editorLanguage = fileMetaQuery.data
      ? getEditorLanguage(viewerPath, fileMetaQuery.data.mimeType)
      : "plain";
    return (
      <div className="page-container page-container--viewport">
        <div className="page-header files-viewer-header">
          <Button type="button" variant="secondary" onClick={closeFileViewer}>
            <ArrowLeft size={14} />
            <span>Back</span>
          </Button>
          <div className="files-viewer-title">
            <div className="files-viewer-path-pill">{viewerPath}</div>
          </div>
          {viewerMode === "text" && (
            <div className="files-viewer-actions">
              <Button
                type="button"
                variant="secondary"
                onClick={handleSaveText}
                disabled={isTextReadonly || !editorDirty || writeTextMutation.isPending}
              >
                <Save size={14} />
                <span>Save</span>
              </Button>
            </div>
          )}
        </div>
        <div className="page-body panel files-viewer-body">
          {fileMetaQuery.isLoading ? (
            <div className="files-empty">Loading file…</div>
          ) : fileMetaQuery.error ? (
            <div className="files-error">
              <span>{fileMetaQuery.error.message}</span>
            </div>
          ) : viewerMode === "text" ? (
            <div className="files-text-viewer">
              {(readTextQuery.data?.readOnlySuggested ||
                readTextQuery.data?.truncated) && (
                <div className="files-viewer-warning">
                  <span>
                    {readTextQuery.data?.truncated
                      ? "File content is truncated for safety."
                      : "Large file opened in read-only mode."}
                  </span>
                  {readTextQuery.data?.readOnlySuggested && (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => setForceEditable(true)}
                      disabled={forceEditable}
                    >
                      Enable Editing
                    </Button>
                  )}
                </div>
              )}
              {readTextQuery.isLoading ? (
                <div className="files-empty">Loading text…</div>
              ) : readTextQuery.error ? (
                <div className="files-error">
                  <span>{readTextQuery.error.message}</span>
                </div>
              ) : (
                <div className="files-text-editor-wrap">
                  <CodeEditor
                    value={editorContent}
                    onChange={(value) => {
                      setEditorContent(value);
                      setEditorDirty(value !== editorBaseline);
                    }}
                    readonly={isTextReadonly}
                    language={editorLanguage}
                    height="100%"
                    minHeight="100%"
                  />
                </div>
              )}
            </div>
          ) : viewerMode === "image" ? (
            <div className="files-media-viewer">
              <img src={sourceUrl} className="files-media-image" />
            </div>
          ) : viewerMode === "audio" ? (
            <div className="files-media-viewer">
              <audio controls src={sourceUrl} className="files-media-audio" />
            </div>
          ) : viewerMode === "video" ? (
            <div className="files-media-viewer">
              <video controls src={sourceUrl} className="files-media-video" />
            </div>
          ) : viewerMode === "pdf" ? (
            <div className="files-pdf-viewer">
              <iframe src={sourceUrl} className="files-pdf-frame" />
            </div>
          ) : (
            <div className="files-binary-viewer">
              <div className="files-binary-card">
                <File size={28} />
                <div className="files-binary-title">Preview not available</div>
                <div className="files-binary-meta">
                  {viewerPath
                    ? getPreviewTypeLabel(
                        viewerPath,
                        fileMetaQuery.data?.mimeType ?? "application/octet-stream"
                      )
                    : "Unknown type"}
                </div>
                <div className="files-binary-meta">
                  {formatSize(fileMetaQuery.data?.size ?? null)}
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    window.open(
                      `/api/files/download?path=${encodeURIComponent(viewerPath)}`,
                      "_blank"
                    )
                  }
                >
                  <Download size={14} />
                  <span>Download</span>
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="page-container page-container--viewport">
      <div className="page-header">
        <h1 className="page-title">Files</h1>
        <div className="files-page-header-actions">
          <Button
            type="button"
            variant="secondary"
            onClick={() => setMobileSidebarOpen(true)}
          >
            <PanelLeft size={14} />
            <span>Browse</span>
          </Button>
        </div>
      </div>
      <div
        className={`page-body files-layout ${mobileSidebarOpen ? "files-layout--mobile-sidebar-open" : ""}`}
      >
        <button
          type="button"
          className="files-sidebar-backdrop"
          onClick={() => setMobileSidebarOpen(false)}
          aria-label="Close navigation"
        />
        <aside className="panel files-sidebar">
          <div className="files-sidebar-mobile-head">
            <div className="files-section-title">Navigation</div>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setMobileSidebarOpen(false)}
            >
              <X size={14} />
              <span>Close</span>
            </Button>
          </div>
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

        <section
          className={`panel files-main ${dragActive ? "files-main--drag-active" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            setDragActive(false);
          }}
          onDrop={async (event) => {
            event.preventDefault();
            setDragActive(false);
            const files = Array.from(event.dataTransfer.files);
            await uploadFiles(files);
          }}
        >
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
              <div className="files-path-actions">
                <Button type="submit" variant="secondary">
                  <ArrowRight size={14} />
                  <span>Go</span>
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => parentPath && handleNavigate(parentPath)}
                  disabled={!parentPath}
                >
                  <ArrowUp size={14} />
                  <span>Up</span>
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={togglePin}
                  disabled={!currentPath}
                >
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
            </form>
            <div className="files-toolbar-actions">
              <Button
                type="button"
                variant="secondary"
                onClick={() => uploadInputRef.current?.click()}
              >
                <Upload size={14} />
                <span>Upload</span>
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={handleDownload}
                disabled={!canDownloadSelectedFile}
              >
                <Download size={14} />
                <span>Download</span>
              </Button>
              <Button type="button" variant="secondary" onClick={handleCreateFolder}>
                <FolderPlus size={14} />
                <span>New Folder</span>
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={handleRename}
                disabled={!canRename}
              >
                <Pencil size={14} />
                <span>Rename</span>
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => handleStageClipboard("copy")}
                disabled={!canUseSelectionActions}
              >
                <Copy size={14} />
                <span>Copy</span>
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => handleStageClipboard("cut")}
                disabled={!canUseSelectionActions}
              >
                <Scissors size={14} />
                <span>Cut</span>
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={async () => {
                  try {
                    await handlePasteClipboard();
                  } catch (error) {
                    withOperationErrorToast(error, "Failed to paste");
                  }
                }}
                disabled={!clipboard || !currentPath}
              >
                <Clipboard size={14} />
                <span>Paste</span>
              </Button>
              <Button
                type="button"
                variant="danger"
                onClick={() => setDeleteConfirmOpen(true)}
                disabled={!canUseSelectionActions}
              >
                <Trash2 size={14} />
                <span>Delete</span>
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setShowHidden((v) => !v)}
              >
                {showHidden ? (
                  <>
                    <EyeOff size={14} />
                    <span>Hidden</span>
                  </>
                ) : (
                  <>
                    <Eye size={14} />
                    <span>Hidden</span>
                  </>
                )}
              </Button>
            </div>
          </div>
          <div className="files-subtoolbar">
            <div className="files-view-switch">
              <Button
                type="button"
                variant={viewMode === "table" ? "primary" : "secondary"}
                onClick={() => setViewMode("table")}
              >
                <Table size={14} />
                <span>Table</span>
              </Button>
              <Button
                type="button"
                variant={viewMode === "grid" ? "primary" : "secondary"}
                onClick={() => setViewMode("grid")}
              >
                <LayoutGrid size={14} />
                <span>Grid</span>
              </Button>
            </div>
            <div className="files-sort-controls">
              <label className="label" htmlFor="files-sort-by">
                Sort
              </label>
              <select
                id="files-sort-by"
                className="files-select"
                value={sortBy}
                onChange={(event) => setSortBy(event.target.value as SortBy)}
              >
                <option value="name">Name</option>
                <option value="size">Size</option>
                <option value="modifiedAt">Modified</option>
                <option value="createdAt">Created</option>
              </select>
              <select
                className="files-select"
                aria-label="Sort direction"
                value={sortDirection}
                onChange={(event) =>
                  setSortDirection(event.target.value as SortDirection)
                }
              >
                <option value="asc">Asc</option>
                <option value="desc">Desc</option>
              </select>
            </div>
            <div className="files-selection">
              {listQuery.isFetching
                ? "Refreshing…"
                : selectedPaths.length > 0
                  ? `Selected: ${selectedPaths.length}`
                  : "Selected: none"}
            </div>
          </div>
          <input
            ref={uploadInputRef}
            className="files-upload-input"
            type="file"
            multiple
            onChange={handleUploadInputChange}
          />

          {listQuery.error ? (
            <div className="files-error">
              <span>{listQuery.error.message}</span>
            </div>
          ) : viewMode === "table" ? (
            <div className="files-table-wrap" ref={tableScrollRef}>
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
                  {listQuery.isLoading ? (
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
                    sortedEntries.map((entry) => (
                      <tr
                        key={entry.path}
                        className={`files-row ${selectedPathSet.has(entry.path) ? "files-row--selected" : ""}`}
                        onClick={(event) => handleItemClick(entry, event)}
                        onMouseDown={(event) => {
                          if (event.shiftKey) {
                            event.preventDefault();
                          }
                        }}
                        onDoubleClick={() => {
                          if (entry.type === "directory") {
                            handleNavigate(entry.path);
                          } else {
                            openFileViewer(entry.path);
                          }
                        }}
                      >
                        <td>
                          <div className="files-entry-button">
                            {entry.type === "directory"
                              ? renderEntryIcon(entry, 14)
                              : renderEntryIcon(entry, 14)}
                            <span>{entry.name}</span>
                          </div>
                        </td>
                        <td>{getEntryTypeLabel(entry)}</td>
                        <td>{formatSize(entry.size)}</td>
                        <td>{formatDate(entry.modifiedAt)}</td>
                        <td>{formatDate(entry.createdAt)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          ) : null}
          {viewMode === "grid" && (
            <div className="files-grid-wrap" ref={gridScrollRef}>
              {listQuery.isLoading ? (
                <div className="files-empty">Loading directory…</div>
              ) : sortedEntries.length === 0 ? (
                <div className="files-empty">Empty directory</div>
              ) : (
                sortedEntries.map((entry) => (
                  <button
                    key={entry.path}
                    className={`files-grid-item ${selectedPathSet.has(entry.path) ? "files-grid-item--selected" : ""}`}
                    onClick={(event) => handleItemClick(entry, event)}
                    onMouseDown={(event) => {
                      if (event.shiftKey) {
                        event.preventDefault();
                      }
                    }}
                    onDoubleClick={() => {
                      if (entry.type === "directory") {
                        handleNavigate(entry.path);
                      } else {
                        openFileViewer(entry.path);
                      }
                    }}
                  >
                    <div className="files-grid-icon">{renderEntryIcon(entry, 18)}</div>
                    <div className="files-grid-name">{entry.name}</div>
                    <div className="files-grid-meta">{getEntryTypeLabel(entry)}</div>
                  </button>
                ))
              )}
            </div>
          )}
        </section>
      </div>
      <FileActionDialog
        isOpen={actionMode !== null}
        mode={actionMode}
        value={actionInputValue}
        onValueChange={setActionInputValue}
        onClose={() => {
          setActionMode(null);
          setActionInputValue("");
        }}
        onSubmit={submitActionDialog}
      />
      <ConfirmDialog
        isOpen={deleteConfirmOpen && selectedPaths.length > 0}
        title="Confirm Delete"
        message={
          selectedPaths.length > 1
            ? `Delete ${selectedPaths.length} selected items?`
            : selectedEntry
              ? `Delete ${selectedEntry.name}?`
              : "Delete selected item?"
        }
        confirmText="Delete"
        onCancel={() => setDeleteConfirmOpen(false)}
        onConfirm={handleDelete}
        variant="danger"
      />
    </div>
  );
}

interface FileActionDialogProps {
  isOpen: boolean;
  mode: FileActionMode;
  value: string;
  onValueChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}

function FileActionDialog({
  isOpen,
  mode,
  value,
  onValueChange,
  onClose,
  onSubmit,
}: FileActionDialogProps) {
  if (!isOpen || !mode) {
    return null;
  }

  const title = mode === "mkdir" ? "Create Folder" : "Rename Item";
  const label = mode === "mkdir" ? "Folder Name" : "New Name";
  const confirmText = mode === "mkdir" ? "Create" : "Rename";
  const titleId =
    mode === "mkdir"
      ? "file-action-dialog-title-mkdir"
      : "file-action-dialog-title-rename";

  return (
    <div className="modal-overlay">
      <div className="modal-backdrop" onClick={onClose} />
      <div
        className="modal-content"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h2 id={titleId} className="modal-title">
          {title}
        </h2>
        <Input
          label={label}
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onSubmit();
            }
          }}
          autoFocus
        />
        <div className="modal-actions">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" variant="primary" onClick={onSubmit}>
            {confirmText}
          </Button>
        </div>
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

function TreeNode({
  nodePath,
  showHidden,
  currentPath,
  onNavigate,
  depth,
}: TreeNodeProps) {
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
        directoriesOnly: true,
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
          <button
            type="button"
            aria-label={expanded ? "Collapse folder" : "Expand folder"}
            onClick={(event) => {
              event.stopPropagation();
              setExpanded((value) => !value);
            }}
            style={{
              background: "transparent",
              border: "none",
              color: "inherit",
              padding: 0,
              display: "inline-flex",
              cursor: "pointer",
            }}
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        </span>
        {expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
        <span>{getDisplayName(nodePath)}</span>
      </button>
      {expanded && (
        <div>
          {nodeQuery.isLoading && !nodeQuery.data ? (
            <div
              className="files-tree-loading"
              style={{ paddingLeft: `${depth * 12 + 30}px` }}
            >
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
