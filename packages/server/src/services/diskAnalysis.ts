import fs from "fs-extra";
import path from "node:path";
import crypto from "node:crypto";
import {
  DiskAnalysisMountStateSchema,
  DiskAnalysisSnapshotEnvelopeSchema,
  DiskAnalysisSnapshotSchema,
  type DiskAnalysisIssue,
  type DiskAnalysisJobState,
  type DiskAnalysisMountIdentity,
  type DiskAnalysisMountState,
  type DiskAnalysisProgress,
  type DiskAnalysisResourceLimits,
  type DiskAnalysisScanEvent,
  type DiskAnalysisSnapshot,
  type DiskAnalysisSnapshotEnvelope,
  type DiskAnalysisStartScanResult,
  type DiskAnalysisTreemapNode,
} from "../lib/diskAnalysisContract.js";
import { DATA_DIR } from "../lib/config.js";

type JobPhase = DiskAnalysisJobState["phase"];
type JobListener = (event: DiskAnalysisScanEvent) => void;

type MutableDirectoryNode = {
  path: string;
  name: string;
  parentPath: string | null;
  type: "directory";
  size: number;
  recursiveSize: number;
  childCount: number;
  descendantsScanned: number;
  truncated: boolean;
  issues: DiskAnalysisIssue[];
  children: DiskAnalysisTreemapNode[];
  pendingChildren: number;
  scanned: boolean;
};

type DirectoryTask = {
  directoryPath: string;
  node: MutableDirectoryNode;
};

type PersistedCacheFile = {
  mount: DiskAnalysisMountIdentity;
  snapshot: DiskAnalysisSnapshot;
};

type DiskAnalysisJobInternal = {
  jobId: string;
  mount: DiskAnalysisMountIdentity;
  phase: JobPhase;
  startedAt: string;
  updatedAt: string;
  progress: DiskAnalysisProgress;
  issues: DiskAnalysisIssue[];
  limits: DiskAnalysisResourceLimits;
  controller: AbortController;
  createdAtMs: number;
  finishedAtMs?: number;
  snapshot?: DiskAnalysisSnapshot;
  lastProgressEmitAtMs: number;
};

export class DiskAnalysisJobNotFoundError extends Error {
  constructor(jobId: string) {
    super(`Disk analysis job not found: ${jobId}`);
    this.name = "DiskAnalysisJobNotFoundError";
  }
}

export class DiskAnalysisMountUnavailableError extends Error {
  constructor(mountPath: string, message: string) {
    super(message || `Disk analysis mount is unavailable: ${mountPath}`);
    this.name = "DiskAnalysisMountUnavailableError";
  }
}

const DISK_ANALYSIS_DIR = path.join(DATA_DIR, "disk-analysis");
const CACHE_FRESH_MS = 24 * 60 * 60 * 1000;
const FINISHED_JOB_TTL_MS = 10 * 60 * 1000;
const RUNNING_JOB_TTL_MS = 2 * 60 * 60 * 1000;
const PROGRESS_EMIT_INTERVAL_MS = 500;
const SMALL_FILE_BUCKET_SUFFIX = "__deckos_small_files__";
const MAX_SMALL_FILE_THRESHOLD_BYTES = 64 * 1024 * 1024;
const DEFAULT_LIMITS: DiskAnalysisResourceLimits = {
  maxWorkers: 4,
  maxPendingDirectories: 2048,
  maxIndexedNodes: 1_000_000,
};

const jobs = new Map<string, DiskAnalysisJobInternal>();
const activeJobIdByMount = new Map<string, string>();
const listenersByJobId = new Map<string, Set<JobListener>>();

function getConfiguredPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function getLimits(): DiskAnalysisResourceLimits {
  return {
    maxWorkers: getConfiguredPositiveInt(
      "DECKOS_DISK_ANALYSIS_MAX_WORKERS",
      DEFAULT_LIMITS.maxWorkers
    ),
    maxPendingDirectories: getConfiguredPositiveInt(
      "DECKOS_DISK_ANALYSIS_MAX_PENDING_DIRECTORIES",
      DEFAULT_LIMITS.maxPendingDirectories
    ),
    maxIndexedNodes: getConfiguredPositiveInt(
      "DECKOS_DISK_ANALYSIS_MAX_INDEXED_NODES",
      DEFAULT_LIMITS.maxIndexedNodes
    ),
  };
}

