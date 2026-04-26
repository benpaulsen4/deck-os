import { createHash } from "node:crypto";
import { opendir, lstat, stat } from "node:fs/promises";
import path from "node:path";
import fs from "fs-extra";
import si from "systeminformation";
import { DATA_DIR } from "../lib/config.js";
import type {
  StorageAnalysisAnalyzerKind,
  StorageAnalysisExtensionLegendEntry,
  StorageAnalysisErrorCode,
  StorageAnalysisMount,
  StorageAnalysisNode,
  StorageAnalysisResponse,
  StorageAnalysisSnapshot,
  StorageAnalysisWarningCode,
} from "../lib/schema.js";

const STORAGE_ANALYSIS_DIR = path.join(DATA_DIR, "storage-analysis");
// These guardrails keep the first release responsive while leaving room for future profiling.
const STORAGE_ANALYSIS_TTL_MS = 5 * 60 * 1000;
const STORAGE_ANALYSIS_MAX_NODES = 40_000;
const STORAGE_ANALYSIS_SCAN_CONCURRENCY = 24;
const EXTENSION_COLOR_PALETTE = [
  "#ff7b72",
  "#f2cc60",
  "#7ee787",
  "#79c0ff",
  "#d2a8ff",
  "#ffa657",
  "#56d364",
  "#58a6ff",
  "#bc8cff",
  "#f778ba",
  "#3fb950",
  "#a5d6ff",
  "#ffb86b",
  "#c297ff",
  "#6ee7b7",
  "#fda4af",
  "#93c5fd",
  "#f9a8d4",
  "#86efac",
  "#fde68a",
] as const;

type SupportedAnalysisStatus = StorageAnalysisResponse["status"];

type StorageAnalysisContext = {
  mount: StorageAnalysisMount;
  mountKey: string;
  startedAt: string;
};

type StorageAnalysisSuccess = {
  analyzer: StorageAnalysisAnalyzerKind;
  sourceKind: StorageAnalysisSnapshot["sourceKind"];
  root: StorageAnalysisNode;
  totalSize: number;
  nodeCount: number;
  oversized: boolean;
  extensionHistogram: StorageAnalysisExtensionLegendEntry[];
  warningCode: StorageAnalysisWarningCode | null;
  warning: string | null;
};

type JobRecord = {
  startedAt: string;
  state: SupportedAnalysisStatus;
  promise: Promise<void>;
  errorCode: StorageAnalysisErrorCode | null;
  error: string | null;
};

type ScanStats = {
  nodeCount: number;
  oversized: boolean;
  permissionDeniedCount: number;
  extensionCounts: Map<string, { count: number; totalSize: number }>;
};

type PartialScanSnapshot = {
  root: StorageAnalysisNode;
  totalSize: number;
  nodeCount: number;
  oversized: boolean;
  extensionHistogram: StorageAnalysisExtensionLegendEntry[];
  warningCode: StorageAnalysisWarningCode | null;
  warning: string | null;
};

type ServiceDeps = {
  fsSize: typeof si.fsSize;
  statImpl: typeof stat;
  lstatImpl: typeof lstat;
  opendirImpl: typeof opendir;
  now: () => number;
};

class StorageAnalysisFailure extends Error {
  code: StorageAnalysisErrorCode;

  constructor(code: StorageAnalysisErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "StorageAnalysisFailure";
  }
}

const jobs = new Map<string, JobRecord>();

function createMountKey(fsName: string, mount: string): string {
  return createHash("sha1").update(`${fsName}\0${mount}`).digest("hex").slice(0, 16);
}

function getSnapshotPath(mountKey: string): string {
  return path.join(STORAGE_ANALYSIS_DIR, `${mountKey}.json`);
}

function getMetaPath(mountKey: string): string {
  return path.join(STORAGE_ANALYSIS_DIR, `${mountKey}.meta.json`);
}

function getNodeName(targetPath: string): string {
  const normalized = targetPath.replace(/\\/g, "/");
  if (normalized === "/") {
    return "/";
  }
  const trimmed = normalized.replace(/\/+$/, "");
  const parts = trimmed.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? trimmed;
}

function getExtension(targetPath: string, type: StorageAnalysisNode["type"]): string | null {
  if (type !== "file") {
    return null;
  }
  const ext = path.extname(targetPath).trim().toLowerCase();
  return ext.length > 0 ? ext : null;
}

function extensionLabel(extension: string): string {
  return extension.length > 0 ? extension.slice(1).toUpperCase() : "(none)";
}

