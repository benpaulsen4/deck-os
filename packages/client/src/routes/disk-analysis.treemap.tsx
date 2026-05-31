import { useEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent } from "react";
import { ArrowRight, X } from "lucide-react";
import { Button } from "../components/ui/Button";
import {
  formatBytes,
  formatCount,
  getLegendColor,
  getNodeDisplayType,
  type DiskAnalysisLegendItem,
} from "../lib/diskAnalysisClient";
import type { DiskAnalysisTreemapNode } from "../../../server/src/lib/diskAnalysisContract.js";
import { DetailRow } from "./disk-analysis.components";

type TreemapRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type TreemapDrawable = {
  node: DiskAnalysisTreemapNode;
  rect: TreemapRect;
  depth: number;
  headerHeight: number;
  headerLabel: string | null;
  showDirectoryChrome: boolean;
  color: ReturnType<typeof getNodeColor>;
};

const DEFAULT_TREEMAP_WIDTH = 960;
const DEFAULT_TREEMAP_HEIGHT = 640;
const MIN_NODE_PIXELS = 4;
const TREEMAP_NODE_GAP_PX = 1;
const DIRECTORY_HEADER_HEIGHT_PX = 20;
const MIN_DIRECTORY_HEADER_WIDTH_PX = 120;
const MIN_DIRECTORY_HEADER_HEIGHT_PX = 32;
const DIRECTORY_CHROME_MIN_SHARE = 0.01;
const FILE_LABEL_MIN_WIDTH_PX = 84;
const FILE_LABEL_MIN_HEIGHT_PX = 28;
const HOVER_EVENT_COOLDOWN_MS = 40;
const BLOCK_TEXT_COLOR_BY_FILL = new Map<string, string>([
  ["#00ff88", "#03140c"],
  ["#58d5ff", "#07131d"],
  ["#aa44ff", "#f5f7fa"],
  ["#ff8f3d", "#1b0d04"],
  ["#ffe066", "#1f1800"],
  ["#ff5470", "#20050c"],
  ["#53f5c7", "#031512"],
  ["#7aa2ff", "#071324"],
  ["#d68cff", "#16081c"],
  ["#ffb86b", "#1b1002"],
  ["#7df5a6", "#041309"],
  ["#ff7ad9", "#1f0616"],
  ["#9eff6b", "#0d1704"],
  ["#6af2ff", "#04141a"],
  ["#ffd36a", "#181101"],
  ["#8cc8ff", "#07131f"],
  ["#ff9f9f", "#1c0b0b"],
  ["#b8ff7a", "#101802"],
  ["#b18cff", "#12091d"],
  ["#f6ff7a", "#171a02"],
  ["#8aa3e3", "#0a1020"],
]);