function getSmallFileThresholdBytes(): number {
  return getConfiguredPositiveInt("DECKOS_DISK_ANALYSIS_SMALL_FILE_THRESHOLD_BYTES", 1024 * 1024);
}

function getAdaptiveSmallFileThresholdBytes(
  baseThresholdBytes: number,
  indexedNodes: number,
  maxIndexedNodes: number,
  entryCount: number
): number {
  let multiplier = 1;
  const nodeUsageRatio = maxIndexedNodes > 0 ? indexedNodes / maxIndexedNodes : 0;

  if (entryCount >= 20000) {
    multiplier = Math.max(multiplier, 16);
  } else if (entryCount >= 10000) {
    multiplier = Math.max(multiplier, 8);
  } else if (entryCount >= 5000) {
    multiplier = Math.max(multiplier, 4);
  } else if (entryCount >= 1000) {
    multiplier = Math.max(multiplier, 2);
  }

  if (nodeUsageRatio >= 0.95) {
    multiplier = Math.max(multiplier, 64);
  } else if (nodeUsageRatio >= 0.9) {
    multiplier = Math.max(multiplier, 32);
  } else if (nodeUsageRatio >= 0.8) {
    multiplier = Math.max(multiplier, 16);
  } else if (nodeUsageRatio >= 0.65) {
    multiplier = Math.max(multiplier, 8);
  } else if (nodeUsageRatio >= 0.5) {
    multiplier = Math.max(multiplier, 4);
  }

  return Math.min(baseThresholdBytes * multiplier, MAX_SMALL_FILE_THRESHOLD_BYTES);
}

function getMountKey(mount: DiskAnalysisMountIdentity): string {
  const resolvedMount = path.resolve(mount.mount);
  const normalizedMount =
    process.platform === "win32" ? resolvedMount.toLowerCase() : resolvedMount;
  return `${normalizedMount}::${mount.fs.trim().toLowerCase()}`;
}

function getMountName(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) {
    return resolved;
  }
  return path.basename(resolved) || resolved;
}

function getNodeName(targetPath: string): string {
  const parsed = path.parse(targetPath);
  return path.basename(targetPath) || parsed.root || targetPath;
}

function getJobState(job: DiskAnalysisJobInternal): DiskAnalysisJobState {
  return {
    jobId: job.jobId,
    mount: job.mount,
    phase: job.phase,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    progress: job.progress,
    issues: job.issues,
    limits: job.limits,
  };
}

function touchJob(job: DiskAnalysisJobInternal, phase?: JobPhase) {
  if (phase) {
    job.phase = phase;
  }
  job.updatedAt = new Date().toISOString();
}

function setJobFinalState(job: DiskAnalysisJobInternal, phase: JobPhase) {
  touchJob(job, phase);
  job.finishedAtMs = Date.now();
  if (activeJobIdByMount.get(getMountKey(job.mount)) === job.jobId) {
    activeJobIdByMount.delete(getMountKey(job.mount));
  }
}

function toStartScanResult(job: DiskAnalysisJobInternal): DiskAnalysisStartScanResult {
  return {
    jobId: job.jobId,
    phase: job.phase,
    streamPath: getJobStreamPath(job),
  };
}

function getJobStreamPath(job: Pick<DiskAnalysisJobInternal, "jobId" | "mount">): string {
  const params = new URLSearchParams({
    mount: job.mount.mount,
    fs: job.mount.fs,
  });
  return `/api/disk-analysis/jobs/${job.jobId}/events?${params.toString()}`;
}

function getCachePath(mount: DiskAnalysisMountIdentity): string {
  const key = crypto.createHash("sha1").update(getMountKey(mount)).digest("hex");
  return path.join(DISK_ANALYSIS_DIR, `${key}.json`);
}