function normalizeMountPath(mountPath: string): string {
  if (process.platform === "win32" && /^[a-zA-Z]:$/.test(mountPath)) {
    return `${mountPath}\\`;
  }
  return mountPath;
}

function cloneNode(node: StorageAnalysisNode): StorageAnalysisNode {
  return {
    ...node,
    children: node.children.map(cloneNode),
  };
}

function createRequestedMount(input: { mount: string; fs: string }): StorageAnalysisMount {
  return {
    id: createMountKey(input.fs, input.mount),
    mount: input.mount,
    fs: input.fs,
    filesystemType: "unknown",
    size: 0,
    used: 0,
    deviceId: null,
  };
}

function toSnapshotResponse(
  snapshot: StorageAnalysisSnapshot,
  status: SupportedAnalysisStatus,
  refreshing: boolean,
  errorCode: StorageAnalysisErrorCode | null,
  error: string | null
): StorageAnalysisResponse {
  return {
    mount: snapshot.mount,
    status,
    analyzer: snapshot.analyzer,
    sourceKind:
      status === "stale" ? "cache-stale" : snapshot.sourceKind === "cache-stale" ? "cache-fresh" : snapshot.sourceKind,
    mountKey: snapshot.mountKey,
    generatedAt: snapshot.generatedAt,
    startedAt: snapshot.startedAt,
    completedAt: snapshot.completedAt,
    freshnessTtlMs: snapshot.freshnessTtlMs,
    totalSize: snapshot.totalSize,
    nodeCount: snapshot.nodeCount,
    isPartial: status === "scanning",
    oversized: snapshot.oversized,
    extensionHistogram: snapshot.extensionHistogram,
    root: snapshot.root,
    refreshing,
    errorCode,
    error,
    warningCode: snapshot.warningCode ?? null,
    warning: snapshot.warning ?? null,
  };
}

function pendingResponse(
  mount: StorageAnalysisMount,
  mountKey: string,
  startedAt: string | null,
  errorCode: StorageAnalysisErrorCode | null,
  error: string | null
): StorageAnalysisResponse {
  return {
    mount,
    status: error ? "failed" : "scanning",
    analyzer: null,
    sourceKind: "pending",
    mountKey,
    generatedAt: null,
    startedAt,
    completedAt: null,
    freshnessTtlMs: STORAGE_ANALYSIS_TTL_MS,
    totalSize: null,
    nodeCount: null,
    isPartial: false,
    oversized: false,
    extensionHistogram: [],
    root: null,
    refreshing: !error,
    errorCode,
    error,
    warningCode: null,
    warning: null,
  };
}

function isSnapshotFresh(snapshot: StorageAnalysisSnapshot, nowMs: number): boolean {
  const completedAtMs = Date.parse(snapshot.completedAt);
  if (!Number.isFinite(completedAtMs)) {
    return false;
  }
  return nowMs - completedAtMs <= snapshot.freshnessTtlMs;
}

async function readSnapshot(mountKey: string): Promise<StorageAnalysisSnapshot | null> {
  const snapshotPath = getSnapshotPath(mountKey);
  if (!(await fs.pathExists(snapshotPath))) {
    return null;
  }
  return await fs.readJson(snapshotPath);
}

async function writeSnapshot(snapshot: StorageAnalysisSnapshot): Promise<void> {
  await fs.ensureDir(STORAGE_ANALYSIS_DIR);
  await fs.writeJson(getSnapshotPath(snapshot.mountKey), snapshot);
  await fs.writeJson(getMetaPath(snapshot.mountKey), {
    mountKey: snapshot.mountKey,
    mount: snapshot.mount.mount,
    fs: snapshot.mount.fs,
    filesystemType: snapshot.mount.filesystemType,
    analyzer: snapshot.analyzer,
    sourceKind: snapshot.sourceKind,
    startedAt: snapshot.startedAt,
    completedAt: snapshot.completedAt,
    rootPath: snapshot.root.path,
    deviceId: snapshot.mount.deviceId,
    nodeCount: snapshot.nodeCount,
    totalSize: snapshot.totalSize,
    oversized: snapshot.oversized,
    extensionHistogram: snapshot.extensionHistogram,
    warningCode: snapshot.warningCode ?? null,
    warning: snapshot.warning ?? null,
  });
}

function createLimiter(concurrency: number) {
  let activeCount = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    activeCount -= 1;
    const run = queue.shift();
    if (run) {
      run();
    }
  };

  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (activeCount >= concurrency) {
      await new Promise<void>((resolve) => {
        queue.push(resolve);
      });
    }
    activeCount += 1;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