export function TreemapCanvas({
  root,
  legendByExtension,
  compactMode,
  onHoverNode,
  onOpenNode,
}: {
  root: DiskAnalysisTreemapNode;
  legendByExtension: Map<string, DiskAnalysisLegendItem>;
  compactMode: boolean;
  onHoverNode: (path: string | null) => void;
  onOpenNode: (node: DiskAnalysisTreemapNode) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hoveredNodeRef = useRef<DiskAnalysisTreemapNode | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const pendingHoverPointRef = useRef<{ x: number; y: number } | null>(null);
  const lastHoverUpdateAtRef = useRef(0);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [hoveredPath, setHoveredPath] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<DiskAnalysisTreemapNode | null>(null);
  const canvasWidth = containerSize.width > 0 ? containerSize.width : DEFAULT_TREEMAP_WIDTH;
  const canvasHeight = containerSize.height > 0 ? containerSize.height : DEFAULT_TREEMAP_HEIGHT;
  const drawables = useMemo(
    () => buildTreemapDrawables(root, legendByExtension, canvasWidth, canvasHeight),
    [canvasHeight, canvasWidth, legendByExtension, root]
  );

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

  useEffect(() => {
    drawTreemapCanvas(canvasRef.current, drawables, canvasWidth, canvasHeight, hoveredPath);
  }, [canvasHeight, canvasWidth, drawables, hoveredPath]);

  useEffect(() => {
    if (!compactMode) {
      setSelectedNode(null);
    }
  }, [compactMode]);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
      }
      onHoverNode(null);
    };
  }, [onHoverNode]);

  const updateHoveredNode = (node: DiskAnalysisTreemapNode | null) => {
    hoveredNodeRef.current = node;
    const nextPath = node?.path ?? null;
    setHoveredPath((current) => (current === nextPath ? current : nextPath));
    onHoverNode(nextPath);
  };

  const resolveNodeFromPointer = (
    event:
      | MouseEvent<HTMLCanvasElement>
      | KeyboardEvent<HTMLCanvasElement>
      | FocusEvent<HTMLCanvasElement>
  ) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return null;
    }
    const bounds = canvas.getBoundingClientRect();
    const pointerEvent = "clientX" in event ? event : null;
    const x =
      pointerEvent && bounds.width > 0 ? pointerEvent.clientX - bounds.left : canvasWidth / 2;
    const y =
      pointerEvent && bounds.height > 0 ? pointerEvent.clientY - bounds.top : canvasHeight / 2;
    return findDrawableAtPoint(drawables, x, y)?.node ?? null;
  };

  const resolveNodeFromPoint = (x: number, y: number) =>
    findDrawableAtPoint(drawables, x, y)?.node ?? null;

  const flushQueuedHover = () => {
    hoverTimerRef.current = null;
    const point = pendingHoverPointRef.current;
    pendingHoverPointRef.current = null;
    lastHoverUpdateAtRef.current = performance.now();
    updateHoveredNode(point ? resolveNodeFromPoint(point.x, point.y) : null);
  };

  const queueHoverUpdate = (x: number, y: number) => {
    pendingHoverPointRef.current = { x, y };
    const elapsedMs = performance.now() - lastHoverUpdateAtRef.current;
    if (elapsedMs >= HOVER_EVENT_COOLDOWN_MS && hoverTimerRef.current === null) {
      flushQueuedHover();
      return;
    }
    if (hoverTimerRef.current !== null) {
      return;
    }
    hoverTimerRef.current = window.setTimeout(
      flushQueuedHover,
      Math.max(0, HOVER_EVENT_COOLDOWN_MS - elapsedMs)
    );
  };

  return (
    <div ref={containerRef} className="disk-analysis-treemap">
      <canvas
        ref={canvasRef}
        className="disk-analysis-treemap__canvas"
        role="img"
        aria-label="Disk usage treemap"
        tabIndex={0}
        onMouseMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          queueHoverUpdate(event.clientX - bounds.left, event.clientY - bounds.top);
        }}
        onMouseLeave={() => {
          if (hoverTimerRef.current !== null) {
            window.clearTimeout(hoverTimerRef.current);
            hoverTimerRef.current = null;
          }
          pendingHoverPointRef.current = null;
          updateHoveredNode(null);
        }}
        onDoubleClick={(event) => {
          const node = resolveNodeFromPointer(event);
          if (node) {
            onOpenNode(node);
          }
        }}
        onClick={(event) => {
          if (!compactMode) {
            return;
          }
          const node = resolveNodeFromPointer(event);
          setSelectedNode(node);
        }}
        onFocus={(event) => {
          updateHoveredNode(resolveNodeFromPointer(event));
        }}
        onBlur={() => {
          updateHoveredNode(null);
        }}
        onKeyDown={(event) => {
          if ((event.key === "Enter" || event.key === " ") && hoveredNodeRef.current) {
            event.preventDefault();
            onOpenNode(hoveredNodeRef.current);
          }
        }}
      />
      {!compactMode ? (
        <div className="disk-analysis-treemap__hint">Double-click a block to open it in Files.</div>
      ) : null}
      {compactMode && selectedNode ? (
        <div className="disk-analysis-treemap__popover" role="dialog" aria-label="Selected block details">
          <div className="disk-analysis-treemap__popover-header">
            <div className="disk-analysis-treemap__popover-title">{selectedNode.name}</div>
            <Button
              type="button"
              variant="icon"
              onClick={() => setSelectedNode(null)}
              aria-label="Close selected block details"
            >
              <X size={14} />
            </Button>
          </div>
          <div className="disk-analysis-details__type">{getNodeDisplayType(selectedNode)}</div>
          <div className="disk-analysis-details__path">{selectedNode.path}</div>
          <div className="disk-analysis-treemap__popover-stats">
            <DetailRow label="Recursive Size" value={formatBytes(selectedNode.recursiveSize)} />
            <DetailRow label="Children" value={formatCount(selectedNode.childCount)} />
          </div>
          <div className="disk-analysis-treemap__popover-actions">
            <Button
              type="button"
              onClick={() => {
                onOpenNode(selectedNode);
              }}
            >
              <ArrowRight size={14} />
              <span>Open In Files</span>
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function layoutNodes(
  nodes: DiskAnalysisTreemapNode[],
  rect: TreemapRect,
  minNodePixels: number
): Array<{ node: DiskAnalysisTreemapNode; rect: TreemapRect }> {
  const weighted = nodes
    .filter((node) => node.recursiveSize > 0)
    .slice()
    .sort((left, right) => right.recursiveSize - left.recursiveSize)
    .map((node) => ({
      node,
      weight: Math.max(node.recursiveSize, 1),
    }));
  const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0 || rect.width <= 0 || rect.height <= 0) {
    return [];
  }

  const layouts: Array<{ node: DiskAnalysisTreemapNode; rect: TreemapRect }> = [];
  const sumWeight = (items: Array<{ node: DiskAnalysisTreemapNode; weight: number }>) =>
    items.reduce((sum, item) => sum + item.weight, 0);
  const recurse = (
    items: Array<{ node: DiskAnalysisTreemapNode; weight: number }>,
    nextRect: TreemapRect
  ) => {
    if (items.length === 0 || nextRect.width < minNodePixels || nextRect.height < minNodePixels) {
      return;
    }
    if (items.length === 1) {
      layouts.push({
        node: items[0].node,
        rect: nextRect,
      });
      return;
    }

    const itemsTotalWeight = sumWeight(items);
    const splitTarget = itemsTotalWeight / 2;
    const firstGroup: Array<{ node: DiskAnalysisTreemapNode; weight: number }> = [];
    const secondGroup: Array<{ node: DiskAnalysisTreemapNode; weight: number }> = [];
    let runningWeight = 0;

    for (const item of items) {
      const nextWeight = runningWeight + item.weight;
      if (
        firstGroup.length === 0 ||
        (nextWeight <= splitTarget && secondGroup.length === 0)
      ) {
        firstGroup.push(item);
        runningWeight = nextWeight;
      } else {
        secondGroup.push(item);
      }
    }

    if (secondGroup.length === 0) {
      secondGroup.push(firstGroup.pop()!);
    }

    const firstWeight = sumWeight(firstGroup);
    const splitHorizontal = nextRect.width >= nextRect.height;
    if (splitHorizontal) {
      const leftWidth = nextRect.width * (firstWeight / itemsTotalWeight);
      recurse(firstGroup, {
        x: nextRect.x,
        y: nextRect.y,
        width: leftWidth,
        height: nextRect.height,
      });
      recurse(secondGroup, {
        x: nextRect.x + leftWidth,
        y: nextRect.y,
        width: Math.max(0, nextRect.width - leftWidth),
        height: nextRect.height,
      });
      return;
    }

    const topHeight = nextRect.height * (firstWeight / itemsTotalWeight);
    recurse(firstGroup, {
      x: nextRect.x,
      y: nextRect.y,
      width: nextRect.width,
      height: topHeight,
    });
    recurse(secondGroup, {
      x: nextRect.x,
      y: nextRect.y + topHeight,
      width: nextRect.width,
      height: Math.max(0, nextRect.height - topHeight),
    });
  };
  recurse(weighted, rect);

  return layouts.filter(
    (item) => item.rect.width >= minNodePixels && item.rect.height >= minNodePixels
  );
}

function buildTreemapDrawables(
  root: DiskAnalysisTreemapNode,
  legendByExtension: Map<string, DiskAnalysisLegendItem>,
  canvasWidth: number,
  canvasHeight: number
): TreemapDrawable[] {
  const visibleNodes = root.children.length > 0 ? root.children : [root];
  const totalBytes = Math.max(root.recursiveSize, 1);
  const drawables: TreemapDrawable[] = [];

  const visitNode = (node: DiskAnalysisTreemapNode, rect: TreemapRect, depth: number) => {
    if (rect.width < MIN_NODE_PIXELS || rect.height < MIN_NODE_PIXELS) {
      return;
    }

    const sizeShare = node.recursiveSize / totalBytes;
    const showDirectoryChrome =
      node.type === "directory" && sizeShare >= DIRECTORY_CHROME_MIN_SHARE;
    const headerLabel =
      node.type === "directory" &&
      showDirectoryChrome &&
      rect.width >= MIN_DIRECTORY_HEADER_WIDTH_PX &&
      rect.height >= MIN_DIRECTORY_HEADER_HEIGHT_PX
        ? `${node.name} (${formatBytes(node.recursiveSize)})`
        : null;
    const headerHeight =
      node.type === "directory" && headerLabel
        ? Math.min(DIRECTORY_HEADER_HEIGHT_PX, Math.max(0, rect.height * 0.3))
        : 0;
    drawables.push({
      node,
      rect,
      depth,
      headerHeight,
      headerLabel,
      showDirectoryChrome,
      color: getNodeColor(node, legendByExtension, depth),
    });

    if (node.type !== "directory" || node.children.length === 0) {
      return;
    }

    const inset = showDirectoryChrome ? TREEMAP_NODE_GAP_PX : 0;
    const childRect = {
      x: rect.x + inset,
      y: rect.y + headerHeight + inset,
      width: Math.max(0, rect.width - inset * 2),
      height: Math.max(0, rect.height - headerHeight - inset * 2),
    };
    if (childRect.width < MIN_NODE_PIXELS || childRect.height < MIN_NODE_PIXELS) {
      return;
    }

    for (const childLayout of layoutNodes(node.children, childRect, MIN_NODE_PIXELS)) {
      visitNode(childLayout.node, childLayout.rect, depth + 1);
    }
  };

  for (const childLayout of layoutNodes(
    visibleNodes,
    {
      x: 0,
      y: 0,
      width: canvasWidth,
      height: canvasHeight,
    },
    MIN_NODE_PIXELS
  )) {
    visitNode(childLayout.node, insetTreemapRect(childLayout.rect, TREEMAP_NODE_GAP_PX), 0);
  }

  return drawables;
}

function insetTreemapRect(rect: TreemapRect, amount: number): TreemapRect {
  if (amount <= 0) {
    return rect;
  }
  const insetX = Math.min(amount / 2, rect.width / 4);
  const insetY = Math.min(amount / 2, rect.height / 4);
  return {
    x: rect.x + insetX,
    y: rect.y + insetY,
    width: Math.max(0, rect.width - insetX * 2),
    height: Math.max(0, rect.height - insetY * 2),
  };
}

function findDrawableAtPoint(drawables: TreemapDrawable[], x: number, y: number): TreemapDrawable | null {
  for (let index = drawables.length - 1; index >= 0; index -= 1) {
    const drawable = drawables[index];
    if (
      x >= drawable.rect.x &&
      x <= drawable.rect.x + drawable.rect.width &&
      y >= drawable.rect.y &&
      y <= drawable.rect.y + drawable.rect.height
    ) {
      return drawable;
    }
  }
  return null;
}

function drawTreemapCanvas(
  canvas: HTMLCanvasElement | null,
  drawables: TreemapDrawable[],
  width: number,
  height: number,
  hoveredPath: string | null
) {
  if (!canvas || width <= 0 || height <= 0) {
    return;
  }
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);

  const styles = getComputedStyle(canvas);
  const textPrimary = styles.getPropertyValue("--text-primary").trim() || "#f5f7fa";
  const textMuted =
    styles.getPropertyValue("--text-muted").trim() || "rgba(255, 255, 255, 0.72)";
  const accent = styles.getPropertyValue("--accent-primary").trim() || "#00ff88";

  for (const drawable of drawables) {
    context.fillStyle = drawable.color.background;
    context.fillRect(drawable.rect.x, drawable.rect.y, drawable.rect.width, drawable.rect.height);

    if (drawable.node.type === "file" || drawable.showDirectoryChrome) {
      context.strokeStyle = drawable.color.border;
      context.lineWidth = 1;
      context.strokeRect(
        drawable.rect.x + 0.5,
        drawable.rect.y + 0.5,
        Math.max(0, drawable.rect.width - 1),
        Math.max(0, drawable.rect.height - 1)
      );
    }

    if (drawable.headerLabel && drawable.headerHeight > 0) {
      context.fillStyle = "rgba(0, 0, 0, 0.3)";
      context.fillRect(
        drawable.rect.x,
        drawable.rect.y,
        drawable.rect.width,
        drawable.headerHeight
      );
      context.fillStyle = textPrimary;
      context.font = "500 10px monospace";
      context.textBaseline = "middle";
      const label = truncateCanvasText(
        context,
        drawable.headerLabel,
        Math.max(24, drawable.rect.width - 12)
      );
      context.fillText(label, drawable.rect.x + 6, drawable.rect.y + drawable.headerHeight / 2);
    } else if (
      drawable.node.type === "file" &&
      drawable.rect.width >= FILE_LABEL_MIN_WIDTH_PX &&
      drawable.rect.height >= FILE_LABEL_MIN_HEIGHT_PX
    ) {
      context.fillStyle = resolveCanvasColor(drawable.color.text, textPrimary) ?? textMuted;
      context.font = "500 11px monospace";
      context.textBaseline = "middle";
      const label = truncateCanvasText(
        context,
        drawable.node.name,
        Math.max(24, drawable.rect.width - 12)
      );
      context.fillText(label, drawable.rect.x + 6, drawable.rect.y + drawable.rect.height / 2);
    }
  }

  if (!hoveredPath) {
    return;
  }
  const hoveredDrawable = drawables.find((drawable) => drawable.node.path === hoveredPath);
  if (!hoveredDrawable) {
    return;
  }
  context.strokeStyle = accent;
  context.lineWidth = 2;
  context.strokeRect(
    hoveredDrawable.rect.x + 1,
    hoveredDrawable.rect.y + 1,
    Math.max(0, hoveredDrawable.rect.width - 2),
    Math.max(0, hoveredDrawable.rect.height - 2)
  );
}