function createIssue(
  code: DiskAnalysisIssue["code"],
  issuePath: string,
  message: string,
  recoverable: boolean = true
): DiskAnalysisIssue {
  return {
    code,
    path: issuePath,
    message,
    recoverable,
  };
}

function getIssueForFsError(targetPath: string, error: unknown): DiskAnalysisIssue {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  if (code === "EACCES" || code === "EPERM") {
    return createIssue("permission-denied", targetPath, `Permission denied: ${targetPath}`);
  }
  if (code === "ENOENT") {
    return createIssue("path-not-found", targetPath, `Path not found: ${targetPath}`);
  }
  return createIssue("path-inaccessible", targetPath, `Path inaccessible: ${targetPath}`);
}

function getCacheState(generatedAt: string): "fresh" | "stale" {
  return Date.now() - new Date(generatedAt).getTime() < CACHE_FRESH_MS ? "fresh" : "stale";
}

function countNodes(node: DiskAnalysisTreemapNode): number {
  let count = 0;
  const stack: DiskAnalysisTreemapNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    count += 1;
    for (const child of current.children) {
      stack.push(child);
    }
  }
  return count;
}

function countIssues(node: DiskAnalysisTreemapNode): number {
  let count = 0;
  const stack: DiskAnalysisTreemapNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    count += current.issues.length;
    for (const child of current.children) {
      stack.push(child);
    }
  }
  return count;
}

async function buildSnapshotEnvelope(
  mount: DiskAnalysisMountIdentity,
  snapshot: DiskAnalysisSnapshot,
  snapshotBytes?: number
): Promise<DiskAnalysisSnapshotEnvelope> {
  const state = getCacheState(snapshot.generatedAt);
  const staleAt = new Date(new Date(snapshot.generatedAt).getTime() + CACHE_FRESH_MS).toISOString();
  return DiskAnalysisSnapshotEnvelopeSchema.parse({
    mount,
    cache: {
      state,
      generatedAt: snapshot.generatedAt,
      staleAt,
      nodeCount: countNodes(snapshot.root),
      issueCount: snapshot.issues.length + countIssues(snapshot.root),
      snapshotBytes,
    },
    snapshot,
  });
}

async function readPersistedCache(
  mount: DiskAnalysisMountIdentity
): Promise<DiskAnalysisSnapshotEnvelope | null> {
  const cachePath = getCachePath(mount);
  const exists = await fs.pathExists(cachePath);
  if (!exists) {
    return null;
  }
  try {
    const parsed = (await fs.readJson(cachePath)) as PersistedCacheFile;
    const snapshot = DiskAnalysisSnapshotSchema.parse(parsed.snapshot);
    const stat = await fs.stat(cachePath);
    return await buildSnapshotEnvelope(parsed.mount, snapshot, stat.size);
  } catch {
    const corruptPath = `${cachePath}.corrupt-${Date.now()}`;
    await fs.move(cachePath, corruptPath, { overwrite: true }).catch(() => undefined);
    return null;
  }
}

async function writePersistedCache(
  mount: DiskAnalysisMountIdentity,
  snapshot: DiskAnalysisSnapshot
): Promise<DiskAnalysisSnapshotEnvelope> {
  const cachePath = getCachePath(mount);
  const tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.ensureDir(DISK_ANALYSIS_DIR);
  const serialized = JSON.stringify({
    mount,
    snapshot,
  } satisfies PersistedCacheFile);
  await fs.writeFile(
    tempPath,
    serialized
  );
  await fs.move(tempPath, cachePath, { overwrite: true });
  return await buildSnapshotEnvelope(mount, snapshot, Buffer.byteLength(serialized));
}

function notifyListeners(jobId: string, event: DiskAnalysisScanEvent) {
  const listeners = listenersByJobId.get(jobId);
  if (!listeners || listeners.size === 0) {
    return;
  }
  for (const listener of listeners) {
    listener(event);
  }
}

function emitStatus(job: DiskAnalysisJobInternal) {
  notifyListeners(job.jobId, {
    event: "status",
    job: getJobState(job),
  });
}

