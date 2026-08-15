import fs from "fs-extra";
import path from "node:path";
import crypto from "node:crypto";
import {
  DiskAnalysisMountStateSchema,
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
} from "@deckos/contracts";
import { DATA_DIR } from "../lib/config.js";
import { assertNotDeniedPath } from "./files.js";

type JobPhase = DiskAnalysisJobState["phase"];
/** Read-only in the event it receives -- see `subscribeToJob`. */
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
  /**
   * Slot of each directory child in `children`, keyed by path, so replacing a
   * placeholder with its finished branch is O(1). A findIndex per insertion made
   * building a wide directory quadratic in its entry count.
   */
  childIndexByPath: Map<string, number>;
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
  cache?: PersistedCacheMetadata;
};

type PersistedCacheMetadata = {
  generatedAt: string;
  staleAt: string;
};

type DiskAnalysisJobInternal = {
  jobId: string;
  mount: DiskAnalysisMountIdentity;
  phase: JobPhase;
  /**
   * Resolves when `runJob` has fully unwound -- every worker returned, the
   * cache written (or not), the final status emitted.
   *
   * `phase` alone is not that signal: `cancelScan` flips the phase to
   * `cancelled` the instant it is called, while the workers it aborted are
   * still inside `fs.readdir`/`fs.stat` holding references to the partial
   * tree. DISK-12 is precisely the gap between those two moments, so it needs
   * an observable that closes only when the gap does.
   */
  runPromise: Promise<void>;
  /**
   * Set when the walk is being torn down because of a genuine error rather
   * than a user cancellation.
   *
   * The two tear-downs share one mechanism: a failure aborts the controller so
   * that workers stop and the scan settles from the same place cancellation
   * does (`settleAbort`, at `activeWorkers === 0`). That means
   * `signal.aborted` on its own can no longer tell `runJob` which of the two
   * happened, so this flag carries the distinction -- and the original error,
   * which is what the `failed` phase reports.
   */
  internalFailure: { error: unknown } | null;
  startedAt: string;
  updatedAt: string;
  progress: DiskAnalysisProgress;
  /** Bounded to `MAX_RETAINED_ISSUES` -- see `recordIssue`. */
  issues: DiskAnalysisIssue[];
  /** Total problems encountered, not issue objects retained -- see `recordIssue`. */
  issueCount: number;
  /**
   * Whether a partial-result-signalling issue has ever been recorded, set
   * unconditionally in `recordIssue` before the retention cap is applied.
   * `hasPartialResult` reads this instead of scanning `issues` -- once an
   * issue that does not survive the cap could still be the only one that
   * mattered, the array itself can no longer be trusted to answer this.
   */
  partialResultDetected: boolean;
  limits: DiskAnalysisResourceLimits;
  controller: AbortController;
  createdAtMs: number;
  finishedAtMs?: number;
  snapshot?: DiskAnalysisSnapshot;
  lastLiveEmitAtMs: number;
  pendingProgressEmit: boolean;
  pendingBranchesByPath: Map<string, DiskAnalysisTreemapNode>;
  liveEmitTimer: ReturnType<typeof setTimeout> | null;
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

/**
 * DISK-6: the scan refuses this root on policy grounds -- it is not a mount
 * worth walking, and walking it would poison the numbers.
 */
export class DiskAnalysisScanRefusedError extends Error {
  constructor(mountPath: string, message: string) {
    super(message || `Disk analysis refused to scan ${mountPath}`);
    this.name = "DiskAnalysisScanRefusedError";
  }
}

/**
 * The scan is fine in principle but there is no capacity for it right now:
 * either the concurrency cap is reached, or this mount's previous scan has not
 * finished unwinding.
 */
export class DiskAnalysisScanBusyError extends Error {
  constructor(mountPath: string, message: string) {
    super(message || `Disk analysis is busy and cannot scan ${mountPath} yet`);
    this.name = "DiskAnalysisScanBusyError";
  }
}

const DISK_ANALYSIS_DIR = path.join(DATA_DIR, "disk-analysis");
const CACHE_FRESH_MS = 24 * 60 * 60 * 1000;
const FINISHED_JOB_TTL_MS = 10 * 60 * 1000;
const RUNNING_JOB_TTL_MS = 2 * 60 * 60 * 1000;
const PROGRESS_EMIT_INTERVAL_MS = 500;
const SMALL_FILE_BUCKET_SUFFIX = "__deckos_small_files__";
const MAX_SMALL_FILE_THRESHOLD_BYTES = 64 * 1024 * 1024;
/**
 * How many scans may be unwinding at once, across every mount.
 *
 * Each scan runs `maxWorkers` (4 by default) concurrent fs operations, and
 * libuv's threadpool is four threads wide by default, so two scans already
 * saturate it. A homelab box has no use for more.
 */
const MAX_CONCURRENT_SCANS = 2;

/**
 * How long a single `readdir`/`stat` may take before the scan gives up on it.
 *
 * What this buys, precisely: the *scan* keeps moving and degrades the offending
 * path to a `path-inaccessible` issue instead of parking on it forever. What it
 * does not buy: the underlying call is not cancelled. `Promise.race` cannot
 * cancel an fs operation; the syscall still occupies its libuv threadpool
 * thread until the kernel returns, which on a dead NFS or SMB mount can be
 * minutes (or never, for a hard mount). So this stops one bad path wedging a
 * scan and wedging cancellation; it does not free the thread, and enough
 * simultaneously-hung paths will still starve the pool. That is the reason for
 * `MAX_CONCURRENT_SCANS` as well.
 *
 * Generous by default: a cold spinning disk under load can legitimately take
 * many seconds to answer a `readdir` on a large directory, and turning that
 * into a bogus issue would be worse than waiting.
 */
const DEFAULT_FS_OPERATION_TIMEOUT_MS = 30_000;

const DEFAULT_LIMITS: DiskAnalysisResourceLimits = {
  maxWorkers: 4,
  // Bounds the ready stack only, not the total work. Overflow spills to a
  // secondary FIFO rather than being dropped -- see the queue comment in
  // `executeScan` -- so this number no longer decides how much of the tree
  // gets indexed, which is the whole point of it.
  maxPendingDirectories: 2048,
  // Was 1_000_000. The tree exists several times over during serialization, so
  // the cap is really a peak-memory setting, and no treemap renders anywhere
  // near this many rectangles. DECKOS_DISK_ANALYSIS_MAX_INDEXED_NODES raises it
  // for anyone who genuinely wants the old ceiling.
  //
  // Since the queue spill it is also the *only* bound on peak memory, and the
  // trade is real: `maxPendingDirectories` caps the stack at 2048, but the
  // overflow FIFO is bounded only by this number, and every spilled child
  // keeps its parent's `pendingChildren > 0`, so the parent cannot finalize
  // and release its own children either. More nodes are therefore live at once
  // than before on a wide tree. That is the cost of making a scan's results
  // depend on the tree instead of on how four concurrent readdirs interleaved,
  // and it is bounded, which the old behaviour's silent truncation was not.
  maxIndexedNodes: 500_000,
};

/**
 * DISK-11: the on-disk cache directory was never pruned, so stale entries
 * and `.corrupt-*` quarantine files (see `moveCorruptCache`) accumulated
 * indefinitely. These are deliberately more generous than `CACHE_FRESH_MS`
 * (the "serve as fresh vs. trigger a background refresh" window): a mount
 * that hasn't been viewed in a day still deserves its instant stale preview
 * while a refresh runs, so entries are only evicted for being genuinely
 * abandoned, not merely stale.
 */
const DEFAULT_CACHE_PRUNE_SETTINGS = {
  /** A regular cache entry older than this (by mtime) is deleted outright. */
  entryMaxAgeMs: 30 * 24 * 60 * 60 * 1000, // 30 days
  /** `.corrupt-*` files are diagnostic-only; they don't need to live long. */
  corruptMaxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  /** Once the surviving entries exceed this, the oldest are evicted first. */
  maxDirectoryBytes: 256 * 1024 * 1024, // 256 MB
};

const jobs = new Map<string, DiskAnalysisJobInternal>();
const activeJobIdByMount = new Map<string, string>();
/**
 * Jobs whose `runPromise` has not settled yet, keyed by mount.
 *
 * Deliberately not the same thing as `activeJobIdByMount`, which is keyed off
 * the job *phase*: see `startJobRun`. This map is what bounds concurrency and
 * what stops a mount being re-scanned while its previous scan drains.
 */
const unsettledJobIdByMount = new Map<string, string>();
const pendingJobStartByMount = new Map<string, Promise<DiskAnalysisJobInternal | null>>();
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

function getCachePruneSettings(): {
  entryMaxAgeMs: number;
  corruptMaxAgeMs: number;
  maxDirectoryBytes: number;
} {
  return {
    entryMaxAgeMs: getConfiguredPositiveInt(
      "DECKOS_DISK_ANALYSIS_CACHE_MAX_AGE_MS",
      DEFAULT_CACHE_PRUNE_SETTINGS.entryMaxAgeMs
    ),
    corruptMaxAgeMs: getConfiguredPositiveInt(
      "DECKOS_DISK_ANALYSIS_CACHE_CORRUPT_MAX_AGE_MS",
      DEFAULT_CACHE_PRUNE_SETTINGS.corruptMaxAgeMs
    ),
    maxDirectoryBytes: getConfiguredPositiveInt(
      "DECKOS_DISK_ANALYSIS_CACHE_MAX_BYTES",
      DEFAULT_CACHE_PRUNE_SETTINGS.maxDirectoryBytes
    ),
  };
}

function getFsOperationTimeoutMs(): number {
  return getConfiguredPositiveInt(
    "DECKOS_DISK_ANALYSIS_FS_TIMEOUT_MS",
    DEFAULT_FS_OPERATION_TIMEOUT_MS
  );
}

class DiskAnalysisFsTimeoutError extends Error {
  readonly code = "ETIMEDOUT";

  constructor(targetPath: string, timeoutMs: number) {
    super(`Filesystem call for ${targetPath} did not return within ${timeoutMs}ms`);
    this.name = "DiskAnalysisFsTimeoutError";
  }
}

/**
 * Race one fs call against a deadline, and against the job's abort signal when
 * one is supplied. See `DEFAULT_FS_OPERATION_TIMEOUT_MS` for what the deadline
 * does and does not achieve.
 *
 * The abort arm matters for how quickly a cancel is *observed*. Without it, a
 * worker parked on a stale mount keeps waiting for the full timeout -- 30s by
 * default -- before it can notice the abort and unwind, so `cancelScan` takes
 * up to that long to settle. With it, the wait ends the moment the signal
 * fires. This changes nothing about the syscall itself: it still holds its
 * libuv threadpool thread until the kernel returns. Only the promise settles
 * early, which is free and is all the scan needs to wind down.
 *
 * The timer is always cleared on the winning path -- a per-entry scan creates
 * one of these per `stat`, so a leaked timer would be a leak per file -- the
 * abort listener is always removed, and the losing promise gets a no-op catch
 * so a late rejection from an operation we stopped waiting for cannot surface
 * as an unhandled rejection.
 */
async function withFsTimeout<T>(
  operation: Promise<T>,
  targetPath: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new DiskAnalysisFsTimeoutError(targetPath, timeoutMs));
    }, timeoutMs);
    if (signal) {
      if (signal.aborted) {
        reject(new DiskAnalysisScanAbortedError());
        return;
      }
      onAbort = () => reject(new DiskAnalysisScanAbortedError());
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (signal && onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
    void operation.catch(() => undefined);
  }
}

