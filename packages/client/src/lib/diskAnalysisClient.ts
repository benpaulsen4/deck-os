import { getPathParent, trimTrailingPathSeparators } from "@deckos/contracts";
import type {
  DiskAnalysisIssue,
  DiskAnalysisMountIdentity,
  DiskAnalysisSnapshot,
  DiskAnalysisTreemapNode,
} from "@deckos/contracts";

export type DiskAnalysisLegendItem = {
  extension: string;
  colorToken: string;
  count: number;
  totalBytes: number;
};

const EXTENSION_COLOR_PALETTE = [
  "#00ff88",
  "#58d5ff",
  "#aa44ff",
  "#ff8f3d",
  "#ffe066",
  "#ff5470",
  "#53f5c7",
  "#7aa2ff",
  "#d68cff",
  "#ffb86b",
  "#7df5a6",
  "#ff7ad9",
  "#9eff6b",
  "#6af2ff",
  "#ffd36a",
  "#8cc8ff",
  "#ff9f9f",
  "#b8ff7a",
  "#b18cff",
  "#f6ff7a",
];
const SMALL_FILE_BUCKET_SUFFIX = "__deckos_small_files__";
const OTHER_ENTRIES_BUCKET_SUFFIX = "__deckos_other_entries__";

export type PresentationTreeOptions = {
  maxDepth?: number;
  maxChildrenPerDirectory?: number;
  minShareByDepth?: number[];
};

/**
 * How many nodes a finished (cached or completed) tree may carry before it is
 * worth pruning for display.
 *
 * DISK-15: `createPresentationTree` used to run only on the in-progress live
 * tree, so a cached or completed snapshot went to the treemap whole -- and a
 * root filesystem snapshot is comfortably half a million nodes, every one of
 * them laid out and hit-tested on each hover.
 *
 * The budget exists because pruning is not free of consequence: it drops the
 * long tail into an "Other" bucket, and doing that to a tree the browser could
 * have rendered faithfully would change what existing users see on a
 * perfectly good scan. Below the budget the snapshot is handed through
 * untouched, by reference.
 */
export const SNAPSHOT_PRESENTATION_NODE_BUDGET = 20_000;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const unitIndex = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024))
  );
  const value = bytes / Math.pow(1024, unitIndex);
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}

export function formatRelativeGeneratedAt(value?: string): string {
  if (!value) {
    return "Unavailable";
  }
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) {
    return "Unavailable";
  }
  const diffMs = Math.max(0, Date.now() - timestamp);
  const diffMinutes = Math.floor(diffMs / 60000);
  if (diffMinutes < 1) {
    return "Just now";
  }
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

export function getMountLabel(mountPath: string): string {
  const normalized = mountPath.replace(/[\\/]+$/, "");
  if (/^[A-Za-z]:$/.test(normalized)) {
    return `${normalized}\\`;
  }
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? mountPath;
}

function getNodeLabel(targetPath: string): string {
  const normalized = targetPath.replace(/[\\/]+$/, "");
  if (/^[A-Za-z]:$/.test(normalized)) {
    return `${normalized}\\`;
  }
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? targetPath;
}

/**
 * Append `childName` to `parentPath` using the separator that path already
 * uses, rather than the one this file happened to be written on.
 *
 * The server hands out whatever `path.join` produced on the host, so on Linux
 * every path in the tree is `/`-separated. A hardcoded backslash produced
 * synthetic nodes named `/var/lib\__deckos_other_entries__`, which nothing
 * else in the system -- `getPathParent`, the file browser, the treemap's
 * "open in Files" navigation -- can take apart correctly.
 */
function joinChildPath(parentPath: string, childName: string): string {
  const trimmed = trimTrailingPathSeparators(parentPath);
  // A filesystem root *is* its separator (`/`, `C:\`), and
  // `trimTrailingPathSeparators` preserves that, so appending directly is
  // right and adding another separator would not be.
  if (trimmed.endsWith("/") || trimmed.endsWith("\\")) {
    return `${trimmed}${childName}`;
  }
  const separator = trimmed.lastIndexOf("\\") > trimmed.lastIndexOf("/") ? "\\" : "/";
  return `${trimmed}${separator}${childName}`;
}