function emitProgress(job: DiskAnalysisJobInternal) {
  notifyListeners(job.jobId, {
    event: "progress",
    job: getJobState(job),
  });
}

function emitProgressIfDue(job: DiskAnalysisJobInternal, force: boolean = false) {
  const now = Date.now();
  if (!force && now - job.lastProgressEmitAtMs < PROGRESS_EMIT_INTERVAL_MS) {
    return;
  }
  job.lastProgressEmitAtMs = now;
  emitProgress(job);
}

function emitBranch(job: DiskAnalysisJobInternal, branch: DiskAnalysisTreemapNode) {
  notifyListeners(job.jobId, {
    event: "branch",
    jobId: job.jobId,
    mount: job.mount,
    branch,
  });
}

function emitSnapshot(job: DiskAnalysisJobInternal, snapshot: DiskAnalysisSnapshot) {
  notifyListeners(job.jobId, {
    event: "snapshot",
    job: getJobState(job),
    snapshot,
  });
}

function createDirectoryNode(directoryPath: string, parentPath: string | null): MutableDirectoryNode {
  return {
    path: directoryPath,
    name: parentPath ? getNodeName(directoryPath) : getMountName(directoryPath),
    parentPath,
    type: "directory",
    size: 0,
    recursiveSize: 0,
    childCount: 0,
    descendantsScanned: 0,
    truncated: false,
    issues: [],
    children: [],
    pendingChildren: 0,
    scanned: false,
  };
}