/**
 * Filesystem types that are never worth walking.
 *
 * DISK-6 is `/proc`: `/proc/kcore` stats at roughly 128 TB, so a single scan
 * of it makes every total on the page nonsense. The rest are the same shape --
 * kernel-synthesised trees whose "sizes" are not bytes on a disk.
 */
const PSEUDO_FILESYSTEM_TYPES = new Set([
  "autofs",
  "binfmt_misc",
  "bpf",
  "cgroup",
  "cgroup2",
  "configfs",
  "debugfs",
  "devpts",
  "devtmpfs",
  "efivarfs",
  "fuse.gvfsd-fuse",
  "fusectl",
  "hugetlbfs",
  "mqueue",
  "nsfs",
  "proc",
  "procfs",
  "pstore",
  "ramfs",
  "securityfs",
  "sysfs",
  "tracefs",
]);

/**
 * Where the kernel publishes the mount table, best source first.
 *
 * Read on every scan start rather than cached: mounts come and go, and a scan
 * is a rare, explicit action, so one small read is not worth the staleness.
 */
const MOUNT_TABLE_PATHS = ["/proc/self/mounts", "/etc/mtab"];

/** `/proc/self/mounts` octal-escapes these four characters in mount points. */
function unescapeMountField(value: string): string {
  return value.replace(/\\(040|011|012|134)/g, (_, code: string) => {
    switch (code) {
      case "040":
        return " ";
      case "011":
        return "\t";
      case "012":
        return "\n";
      default:
        return "\\";
    }
  });
}

function parseMountTable(contents: string): { mountPoint: string; fsType: string }[] {
  const entries: { mountPoint: string; fsType: string }[] = [];
  for (const line of contents.split("\n")) {
    const fields = line.trim().split(/\s+/);
    // device, mount point, fs type, options, dump, pass
    if (fields.length < 3 || !fields[1] || !fields[2]) {
      continue;
    }
    entries.push({
      mountPoint: unescapeMountField(fields[1]),
      fsType: fields[2].toLowerCase(),
    });
  }
  return entries;
}

async function readMountTable(): Promise<{ mountPoint: string; fsType: string }[] | null> {
  for (const tablePath of MOUNT_TABLE_PATHS) {
    try {
      const contents = await withFsTimeout(
        fs.readFile(tablePath, "utf8"),
        tablePath,
        getFsOperationTimeoutMs()
      );
      const entries = parseMountTable(contents);
      if (entries.length > 0) {
        return entries;
      }
    } catch {
      // Missing, unreadable, or hung -- try the next candidate.
    }
  }
  return null;
}

/**
 * Refuse a root that the kernel says lives on a pseudo-filesystem.
 *
 * This is the check `assertNotDeniedPath` cannot make. That denylist is a
 * prefix comparison over a path string and documents its own blind spot
 * (FILE-12): a container that bind-mounts the host's `/proc` at `/host/proc`
 * produces a resolved path matching none of its prefixes. The mount table
 * knows the filesystem *type* at that path, so it catches the bind mount that
 * the string comparison cannot.
 *
 * Degradation, per platform:
 *  - **Linux:** `/proc/self/mounts` (falling back to `/etc/mtab`) is read and
 *    the longest mount point that contains the resolved root decides.
 *  - **Windows, macOS, and any Linux where neither file can be read:** there
 *    is no equivalent table here, the read fails, and the scan is *allowed*.
 *    A check that is unavailable must not become a check that refuses
 *    everything; `assertNotDeniedPath` still applies on every platform.
 *  - A path that matches no entry at all is likewise allowed: the absence of a
 *    row is not evidence of a pseudo-filesystem.
 */
async function assertNotPseudoFilesystem(resolvedMount: string): Promise<void> {
  const entries = await readMountTable();
  if (!entries) {
    return;
  }

  const normalizedMount = normalizeMountPathKey(resolvedMount);
  let bestMatch: { mountPoint: string; fsType: string; normalizedLength: number } | null = null;
  for (const entry of entries) {
    let normalizedEntry: string;
    try {
      normalizedEntry = normalizeMountPathKey(entry.mountPoint);
    } catch {
      continue; // A relative or malformed mount point is not a match for anything.
    }
    const contains =
      normalizedMount === normalizedEntry ||
      normalizedMount.startsWith(
        normalizedEntry.endsWith(path.sep) ? normalizedEntry : `${normalizedEntry}${path.sep}`
      );
    if (!contains) {
      continue;
    }
    // Longest mount point wins: `/` contains everything, so the nested mount
    // is the one that actually describes this path. Compared on the normalized
    // form, which is what `contains` matched on -- ranking raw strings while
    // matching normalized ones is the kind of mismatch that holds for every
    // kernel-emitted table and then surprises someone feeding it a
    // hand-written or relative mount point.
    if (!bestMatch || normalizedEntry.length > bestMatch.normalizedLength) {
      bestMatch = { ...entry, normalizedLength: normalizedEntry.length };
    }
  }

  if (bestMatch && PSEUDO_FILESYSTEM_TYPES.has(bestMatch.fsType)) {
    throw new DiskAnalysisScanRefusedError(
      resolvedMount,
      `Refusing to scan ${resolvedMount}: ${bestMatch.mountPoint} is a ${bestMatch.fsType} pseudo-filesystem, whose reported sizes are not bytes on a disk`
    );
  }
}

function getSmallFileThresholdBytes(): number {
  return getConfiguredPositiveInt(
    "DECKOS_DISK_ANALYSIS_SMALL_FILE_THRESHOLD_BYTES",
    2 * 1024 * 1024
  );
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

function resolveMountPath(mountPath: string): string {
  if (process.platform === "win32" && /^[A-Za-z]:$/.test(mountPath)) {
    return `${mountPath}\\`;
  }
  if (!path.isAbsolute(mountPath)) {
    throw new DiskAnalysisMountUnavailableError(
      mountPath,
      `Disk analysis mount must be an absolute path: ${mountPath}`
    );
  }
  return path.resolve(mountPath);
}

function normalizeMountPathKey(mountPath: string): string {
  const resolvedMount = resolveMountPath(mountPath);
  return process.platform === "win32" ? resolvedMount.toLowerCase() : resolvedMount;
}

function getMountKey(mount: DiskAnalysisMountIdentity): string {
  return normalizeMountPathKey(mount.mount);
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
    issueCount: job.issueCount,
    limits: job.limits,
  };
}

/**
 * DISK-1: `issues` rode along inside every progress event, so a directory
 * full of symlinks (or any host with many unreadable paths) grew an
 * unbounded array that got re-sent to every connected browser on every tick.
 * `job.issues` is bounded now (see `recordIssue`), but a progress event fires
 * on a ~500ms cadence for the whole life of a scan -- resending even a
 * capped 100-entry array on each tick is still wasted bandwidth for a value
 * that mostly doesn't change between ticks. Progress events carry only the
 * live count; the populated (bounded) array is for the final snapshot and
 * status events.
 */