function buildExtensionHistogram(
  counts: Map<string, { count: number; totalSize: number }>
): StorageAnalysisExtensionLegendEntry[] {
  return [...counts.entries()]
    .sort((left, right) => {
      const countDelta = right[1].count - left[1].count;
      if (countDelta !== 0) {
        return countDelta;
      }
      const sizeDelta = right[1].totalSize - left[1].totalSize;
      if (sizeDelta !== 0) {
        return sizeDelta;
      }
      return left[0].localeCompare(right[0]);
    })
    .slice(0, EXTENSION_COLOR_PALETTE.length)
    .map(([extension, value], index) => ({
      extension,
      label: extensionLabel(extension),
      count: value.count,
      totalSize: value.totalSize,
      color: EXTENSION_COLOR_PALETTE[index],
    }));
}

async function scanTree(
  rootPath: string,
  rootDeviceId: number,
  deps: ServiceDeps,
  onPartialSnapshot?: (partial: PartialScanSnapshot) => Promise<void>
): Promise<StorageAnalysisSuccess> {
  const limit = createLimiter(STORAGE_ANALYSIS_SCAN_CONCURRENCY);
  const stats: ScanStats = {
    nodeCount: 0,
    oversized: false,
    permissionDeniedCount: 0,
    extensionCounts: new Map(),
  };

  const buildWarningState = () => ({
    warningCode: stats.permissionDeniedCount > 0 ? ("partial-permissions" as const) : null,
    warning:
      stats.permissionDeniedCount > 0
        ? `Skipped ${stats.permissionDeniedCount} path${stats.permissionDeniedCount === 1 ? "" : "s"} because DeckOS did not have permission to read them.`
        : null,
  });

  const emitPartialSnapshot = async (root: StorageAnalysisNode) => {
    if (!onPartialSnapshot) {
      return;
    }
    const warningState = buildWarningState();
    await onPartialSnapshot({
      root: cloneNode(root),
      totalSize: root.size,
      nodeCount: stats.nodeCount,
      oversized: stats.oversized,
      extensionHistogram: buildExtensionHistogram(stats.extensionCounts),
      warningCode: warningState.warningCode,
      warning: warningState.warning,
    });
  };

  const visit = async (targetPath: string, isRoot = false): Promise<StorageAnalysisNode | null> => {
    let entryStat;
    try {
      entryStat = await limit(() => deps.lstatImpl(targetPath));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "EACCES" || code === "EPERM") {
        if (targetPath === rootPath) {
          throw new StorageAnalysisFailure(
            "permission-denied",
            "DeckOS cannot read this mount. Check filesystem permissions and try again."
          );
        }
        stats.permissionDeniedCount += 1;
        return null;
      }
      throw error;
    }
    if (entryStat.dev !== rootDeviceId) {
      return null;
    }

    const type: StorageAnalysisNode["type"] = entryStat.isDirectory()
      ? "directory"
      : entryStat.isFile()
        ? "file"
        : entryStat.isSymbolicLink()
          ? "symlink"
          : "other";

    if (type === "directory") {
      let dir;
      try {
        dir = await limit(() => deps.opendirImpl(targetPath));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code === "EACCES" || code === "EPERM") {
          if (targetPath === rootPath) {
            throw new StorageAnalysisFailure(
              "permission-denied",
              "DeckOS cannot open this mount. Check filesystem permissions and try again."
            );
          }
          stats.permissionDeniedCount += 1;
          return null;
        }
        throw error;
      }
      const node: StorageAnalysisNode = {
        path: targetPath,
        name: getNodeName(targetPath),
        type,
        size: 0,
        extension: null,
        childCount: 0,
        children: [],
      };
      const childTasks: Promise<void>[] = [];
      for await (const entry of dir) {
        const childPath = path.join(targetPath, entry.name);
        const task = visit(childPath).catch((error: unknown) => {
          const code = (error as NodeJS.ErrnoException | undefined)?.code;
          if (code === "EACCES" || code === "EPERM" || code === "ENOENT") {
            if (code === "EACCES" || code === "EPERM") {
              stats.permissionDeniedCount += 1;
            }
            return null;
          }
          throw error;
        });
        childTasks.push(
          task.then(async (child) => {
            if (!child) {
              return;
            }
            node.children.push(child);
            node.children.sort(
              (left, right) => right.size - left.size || left.name.localeCompare(right.name)
            );
            node.childCount = node.children.length;
            node.size = node.children.reduce((sum, current) => sum + current.size, 0);
            if (isRoot) {
              await emitPartialSnapshot(node);
            }
          })
        );
      }
      await Promise.all(childTasks);
      stats.nodeCount += 1;
      stats.oversized ||= stats.nodeCount > STORAGE_ANALYSIS_MAX_NODES;
      return node;
    }

    const extension = getExtension(targetPath, type);
    if (extension) {
      const current = stats.extensionCounts.get(extension) ?? { count: 0, totalSize: 0 };
      current.count += 1;
      current.totalSize += entryStat.size;
      stats.extensionCounts.set(extension, current);
    }
    stats.nodeCount += 1;
    stats.oversized ||= stats.nodeCount > STORAGE_ANALYSIS_MAX_NODES;
    return {
      path: targetPath,
      name: getNodeName(targetPath),
      type,
      size: entryStat.size,
      extension,
      childCount: 0,
      children: [],
    };
  };

  const root = await visit(rootPath, true);
  if (!root) {
    throw new Error(`Unable to scan root path: ${rootPath}`);
  }

  const warningState = buildWarningState();
  return {
    analyzer: "scan",
    sourceKind: "scan",
    root,
    totalSize: root.size,
    nodeCount: stats.nodeCount,
    oversized: stats.oversized,
    extensionHistogram: buildExtensionHistogram(stats.extensionCounts),
    warningCode: warningState.warningCode,
    warning: warningState.warning,
  };
}

