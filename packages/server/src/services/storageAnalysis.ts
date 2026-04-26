import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { opendir, lstat, stat } from "node:fs/promises";
import path from "node:path";
import fs from "fs-extra";
import si from "systeminformation";
import { DATA_DIR } from "../lib/config.js";
import type {
  StorageAnalysisAnalyzerKind,
  StorageAnalysisExtensionLegendEntry,
  StorageAnalysisMount,
  StorageAnalysisNode,
  StorageAnalysisResponse,
  StorageAnalysisSnapshot,
} from "../lib/schema.js";

const STORAGE_ANALYSIS_DIR = path.join(DATA_DIR, "storage-analysis");
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

type StorageAnalyzerFailureCode =
  | "unsupported"
  | "unsafe"
  | "permission-denied"
  | "runtime-failed";

type StorageAnalysisContext = {
  mount: StorageAnalysisMount;
  mountKey: string;
  startedAt: string;
};

type StorageAnalyzerUnsupported = {
  ok: false;
  code: StorageAnalyzerFailureCode;
  reason: string;
};

type StorageAnalyzerSuccess = {
  ok: true;
  analyzer: StorageAnalysisAnalyzerKind;
  sourceKind: StorageAnalysisSnapshot["sourceKind"];
  root: StorageAnalysisNode;
  totalSize: number;
  nodeCount: number;
  oversized: boolean;
  extensionHistogram: StorageAnalysisExtensionLegendEntry[];
  fallbackReason?: string | null;
};

type StorageAnalyzerResult = StorageAnalyzerSuccess | StorageAnalyzerUnsupported;

type StorageAnalyzer = {
  name: StorageAnalysisAnalyzerKind;
  isSupported(
    context: StorageAnalysisContext,
    deps: ServiceDeps
  ): Promise<StorageAnalyzerUnsupported | null>;
  analyze(context: StorageAnalysisContext, deps: ServiceDeps): Promise<StorageAnalyzerResult>;
};

type JobRecord = {
  startedAt: string;
  state: SupportedAnalysisStatus;
  promise: Promise<void>;
  error: string | null;
};

type ScanStats = {
  nodeCount: number;
  oversized: boolean;
  extensionCounts: Map<string, { count: number; totalSize: number }>;
};

type ServiceDeps = {
  fsSize: typeof si.fsSize;
  spawnImpl: typeof spawn;
  statImpl: typeof stat;
  lstatImpl: typeof lstat;
  opendirImpl: typeof opendir;
  now: () => number;
};

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

function toSnapshotResponse(
  snapshot: StorageAnalysisSnapshot,
  status: SupportedAnalysisStatus,
  refreshing: boolean,
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
    oversized: snapshot.oversized,
    extensionHistogram: snapshot.extensionHistogram,
    root: snapshot.root,
    refreshing,
    error,
    fallbackReason: snapshot.fallbackReason ?? null,
  };
}