/**
 * The root path this mount's tree is built around.
 *
 * Every path the server emits descends from `path.resolve(mount)`, so the
 * client has to compare against the same shape or nothing matches. A trailing
 * separator is the easiest way to see that go wrong, but it is not the only
 * one -- `.`/`..` segments, doubled separators and (on Windows) drive-letter
 * case all survive the route's `?mount=` search param and none of them survive
 * `path.resolve`. The client cannot reproduce `path.resolve` (it has no cwd
 * and no platform), so the real fix is upstream in `disk-analysis.tsx`, which
 * adopts the mount identity the server puts on its own events. This trim is
 * the cheap guard for the window before the first event arrives.
 */
function getMountRootPath(mount: DiskAnalysisMountIdentity): string {
  return trimTrailingPathSeparators(mount.mount);
}

function dedupeIssues(issues: DiskAnalysisIssue[]): DiskAnalysisIssue[] {
  const deduped = new Map<string, DiskAnalysisIssue>();
  for (const issue of issues) {
    deduped.set(`${issue.code}:${issue.path}:${issue.message}`, issue);
  }
  return [...deduped.values()];
}

function sortChildren(children: DiskAnalysisTreemapNode[]): DiskAnalysisTreemapNode[] {
  return [...children].sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "directory" ? -1 : 1;
    }
    return right.recursiveSize - left.recursiveSize || left.name.localeCompare(right.name);
  });
}

function cloneNodeShallow(node: DiskAnalysisTreemapNode): DiskAnalysisTreemapNode {
  return {
    ...node,
    issues: [...node.issues],
    children: [...node.children].filter((child) => child.path !== node.path),
  };
}

function replaceChild(
  children: DiskAnalysisTreemapNode[],
  child: DiskAnalysisTreemapNode
): DiskAnalysisTreemapNode[] {
  const nextChildren = [...children];
  const existingIndex = nextChildren.findIndex((entry) => entry.path === child.path);
  if (existingIndex >= 0) {
    nextChildren[existingIndex] = child;
  } else {
    nextChildren.push(child);
  }
  return sortChildren(nextChildren);
}

function recomputeDirectoryNode(node: DiskAnalysisTreemapNode): DiskAnalysisTreemapNode {
  if (node.type === "file") {
    return node;
  }
  const children = sortChildren(node.children.filter((child) => child.path !== node.path));
  return {
    ...node,
    childCount: children.length,
    recursiveSize: children.reduce((sum, child) => sum + child.recursiveSize, 0),
    descendantsScanned: children.reduce((sum, child) => {
      return sum + (child.type === "directory" ? child.descendantsScanned + 1 : 0);
    }, 0),
    truncated: node.truncated || children.some((child) => child.truncated),
    issues: dedupeIssues(node.issues),
    children,
  };
}

function buildAncestorChain(targetParentPath: string, rawMountPath: string): string[] {
  const mountPath = trimTrailingPathSeparators(rawMountPath);
  if (targetParentPath === mountPath) {
    return [];
  }

  const chain: string[] = [];
  let cursor = targetParentPath;
  while (cursor && cursor !== mountPath) {
    chain.push(cursor);
    const nextParent = getPathParent(cursor);
    if (!nextParent || nextParent === cursor) {
      break;
    }
    cursor = nextParent;
  }
  return chain.reverse();
}

export function createSyntheticLiveRoot(
  mount: DiskAnalysisMountIdentity
): DiskAnalysisTreemapNode {
  return {
    path: getMountRootPath(mount),
    name: getMountLabel(mount.mount),
    type: "directory",
    size: 0,
    recursiveSize: 0,
    extension: null,
    childCount: 0,
    descendantsScanned: 0,
    truncated: false,
    issues: [],
    children: [],
  };
}