function getProgressJobState(job: DiskAnalysisJobInternal): DiskAnalysisJobState {
  return { ...getJobState(job), issues: [] };
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

const MAX_ISSUE_MESSAGE_LENGTH = 2048;

function truncateMessage(message: string): string {
  if (message.length <= MAX_ISSUE_MESSAGE_LENGTH) return message;
  // An issue that fails its own schema takes the whole scan down, and on the
  // SSE path it wedges the browser's EventSource open with no more events.
  // A clipped message is strictly better than that.
  return `${message.slice(0, MAX_ISSUE_MESSAGE_LENGTH - 1)}…`;
}

export function createIssue(
  code: DiskAnalysisIssue["code"],
  issuePath: string,
  message: string,
  recoverable: boolean = true
): DiskAnalysisIssue {
  return {
    code,
    path: issuePath,
    message: truncateMessage(message),
    recoverable,
  };
}

/**
 * DISK-1: retaining every issue object let the array grow without limit on a
 * host with many unreadable paths. `MAX_RETAINED_ISSUES` caps what is kept
 * for display; `job.issueCount` keeps counting past the cap so the total
 * stays truthful even once the array stops growing.
 */
const MAX_RETAINED_ISSUES = 100;

/**
 * Codes that mean the totals are a lower bound.
 *
 * `recoverable` defaults to true on every issue, so keying off it alone let
 * permission-denied scans report "completed" with a confident total that could
 * be a fraction of reality — and then cached that for 24 hours. The service
 * runs unprivileged, so EACCES on /root, /var/lib/docker and other users' homes
 * is the normal case on any real host, not an edge case.
 *
 * Checked inside `recordIssue`, unconditionally and before the retention cap
 * -- see `DiskAnalysisJobInternal.partialResultDetected`. A directory full of
 * `symlink-skipped` notices (not partial-signalling; those are deliberately
 * excluded, dropped subtrees) can fill the retained array before a real
 * `permission-denied` arrives. If partiality were read back off `job.issues`,
 * that later issue simply not being retained would make the whole scan look
 * complete when it wasn't -- the exact failure this set exists to prevent.
 */
const PARTIAL_RESULT_CODES = new Set([
  "partial-scan",
  "permission-denied",
  "path-inaccessible",
  "path-not-found",
  // A skipped nested mount is a whole subtree the scan never counted — on a
  // homelab box that's frequently the media drive, i.e. most of the data. The
  // total is a lower bound in exactly the sense this set exists to flag.
  "nested-mount-skipped",
]);

/**
 * Record an issue against a job (and optionally the tree node it belongs to).
 *
 * `occurrences` lets an aggregated issue -- e.g. one "500 symlinks skipped
 * under this directory" object -- count as 500 toward `issueCount` even
 * though it is a single retained object. Callers that already aggregate
 * per-directory (symlinks, traversal-limit skips, node-limit skips, nested
 * mounts) pass their tally; everything else defaults to one occurrence per
 * issue.
 *
 * Two things happen here that must not depend on whether the issue itself
 * ends up retained in `job.issues`:
 *  - `job.partialResultDetected` is set from the issue's own code/recoverable
 *    flag, not from scanning the (capped) array afterward.
 *  - A `recoverable: false` issue -- the reason a scan reports "failed" -- is
 *    never silently dropped by the FIFO cap. If the array is already full
 *    when one arrives, the most recently retained recoverable issue is
 *    evicted to make room for it.
 */
function recordIssue(
  job: DiskAnalysisJobInternal,
  issue: DiskAnalysisIssue,
  options?: { nodeIssues?: DiskAnalysisIssue[]; occurrences?: number }
): void {
  options?.nodeIssues?.push(issue);
  job.issueCount += options?.occurrences ?? 1;

  if (PARTIAL_RESULT_CODES.has(issue.code) || issue.recoverable === false) {
    job.partialResultDetected = true;
  }

  if (issue.recoverable === false && job.issues.length >= MAX_RETAINED_ISSUES) {
    for (let index = job.issues.length - 1; index >= 0; index -= 1) {
      if (job.issues[index]?.recoverable !== false) {
        job.issues.splice(index, 1);
        break;
      }
    }
  }

  if (job.issues.length < MAX_RETAINED_ISSUES) {
    job.issues.push(issue);
  }
}

function getIssueForFsError(targetPath: string, error: unknown): DiskAnalysisIssue {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  if (code === "EACCES" || code === "EPERM") {
    return createIssue(
      "permission-denied",
      targetPath,
      `Permission denied: ${targetPath}`
    );
  }
  if (code === "ENOENT") {
    return createIssue("path-not-found", targetPath, `Path not found: ${targetPath}`);
  }
  if (error instanceof DiskAnalysisFsTimeoutError) {
    // Distinct message, same code: from the treemap's point of view a path the
    // scan gave up waiting for is a path it could not read.
    return createIssue("path-inaccessible", targetPath, error.message);
  }
  return createIssue("path-inaccessible", targetPath, `Path inaccessible: ${targetPath}`);
}

function getComparableDeviceId(stat: fs.Stats): number | null {
  return Number.isSafeInteger(stat.dev) ? stat.dev : null;
}

/**
 * DISK-8: bytes actually allocated on disk for this file, not its apparent
 * length. A tool whose whole job is "where did my disk space go" should
 * report what the filesystem consumed, not what `read()` would return --
 * those differ for sparse files, and (via the hardlink dedup below) for
 * hardlinks.
 *
 * `stat.blocks` is POSIX-only, in 512-byte units regardless of the
 * filesystem's actual block size, and Node does not populate it meaningfully
 * on every platform. On Windows/NTFS it is observed as `0` for small files
 * resident inside the MFT record with no cluster allocated, and a genuine
 * cluster count once a file is large enough to need one -- so it is neither
 * "always populated" nor "always zero" there, and the fallback to
 * `stat.size` is only correct on that platform: `blocks === 0` there means
 * "no separate allocation to measure", not "no data".
 *
 * On POSIX, `blocks === 0` is not evidence of a missing measurement -- it is
 * the answer, for an empty file or a fully sparse one. A 1 GB sparse file
 * with zero real blocks allocated legitimately reports `blocks === 0`, and
 * falling back to its apparent size there would report it as costing 1 GB,
 * the opposite of what this helper exists to do. So the `stat.size` fallback
 * is scoped to Windows; everywhere else a measured zero stands as zero, and
 * only a genuinely absent measurement (negative, NaN, or undefined) falls
 * back to apparent size.
 */
function getAllocatedSizeBytes(stat: fs.Stats): number {
  if (!Number.isFinite(stat.blocks) || stat.blocks < 0) {
    return stat.size;
  }
  if (stat.blocks > 0) {
    return stat.blocks * 512;
  }
  return process.platform === "win32" ? stat.size : 0;
}

function getCacheState(generatedAt: string): "fresh" | "stale" {
  return Date.now() - new Date(generatedAt).getTime() < CACHE_FRESH_MS
    ? "fresh"
    : "stale";
}

function getStaleAt(generatedAt: string): string {
  return new Date(new Date(generatedAt).getTime() + CACHE_FRESH_MS).toISOString();
}

function buildPersistedCacheMetadata(snapshot: DiskAnalysisSnapshot): PersistedCacheMetadata {
  return {
    generatedAt: snapshot.generatedAt,
    staleAt: getStaleAt(snapshot.generatedAt),
  };
}

function isPersistedCacheMetadata(value: unknown): value is PersistedCacheMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<PersistedCacheMetadata>;
  return (
    typeof candidate.generatedAt === "string" &&
    !Number.isNaN(new Date(candidate.generatedAt).getTime()) &&
    typeof candidate.staleAt === "string" &&
    !Number.isNaN(new Date(candidate.staleAt).getTime())
  );
}

function getCacheMetadata(
  generatedAt: string,
  persisted?: PersistedCacheMetadata
): DiskAnalysisMountState["cache"] {
  return {
    state: getCacheState(generatedAt),
    generatedAt,
    staleAt: persisted?.staleAt ?? getStaleAt(generatedAt),
  };
}

function buildSnapshotEnvelope(
  mount: DiskAnalysisMountIdentity,
  snapshot: DiskAnalysisSnapshot,
  persisted?: PersistedCacheMetadata
): DiskAnalysisSnapshotEnvelope {
  return {
    mount,
    cache: getCacheMetadata(snapshot.generatedAt, persisted),
    snapshot,
  };
}

async function moveCorruptCache(cachePath: string): Promise<void> {
  const corruptPath = `${cachePath}.corrupt-${Date.now()}`;
  await fs.move(cachePath, corruptPath, { overwrite: true }).catch(() => undefined);
}

/** Where `readPersistedCacheFile`/`writePersistedCache` keep their files. */
export function getDiskAnalysisCacheDir(): string {
  return DISK_ANALYSIS_DIR;
}

/**
 * Unlink a cache file, tolerating the case where it is already gone.
 *
 * Deletion is destructive, so this is the only place in pruning allowed to
 * call `fs.unlink`. Anything other than ENOENT is logged rather than thrown
 * -- a locked file on one platform, a permissions quirk, whatever -- pruning
 * one bad entry must never take the rest of the run down with it.
 */
async function safeUnlinkCacheFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT") {
      return;
    }
    console.error("[deckos] Failed to prune disk analysis cache file:", filePath, error);
  }
}

/**
 * DISK-11: prune the on-disk analysis cache. Called once at process startup
 * (see `index.ts`), not on every scan.
 *
 * Scope, precisely:
 *  - Only ever touches regular files directly inside `getDiskAnalysisCacheDir()`.
 *    Directories and symlinks are skipped outright -- `fs.readdir`'s Dirent
 *    type is checked before anything is opened or removed, so a symlink
 *    planted in the cache directory is neither followed nor deleted, and
 *    whatever it points at is never touched.
 *  - Deletes: regular cache entries older than `entryMaxAgeMs`, `.corrupt-*`
 *    quarantine files older than `corruptMaxAgeMs`, and (if the directory is
 *    still over `maxDirectoryBytes` after those two passes) the oldest
 *    remaining entries by mtime until it is back under the cap.
 *  - Never throws: a file that vanishes between listing and deletion (another
 *    prune run, a manual cleanup) is treated as already-pruned, not an error.
 */