const defaultDeps: ServiceDeps = {
  fsSize: si.fsSize,
  statImpl: stat,
  lstatImpl: lstat,
  opendirImpl: opendir,
  now: () => Date.now(),
};

async function resolveMount(
  mountPath: string,
  fsName: string,
  deps: ServiceDeps
): Promise<StorageAnalysisMount> {
  const entries = await deps.fsSize();
  const match = entries.find((entry) => entry.mount === mountPath && entry.fs === fsName);
  if (!match) {
    throw new StorageAnalysisFailure(
      "unsupported",
      "This disk is no longer available. Re-open analysis from Settings."
    );
  }
  let rootStat;
  try {
    const normalizedMount = normalizeMountPath(match.mount);
    rootStat = await deps.statImpl(normalizedMount);
    return {
      id: createMountKey(match.fs, match.mount),
      mount: normalizedMount,
      fs: match.fs,
      filesystemType: (match.type || "unknown").toLowerCase(),
      size: match.size,
      used: match.used,
      deviceId: Number.isFinite(rootStat.dev) ? rootStat.dev : null,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EACCES" || code === "EPERM") {
      throw new StorageAnalysisFailure(
        "permission-denied",
        "DeckOS cannot inspect this mount. Check filesystem permissions and try again."
      );
    }
    throw new StorageAnalysisFailure(
      "runtime-failed",
      error instanceof Error ? error.message : "Storage analysis failed unexpectedly."
    );
  }
}

async function runAnalysis(context: StorageAnalysisContext, deps: ServiceDeps): Promise<void> {
  if (context.mount.deviceId === null) {
    throw new StorageAnalysisFailure(
      "unsupported",
      "DeckOS could not resolve a stable device boundary for this mount."
    );
  }
  const result = await scanTree(
    context.mount.mount,
    context.mount.deviceId,
    deps,
    async (partial) => {
      const generatedAt = new Date(deps.now()).toISOString();
      await writeSnapshot({
        mount: context.mount,
        status: "scanning",
        analyzer: "scan",
        sourceKind: "scan",
        mountKey: context.mountKey,
        generatedAt,
        startedAt: context.startedAt,
        completedAt: generatedAt,
        freshnessTtlMs: STORAGE_ANALYSIS_TTL_MS,
        totalSize: partial.totalSize,
        nodeCount: partial.nodeCount,
        oversized: partial.oversized,
        extensionHistogram: partial.extensionHistogram,
        root: partial.root,
        warningCode: partial.warningCode,
        warning: partial.warning,
      });
    }
  );

  const completedAt = new Date(deps.now()).toISOString();
  const snapshot: StorageAnalysisSnapshot = {
    mount: context.mount,
    status: "ready",
    analyzer: result.analyzer,
    sourceKind: result.sourceKind,
    mountKey: context.mountKey,
    generatedAt: completedAt,
    startedAt: context.startedAt,
    completedAt,
    freshnessTtlMs: STORAGE_ANALYSIS_TTL_MS,
    totalSize: result.totalSize,
    nodeCount: result.nodeCount,
    oversized: result.oversized,
    extensionHistogram: result.extensionHistogram,
    root: result.root,
    warningCode: result.warningCode,
    warning: result.warning,
  };
  await writeSnapshot(snapshot);
}