function createAggregateBucket(
  directoryPath: string,
  fileCount: number,
  directoryCount: number,
  totalBytes: number,
  hasIssues: boolean
): DiskAnalysisTreemapNode {
  const entryCount = fileCount + directoryCount;
  const directoryLabel =
    directoryCount > 0 ? `${directoryCount} folder${directoryCount === 1 ? "" : "s"}` : null;
  const fileLabel = fileCount > 0 ? `${fileCount} file${fileCount === 1 ? "" : "s"}` : null;
  const detail = [directoryLabel, fileLabel].filter(Boolean).join(", ");
  return {
    path: joinChildPath(directoryPath, OTHER_ENTRIES_BUCKET_SUFFIX),
    name: detail ? `Other (${detail})` : "Other",
    type: "file",
    size: totalBytes,
    recursiveSize: totalBytes,
    extension: null,
    childCount: entryCount,
    descendantsScanned: 0,
    truncated: false,
    issues: hasIssues
      ? [
          {
            code: "partial-scan",
            path: directoryPath,
            message: `Additional entries were hidden to keep the live treemap responsive.`,
            recoverable: true,
          },
        ]
      : [],
    children: [],
  };
}

export function createPresentationTree(
  root: DiskAnalysisTreemapNode | null,
  options: PresentationTreeOptions = {}
): DiskAnalysisTreemapNode | null {
  if (!root) {
    return null;
  }

  const maxDepth = options.maxDepth ?? 4;
  const maxChildrenPerDirectory = options.maxChildrenPerDirectory ?? 40;
  const minShareByDepth = options.minShareByDepth ?? [0, 0.0025, 0.0012, 0.0005, 0.0002];
  const totalBytes = Math.max(root.recursiveSize, 1);

  const pruneNode = (node: DiskAnalysisTreemapNode, depth: number): DiskAnalysisTreemapNode => {
    if (node.type === "file") {
      return {
        ...node,
        issues: dedupeIssues(node.issues),
        children: [],
      };
    }

    if (node.children.length === 0) {
      return {
        ...node,
        issues: dedupeIssues(node.issues),
        children: [],
      };
    }

    const threshold =
      minShareByDepth[Math.min(depth, minShareByDepth.length - 1)] ?? minShareByDepth.at(-1) ?? 0;
    const keptChildren: DiskAnalysisTreemapNode[] = [];
    let hiddenBytes = 0;
    let hiddenFileCount = 0;
    let hiddenDirectoryCount = 0;
    let hiddenHasIssues = false;

    for (const [index, child] of node.children.entries()) {
      const share = child.recursiveSize / totalBytes;
      const forceKeep = depth === 0 ? index < 24 : depth === 1 ? index < 16 : index < 10;
      const withinBudget = keptChildren.length < maxChildrenPerDirectory;
      const shouldKeep = forceKeep || (withinBudget && share >= threshold);

      if (!shouldKeep) {
        hiddenBytes += child.recursiveSize;
        hiddenHasIssues ||= child.truncated || child.issues.length > 0;
        if (child.type === "directory") {
          hiddenDirectoryCount += 1;
        } else {
          hiddenFileCount += 1;
        }
        continue;
      }

      if (depth >= maxDepth) {
        hiddenBytes += child.recursiveSize;
        hiddenHasIssues ||= child.truncated || child.issues.length > 0;
        if (child.type === "directory") {
          hiddenDirectoryCount += 1;
        } else {
          hiddenFileCount += 1;
        }
        continue;
      }

      keptChildren.push(pruneNode(child, depth + 1));
    }

    if (hiddenBytes > 0) {
      keptChildren.push(
        createAggregateBucket(
          node.path,
          hiddenFileCount,
          hiddenDirectoryCount,
          hiddenBytes,
          hiddenHasIssues
        )
      );
    }

    return {
      ...node,
      issues: dedupeIssues(node.issues),
      children: sortChildren(keptChildren),
    };
  };

  return pruneNode(root, 0);
}