export async function pruneDiskAnalysisCache(): Promise<void> {
  const cacheDir = getDiskAnalysisCacheDir();
  let entries: fs.Dirent[];
  try {
    entries = await fs.readdir(cacheDir, { withFileTypes: true });
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT") {
      return;
    }
    console.error("[deckos] Failed to read disk analysis cache dir for pruning:", error);
    return;
  }

  const settings = getCachePruneSettings();
  const now = Date.now();
  const survivors: { path: string; mtimeMs: number; size: number }[] = [];

  for (const entry of entries) {
    // Symlinks and directories are never candidates -- lstat (not stat) so a
    // symlink's own type is what's inspected, not whatever it points to.
    if (!entry.isFile()) {
      continue;
    }
    const entryPath = path.join(cacheDir, entry.name);
    let stat: fs.Stats;
    try {
      stat = await fs.lstat(entryPath);
    } catch {
      continue; // Vanished between readdir and lstat -- nothing to prune.
    }
    if (!stat.isFile()) {
      continue;
    }

    const isCorrupt = entry.name.includes(".corrupt-");
    const maxAgeMs = isCorrupt ? settings.corruptMaxAgeMs : settings.entryMaxAgeMs;
    if (now - stat.mtimeMs > maxAgeMs) {
      await safeUnlinkCacheFile(entryPath);
      continue;
    }

    survivors.push({ path: entryPath, mtimeMs: stat.mtimeMs, size: stat.size });
  }

  let totalBytes = survivors.reduce((sum, survivor) => sum + survivor.size, 0);
  if (totalBytes > settings.maxDirectoryBytes) {
    survivors.sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const survivor of survivors) {
      if (totalBytes <= settings.maxDirectoryBytes) {
        break;
      }
      await safeUnlinkCacheFile(survivor.path);
      totalBytes -= survivor.size;
    }
  }
}

async function readPersistedCacheFile(
  mount: DiskAnalysisMountIdentity
): Promise<{ parsed: PersistedCacheFile; cachePath: string } | null> {
  const cachePath = getCachePath(mount);
  try {
    const serialized = await fs.readFile(cachePath, "utf8");
    return {
      parsed: JSON.parse(serialized) as PersistedCacheFile,
      cachePath,
    };
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT") {
      return null;
    }
    await moveCorruptCache(cachePath);
    return null;
  }
}

function getPersistedGeneratedAt(parsed: PersistedCacheFile): string | null {
  const generatedAt =
    parsed &&
    typeof parsed === "object" &&
    parsed.snapshot &&
    typeof parsed.snapshot === "object" &&
    "generatedAt" in parsed.snapshot
      ? parsed.snapshot.generatedAt
      : null;
  if (typeof generatedAt !== "string") {
    return null;
  }
  return Number.isNaN(new Date(generatedAt).getTime()) ? null : generatedAt;
}

function hasShallowSnapshotMetadata(value: unknown): value is PersistedCacheFile["snapshot"] {
  if (!value || typeof value !== "object") {
    return false;
  }
  const snapshot = value as Partial<PersistedCacheFile["snapshot"]>;
  if (typeof snapshot.generatedAt !== "string") {
    return false;
  }
  if (Number.isNaN(new Date(snapshot.generatedAt).getTime())) {
    return false;
  }
  if (!snapshot.root || typeof snapshot.root !== "object") {
    return false;
  }
  const root = snapshot.root as Partial<DiskAnalysisSnapshot["root"]>;
  if (
    typeof root.path !== "string" ||
    typeof root.name !== "string" ||
    (root.type !== "directory" && root.type !== "file") ||
    !Array.isArray(root.children)
  ) {
    return false;
  }
  if (!snapshot.totals || typeof snapshot.totals !== "object") {
    return false;
  }
  const totals = snapshot.totals as Partial<DiskAnalysisSnapshot["totals"]>;
  if (
    typeof totals.totalBytes !== "number" ||
    typeof totals.totalFiles !== "number" ||
    typeof totals.totalDirectories !== "number"
  ) {
    return false;
  }
  return Array.isArray(snapshot.extensionLegend) && Array.isArray(snapshot.issues);
}

function getPersistedMount(parsed: PersistedCacheFile): DiskAnalysisMountIdentity | null {
  if (
    parsed &&
    typeof parsed === "object" &&
    parsed.mount &&
    typeof parsed.mount === "object" &&
    typeof parsed.mount.mount === "string" &&
    typeof parsed.mount.fs === "string"
  ) {
    return parsed.mount;
  }
  return null;
}

async function readPersistedCacheMetadata(
  mount: DiskAnalysisMountIdentity
): Promise<DiskAnalysisMountState["cache"] | null> {
  const file = await readPersistedCacheFile(mount);
  if (!file) {
    return null;
  }
  const persistedMount = getPersistedMount(file.parsed);
  if (!persistedMount || !hasShallowSnapshotMetadata(file.parsed.snapshot)) {
    await moveCorruptCache(file.cachePath);
    return null;
  }
  const persistedCache = isPersistedCacheMetadata(file.parsed.cache)
    ? file.parsed.cache
    : undefined;
  return getCacheMetadata(file.parsed.snapshot.generatedAt, persistedCache);
}

async function readPersistedCache(
  mount: DiskAnalysisMountIdentity
): Promise<DiskAnalysisSnapshotEnvelope | null> {
  const file = await readPersistedCacheFile(mount);
  if (!file) {
    return null;
  }
  try {
    const persistedMount = getPersistedMount(file.parsed);
    const generatedAt = getPersistedGeneratedAt(file.parsed);
    if (!persistedMount || !generatedAt) {
      throw new Error("Invalid persisted disk analysis cache");
    }
    const snapshot = DiskAnalysisSnapshotSchema.parse(file.parsed.snapshot);
    const persistedCache = isPersistedCacheMetadata(file.parsed.cache)
      ? file.parsed.cache
      : undefined;
    return buildSnapshotEnvelope(persistedMount, snapshot, persistedCache);
  } catch {
    await moveCorruptCache(file.cachePath);
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
  const cache = buildPersistedCacheMetadata(snapshot);
  const serialized = JSON.stringify({
    mount,
    snapshot,
    cache,
  } satisfies PersistedCacheFile);
  await fs.writeFile(tempPath, serialized);
  await fs.move(tempPath, cachePath, { overwrite: true });
  return buildSnapshotEnvelope(mount, snapshot, cache);
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
    job: getProgressJobState(job),
  });
}

function clearLiveEmitTimer(job: DiskAnalysisJobInternal) {
  if (job.liveEmitTimer !== null) {
    clearTimeout(job.liveEmitTimer);
    job.liveEmitTimer = null;
  }
}

function getActiveJobForMount(mount: DiskAnalysisMountIdentity): DiskAnalysisJobInternal | null {
  const mountKey = getMountKey(mount);
  const activeJobId = activeJobIdByMount.get(mountKey);
  const existing = activeJobId ? jobs.get(activeJobId) : null;
  return existing && isActivePhase(existing.phase) ? existing : null;
}

function flushQueuedLiveEvents(job: DiskAnalysisJobInternal) {
  clearLiveEmitTimer(job);
  if (!job.pendingProgressEmit && job.pendingBranchesByPath.size === 0) {
    return;
  }
  job.lastLiveEmitAtMs = Date.now();
  if (job.pendingProgressEmit) {
    job.pendingProgressEmit = false;
    emitProgress(job);
  }
  if (job.pendingBranchesByPath.size === 0) {
    return;
  }
  const branches = [...job.pendingBranchesByPath.values()];
  job.pendingBranchesByPath.clear();
  for (const branch of branches) {
    emitBranch(job, branch);
  }
}

function scheduleQueuedLiveEvents(job: DiskAnalysisJobInternal, force: boolean = false) {
  if (force) {
    flushQueuedLiveEvents(job);
    return;
  }
  if (job.liveEmitTimer !== null) {
    return;
  }
  const elapsedMs = Date.now() - job.lastLiveEmitAtMs;
  const delayMs = Math.max(0, PROGRESS_EMIT_INTERVAL_MS - elapsedMs);
  if (delayMs === 0) {
    flushQueuedLiveEvents(job);
    return;
  }
  job.liveEmitTimer = setTimeout(() => {
    flushQueuedLiveEvents(job);
  }, delayMs);
}

function queueProgressEmit(job: DiskAnalysisJobInternal, force: boolean = false) {
  job.pendingProgressEmit = true;
  scheduleQueuedLiveEvents(job, force);
}

function emitBranch(job: DiskAnalysisJobInternal, branch: DiskAnalysisTreemapNode) {
  notifyListeners(job.jobId, {
    event: "branch",
    jobId: job.jobId,
    mount: job.mount,
    branch,
  });
}

function queueBranchEmit(
  job: DiskAnalysisJobInternal,
  branch: DiskAnalysisTreemapNode,
  force: boolean = false
) {
  job.pendingBranchesByPath.set(branch.path, branch);
  scheduleQueuedLiveEvents(job, force);
}

function emitSnapshot(job: DiskAnalysisJobInternal, snapshot: DiskAnalysisSnapshot) {
  notifyListeners(job.jobId, {
    event: "snapshot",
    job: getJobState(job),
    snapshot,
  });
}