function truncateCanvasText(
  context: CanvasRenderingContext2D,
  value: string,
  maxWidth: number
): string {
  if (maxWidth <= 0 || context.measureText(value).width <= maxWidth) {
    return value;
  }
  const ellipsis = "...";
  let endIndex = value.length;
  while (endIndex > 0) {
    const candidate = `${value.slice(0, endIndex)}${ellipsis}`;
    if (context.measureText(candidate).width <= maxWidth) {
      return candidate;
    }
    endIndex -= 1;
  }
  return ellipsis;
}

function resolveCanvasColor(value: string, fallback: string): string {
  const match = value.match(/^var\((--[^)]+)\)$/);
  if (!match) {
    return value || fallback;
  }
  const resolved = getComputedStyle(document.documentElement).getPropertyValue(match[1]).trim();
  return resolved || fallback;
}

function getCanvasTextColorForFill(fill: string, fallback: string): string {
  const normalizedFill = fill.trim().toLowerCase();
  return BLOCK_TEXT_COLOR_BY_FILL.get(normalizedFill) ?? fallback;
}

function getNodeColor(
  node: DiskAnalysisTreemapNode,
  legendByExtension: Map<string, DiskAnalysisLegendItem>,
  depth: number
) {
  if (node.path.endsWith("__deckos_other_entries__")) {
    return {
      background: "#8aa3e3",
      border: "#abc0f5",
      text: getCanvasTextColorForFill("#8aa3e3", "#0a1020"),
    };
  }
  if (node.type === "file") {
    const legendItem = node.extension ? legendByExtension.get(node.extension) : undefined;
    const base = legendItem ? getLegendColor(legendItem.colorToken) : "#5f6877";
    return {
      background: base,
      border: legendItem ? base : "rgba(122, 132, 155, 0.55)",
      text: getCanvasTextColorForFill(base, "#f5f7fa"),
    };
  }
  const tint = Math.max(34, 74 - depth * 8);
  return {
    background: `rgb(${tint}, ${tint}, ${tint})`,
    border: "rgba(255, 255, 255, 0.16)",
    text: "var(--text-primary)",
  };
}