/** Counts nodes only until the answer stops being interesting. */
function exceedsNodeBudget(root: DiskAnalysisTreemapNode, budget: number): boolean {
  let count = 0;
  const stack: DiskAnalysisTreemapNode[] = [root];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || visited.has(node.path)) {
      continue;
    }
    visited.add(node.path);
    count += 1;
    if (count > budget) {
      return true;
    }
    if (node.type === "directory") {
      for (const child of node.children) {
        if (child.path !== node.path) {
          stack.push(child);
        }
      }
    }
  }
  return false;
}

/**
 * Prepare a finished snapshot root for the treemap.
 *
 * Unlike `createPresentationTree`, which the live view applies unconditionally
 * because an in-progress tree is republished several times a second, this
 * returns small trees untouched -- see `SNAPSHOT_PRESENTATION_NODE_BUDGET`.
 * The returned node is the caller's own root by reference in that case, which
 * is exactly what the hover index wants: no new object, no rebuilt index.
 */
export function createSnapshotPresentationTree(
  root: DiskAnalysisTreemapNode | null,
  options: PresentationTreeOptions = {}
): DiskAnalysisTreemapNode | null {
  if (!root) {
    return null;
  }
  if (!exceedsNodeBudget(root, SNAPSHOT_PRESENTATION_NODE_BUDGET)) {
    return root;
  }
  return createPresentationTree(root, options);
}

function createSyntheticDirectory(pathValue: string): DiskAnalysisTreemapNode {
  return {
    path: pathValue,
    name: getNodeLabel(pathValue),
    type: "directory",
    size: 0,
    recursiveSize: 0,
    extension: null,
    childCount: 0,
    descendantsScanned: 0,
    truncated: false,
    issues: [],
    children: [],
  };
}


function mergeLiveBranch(
  existing: DiskAnalysisTreemapNode,
  incoming: DiskAnalysisTreemapNode
): DiskAnalysisTreemapNode {
  if (existing.type === "file" || incoming.type === "file") {
    return cloneNodeShallow(incoming);
  }

  const existingChildrenByPath = new Map(existing.children.map((child) => [child.path, child]));
  const incomingChildrenPaths = new Set(incoming.children.map((child) => child.path));
  const mergedChildren: DiskAnalysisTreemapNode[] = incoming.children
    .filter((child) => child.path !== incoming.path)
    .map((child) => {
      const prior = existingChildrenByPath.get(child.path);
      if (!prior) {
        return child;
      }
      if (
        child.type === "directory" &&
        prior.type === "directory" &&
        child.children.length === 0
      ) {
        return {
          ...child,
          recursiveSize: child.recursiveSize,
          childCount: Math.max(child.childCount, prior.childCount, prior.children.length),
          descendantsScanned: Math.max(child.descendantsScanned, prior.descendantsScanned),
          truncated: child.truncated || prior.truncated,
          issues: dedupeIssues([...prior.issues, ...child.issues]),
          children: [...prior.children],
        };
      }
      return child;
    });

  for (const prior of existing.children) {
    if (!incomingChildrenPaths.has(prior.path) && prior.path !== incoming.path) {
      mergedChildren.push(prior);
    }
  }

  return recomputeDirectoryNode({
    ...incoming,
    recursiveSize: Math.max(existing.recursiveSize, incoming.recursiveSize),
    childCount: Math.max(existing.childCount, incoming.childCount, mergedChildren.length),
    descendantsScanned: Math.max(existing.descendantsScanned, incoming.descendantsScanned),
    truncated: existing.truncated || incoming.truncated,
    issues: dedupeIssues([...existing.issues, ...incoming.issues]),
    children: sortChildren(mergedChildren),
  });
}