function createDirectoryNode(
  directoryPath: string,
  parentPath: string | null
): MutableDirectoryNode {
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
    childIndexByPath: new Map(),
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

/**
 * Test-only instrumentation for the tree-build and emit paths.
 *
 * `nodeCopyCount` counts treemap nodes materialised *from an existing node* —
 * every serialisation or clone. It deliberately does not count the walker's
 * original node creations, which are one per node by construction. The
 * invariant the suite asserts is that the total stays bounded by the number of
 * nodes in the finished tree: linear, not nodes x depth.
 *
 * `childLookups` counts insertions; `childLookupCandidates` counts the sibling
 * entries those insertions had to inspect; `maxChildIndexSize` records the
 * widest path index actually built. The three are incremented in three
 * different places on purpose, so that no single edit can keep them consistent
 * while changing the algorithm underneath them -- see `findChildSlot`.
 */
let nodeCopyCount = 0;
let childLookups = 0;
let childLookupCandidates = 0;
let maxChildIndexSize = 0;

/**
 * The one place a child's slot is located.
 *
 * The body must increment `childLookupCandidates` once per candidate it
 * actually inspects. A `Map` probe inspects exactly one, which is the whole
 * point: `upsertChildBranch` used to run a `findIndex` over the sibling array,
 * so building a directory with n entries cost O(n^2). If you replace this body,
 * count honestly -- the suite asserts one candidate per lookup, and deleting
 * the call to this function drops the count to zero and fails the same test.
 */
function findChildSlot(parent: MutableDirectoryNode, childPath: string): number | undefined {
  childLookupCandidates += 1;
  return parent.childIndexByPath.get(childPath);
}

function upsertChildBranch(parent: MutableDirectoryNode, child: DiskAnalysisTreemapNode) {
  childLookups += 1;
  const childIndex = findChildSlot(parent, child.path);
  if (childIndex !== undefined) {
    parent.children[childIndex] = child;
    return;
  }
  parent.childIndexByPath.set(child.path, parent.children.length);
  parent.children.push(child);
}

/**
 * Turn a finished directory into its treemap node.
 *
 * Children are already final treemap nodes and are attached **by reference**.
 * The previous version deep copied the whole subtree at every level, so each
 * node was re-serialised once per ancestor between it and the root -- ten to
 * fifteen million throwaway allocations on a million-node tree, and the main
 * source of out-of-memory kills.
 *
 * Only call this once the directory is scanned and has no pending children:
 * `children` is sorted in place here, which leaves `childIndexByPath` stale.
 */
function finalizeDirectoryNode(node: MutableDirectoryNode): DiskAnalysisTreemapNode {
  maxChildIndexSize = Math.max(maxChildIndexSize, node.childIndexByPath.size);
  const children = node.children;
  children.sort((left, right) => right.recursiveSize - left.recursiveSize);
  let recursiveSize = 0;
  let descendantsScanned = 0;
  for (const child of children) {
    recursiveSize += child.recursiveSize;
    if (child.type === "directory") {
      descendantsScanned += child.descendantsScanned + 1;
    }
  }
  nodeCopyCount += 1;
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

/**
 * The live branch event carries a directory and its direct children only --
 * sending the subtree would be the whole tree again, once per emit.
 *
 * Directory children are copied with their own children stripped. File children
 * have no children to strip and are never mutated after the walker creates
 * them, so they travel by reference. Listeners must treat everything they
 * receive as read-only -- see `subscribeToJob`.
 */
function toShallowBranch(branch: DiskAnalysisTreemapNode): DiskAnalysisTreemapNode {
  nodeCopyCount += 1;
  return {
    ...branch,
    issues: [...branch.issues],
    children: branch.children.map((child) => {
      if (child.type === "file") {
        return child;
      }
      nodeCopyCount += 1;
      return {
        ...child,
        issues: [...child.issues],
        children: [],
      };
    }),
  };
}

/**
 * The schema caps `extension` at 64 characters, on the treemap node and on the
 * legend entry alike, so anything longer has to be clipped here.
 *
 * A final dot-segment that long is ordinary -- a content hash, a UUID, a
 * timestamp suffix. While the snapshot was re-parsed on the emit path an
 * over-long extension failed the whole scan loudly; without that parse it would
 * instead sail through, be written to the cache, be reported "fresh" by the
 * shallow metadata check, and then be rejected and quarantined on every read.
 * That is a full-disk rescan loop on exactly the hosts this file exists to
 * protect, so the clamp belongs at the source.
 */
const MAX_EXTENSION_LENGTH = 64;

function getFileExtension(filePath: string): string | null {
  const extension = path.extname(filePath).replace(/^\./, "").trim().toLowerCase();
  if (extension.length === 0) {
    return null;
  }
  return extension.length > MAX_EXTENSION_LENGTH
    ? extension.slice(0, MAX_EXTENSION_LENGTH)
    : extension;
}

function isActivePhase(phase: JobPhase): boolean {
  return phase === "queued" || phase === "scanning";
}

function hasPartialResult(job: DiskAnalysisJobInternal): boolean {
  return job.partialResultDetected;
}

async function ensureMountAvailable(mount: DiskAnalysisMountIdentity): Promise<string> {
  const resolvedMount = resolveMountPath(mount.mount);
  let stat;
  try {
    // Timed out like every other fs call in this file: a hard NFS mount that
    // has gone away would otherwise leave `startScan` awaiting forever, with
    // the job already registered and its concurrency slot taken.
    stat = await withFsTimeout(
      fs.stat(resolvedMount),
      resolvedMount,
      getFsOperationTimeoutMs()
    );
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

/** Rejection reason for a scan stopped by `cancelScan` (or the running-job TTL). */
class DiskAnalysisScanAbortedError extends Error {
  constructor() {
    super("Disk analysis scan aborted");
    this.name = "DiskAnalysisScanAbortedError";
  }
}

async function executeScan(job: DiskAnalysisJobInternal): Promise<DiskAnalysisSnapshot> {
  const fsTimeoutMs = getFsOperationTimeoutMs();
  const rootPath = await ensureMountAvailable(job.mount);
  const rootStat = await withFsTimeout(
    fs.stat(rootPath),
    rootPath,
    fsTimeoutMs,
    job.controller.signal
  );
  const rootDeviceId = getComparableDeviceId(rootStat);
  const smallFileThresholdBytes = getSmallFileThresholdBytes();
  const rootNode = createDirectoryNode(rootPath, null);
  const nodesByPath = new Map<string, MutableDirectoryNode>([[rootPath, rootNode]]);
  /**
   * DISK-8: `dev:ino` pairs already counted for this job, so a second (or
   * tenth) hardlink to the same inode contributes nothing further to the
   * totals. Borg, rsnapshot and Time Machine backup trees are built almost
   * entirely from hardlinks, so without this a 200 GB backup directory can
   * report as several terabytes -- the same blocks summed once per link.
   *
   * Scoped to this job the same way `nodesByPath` is, and cleared alongside
   * it in `releasePartialTree` so a cancelled or failed scan does not keep it
   * (or the tree it references) alive past the job's own teardown.
   *
   * Only ever consulted when `stat.nlink > 1` at the call site below -- every
   * file on a normal filesystem has `nlink === 1`, and hashing a `dev:ino`
   * key for each one would be pure cost on the hot path of a million-node
   * walk for a check that almost never applies.
   */
  const seenHardlinkInodes = new Set<string>();
  const extensionCounts = new Map<string, { count: number; totalBytes: number }>();
  let totalFiles = 0;
  let totalDirectories = 1;
  let indexedNodes = 1;
  let activeWorkers = 0;
  let settled = false;

  /**
   * The work queue, in two halves.
   *
   * `pending` is a bounded LIFO stack: taking the most recently discovered
   * directory first keeps the walk depth-first, which is what keeps the number
   * of half-finished directories (and therefore live `MutableDirectoryNode`s)
   * small on a wide tree.
   *
   * `overflow` is the FIFO the stack spills into once it is full. It exists
   * because `maxPendingDirectories` used to *drop* the directories that did
   * not fit and mark the scan partial -- a queue-length bound masquerading as
   * a work budget. Whether a given directory fit depended on how many siblings
   * happened to be queued at that instant, i.e. on how the concurrent workers
   * interleaved, so the same tree could scan to two different sizes on two
   * runs. Nothing is dropped here; the only budget that truncates is
   * `maxIndexedNodes`, which is checked before a directory is ever queued, so
   * the two halves together still hold at most that many tasks.
   */
  const pending: DirectoryTask[] = [];
  const overflow: (DirectoryTask | undefined)[] = [];
  let overflowHead = 0;

  const enqueueDirectory = (task: DirectoryTask) => {
    if (pending.length < job.limits.maxPendingDirectories) {
      pending.push(task);
      return;
    }
    overflow.push(task);
  };

  const dequeueDirectory = (): DirectoryTask | undefined => {
    const next = pending.pop();
    if (next) {
      return next;
    }
    if (overflowHead >= overflow.length) {
      return undefined;
    }
    const task = overflow[overflowHead];
    // Release the slot's reference as well as handing the task out, so a
    // drained overflow array is not still pinning every node it ever held.
    overflow[overflowHead] = undefined;
    overflowHead += 1;
    if (overflowHead >= overflow.length) {
      overflow.length = 0;
      overflowHead = 0;
    } else if (overflowHead >= 1024 && overflowHead * 2 >= overflow.length) {
      // Amortised O(1): compact only once the dead prefix is at least half the
      // array, so the copying cost is paid at most once per element overall.
      overflow.splice(0, overflowHead);
      overflowHead = 0;
    }
    return task;
  };

  const hasQueuedWork = (): boolean => pending.length > 0 || overflowHead < overflow.length;

  enqueueDirectory({ directoryPath: rootPath, node: rootNode });

  job.progress.directoriesDiscovered = 1;

  const done = new Promise<DiskAnalysisSnapshot>((resolve, reject) => {
    const finalizeNode = (node: MutableDirectoryNode) => {
      const branch = finalizeDirectoryNode(node);
      if (
        node.parentPath === null ||
        branch.recursiveSize > 0 ||
        branch.truncated ||
        branch.issues.length > 0
      ) {
        queueBranchEmit(job, toShallowBranch(branch));
      }

      if (node.parentPath) {
        const parent = nodesByPath.get(node.parentPath);
        if (parent) {
          upsertChildBranch(parent, branch);
          parent.pendingChildren = Math.max(0, parent.pendingChildren - 1);
          if (parent.scanned && parent.pendingChildren === 0) {
            finalizeNode(parent);
          }
        }
        // The branch now owns `node.children`; the mutable node itself is done.
        nodesByPath.delete(node.path);
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

      // No schema parse here. This service authored every field a line above;
      // nothing crossed a trust boundary, and z.lazy would walk and reallocate
      // the entire tree a second time to tell us what we just wrote. The parse
      // stays on the cache **read** path, where the file on disk could have been
      // truncated, hand-edited, or written by an older version.
      const snapshot: DiskAnalysisSnapshot = {
        mount: job.mount,
        generatedAt,
        root: branch,
        extensionLegend,
        totals: {
          totalBytes: branch.recursiveSize,
          totalFiles,
          totalDirectories,
        },
        issues: [...job.issues],
        issueCount: job.issueCount,
        // The same flag `runJob` turns into `phase: "partial"` a moment later
        // (`setJobFinalState(job, hasPartialResult(job) ? "partial" : ...)`),
        // recorded on the snapshot so the client can still say "totals are a
        // lower bound" after the job has been pruned. Read here because this
        // is where the tree stops changing: every worker has finished and
        // every descendant is finalised, so no further issue can be recorded
        // against this job.
        partial: hasPartialResult(job),
      };

      // `snapshot.root.children` *is* `rootNode.children` now, not a deep copy of
      // it. Leaving the root reachable through `nodesByPath` would leave a late
      // `upsertChildBranch` able to mutate a snapshot that has already gone to
      // the cache file and to every SSE subscriber. No such path exists today --
      // both root-finalisation sites require `activeWorkers === 0`, and
      // `pendingChildren === 0` means every descendant is already finalised --
      // but that is an invariant of the scheduler, not of this function, so drop
      // the handle rather than depend on it.
      nodesByPath.delete(node.path);
      // No further stat will be compared against this job's dev:ino set --
      // the walk is over -- so release it alongside the tree handle above.
      seenHardlinkInodes.clear();

      settled = true;
      resolve(snapshot);
    };

    const failScan = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      releasePartialTree();
      reject(error);
    };

    /**
     * Drop every reference the walk still holds to the half-built tree.
     *
     * DISK-12's second half: the done promise's executor closes over
     * `nodesByPath`, the queues and `rootNode`, and a cancelled scan used to
     * leave all of it reachable for as long as anything held the promise.
     *
     * It is only ever safe to call this once no worker can still be writing
     * into the tree, which is why `failScan` is reached from `settleAbort` and
     * nowhere else, and why `settleAbort` is a no-op until
     * `activeWorkers === 0`. Errors take the same route as cancellations
     * (`abortWithFailure`) precisely so that this holds on every path rather
     * than only on the cancellation one.
     */
    function releasePartialTree() {
      nodesByPath.clear();
      seenHardlinkInodes.clear();
      pending.length = 0;
      overflow.length = 0;
      overflowHead = 0;
      rootNode.children = [];
      rootNode.childIndexByPath.clear();
    }

    const isAborted = () => job.controller.signal.aborted;

    /**
     * Settle a cancelled scan -- but only once every worker has returned.
     *
     * The old code rejected from whichever call site noticed the abort first,
     * while other workers were still mid-`readdir` holding
     * `MutableDirectoryNode` references. That had two consequences. If nobody
     * noticed (every worker parked in an fs call that never returns, i.e. a
     * stale NFS or SMB mount) the promise simply never settled -- DISK-12.
     * And if somebody did, the walk carried on mutating nodes after the
     * promise had been handed back. Waiting for `activeWorkers === 0` fixes
     * both, and is what makes `releasePartialTree` safe: at that point no
     * worker holds a reference into the tree, so nothing can mutate a
     * structure that has already been published (B4's invariant, which on the
     * success path is enforced by dropping the root from `nodesByPath` before
     * `resolve`).
     */
    const settleAbort = () => {
      if (settled || activeWorkers > 0) {
        return;
      }
      failScan(job.internalFailure?.error ?? new DiskAnalysisScanAbortedError());
    };

    /**
     * Tear the scan down because something threw, rather than because the user
     * cancelled.
     *
     * This used to settle on the spot from the worker catch-all, which broke
     * every guarantee the cancellation rewrite added. `failScan` ran
     * `releasePartialTree()` while other workers were still writing into the
     * tree (and `nodesByPath.set` promptly re-populated the map it had just
     * cleared); the controller was never aborted, so those workers kept
     * walking with no way to stop them -- `cancelScan` returns false once the
     * phase is terminal; and `runJob` returned straight away, which released
     * the mount's entry in `unsettledJobIdByMount` and let `startScan` admit a
     * second walk of a mount that was still being walked. That is exactly the
     * condition guard 4 exists to prevent, and a thrown SSE write was enough
     * to defeat it: `notifyListeners` invokes subscriber callbacks unguarded,
     * and `queueBranchEmit`/`queueProgressEmit` reach it synchronously once
     * the emit interval has elapsed.
     *
     * So a failure now takes the cancellation route: record why, abort the
     * controller so every worker stops and unwinds, and let the last one out
     * settle through `settleAbort`. `runJob` reads `internalFailure` to decide
     * `failed` versus `cancelled`.
     */
    const abortWithFailure = (error: unknown) => {
      if (settled) {
        return;
      }
      // A cancellation already in flight keeps its phase: the user asked for
      // this to stop, and whatever threw on the way out is a consequence.
      if (!job.internalFailure && !isAborted()) {
        job.internalFailure = { error };
      }
      job.controller.abort();
      settleAbort();
    };

    const addNodeWithinLimit = () => {
      if (indexedNodes >= job.limits.maxIndexedNodes) {
        return false;
      }
      indexedNodes += 1;
      return true;
    };

    const schedule = () => {
      if (settled) {
        return;
      }
      if (isAborted()) {
        // No new work, and settle here if there is nobody left to settle from
        // the worker `finally`.
        settleAbort();
        return;
      }

      while (activeWorkers < job.limits.maxWorkers && hasQueuedWork()) {
        const task = dequeueDirectory();
        if (!task) {
          break;
        }
        activeWorkers += 1;
        void (async () => {
          try {
            if (isAborted()) {
              return;
            }

            let entries: fs.Dirent[];
            try {
              entries = await withFsTimeout(
                fs.readdir(task.directoryPath, { withFileTypes: true }),
                task.directoryPath,
                fsTimeoutMs,
                job.controller.signal
              );
            } catch (error) {
              if (isAborted()) {
                return;
              }
              const issue = getIssueForFsError(task.directoryPath, error);
              recordIssue(job, issue, { nodeIssues: task.node.issues });
              task.node.truncated = true;
              task.node.scanned = true;
              job.progress.directoriesCompleted += 1;
              touchJob(job);
              queueProgressEmit(job);
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
            let indexedNodeSkips = 0;
            let nestedMountSkips = 0;
            let symlinkSkips = 0;
            // Only call this once a file's bytes are actually entering the tree (the
            // small-file bucket, or past the node-limit gate) — a file skipped by the
            // gate must not inflate totalFiles or the extension legend beyond what the
            // treemap shows.
            const recordFileAccounting = (extension: string | null, size: number) => {
              if (extension) {
                const current = extensionCounts.get(extension) ?? {
                  count: 0,
                  totalBytes: 0,
                };
                current.count += 1;
                current.totalBytes += size;
                extensionCounts.set(extension, current);
              }
              totalFiles += 1;
            };
            for (const entry of entries) {
              if (isAborted()) {
                return;
              }

              const entryPath = path.join(task.directoryPath, entry.name);
              if (entry.isSymbolicLink()) {
                // Aggregated below, once per directory, rather than one issue
                // per link -- a directory full of symlinks must not fan out
                // into thousands of near-identical issue objects.
                symlinkSkips += 1;
                task.node.truncated = true;
                continue;
              }

              let stat;
              try {
                stat = await withFsTimeout(
                  fs.stat(entryPath),
                  entryPath,
                  fsTimeoutMs,
                  job.controller.signal
                );
              } catch (error) {
                if (isAborted()) {
                  return;
                }
                const issue = getIssueForFsError(entryPath, error);
                recordIssue(job, issue, { nodeIssues: task.node.issues });
                task.node.truncated = true;
                continue;
              }

              // Stay on the selected mount instead of traversing into nested mounts like
              // procfs, sysfs, tmpfs, removable drives, or bind-mounted trees. The subtree
              // is real data the user has on disk, so record that it was skipped instead of
              // letting it vanish from the totals with no trace.
              if (rootDeviceId !== null && getComparableDeviceId(stat) !== rootDeviceId) {
                task.node.truncated = true;
                nestedMountSkips += 1;
                continue;
              }

              if (stat.isDirectory()) {
                task.node.childCount += 1;
                // The node budget is the only reason a directory is dropped.
                // A full `pending` stack is not: the directory spills into the
                // overflow FIFO and is walked later -- see the queue comment
                // at the top of this function.
                if (!addNodeWithinLimit()) {
                  task.node.truncated = true;
                  indexedNodeSkips += 1;
                  continue;
                }

                const childNode = createDirectoryNode(entryPath, task.node.path);
                nodesByPath.set(entryPath, childNode);
                upsertChildBranch(task.node, createDirectoryPlaceholder(entryPath));
                task.node.pendingChildren += 1;
                totalDirectories += 1;
                job.progress.directoriesDiscovered += 1;
                enqueueDirectory({ directoryPath: entryPath, node: childNode });
                continue;
              }

              if (!stat.isFile()) {
                continue;
              }

              if (stat.nlink > 1 && Number.isSafeInteger(stat.ino)) {
                // A dev:ino pair identifies the physical inode; hardlinks to
                // it share one. Only checked when nlink > 1 -- see the
                // comment on `seenHardlinkInodes` -- so an ordinary file
                // (nlink === 1, the overwhelming common case) never pays for
                // the lookup. `ino`, like `dev` (see `getComparableDeviceId`),
                // can exceed Number.MAX_SAFE_INTEGER on 64-bit-inode
                // filesystems; unlike a device-id comparison, a collision
                // here is not a merely-inaccurate answer but a distinct real
                // file silently vanishing from the tree and the totals, so an
                // unsafe `ino` is treated as unmeasured and this file is
                // counted normally instead of risking the key. This is not a
                // rare-filesystem corner case: Windows/NTFS file IDs are
                // 64-bit and routinely exceed 2^53 even for an ordinary
                // hardlink on a fresh volume, so on that platform this guard
                // is the common path and hardlink dedup effectively does not
                // fire -- every link is counted as its own file there.
                //
                // A link already seen (and confirmed via a safe key) has
                // already had its bytes counted in full through the first
                // path that reached it, so this one is skipped entirely: no
                // size, no childCount, no extension-legend entry, no node in
                // the tree. Counting it again would be counting the same
                // disk blocks twice.
                const inodeKey = `${stat.dev}:${stat.ino}`;
                if (seenHardlinkInodes.has(inodeKey)) {
                  continue;
                }
                seenHardlinkInodes.add(inodeKey);
              }

              // DISK-8: bytes this file actually occupies on disk, not its
              // apparent length -- see `getAllocatedSizeBytes`. Flows into the
              // treemap node, the small-file bucket, `job.progress`, and (via
              // `recordFileAccounting`) the extension legend uniformly, so the
              // legend never disagrees with what the treemap shows for the
              // same file.
              const allocatedSize = getAllocatedSizeBytes(stat);
              const extension = getFileExtension(entryPath);
              task.node.childCount += 1;
              if (allocatedSize < adaptiveSmallFileThresholdBytes) {
                recordFileAccounting(extension, allocatedSize);
                smallFileCount += 1;
                smallFileBytes += allocatedSize;
                task.node.size += allocatedSize;
                job.progress.filesDiscovered += 1;
                job.progress.bytesProcessed += allocatedSize;
                continue;
              }
              if (!addNodeWithinLimit()) {
                task.node.truncated = true;
                indexedNodeSkips += 1;
                continue;
              }
              recordFileAccounting(extension, allocatedSize);
              task.node.children.push({
                path: entryPath,
                name: entry.name,
                type: "file",
                size: allocatedSize,
                recursiveSize: allocatedSize,
                extension,
                childCount: 0,
                descendantsScanned: 0,
                truncated: false,
                issues: [],
                children: [],
              });
              task.node.size += allocatedSize;
              job.progress.filesDiscovered += 1;
              job.progress.bytesProcessed += allocatedSize;
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

            if (symlinkSkips > 0) {
              const issue = createIssue(
                "symlink-skipped",
                task.directoryPath,
                `Symlink skipped for ${symlinkSkips} entr${symlinkSkips === 1 ? "y" : "ies"} under ${task.directoryPath}`
              );
              recordIssue(job, issue, {
                nodeIssues: task.node.issues,
                occurrences: symlinkSkips,
              });
            }

            if (indexedNodeSkips > 0) {
              const issue = createIssue(
                "partial-scan",
                task.directoryPath,
                `Node limit reached while indexing ${indexedNodeSkips} entr${indexedNodeSkips === 1 ? "y" : "ies"} under ${task.directoryPath}`
              );
              recordIssue(job, issue, {
                nodeIssues: task.node.issues,
                occurrences: indexedNodeSkips,
              });
            }

            if (nestedMountSkips > 0) {
              const issue = createIssue(
                "nested-mount-skipped",
                task.directoryPath,
                `Nested mount skipped for ${nestedMountSkips} entr${nestedMountSkips === 1 ? "y" : "ies"} under ${task.directoryPath}`
              );
              recordIssue(job, issue, {
                nodeIssues: task.node.issues,
                occurrences: nestedMountSkips,
              });
            }

            task.node.scanned = true;
            job.progress.directoriesCompleted += 1;
            touchJob(job);
            queueProgressEmit(job);
            if (task.node.pendingChildren === 0) {
              finalizeNode(task.node);
            }
          } catch (error) {
            abortWithFailure(error);
          } finally {
            activeWorkers -= 1;
            if (!settled) {
              if (isAborted()) {
                // Both tear-downs -- cancellation and failure -- settle here,
                // and only here. Every worker runs this on its way out, and
                // `settleAbort` is a no-op until `activeWorkers` reaches zero,
                // so the last worker to unwind is the one that rejects. That
                // ordering is what makes `releasePartialTree` safe: by then
                // nobody holds a reference into the tree, so nothing can
                // mutate a structure that has already been handed out.
                //
                // Reaching this from the `finally` rather than from a check
                // inside the walk is the actual DISK-12 fix. A worker parked
                // in a hung `readdir`/`stat` never reaches an abort check; it
                // leaves through the per-operation timeout, and it has to
                // settle the scan on its way past even though the root was
                // never scanned.
                settleAbort();
              } else if (hasQueuedWork()) {
                schedule();
              } else if (
                activeWorkers === 0 &&
                rootNode.scanned &&
                rootNode.pendingChildren === 0
              ) {
                finalizeNode(rootNode);
              }
            }
          }
        })();
      }

      if (!settled && activeWorkers === 0 && !hasQueuedWork() && rootNode.scanned) {
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
  queueProgressEmit(job, true);

  try {
    const snapshot = await executeScan(job);
    // `internalFailure` is checked here too, matching the catch block below:
    // a worker can throw (setting `internalFailure` and aborting the
    // controller) while a different worker is mid-`stat` on its directory's
    // last entry, past the per-entry abort check and about to fall through
    // the fully synchronous finalize block with no abort check of its own.
    // That worker's `finalizeNode` cascade can still resolve `done` with a
    // complete snapshot -- `signal.aborted` alone can no longer tell this
    // branch apart from a genuine cancellation, so without `internalFailure`
    // a real internal failure is reported as `cancelled` and its finished
    // snapshot is silently discarded instead of being published through the
    // normal completed/partial path below, the same way it would be had no
    // worker failed at all.
    if (job.controller.signal.aborted && !job.internalFailure) {
      // Cancelled in the narrow window between the last worker finishing and
      // this line. The result is complete, but the client has already been
      // told the job is `cancelled`, and writing the cache here would publish
      // a snapshot nobody asked for under a phase that denies it exists.
      clearLiveEmitTimer(job);
      setJobFinalState(job, "cancelled");
      emitStatus(job);
      return;
    }
    job.snapshot = snapshot;
    flushQueuedLiveEvents(job);
    await writePersistedCache(job.mount, snapshot);
    setJobFinalState(job, hasPartialResult(job) ? "partial" : "completed");
    emitSnapshot(job, snapshot);
    emitStatus(job);
  } catch (error) {
    // `signal.aborted` alone no longer means "the user cancelled": a failure
    // aborts the controller too, so that workers stop and the scan settles
    // through the same wind-down. `internalFailure` is what separates them.
    if (job.controller.signal.aborted && !job.internalFailure) {
      clearLiveEmitTimer(job);
      setJobFinalState(job, "cancelled");
      emitStatus(job);
      return;
    }

    clearLiveEmitTimer(job);
    const issue = createIssue(
      "unknown",
      job.mount.mount,
      error instanceof Error ? error.message : "Disk analysis failed",
      false
    );
    recordIssue(job, issue);
    setJobFinalState(job, "failed");
    emitStatus(job);
  }
}

/**
 * Hand a freshly created job to `runJob` on the microtask queue (so `startScan`
 * returns before the walk begins) and record the run as unsettled for the
 * mount until it has fully unwound.
 *
 * The entry in `unsettledJobIdByMount` outlives the job's terminal *phase* on
 * purpose: a cancelled job is `cancelled` immediately but its workers keep
 * running until they return from whatever fs call they were in. Until then the
 * mount is still being walked, so a second scan of it must not start.
 */
function startJobRun(job: DiskAnalysisJobInternal, mountKey: string): Promise<void> {
  unsettledJobIdByMount.set(mountKey, job.jobId);
  return Promise.resolve()
    .then(() => runJob(job))
    .catch((error) => {
      // runJob handles its own failures; anything reaching here came from a
      // listener callback and must not become an unhandled rejection.
      console.error("[deckos] Disk analysis job failed unexpectedly:", error);
    })
    .finally(() => {
      if (unsettledJobIdByMount.get(mountKey) === job.jobId) {
        unsettledJobIdByMount.delete(mountKey);
      }
    });
}

/**
 * Create and launch a scan for `mount`, or join the one already running.
 *
 * No longer takes an `allowAutoStart` flag: `getMountState` was the only
 * caller that ever passed one, and it no longer starts anything (DISK-3), so
 * every remaining path through here is an explicit user request via
 * `startScan`. The policy guards live in `startScan` rather than here, because
 * joining an already-running job must not re-run them.
 */
async function ensureJob(
  mount: DiskAnalysisMountIdentity
): Promise<DiskAnalysisJobInternal | null> {
  pruneJobs();
  const mountKey = getMountKey(mount);
  const existing = getActiveJobForMount(mount);
  if (existing) {
    return existing;
  }

  const pendingStart = pendingJobStartByMount.get(mountKey);
  if (pendingStart) {
    return await pendingStart;
  }

  const startPromise = (async () => {
    const activeJob = getActiveJobForMount(mount);
    if (activeJob) {
      return activeJob;
    }

    const resolvedMount = await ensureMountAvailable(mount);
    const latestActiveJob = getActiveJobForMount(mount);
    if (latestActiveJob) {
      return latestActiveJob;
    }

    const now = new Date().toISOString();
    const job: DiskAnalysisJobInternal = {
      jobId: crypto.randomUUID(),
      mount: {
        mount: resolvedMount,
        fs: mount.fs,
      },
      phase: "queued",
      // Replaced immediately below, once the job object exists to hand to runJob.
      runPromise: Promise.resolve(),
      internalFailure: null,
      startedAt: now,
      updatedAt: now,
      progress: {
        directoriesDiscovered: 0,
        directoriesCompleted: 0,
        filesDiscovered: 0,
        bytesProcessed: 0,
      },
      issues: [],
      issueCount: 0,
      partialResultDetected: false,
      limits: getLimits(),
      controller: new AbortController(),
      createdAtMs: Date.now(),
      lastLiveEmitAtMs: 0,
      pendingProgressEmit: false,
      pendingBranchesByPath: new Map(),
      liveEmitTimer: null,
    };
    jobs.set(job.jobId, job);
    activeJobIdByMount.set(mountKey, job.jobId);
    job.runPromise = startJobRun(job, mountKey);
    emitStatus(job);
    return job;
  })();

  pendingJobStartByMount.set(mountKey, startPromise);
  try {
    return await startPromise;
  } finally {
    if (pendingJobStartByMount.get(mountKey) === startPromise) {
      pendingJobStartByMount.delete(mountKey);
    }
  }
}

/**
 * Report what is known about a mount without touching it. Observe-only.
 *
 * DISK-3: this used to start a full filesystem walk when the cache was missing
 * (`ensureJob(mount, { allowAutoStart: true })`) and schedule a background one
 * when it was stale (`scheduleRefreshJob`). Both were reached by merely
 * *looking* at the disk-analysis page, so opening it committed the box to
 * potentially hours of I/O that nobody asked for -- and, since a GET is
 * retried freely, re-committed it on every navigation.
 *
 * Scanning is now an explicit action: this function reads the cache metadata
 * and reports any job that is already running. It starts nothing, and it does
 * not stat the mount -- an unavailable mount is a fact for `startScan` to
 * discover, not a reason for the page to hang.
 */
export async function getMountState(
  mount: DiskAnalysisMountIdentity
): Promise<DiskAnalysisMountState> {
  pruneJobs();
  const cache = await readPersistedCacheMetadata(mount);
  const activeJob = getActiveJobForMount(mount);
  return DiskAnalysisMountStateSchema.parse({
    mount,
    cache: cache ?? {
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

/**
 * Start an explicit scan of `mount`, or join the one already running on it.
 *
 * This is now the only way a scan begins, so it is where the guards live.
 * In order:
 *
 *  1. **Denylisted roots** (DISK-6). `/proc/kcore` stats at roughly 128 TB, so
 *     a single walk of `/proc` makes every total on the page nonsense. The
 *     denylist is the one in `files.ts` rather than a second copy here, so the
 *     file browser and the analyser cannot drift apart about what is off
 *     limits.
 *  2. **Pseudo-filesystems the denylist cannot see**, via the kernel mount
 *     table -- see `assertNotPseudoFilesystem` for what that does per platform.
 *  3. **An already-running scan of this mount** is joined rather than
 *     duplicated, which keeps a double-clicked button harmless.
 *  4. **A previous scan of this mount that has not wound down** is refused.
 *     A cancelled job reports `cancelled` immediately while its workers are
 *     still inside `readdir`/`stat`; starting again now would mean two walks
 *     of the same mount.
 *  5. **The global concurrency cap.** Each scan runs `maxWorkers` (4)
 *     concurrent fs operations against a four-thread libuv pool, so two scans
 *     already saturate it and a third would only make all three slower.
 */
export async function startScan(
  mount: DiskAnalysisMountIdentity
): Promise<DiskAnalysisStartScanResult> {
  pruneJobs();
  const resolvedMount = resolveMountPath(mount.mount);
  assertNotDeniedPath(resolvedMount);
  await assertNotPseudoFilesystem(resolvedMount);

  const mountKey = getMountKey(mount);
  const existing = getActiveJobForMount(mount);
  if (existing) {
    return toStartScanResult(existing);
  }

  if (unsettledJobIdByMount.has(mountKey)) {
    throw new DiskAnalysisScanBusyError(
      resolvedMount,
      `A previous scan of ${resolvedMount} is still winding down; try again in a moment`
    );
  }

  // `pendingJobStartByMount` is counted alongside the unsettled runs because a
  // job does not claim its slot until `ensureMountAvailable` has resolved, and
  // that await is long enough for two concurrent requests to both pass a check
  // that only looked at `unsettledJobIdByMount`. `ensureJob` registers the
  // pending entry synchronously, so counting both closes the window.
  const scansInFlight = new Set([
    ...unsettledJobIdByMount.keys(),
    ...pendingJobStartByMount.keys(),
  ]);
  if (scansInFlight.size >= MAX_CONCURRENT_SCANS) {
    throw new DiskAnalysisScanBusyError(
      resolvedMount,
      `${scansInFlight.size} disk analysis scans are already running; wait for one to finish before scanning ${resolvedMount}`
    );
  }

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
  if (!isActivePhase(job.phase)) {
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

/** The returned event is read-only for the caller, as for `subscribeToJob`. */
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

/**
 * Subscribe to a job's scan events.
 *
 * **Listeners must treat the event and everything reachable from it as
 * read-only.** Since the tree is assembled by reference, a `branch` event shares
 * its file nodes with the live tree and a `snapshot` event *is* the live tree --
 * the same objects held by `job.snapshot`, written to the cache file, and handed
 * to every other subscriber. Mutating any of it corrupts all of them. Copy first
 * if you need to change something.
 */
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
  MAX_RETAINED_ISSUES,
  /**
   * Direct unit access to `recordIssue`'s retention/eviction behaviour
   * (finding 4, B5 review round 1). Driving a genuine uncaught mid-scan
   * failure through the public scan API to exercise this end-to-end isn't
   * practical -- every foreseeable fs error along that path is already
   * caught and turned into a normal (recoverable) issue by design, so a
   * `recoverable: false` issue in practice only ever comes from the single
   * scan-failure call site in `runJob`. The stub only needs the three fields
   * `recordIssue` actually touches.
   */
  recordIssueForTesting(
    job: Pick<DiskAnalysisJobInternal, "issues" | "issueCount" | "partialResultDetected">,
    issue: DiskAnalysisIssue,
    options?: { nodeIssues?: DiskAnalysisIssue[]; occurrences?: number }
  ): void {
    recordIssue(job as DiskAnalysisJobInternal, issue, options);
  },
  getNodeCopyCount(): number {
    return nodeCopyCount;
  },
  getChildLookupStats(): { lookups: number; candidates: number; maxIndexSize: number } {
    return {
      lookups: childLookups,
      candidates: childLookupCandidates,
      maxIndexSize: maxChildIndexSize,
    };
  },
  resetInstrumentation() {
    nodeCopyCount = 0;
    childLookups = 0;
    childLookupCandidates = 0;
    maxChildIndexSize = 0;
  },
  /**
   * Await a job's run to fully unwind and report the phase it landed on.
   *
   * `getJob(...).phase` is not this: `cancelScan` sets `cancelled`
   * synchronously while the walk is still in flight. DISK-12 lives in that
   * gap, so the test for it has to wait on the run itself.
   */
  async waitForJobSettled(jobId: string): Promise<DiskAnalysisJobState | null> {
    const job = jobs.get(jobId);
    if (!job) {
      return null;
    }
    await job.runPromise;
    return getJobState(job);
  },
  resetState() {
    jobs.clear();
    activeJobIdByMount.clear();
    unsettledJobIdByMount.clear();
    pendingJobStartByMount.clear();
    listenersByJobId.clear();
  },
  async clearState() {
    const running: Promise<void>[] = [];
    for (const job of jobs.values()) {
      if (isActivePhase(job.phase)) {
        job.controller.abort();
      }
      clearLiveEmitTimer(job);
      running.push(job.runPromise);
    }

    // Wait on the runs themselves rather than polling the phase: a cancelled
    // job reports a terminal phase long before its workers have unwound, and
    // tearing the module state down underneath a live walk is how one test's
    // scan ends up writing into the next test's data directory.
    await Promise.race([
      Promise.all(running),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);

    this.resetState();
    await fs.remove(DISK_ANALYSIS_DIR).catch(() => undefined);
  },
};