function pendingResponse(
  mount: StorageAnalysisMount,
  mountKey: string,
  error: string | null
): StorageAnalysisResponse {
  return {
    mount,
    status: error ? "failed" : "scanning",
    analyzer: null,
    sourceKind: "pending",
    mountKey,
    generatedAt: null,
    startedAt: null,
    completedAt: null,
    freshnessTtlMs: STORAGE_ANALYSIS_TTL_MS,
    totalSize: null,
    nodeCount: null,
    oversized: false,
    extensionHistogram: [],
    root: null,
    refreshing: !error,
    error,
    fallbackReason: null,
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
    fallbackReason: snapshot.fallbackReason ?? null,
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
  deps: ServiceDeps
): Promise<StorageAnalyzerSuccess> {
  const limit = createLimiter(STORAGE_ANALYSIS_SCAN_CONCURRENCY);
  const stats: ScanStats = {
    nodeCount: 0,
    oversized: false,
    extensionCounts: new Map(),
  };

  const visit = async (targetPath: string): Promise<StorageAnalysisNode | null> => {
    const entryStat = await limit(() => deps.lstatImpl(targetPath));
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
      const dir = await limit(() => deps.opendirImpl(targetPath));
      const childTasks: Promise<StorageAnalysisNode | null>[] = [];
      for await (const entry of dir) {
        const childPath = path.join(targetPath, entry.name);
        childTasks.push(
          visit(childPath).catch((error: unknown) => {
            const code = (error as NodeJS.ErrnoException | undefined)?.code;
            if (code === "EACCES" || code === "EPERM" || code === "ENOENT") {
              return null;
            }
            throw error;
          })
        );
      }
      const children = (await Promise.all(childTasks))
        .filter((child): child is StorageAnalysisNode => child !== null)
        .sort((left, right) => right.size - left.size || left.name.localeCompare(right.name));
      const size = children.reduce((sum, child) => sum + child.size, 0);
      stats.nodeCount += 1;
      stats.oversized ||= stats.nodeCount > STORAGE_ANALYSIS_MAX_NODES;
      return {
        path: targetPath,
        name: getNodeName(targetPath),
        type,
        size,
        extension: null,
        childCount: children.length,
        children,
      };
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

  const root = await visit(rootPath);
  if (!root) {
    throw new Error(`Unable to scan root path: ${rootPath}`);
  }

  return {
    ok: true,
    analyzer: "fallback",
    sourceKind: "scan",
    root,
    totalSize: root.size,
    nodeCount: stats.nodeCount,
    oversized: stats.oversized,
    extensionHistogram: buildExtensionHistogram(stats.extensionCounts),
    fallbackReason: null,
  };
}

async function runCommand(
  spawnImpl: typeof spawn,
  command: string,
  args: readonly string[]
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

const btrfsAnalyzer: StorageAnalyzer = {
  name: "btrfs",
  async isSupported(context, deps) {
    if (context.mount.filesystemType.toLowerCase() !== "btrfs") {
      return { ok: false, code: "unsupported", reason: "Filesystem is not btrfs." };
    }
    if (process.platform !== "linux") {
      return { ok: false, code: "unsupported", reason: "btrfs fast path requires Linux." };
    }
    const probe = await runCommand(deps.spawnImpl, "btdu", ["--help"]).catch(() => null);
    if (!probe || probe.code !== 0) {
      return { ok: false, code: "unsupported", reason: "btdu is not installed." };
    }
    return null;
  },
  async analyze(context, deps) {
    const unsupported = await this.isSupported(context, deps);
    if (unsupported) {
      return unsupported;
    }
    return {
      ok: false,
      code: "unsupported",
      reason:
        "btdu support detected, but automatic export parsing is not available in this build.",
    };
  },
};

const defaultDeps: ServiceDeps = {
  fsSize: si.fsSize,
  spawnImpl: spawn,
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
    throw new Error(`Disk mount not found: ${mountPath}`);
  }
  const rootStat = await deps.statImpl(match.mount);
  return {
    id: createMountKey(match.fs, match.mount),
    mount: match.mount,
    fs: match.fs,
    filesystemType: (match.type || "unknown").toLowerCase(),
    size: match.size,
    used: match.used,
    deviceId: Number.isFinite(rootStat.dev) ? rootStat.dev : null,
  };
}

async function runAnalysis(context: StorageAnalysisContext, deps: ServiceDeps): Promise<void> {
  let result = await btrfsAnalyzer.analyze(context, deps);
  if (!result.ok) {
    if (context.mount.deviceId === null) {
      throw new Error("Unable to determine device id for selected mount.");
    }
    const fallback = await scanTree(context.mount.mount, context.mount.deviceId, deps);
    result = {
      ...fallback,
      fallbackReason: result.reason,
    };
  }

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
    fallbackReason: result.fallbackReason ?? null,
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
  if (existing && !force && existing.state === "scanning") {
    return existing;
  }

  const startedAt = new Date(deps.now()).toISOString();
  const record: JobRecord = {
    startedAt,
    state: "scanning",
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
          current.error = null;
        }
      } catch (error) {
        const current = jobs.get(mountKey);
        if (current) {
          current.state = "failed";
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
  const mount = await resolveMount(input.mount, input.fs, deps);
  const mountKey = mount.id;
  const snapshot = await readSnapshot(mountKey);
  const job = jobs.get(mountKey);
  const nowMs = deps.now();

  if (snapshot) {
    const fresh = isSnapshotFresh(snapshot, nowMs);
    if (fresh) {
      return toSnapshotResponse(snapshot, "ready", job?.state === "scanning", job?.error ?? null);
    }
    await scheduleRefresh(mount, deps);
    return toSnapshotResponse(snapshot, "stale", true, job?.error ?? null);
  }

  await scheduleRefresh(mount, deps);
  const current = jobs.get(mountKey);
  return pendingResponse(mount, mountKey, current?.state === "failed" ? current.error : null);
}

export async function refreshStorageAnalysis(
  input: { mount: string; fs: string },
  deps: ServiceDeps = defaultDeps
): Promise<StorageAnalysisResponse> {
  const mount = await resolveMount(input.mount, input.fs, deps);
  await scheduleRefresh(mount, deps, true);
  const snapshot = await readSnapshot(mount.id);
  if (snapshot) {
    return toSnapshotResponse(snapshot, "stale", true, null);
  }
  return pendingResponse(mount, mount.id, null);
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
  btrfsAnalyzer,
};
