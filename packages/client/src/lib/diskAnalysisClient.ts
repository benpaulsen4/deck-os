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

function cloneNode(node: DiskAnalysisTreemapNode): DiskAnalysisTreemapNode {
  return {
    ...node,
    issues: [...node.issues],
    children: node.children.map(cloneNode),
  };
}

function sortTree(node: DiskAnalysisTreemapNode): DiskAnalysisTreemapNode {
  if (node.type === "file") {
    return node;
  }
  const children = node.children.map(sortTree).sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "directory" ? -1 : 1;
    }
    return right.recursiveSize - left.recursiveSize || left.name.localeCompare(right.name);
  });
  const recursiveSize = children.reduce((sum, child) => sum + child.recursiveSize, node.size);
  const descendantsScanned = children.reduce((sum, child) => {
    return sum + (child.type === "directory" ? child.descendantsScanned + 1 : 0);
  }, 0);
  const issues = children.reduce<DiskAnalysisIssue[]>((sum, child) => {
    if (child.issues.length > 0) {
      sum.push(...child.issues);
    }
    return sum;
  }, [...node.issues]);
  return {
    ...node,
    childCount: children.length,
    recursiveSize,
    descendantsScanned,
    truncated: node.truncated || children.some((child) => child.truncated),
    issues,
    children,
  };
}

function replaceOrInsertChild(
  node: DiskAnalysisTreemapNode,
  parentPath: string,
  branch: DiskAnalysisTreemapNode
): boolean {
  if (node.type !== "directory") {
    return false;
  }
  if (node.path === parentPath) {
    const nextChildren = [...node.children];
    const existingIndex = nextChildren.findIndex((child) => child.path === branch.path);
    if (existingIndex >= 0) {
      nextChildren[existingIndex] = branch;
    } else {
      nextChildren.push(branch);
    }
    node.children = nextChildren;
    return true;
  }
  for (const child of node.children) {
    if (replaceOrInsertChild(child, parentPath, branch)) {
      return true;
    }
  }
  return false;
}

export function integrateBranchIntoTree(
  currentRoot: DiskAnalysisTreemapNode | null,
  mount: DiskAnalysisMountIdentity,
  branch: DiskAnalysisTreemapNode
): DiskAnalysisTreemapNode {
  if (branch.path === mount.mount) {
    return sortTree(cloneNode(branch));
  }

  const workingRoot = cloneNode(currentRoot ?? createSyntheticLiveRoot(mount));
  const inserted = replaceOrInsertChild(
    workingRoot,
    getPathParent(branch.path) || mount.mount,
    cloneNode(branch)
  );
  if (!inserted && getPathParent(branch.path) === mount.mount) {
    workingRoot.children = [...workingRoot.children, cloneNode(branch)];
  }
  return sortTree(workingRoot);
}

export function flattenVisibleNodes(
  root: DiskAnalysisTreemapNode | null
): DiskAnalysisTreemapNode[] {
  if (!root) {
    return [];
  }
  const nodes: DiskAnalysisTreemapNode[] = [];
  const visit = (node: DiskAnalysisTreemapNode) => {
    nodes.push(node);
    if (node.type === "directory") {
      for (const child of node.children) {
        visit(child);
      }
    }
  };
  visit(root);
  return nodes;
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
  const counts = new Map<string, number>();
  for (const node of flattenVisibleNodes(root)) {
    if (node.type === "file" && node.extension) {
      counts.set(node.extension, (counts.get(node.extension) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 20)
    .map(([extension, count], index) => ({
      extension,
      count,
      colorToken: `disk-ext-${index + 1}`,
    }));
}

export function getLegendColor(colorToken: string): string {
  const match = colorToken.match(/(\d+)$/);
  const index = match ? Math.max(0, Number(match[1]) - 1) : 0;
  return EXTENSION_COLOR_PALETTE[index % EXTENSION_COLOR_PALETTE.length];
}

export function getNodeDisplayType(node: DiskAnalysisTreemapNode): string {
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