async function scheduleRefresh(
  mount: StorageAnalysisMount,
  deps: ServiceDeps,
  force = false
): Promise<JobRecord | null> {
  const mountKey = mount.id;
  const existing = jobs.get(mountKey);
  if (existing && !force && (existing.state === "scanning" || existing.state === "failed")) {
    return existing;
  }

  const startedAt = new Date(deps.now()).toISOString();
  const record: JobRecord = {
    startedAt,
    state: "scanning",
    errorCode: null,
    error: null,
    promise: (async () => {
      try {
        await runAnalysis(
          {
            mount,
            mountKey,
            startedAt,
          },
          deps
        );
        const current = jobs.get(mountKey);
        if (current) {
          current.state = "ready";
          current.errorCode = null;
          current.error = null;
        }
      } catch (error) {
        const current = jobs.get(mountKey);
        if (current) {
          current.state = "failed";
          current.errorCode =
            error instanceof StorageAnalysisFailure ? error.code : "runtime-failed";
          current.error =
            error instanceof Error ? error.message : "Storage analysis failed unexpectedly.";
        }
      }
    })(),
  };
  jobs.set(mountKey, record);
  void record.promise.finally(() => {
    const current = jobs.get(mountKey);
    if (current && current.promise === record.promise && current.state === "ready") {
      jobs.delete(mountKey);
    }
  });
  return record;
}

export async function getStorageAnalysis(
  input: { mount: string; fs: string },
  deps: ServiceDeps = defaultDeps
): Promise<StorageAnalysisResponse> {
  let mount: StorageAnalysisMount;
  try {
    mount = await resolveMount(input.mount, input.fs, deps);
  } catch (error) {
    const failure =
      error instanceof StorageAnalysisFailure
        ? error
        : new StorageAnalysisFailure(
            "runtime-failed",
            error instanceof Error ? error.message : "Storage analysis failed unexpectedly."
          );
    const requestedMount = createRequestedMount(input);
    return pendingResponse(
      requestedMount,
      requestedMount.id,
      null,
      failure.code,
      failure.message
    );
  }
  const mountKey = mount.id;
  const snapshot = await readSnapshot(mountKey);
  const job = jobs.get(mountKey);
  const nowMs = deps.now();

  if (snapshot) {
    if (snapshot.status === "scanning") {
      return toSnapshotResponse(
        snapshot,
        "scanning",
        true,
        job?.errorCode ?? null,
        job?.error ?? null
      );
    }
    const fresh = isSnapshotFresh(snapshot, nowMs);
    if (fresh) {
      return toSnapshotResponse(
        snapshot,
        "ready",
        job?.state === "scanning",
        job?.errorCode ?? null,
        job?.error ?? null
      );
    }
    await scheduleRefresh(mount, deps);
    return toSnapshotResponse(snapshot, "stale", true, job?.errorCode ?? null, job?.error ?? null);
  }

  await scheduleRefresh(mount, deps);
  const current = jobs.get(mountKey);
  return pendingResponse(
    mount,
    mountKey,
    current?.startedAt ?? null,
    current?.state === "failed" ? current.errorCode : null,
    current?.state === "failed" ? current.error : null
  );
}

export async function refreshStorageAnalysis(
  input: { mount: string; fs: string },
  deps: ServiceDeps = defaultDeps
): Promise<StorageAnalysisResponse> {
  let mount: StorageAnalysisMount;
  try {
    mount = await resolveMount(input.mount, input.fs, deps);
  } catch (error) {
    const failure =
      error instanceof StorageAnalysisFailure
        ? error
        : new StorageAnalysisFailure(
            "runtime-failed",
            error instanceof Error ? error.message : "Storage analysis failed unexpectedly."
          );
    const requestedMount = createRequestedMount(input);
    return pendingResponse(
      requestedMount,
      requestedMount.id,
      null,
      failure.code,
      failure.message
    );
  }
  await scheduleRefresh(mount, deps, true);
  const snapshot = await readSnapshot(mount.id);
  if (snapshot) {
    return toSnapshotResponse(snapshot, "stale", true, null, null);
  }
  const current = jobs.get(mount.id);
  return pendingResponse(
    mount,
    mount.id,
    current?.startedAt ?? null,
    current?.state === "failed" ? current.errorCode : null,
    current?.state === "failed" ? current.error : null
  );
}

export async function clearStorageAnalysisState(): Promise<void> {
  jobs.clear();
}

export const __storageAnalysisTestUtils = {
  STORAGE_ANALYSIS_DIR,
  STORAGE_ANALYSIS_TTL_MS,
  buildExtensionHistogram,
  createMountKey,
  getSnapshotPath,
  getMetaPath,
};