function createDirectoryPlaceholder(directoryPath: string): DiskAnalysisTreemapNode {
  return {
    path: directoryPath,
    name: getNodeName(directoryPath),
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

function createSmallFilesBucket(
  directoryPath: string,
  fileCount: number,
  totalBytes: number,
  thresholdBytes: number
): DiskAnalysisTreemapNode {
  const thresholdLabel =
    thresholdBytes >= 1024 * 1024
      ? `< ${(thresholdBytes / (1024 * 1024)).toFixed(0)} MB`
      : `< ${Math.max(1, Math.round(thresholdBytes / 1024))} KB`;
  return {
    path: path.join(directoryPath, SMALL_FILE_BUCKET_SUFFIX),
    name: `Small Files (${thresholdLabel}) x ${fileCount}`,
    type: "file",
    size: totalBytes,
    recursiveSize: totalBytes,
    extension: null,
    childCount: 0,
    descendantsScanned: 0,
    truncated: false,
    issues: [],
    children: [],
  };
}

function upsertChildBranch(parent: MutableDirectoryNode, child: DiskAnalysisTreemapNode) {
  const childIndex = parent.children.findIndex((entry) => entry.path === child.path);
  if (childIndex >= 0) {
    parent.children[childIndex] = child;
    return;
  }
  parent.children.push(child);
}

function serializeChildNode(
  node: DiskAnalysisTreemapNode,
  mode: "deep" | "shallow"
): DiskAnalysisTreemapNode {
  if (node.type === "file") {
    return {
      ...node,
      issues: [...node.issues],
      children: [],
    };
  }

  const children =
    mode === "deep"
      ? node.children.map((child) => serializeChildNode(child, mode))
      : [];
  return {
    ...node,
    issues: [...node.issues],
    children,
  };
}

function toTreemapNode(
  node: MutableDirectoryNode,
  mode: "deep" | "shallow" = "deep"
): DiskAnalysisTreemapNode {
  const children = [...node.children]
    .map((child) => serializeChildNode(child, mode))
    .sort((left, right) => right.recursiveSize - left.recursiveSize);
  const recursiveSize = children.reduce((sum, child) => sum + child.recursiveSize, node.size);
  const descendantsScanned = children.reduce((sum, child) => {
    return sum + (child.type === "directory" ? child.descendantsScanned + 1 : 0);
  }, 0);
  return {
    path: node.path,
    name: node.name,
    type: "directory",
    size: node.size,
    recursiveSize,
    childCount: node.childCount,
    descendantsScanned,
    truncated: node.truncated,
    issues: node.issues,
    children,
  };
}

function getFileExtension(filePath: string): string | null {
  const extension = path.extname(filePath).replace(/^\./, "").trim().toLowerCase();
  return extension.length > 0 ? extension : null;
}

function isActivePhase(phase: JobPhase): boolean {
  return phase === "queued" || phase === "scanning";
}

function hasPartialResult(job: DiskAnalysisJobInternal): boolean {
  return job.issues.some((issue) => issue.code === "partial-scan" || issue.recoverable === false);
}

async function ensureMountAvailable(mount: DiskAnalysisMountIdentity): Promise<string> {
  const resolvedMount = path.resolve(mount.mount);
  let stat;
  try {
    stat = await fs.stat(resolvedMount);
  } catch (error) {
    throw new DiskAnalysisMountUnavailableError(
      resolvedMount,
      getIssueForFsError(resolvedMount, error).message
    );
  }
  if (!stat.isDirectory()) {
    throw new DiskAnalysisMountUnavailableError(
      resolvedMount,
      `Disk analysis mount is not a directory: ${resolvedMount}`
    );
  }
  return resolvedMount;
}

function pruneJobs(now: number = Date.now()) {
  for (const [jobId, job] of jobs) {
    if (isActivePhase(job.phase)) {
      if (now - job.createdAtMs > RUNNING_JOB_TTL_MS) {
        job.controller.abort();
        setJobFinalState(job, "cancelled");
        emitStatus(job);
      }
      continue;
    }

    const finishedAtMs = job.finishedAtMs ?? job.createdAtMs;
    if (now - finishedAtMs > FINISHED_JOB_TTL_MS) {
      jobs.delete(jobId);
      listenersByJobId.delete(jobId);
    }
  }
}

async function executeScan(job: DiskAnalysisJobInternal): Promise<DiskAnalysisSnapshot> {
  const rootPath = await ensureMountAvailable(job.mount);
  const smallFileThresholdBytes = getSmallFileThresholdBytes();
  const rootNode = createDirectoryNode(rootPath, null);
  const nodesByPath = new Map<string, MutableDirectoryNode>([[rootPath, rootNode]]);
  const pending: DirectoryTask[] = [{ directoryPath: rootPath, node: rootNode }];
  const extensionCounts = new Map<string, { count: number; totalBytes: number }>();
  let totalFiles = 0;
  let totalDirectories = 1;
  let indexedNodes = 1;
  let activeWorkers = 0;
  let settled = false;

  job.progress.directoriesDiscovered = 1;

  const done = new Promise<DiskAnalysisSnapshot>((resolve, reject) => {
    const finalizeNode = (node: MutableDirectoryNode) => {
      const deepBranch = toTreemapNode(node, "deep");
      if (
        node.parentPath === null ||
        deepBranch.recursiveSize > 0 ||
        deepBranch.truncated ||
        deepBranch.issues.length > 0
      ) {
        emitBranch(job, toTreemapNode(node, "shallow"));
      }

      if (node.parentPath) {
        const parent = nodesByPath.get(node.parentPath);
        if (parent) {
          upsertChildBranch(parent, deepBranch);
          parent.pendingChildren = Math.max(0, parent.pendingChildren - 1);
          if (parent.scanned && parent.pendingChildren === 0) {
            finalizeNode(parent);
          }
        }
        nodesByPath.delete(node.path);
        node.children = [];
        return;
      }

      const generatedAt = new Date().toISOString();
      const extensionLegend = [...extensionCounts.entries()]
        .sort(
          (left, right) =>
            right[1].totalBytes - left[1].totalBytes ||
            right[1].count - left[1].count ||
            left[0].localeCompare(right[0])
        )
        .slice(0, 20)
        .map(([extension, stats], index) => ({
          extension,
          colorToken: `disk-ext-${index + 1}`,
          count: stats.count,
          totalBytes: stats.totalBytes,
        }));

      const snapshot = DiskAnalysisSnapshotSchema.parse({
        mount: job.mount,
        generatedAt,
        root: deepBranch,
        extensionLegend,
        totals: {
          totalBytes: deepBranch.recursiveSize,
          totalFiles,
          totalDirectories,
        },
        issues: job.issues,
      });

      settled = true;
      resolve(snapshot);
    };

    const failScan = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    const maybeAbort = () => {
      if (job.controller.signal.aborted) {
        failScan(new Error("Disk analysis scan aborted"));
        return true;
      }
      return false;
    };

    const addNodeWithinLimit = () => {
      if (indexedNodes >= job.limits.maxIndexedNodes) {
        return false;
      }
      indexedNodes += 1;
      return true;
    };

    const schedule = () => {
      if (settled || maybeAbort()) {
        return;
      }

      while (activeWorkers < job.limits.maxWorkers && pending.length > 0) {
        const task = pending.pop();
        if (!task) {
          break;
        }
        activeWorkers += 1;
        void (async () => {
          try {
            if (maybeAbort()) {
              return;
            }

            let entries: fs.Dirent[];
            try {
              entries = await fs.readdir(task.directoryPath, { withFileTypes: true });
            } catch (error) {
              const issue = getIssueForFsError(task.directoryPath, error);
              task.node.issues.push(issue);
              job.issues.push(issue);
              task.node.truncated = true;
              task.node.scanned = true;
              job.progress.directoriesCompleted += 1;
              touchJob(job);
              emitProgress(job);
              if (task.node.pendingChildren === 0) {
                finalizeNode(task.node);
              }
              return;
            }

            const adaptiveSmallFileThresholdBytes = getAdaptiveSmallFileThresholdBytes(
              smallFileThresholdBytes,
              indexedNodes,
              job.limits.maxIndexedNodes,
              entries.length
            );

            let smallFileCount = 0;
            let smallFileBytes = 0;
            let pendingLimitSkips = 0;
            let indexedNodeSkips = 0;
            for (const entry of entries) {
              if (maybeAbort()) {
                return;
              }

              const entryPath = path.join(task.directoryPath, entry.name);
              if (entry.isSymbolicLink()) {
                const issue = createIssue(
                  "symlink-skipped",
                  entryPath,
                  `Symlink skipped: ${entryPath}`
                );
                task.node.issues.push(issue);
                job.issues.push(issue);
                task.node.truncated = true;
                continue;
              }

              let stat;
              try {
                stat = await fs.stat(entryPath);
              } catch (error) {
                const issue = getIssueForFsError(entryPath, error);
                task.node.issues.push(issue);
                job.issues.push(issue);
                task.node.truncated = true;
                continue;
              }

              if (stat.isDirectory()) {
                task.node.childCount += 1;
                if (pending.length >= job.limits.maxPendingDirectories || !addNodeWithinLimit()) {
                  task.node.truncated = true;
                  if (pending.length >= job.limits.maxPendingDirectories) {
                    pendingLimitSkips += 1;
                  } else {
                    indexedNodeSkips += 1;
                  }
                  continue;
                }

                const childNode = createDirectoryNode(entryPath, task.node.path);
                nodesByPath.set(entryPath, childNode);
                upsertChildBranch(task.node, createDirectoryPlaceholder(entryPath));
                task.node.pendingChildren += 1;
                totalDirectories += 1;
                job.progress.directoriesDiscovered += 1;
                pending.push({ directoryPath: entryPath, node: childNode });
                continue;
              }

              if (!stat.isFile()) {
                continue;
              }

              const extension = getFileExtension(entryPath);
              if (extension) {
                const current = extensionCounts.get(extension) ?? { count: 0, totalBytes: 0 };
                current.count += 1;
                current.totalBytes += stat.size;
                extensionCounts.set(extension, current);
              }
              totalFiles += 1;
              task.node.childCount += 1;
              if (stat.size < adaptiveSmallFileThresholdBytes) {
                smallFileCount += 1;
                smallFileBytes += stat.size;
                task.node.size += stat.size;
                job.progress.filesDiscovered += 1;
                job.progress.bytesProcessed += stat.size;
                continue;
              }
              if (!addNodeWithinLimit()) {
                task.node.truncated = true;
                indexedNodeSkips += 1;
                continue;
              }
              task.node.children.push({
                path: entryPath,
                name: entry.name,
                type: "file",
                size: stat.size,
                recursiveSize: stat.size,
                extension,
                childCount: 0,
                descendantsScanned: 0,
                truncated: false,
                issues: [],
                children: [],
              });
              task.node.size += stat.size;
              job.progress.filesDiscovered += 1;
              job.progress.bytesProcessed += stat.size;
            }

            if (smallFileCount > 0) {
              task.node.children.push(
                createSmallFilesBucket(
                  task.directoryPath,
                  smallFileCount,
                  smallFileBytes,
                  adaptiveSmallFileThresholdBytes
                )
              );
            }

            if (pendingLimitSkips > 0) {
              const issue = createIssue(
                "partial-scan",
                task.directoryPath,
                `Traversal limit reached while indexing ${pendingLimitSkips} child director${pendingLimitSkips === 1 ? "y" : "ies"} under ${task.directoryPath}`
              );
              task.node.issues.push(issue);
              job.issues.push(issue);
            }

            if (indexedNodeSkips > 0) {
              const issue = createIssue(
                "partial-scan",
                task.directoryPath,
                `Node limit reached while indexing ${indexedNodeSkips} entr${indexedNodeSkips === 1 ? "y" : "ies"} under ${task.directoryPath}`
              );
              task.node.issues.push(issue);
              job.issues.push(issue);
            }

            task.node.scanned = true;
            job.progress.directoriesCompleted += 1;
            touchJob(job);
            emitProgressIfDue(job);
            if (task.node.pendingChildren === 0) {
              finalizeNode(task.node);
            }
          } catch (error) {
            failScan(error);
          } finally {
            activeWorkers -= 1;
            if (!settled) {
              if (pending.length > 0) {
                schedule();
              } else if (activeWorkers === 0 && rootNode.scanned && rootNode.pendingChildren === 0) {
                finalizeNode(rootNode);
              }
            }
          }
        })();
      }

      if (!settled && activeWorkers === 0 && pending.length === 0 && rootNode.scanned) {
        finalizeNode(rootNode);
      }
    };

    schedule();
  });

  return await done;
}

async function runJob(job: DiskAnalysisJobInternal): Promise<void> {
  touchJob(job, "scanning");
  emitStatus(job);
  emitProgressIfDue(job, true);

  try {
    const snapshot = await executeScan(job);
    job.snapshot = snapshot;
    emitProgressIfDue(job, true);
    await writePersistedCache(job.mount, snapshot);
    setJobFinalState(job, hasPartialResult(job) ? "partial" : "completed");
    emitSnapshot(job, snapshot);
    emitStatus(job);
  } catch (error) {
    if (job.controller.signal.aborted) {
      setJobFinalState(job, "cancelled");
      emitStatus(job);
      return;
    }

    const issue = createIssue(
      "unknown",
      job.mount.mount,
      error instanceof Error ? error.message : "Disk analysis failed",
      false
    );
    job.issues.push(issue);
    setJobFinalState(job, "failed");
    emitStatus(job);
  }
}

async function ensureJob(
  mount: DiskAnalysisMountIdentity,
  options?: { allowAutoStart?: boolean }
): Promise<DiskAnalysisJobInternal | null> {
  pruneJobs();
  const mountKey = getMountKey(mount);
  const activeJobId = activeJobIdByMount.get(mountKey);
  const existing = activeJobId ? jobs.get(activeJobId) : null;
  if (existing && isActivePhase(existing.phase)) {
    return existing;
  }

  if (options?.allowAutoStart === false) {
    return null;
  }

  const resolvedMount = await ensureMountAvailable(mount);
  const now = new Date().toISOString();
  const job: DiskAnalysisJobInternal = {
    jobId: crypto.randomUUID(),
    mount: {
      mount: resolvedMount,
      fs: mount.fs,
    },
    phase: "queued",
    startedAt: now,
    updatedAt: now,
    progress: {
      directoriesDiscovered: 0,
      directoriesCompleted: 0,
      filesDiscovered: 0,
      bytesProcessed: 0,
    },
    issues: [],
    limits: getLimits(),
    controller: new AbortController(),
    createdAtMs: Date.now(),
    lastProgressEmitAtMs: 0,
  };
  jobs.set(job.jobId, job);
  activeJobIdByMount.set(mountKey, job.jobId);
  emitStatus(job);
  queueMicrotask(() => {
    void runJob(job);
  });
  return job;
}

async function maybeStartRefreshJob(mount: DiskAnalysisMountIdentity): Promise<DiskAnalysisJobInternal | null> {
  const cached = await readPersistedCache(mount);
  if (!cached || cached.cache.state === "fresh") {
    return ensureJob(mount, { allowAutoStart: cached === null });
  }

  try {
    return await ensureJob(mount);
  } catch (error) {
    if (error instanceof DiskAnalysisMountUnavailableError) {
      return null;
    }
    throw error;
  }
}

export async function getMountState(
  mount: DiskAnalysisMountIdentity
): Promise<DiskAnalysisMountState> {
  pruneJobs();
  const cache = await readPersistedCache(mount);
  const activeJob = await maybeStartRefreshJob(mount);
  return DiskAnalysisMountStateSchema.parse({
    mount,
    cache: cache?.cache ?? {
      state: "missing",
    },
    activeJob: activeJob ? getJobState(activeJob) : null,
  });
}

export async function getCachedSnapshot(
  mount: DiskAnalysisMountIdentity
): Promise<DiskAnalysisSnapshotEnvelope | null> {
  pruneJobs();
  return await readPersistedCache(mount);
}

export async function startScan(
  mount: DiskAnalysisMountIdentity
): Promise<DiskAnalysisStartScanResult> {
  const job = await ensureJob(mount);
  if (!job) {
    throw new DiskAnalysisMountUnavailableError(
      mount.mount,
      `Disk analysis could not start for ${mount.mount}`
    );
  }
  return toStartScanResult(job);
}

export function cancelScan(mount: DiskAnalysisMountIdentity, jobId: string): boolean {
  pruneJobs();
  const job = jobs.get(jobId);
  if (!job) {
    return false;
  }
  if (getMountKey(job.mount) !== getMountKey(mount)) {
    return false;
  }
  job.controller.abort();
  touchJob(job, "cancelled");
  emitStatus(job);
  return true;
}

export function getJob(jobId: string): DiskAnalysisJobState | null {
  pruneJobs();
  const job = jobs.get(jobId);
  return job ? getJobState(job) : null;
}

export function getJobKeepaliveEvent(jobId: string): DiskAnalysisScanEvent {
  return {
    event: "keepalive",
    jobId,
  };
}

export function getJobStreamInitialEvent(
  jobId: string,
  mount: DiskAnalysisMountIdentity
): DiskAnalysisScanEvent {
  pruneJobs();
  const job = jobs.get(jobId);
  if (!job) {
    throw new DiskAnalysisJobNotFoundError(jobId);
  }
  if (getMountKey(job.mount) !== getMountKey(mount)) {
    throw new DiskAnalysisJobNotFoundError(jobId);
  }
  if (job.snapshot) {
    return {
      event: "snapshot",
      job: getJobState(job),
      snapshot: job.snapshot,
    };
  }
  return {
    event: "status",
    job: getJobState(job),
  };
}

export function subscribeToJob(jobId: string, listener: JobListener): () => void {
  let listeners = listenersByJobId.get(jobId);
  if (!listeners) {
    listeners = new Set<JobListener>();
    listenersByJobId.set(jobId, listeners);
  }
  listeners.add(listener);
  return () => {
    const current = listenersByJobId.get(jobId);
    if (!current) {
      return;
    }
    current.delete(listener);
    if (current.size === 0) {
      listenersByJobId.delete(jobId);
    }
  };
}

export const __testing = {
  resetState() {
    jobs.clear();
    activeJobIdByMount.clear();
    listenersByJobId.clear();
  },
  async clearState() {
    this.resetState();
    await fs.remove(DISK_ANALYSIS_DIR).catch(() => undefined);
  },
};
