import {
  getPathParent,
  type DiskAnalysisIssue,
  type DiskAnalysisMountIdentity,
  type DiskAnalysisSnapshot,
  type DiskAnalysisTreemapNode,
} from "../../../server/src/lib/diskAnalysisContract.js";

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

function buildAncestorChain(targetParentPath: string, mountPath: string): string[] {
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
    path: mount.mount,
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
    path: `${directoryPath}\\${OTHER_ENTRIES_BUCKET_SUFFIX}`,
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
  const sourceRoot = currentRoot ?? createSyntheticLiveRoot(mount);
  const workingRoot = cloneNodeShallow(sourceRoot);

  if (safeBranch.path === mount.mount) {
    return mergeLiveBranch(workingRoot, safeBranch);
  }

  const parentPath = getPathParent(safeBranch.path) || mount.mount;
  const chain = buildAncestorChain(parentPath, mount.mount);
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

export function flattenVisibleNodes(
  root: DiskAnalysisTreemapNode | null
): DiskAnalysisTreemapNode[] {
  if (!root) {
    return [];
  }
  const nodes: DiskAnalysisTreemapNode[] = [];
  const stack: DiskAnalysisTreemapNode[] = [root];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    if (visited.has(node.path)) {
      continue;
    }
    visited.add(node.path);
    nodes.push(node);
    if (node.type === "directory") {
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        const child = node.children[index];
        if (child.path !== node.path) {
          stack.push(child);
        }
      }
    }
  }
  return nodes;
}

export function findNodeByPath(
  root: DiskAnalysisTreemapNode | null,
  targetPath: string | null
): DiskAnalysisTreemapNode | null {
  if (!root || !targetPath) {
    return null;
  }
  const stack: DiskAnalysisTreemapNode[] = [root];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    if (node.path === targetPath) {
      return node;
    }
    if (visited.has(node.path)) {
      continue;
    }
    visited.add(node.path);
    if (node.type === "directory") {
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        const child = node.children[index];
        if (child.path !== node.path) {
          stack.push(child);
        }
      }
    }
  }
  return null;
}

export function deriveLegendFromSnapshot(
  snapshot: DiskAnalysisSnapshot | null
): DiskAnalysisLegendItem[] {
  return snapshot?.extensionLegend ?? [];
}

export function deriveLegendFromTree(
  root: DiskAnalysisTreemapNode | null
): DiskAnalysisLegendItem[] {
  if (!root) {
    return [];
  }
  const counts = new Map<string, { count: number; totalBytes: number }>();
  for (const node of flattenVisibleNodes(root)) {
    if (node.type === "file" && node.extension) {
      const current = counts.get(node.extension) ?? { count: 0, totalBytes: 0 };
      current.count += 1;
      current.totalBytes += node.recursiveSize;
      counts.set(node.extension, current);
    }
  }
  return [...counts.entries()]
    .sort(
      (left, right) =>
        right[1].totalBytes - left[1].totalBytes ||
        right[1].count - left[1].count ||
        left[0].localeCompare(right[0])
    )
    .slice(0, 20)
    .map(([extension, stats], index) => ({
      extension,
      count: stats.count,
      totalBytes: stats.totalBytes,
      colorToken: `disk-ext-${index + 1}`,
    }));
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

export function collectIssues(root: DiskAnalysisTreemapNode | null): DiskAnalysisIssue[] {
  if (!root) {
    return [];
  }
  return flattenVisibleNodes(root).flatMap((node) => node.issues);
}