export function integrateBranchIntoTree(
  currentRoot: DiskAnalysisTreemapNode | null,
  mount: DiskAnalysisMountIdentity,
  branch: DiskAnalysisTreemapNode
): DiskAnalysisTreemapNode {
  const safeBranch = cloneNodeShallow(branch);
  const mountPath = getMountRootPath(mount);
  const sourceRoot = currentRoot ?? createSyntheticLiveRoot(mount);
  const workingRoot = cloneNodeShallow(sourceRoot);

  if (safeBranch.path === mountPath) {
    return mergeLiveBranch(workingRoot, safeBranch);
  }

  const parentPath = getPathParent(safeBranch.path) || mountPath;
  const chain = buildAncestorChain(parentPath, mountPath);
  let sourceCursor: DiskAnalysisTreemapNode = sourceRoot;
  let targetCursor: DiskAnalysisTreemapNode = workingRoot;
  const targetChain: DiskAnalysisTreemapNode[] = [workingRoot];

  for (const pathValue of chain) {
    const sourceChild =
      sourceCursor.type === "directory"
        ? sourceCursor.children.find(
            (child): child is DiskAnalysisTreemapNode =>
              child.type === "directory" && child.path === pathValue
          ) ?? null
        : null;
    const targetChild = sourceChild
      ? cloneNodeShallow(sourceChild)
      : createSyntheticDirectory(pathValue);
    targetCursor.children = replaceChild(targetCursor.children, targetChild);
    sourceCursor = sourceChild ?? targetChild;
    targetCursor = targetChild;
    targetChain.push(targetCursor);
  }

  const existingChild =
    sourceCursor.type === "directory"
      ? sourceCursor.children.find((child) => child.path === safeBranch.path) ?? null
      : null;
  const mergedBranch = recomputeDirectoryNode(
    existingChild ? mergeLiveBranch(existingChild, safeBranch) : safeBranch
  );
  targetCursor.children = replaceChild(targetCursor.children, mergedBranch);

  for (let index = targetChain.length - 1; index >= 0; index -= 1) {
    const node = targetChain[index];
    const recomputed = recomputeDirectoryNode(node);
    if (index === 0) {
      return recomputed;
    }
    const parent = targetChain[index - 1];
    parent.children = replaceChild(parent.children, recomputed);
  }

  return workingRoot;
}

/**
 * Depth-first, left-to-right, first path wins -- the same order the linear
 * search this replaces returned, so a duplicated path still resolves to the
 * shallowest, leftmost node carrying it.
 */
export function createNodeIndex(
  root: DiskAnalysisTreemapNode | null
): Map<string, DiskAnalysisTreemapNode> {
  const index = new Map<string, DiskAnalysisTreemapNode>();
  if (!root) {
    return index;
  }
  const stack: DiskAnalysisTreemapNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || index.has(node.path)) {
      continue;
    }
    index.set(node.path, node);
    if (node.type === "directory") {
      for (let position = node.children.length - 1; position >= 0; position -= 1) {
        const child = node.children[position];
        if (child.path !== node.path) {
          stack.push(child);
        }
      }
    }
  }
  return index;
}

/**
 * DISK-15: `hoveredPath` changes roughly every 40ms while the pointer moves,
 * and this used to answer each change with a fresh full-tree walk plus a new
 * `Set` of every path in it. On a root-filesystem snapshot that is hundreds of
 * thousands of nodes per mouse move, on the main thread, which is what made
 * the page stop responding.
 *
 * The index is cached against the root **object**, not its path or the mount:
 * a rescan produces a brand new root that reuses every path it had before, so
 * any key that is merely stable would keep serving the previous scan's nodes.
 * Object identity is the only key that is true here, and it makes the cache
 * self-invalidating -- a new root is a cache miss by construction, and a root
 * nobody holds any more is collected with its index.
 *
 * It is built lazily rather than eagerly so the raw (unpruned) tree, which the
 * treemap never renders and therefore practically never hovers into, does not
 * pay for an index on every republish.
 */
const nodeIndexByRoot = new WeakMap<
  DiskAnalysisTreemapNode,
  Map<string, DiskAnalysisTreemapNode>
>();

export function findNodeByPath(
  root: DiskAnalysisTreemapNode | null,
  targetPath: string | null
): DiskAnalysisTreemapNode | null {
  if (!root || !targetPath) {
    return null;
  }
  let index = nodeIndexByRoot.get(root);
  if (!index) {
    index = createNodeIndex(root);
    nodeIndexByRoot.set(root, index);
  }
  return index.get(targetPath) ?? null;
}

export function resolveHoveredNode(
  presentationRoot: DiskAnalysisTreemapNode | null,
  rawRoot: DiskAnalysisTreemapNode | null,
  hoveredPath: string | null,
  fallbackRoot: DiskAnalysisTreemapNode | null = null
): DiskAnalysisTreemapNode | null {
  return (
    findNodeByPath(presentationRoot, hoveredPath) ??
    findNodeByPath(rawRoot, hoveredPath) ??
    presentationRoot ??
    fallbackRoot ??
    rawRoot ??
    null
  );
}

const GENERIC_SCAN_START_FAILURE = "Failed to start disk analysis scan";

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return "";
}

function getTrpcErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const data = (error as { data?: { code?: unknown } }).data;
  return typeof data?.code === "string" ? data.code : null;
}

/**
 * Turn a rejected `startScan` into something a user can act on.
 *
 * B6 gave the scanner two distinct refusals and the router maps them to
 * distinct tRPC codes, because they are different answers: a denied or
 * pseudo-filesystem path (`FORBIDDEN`) will never scan no matter how many
 * times the button is pressed, while a full concurrency slot or a previous
 * scan still winding down (`CONFLICT`) clears on its own. Collapsing them into
 * one "scan failed" -- which is what a raw 500 got you before the mapping
 * existed -- tells the user to retry the one case that cannot work and to give
 * up on the one that would have.
 */
export function describeScanStartError(error: unknown): string {
  const detail = getErrorMessage(error).trim();
  switch (getTrpcErrorCode(error)) {
    case "FORBIDDEN":
      return detail ? `This path cannot be scanned: ${detail}` : "This path cannot be scanned.";
    case "CONFLICT":
      return detail
        ? `Something else is scanning right now - try again shortly. ${detail}`
        : "Something else is scanning right now - try again shortly.";
    default:
      return detail || GENERIC_SCAN_START_FAILURE;
  }
}

export function deriveLegendFromSnapshot(
  snapshot: DiskAnalysisSnapshot | null
): DiskAnalysisLegendItem[] {
  return snapshot?.extensionLegend ?? [];
}

export function getLegendColor(colorToken: string): string {
  const match = colorToken.match(/(\d+)$/);
  const index = match ? Math.max(0, Number(match[1]) - 1) : 0;
  return EXTENSION_COLOR_PALETTE[index % EXTENSION_COLOR_PALETTE.length];
}

export function getNodeDisplayType(node: DiskAnalysisTreemapNode): string {
  if (node.path.endsWith(SMALL_FILE_BUCKET_SUFFIX)) {
    return "Small Files Bucket";
  }
  if (node.path.endsWith(OTHER_ENTRIES_BUCKET_SUFFIX)) {
    return "Other Entries";
  }
  if (node.type === "directory") {
    return "Folder";
  }
  return node.extension ? `.${node.extension} file` : "File";
}

export function getNodeNavigationSearch(node: DiskAnalysisTreemapNode): {
  path?: string;
  reveal?: string;
  source: "disk-analysis";
} {
  if (
    node.path.endsWith(SMALL_FILE_BUCKET_SUFFIX) ||
    node.path.endsWith(OTHER_ENTRIES_BUCKET_SUFFIX)
  ) {
    return {
      path: getPathParent(node.path),
      source: "disk-analysis",
    };
  }
  if (node.type === "directory") {
    return {
      path: node.path,
      source: "disk-analysis",
    };
  }
  return {
    reveal: node.path,
    source: "disk-analysis",
  };
}
