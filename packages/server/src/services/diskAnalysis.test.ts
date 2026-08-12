import fs from "fs-extra";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  DiskAnalysisIssue,
  DiskAnalysisScanEvent,
  DiskAnalysisMountIdentity,
} from "@deckos/contracts";
import { DiskAnalysisIssueSchema } from "@deckos/contracts";

type DiskAnalysisModule = typeof import("./diskAnalysis.js");

const DEFAULT_ENV = {
  workers: process.env.DECKOS_DISK_ANALYSIS_MAX_WORKERS,
  pending: process.env.DECKOS_DISK_ANALYSIS_MAX_PENDING_DIRECTORIES,
  nodes: process.env.DECKOS_DISK_ANALYSIS_MAX_INDEXED_NODES,
  smallThreshold: process.env.DECKOS_DISK_ANALYSIS_SMALL_FILE_THRESHOLD_BYTES,
  cacheMaxBytes: process.env.DECKOS_DISK_ANALYSIS_CACHE_MAX_BYTES,
  fsTimeout: process.env.DECKOS_DISK_ANALYSIS_FS_TIMEOUT_MS,
};

/**
 * A promise the test can leave pending for as long as it likes, used to park a
 * mocked `fs` call the way a stale NFS or SMB mount parks a real one.
 *
 * `enter()` is what the mock awaits; `entered` resolves the first time any
 * mock reaches the gate. Tests that mean to act on a scan while a worker is
 * genuinely parked must wait on `entered` rather than sleeping: cancelling
 * before the walk has reached the gate settles the job immediately, which is
 * correct behaviour but not the case those tests exist to cover.
 */
function createGate(): {
  wait: Promise<void>;
  open: () => void;
  enter: () => Promise<void>;
  entered: Promise<void>;
} {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  let markEntered: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const enter = (): Promise<void> => {
    markEntered();
    return wait;
  };
  return { wait, open, enter, entered };
}

async function createTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function loadDiskAnalysisModule(dataDir: string): Promise<DiskAnalysisModule> {
  vi.resetModules();
  vi.doMock("../lib/config.js", () => ({
    DATA_DIR: dataDir,
  }));
  return await import("./diskAnalysis.js");
}

async function waitForTerminalJob(
  diskAnalysis: DiskAnalysisModule,
  jobId: string
): Promise<ReturnType<DiskAnalysisModule["getJob"]>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = diskAnalysis.getJob(jobId);
    if (
      job &&
      job.phase !== "queued" &&
      job.phase !== "scanning"
    ) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for disk analysis job ${jobId}`);
}

function getMountCacheHash(mount: DiskAnalysisMountIdentity): string {
  const resolvedMount = path.resolve(mount.mount);
  const normalizedMount =
    process.platform === "win32" ? resolvedMount.toLowerCase() : resolvedMount;
  return crypto.createHash("sha1").update(normalizedMount).digest("hex");
}

describe("diskAnalysis service", () => {
  beforeEach(() => {
    process.env.DECKOS_DISK_ANALYSIS_MAX_WORKERS = "1";
    process.env.DECKOS_DISK_ANALYSIS_MAX_PENDING_DIRECTORIES = "128";
    process.env.DECKOS_DISK_ANALYSIS_MAX_INDEXED_NODES = "1000";
  });

  afterEach(async () => {
    process.env.DECKOS_DISK_ANALYSIS_MAX_WORKERS = DEFAULT_ENV.workers;
    process.env.DECKOS_DISK_ANALYSIS_MAX_PENDING_DIRECTORIES = DEFAULT_ENV.pending;
    process.env.DECKOS_DISK_ANALYSIS_MAX_INDEXED_NODES = DEFAULT_ENV.nodes;
    process.env.DECKOS_DISK_ANALYSIS_SMALL_FILE_THRESHOLD_BYTES = DEFAULT_ENV.smallThreshold;
    process.env.DECKOS_DISK_ANALYSIS_CACHE_MAX_BYTES = DEFAULT_ENV.cacheMaxBytes;
    process.env.DECKOS_DISK_ANALYSIS_FS_TIMEOUT_MS = DEFAULT_ENV.fsTimeout;
    vi.resetModules();
    vi.clearAllMocks();
  });

  test("scan emits incremental branch events and persists a reusable cache", async () => {
    const dataDir = await createTempDir("deckos-disk-analysis-data-");
    const mountDir = await createTempDir("deckos-disk-analysis-mount-");
    await fs.ensureDir(path.join(mountDir, "alpha"));
    await fs.ensureDir(path.join(mountDir, "beta"));
    await fs.writeFile(path.join(mountDir, "alpha", "report.txt"), "hello world", "utf8");
    await fs.writeFile(path.join(mountDir, "beta", "movie.mkv"), Buffer.alloc(64));

    const diskAnalysis = await loadDiskAnalysisModule(dataDir);
    const mount = { mount: mountDir, fs: "testfs" };
    const start = await diskAnalysis.startScan(mount);
    const events: DiskAnalysisScanEvent[] = [];
    const unsubscribe = diskAnalysis.subscribeToJob(start.jobId, (event) => {
      events.push(event);
    });

    const finalJob = await waitForTerminalJob(diskAnalysis, start.jobId);
    unsubscribe();

    expect(finalJob?.phase).toBe("completed");
    expect(events.some((event) => event.event === "progress")).toBe(true);
    expect(
      events.some(
        (event) =>
          event.event === "branch" &&
          event.branch.path === mountDir &&
          event.branch.children.some((child) => child.path.endsWith("alpha")) &&
          event.branch.children.some((child) => child.path.endsWith("beta"))
      )
    ).toBe(true);
    expect(
      events.some((event) => event.event === "branch" && event.branch.path.endsWith("alpha"))
    ).toBe(true);
    expect(
      events.some((event) => event.event === "branch" && event.branch.path.endsWith("beta"))
    ).toBe(true);

    const cached = await diskAnalysis.getCachedSnapshot(mount);
    expect(cached?.cache.state).toBe("fresh");
    expect(cached?.snapshot.totals.totalFiles).toBe(2);
    expect(cached?.snapshot.totals.totalBytes).toBe(75);
    expect(cached?.snapshot.root.recursiveSize).toBe(75);
    expect(
      cached?.snapshot.root.children.every(
        (child) =>
          child.type === "directory" &&
          child.children.some(
            (grandchild) =>
              grandchild.type === "file" && grandchild.name.startsWith("Small Files (")
          )
      )
    ).toBe(true);
    expect(cached?.snapshot.extensionLegend.map((entry) => entry.extension)).toEqual([
      "mkv",
      "txt",
    ]);
    const alphaDir = cached?.snapshot.root.children.find((child) => child.path.endsWith("alpha"));
    const betaDir = cached?.snapshot.root.children.find((child) => child.path.endsWith("beta"));
    expect(alphaDir?.recursiveSize).toBe(11);
    expect(betaDir?.recursiveSize).toBe(64);

    await diskAnalysis.__testing.clearState();
    await fs.remove(dataDir);
    await fs.remove(mountDir);
  });

  // The test "stale cached snapshot is served immediately and triggers a
  // background regeneration" lived here. It was replaced, not dropped: see
  // "a stale cache is reported as stale without a background rescan" in the
  // DISK-3/6/12 block at the bottom of this file, which keeps its surviving
  // half (a stale entry is served instantly and without touching the mount)
  // and asserts the new policy in place of the regeneration half.
  test("legacy cached snapshots without persisted metadata remain readable", async () => {
    const dataDir = await createTempDir("deckos-disk-analysis-data-");
    const mountDir = await createTempDir("deckos-disk-analysis-mount-");
    await fs.writeFile(path.join(mountDir, "notes.txt"), "cached", "utf8");

    let diskAnalysis = await loadDiskAnalysisModule(dataDir);
    const mount = { mount: mountDir, fs: "testfs" };
    const start = await diskAnalysis.startScan(mount);
    await waitForTerminalJob(diskAnalysis, start.jobId);

    const cacheFile = path.join(
      dataDir,
      "disk-analysis",
      `${getMountCacheHash(mount)}.json`
    );
    const persisted = (await fs.readJson(cacheFile)) as {
      mount: DiskAnalysisMountIdentity;
      snapshot: { generatedAt: string; totals: { totalFiles: number } };
      cache?: unknown;
    };
    delete persisted.cache;
    await fs.writeJson(cacheFile, persisted, { spaces: 2 });

    diskAnalysis.__testing.resetState();
    diskAnalysis = await loadDiskAnalysisModule(dataDir);

    const mountState = await diskAnalysis.getMountState(mount);
    const snapshot = await diskAnalysis.getCachedSnapshot(mount);

    expect(mountState.cache.state).toBe("fresh");
    expect(snapshot?.snapshot.totals.totalFiles).toBe(1);

    await diskAnalysis.__testing.clearState();
    await fs.remove(dataDir);
    await fs.remove(mountDir);
  });

  test("a cached snapshot written before issueCount existed is still readable, not quarantined", async () => {
    // B5 review round 2, open item 1: DiskAnalysisSnapshotSchema.parse runs
    // on the cache *read* path against a JSON file that may have been
    // written by an older version of this service -- including this
    // branch's own prior commit, before `issueCount` existed on the
    // snapshot. A bare (non-defaulted) required field fails that parse, and
    // the catch quarantines the file as `.corrupt-<epoch>`, discarding a
    // perfectly good cache entry on every upgrade -- and worse, since
    // `hasShallowSnapshotMetadata` does not check `issueCount`,
    // `getMountState` would still report the file "fresh" while
    // `getCachedSnapshot` returns null for it, so the user sees "fresh
    // cache" and no treemap.
    const dataDir = await createTempDir("deckos-disk-analysis-data-");
    const mountDir = await createTempDir("deckos-disk-analysis-mount-");
    await fs.writeFile(path.join(mountDir, "notes.txt"), "cached", "utf8");

    let diskAnalysis = await loadDiskAnalysisModule(dataDir);
    const mount = { mount: mountDir, fs: "testfs" };
    const start = await diskAnalysis.startScan(mount);
    await waitForTerminalJob(diskAnalysis, start.jobId);

    const cacheFile = path.join(
      dataDir,
      "disk-analysis",
      `${getMountCacheHash(mount)}.json`
    );
    const persisted = (await fs.readJson(cacheFile)) as {
      mount: DiskAnalysisMountIdentity;
      snapshot: { issueCount?: number; totals: { totalFiles: number } };
      cache?: unknown;
    };
    delete persisted.snapshot.issueCount;
    await fs.writeJson(cacheFile, persisted, { spaces: 2 });

    diskAnalysis.__testing.resetState();
    diskAnalysis = await loadDiskAnalysisModule(dataDir);

    const mountState = await diskAnalysis.getMountState(mount);
    const snapshot = await diskAnalysis.getCachedSnapshot(mount);

    expect(mountState.cache.state).toBe("fresh");
    expect(snapshot).not.toBeNull();
    expect(snapshot?.snapshot.totals.totalFiles).toBe(1);
    expect(snapshot?.snapshot.issueCount).toBe(0);

    const files = await fs.readdir(path.join(dataDir, "disk-analysis"));
    expect(files.some((file) => file.includes(".corrupt-"))).toBe(false);

    await diskAnalysis.__testing.clearState();
    await fs.remove(dataDir);
    await fs.remove(mountDir);
  });

  test("rejects relative mount paths", async () => {
    const dataDir = await createTempDir("deckos-disk-analysis-data-");
    const diskAnalysis = await loadDiskAnalysisModule(dataDir);

    await expect(
      diskAnalysis.startScan({ mount: ".", fs: "testfs" })
    ).rejects.toThrow(/absolute path/i);

    await diskAnalysis.__testing.clearState();
    await fs.remove(dataDir);
  });

  test("accepts bare Windows drive roots", async () => {
    const dataDir = await createTempDir("deckos-disk-analysis-data-");
    const diskAnalysis = await loadDiskAnalysisModule(dataDir);

  if (process.platform === "win32") {
    const started = await diskAnalysis.startScan({ mount: "C:", fs: "ntfs" });
    expect(started.streamPath).toContain("mount=C%3A%5C");
  } else {
    await expect(
      diskAnalysis.startScan({ mount: "C:", fs: "ntfs" })
    ).rejects.toThrow(/absolute path/i);
  }

    await diskAnalysis.__testing.clearState();
    await fs.remove(dataDir);
  });

  test("reuses the same active job for a mount even when callers provide different fs values", async () => {
    const dataDir = await createTempDir("deckos-disk-analysis-data-");
    const mountDir = await createTempDir("deckos-disk-analysis-mount-");
    await fs.writeFile(path.join(mountDir, "notes.txt"), "cached", "utf8");

    const diskAnalysis = await loadDiskAnalysisModule(dataDir);
    const first = await diskAnalysis.startScan({ mount: mountDir, fs: "ntfs" });
    const second = await diskAnalysis.startScan({ mount: mountDir, fs: "ext4" });

    expect(second.jobId).toBe(first.jobId);
    expect(second.streamPath).toBe(first.streamPath);

    await waitForTerminalJob(diskAnalysis, first.jobId);
    await diskAnalysis.__testing.clearState();
    await fs.remove(dataDir);
    await fs.remove(mountDir);
  });

  test("moves malformed persisted snapshots aside instead of serving them", async () => {
    const dataDir = await createTempDir("deckos-disk-analysis-data-");
    const mountDir = await createTempDir("deckos-disk-analysis-mount-");
    await fs.writeFile(path.join(mountDir, "notes.txt"), "cached", "utf8");

    let diskAnalysis = await loadDiskAnalysisModule(dataDir);
    const mount = { mount: mountDir, fs: "testfs" };
    const start = await diskAnalysis.startScan(mount);
    await waitForTerminalJob(diskAnalysis, start.jobId);

    const cacheFile = path.join(
      dataDir,
      "disk-analysis",
      `${getMountCacheHash(mount)}.json`
    );
    const persisted = (await fs.readJson(cacheFile)) as {
      mount: DiskAnalysisMountIdentity;
      snapshot: Record<string, unknown>;
      cache?: unknown;
    };
    persisted.snapshot = {
      mount,
      generatedAt: new Date().toISOString(),
      root: {
        path: mount.mount,
      },
    };
    await fs.writeJson(cacheFile, persisted, { spaces: 2 });

    diskAnalysis.__testing.resetState();
    diskAnalysis = await loadDiskAnalysisModule(dataDir);

    const mountState = await diskAnalysis.getMountState(mount);
    const snapshot = await diskAnalysis.getCachedSnapshot(mount);
    const diskAnalysisDir = path.join(dataDir, "disk-analysis");
    const files = await fs.readdir(diskAnalysisDir);

    expect(mountState.cache.state).toBe("missing");
    // A quarantined cache reads as "missing", and missing no longer means
    // "start scanning" (DISK-3). The subject of this test is the quarantine --
    // that a malformed entry is moved aside rather than served -- and that is
    // unchanged; only the auto-start that used to follow it is gone.
    expect(mountState.activeJob).toBeNull();
    expect(snapshot).toBeNull();
    expect(files.some((file) => file.includes(".corrupt-"))).toBe(true);

    await diskAnalysis.__testing.clearState();
    await fs.remove(dataDir);
    await fs.remove(mountDir);
  });

  test("a partial scan records it on the snapshot so the warning survives a reload", async () => {
    // B7 review round 1, finding 2: the client's partial banner keyed on
    // `activeJob.phase === "partial"`, but `getMountState` only reports
    // queued/scanning jobs in `activeJob`, so the banner rendered only in the
    // tab that watched the scan finish. Every subsequent page load lost the
    // "totals are a lower bound" warning entirely. The snapshot is the only
    // thing that outlives the job, so the fact has to live on the snapshot.
    process.env.DECKOS_DISK_ANALYSIS_MAX_INDEXED_NODES = "2";
    const dataDir = await createTempDir("deckos-disk-analysis-data-");
    const mountDir = await createTempDir("deckos-disk-analysis-mount-");
    await Promise.all([
      fs.ensureDir(path.join(mountDir, "a")),
      fs.ensureDir(path.join(mountDir, "b")),
      fs.ensureDir(path.join(mountDir, "c")),
    ]);
    await fs.writeFile(path.join(mountDir, "a", "one.txt"), "1", "utf8");
    await fs.writeFile(path.join(mountDir, "b", "two.txt"), "2", "utf8");
    await fs.writeFile(path.join(mountDir, "c", "three.txt"), "3", "utf8");

    let diskAnalysis = await loadDiskAnalysisModule(dataDir);
    const mount = { mount: mountDir, fs: "testfs" };
    const start = await diskAnalysis.startScan(mount);
    const finalJob = await waitForTerminalJob(diskAnalysis, start.jobId);
    const snapshot = await diskAnalysis.getCachedSnapshot(mount);

    expect(finalJob?.phase).toBe("partial");
    expect(snapshot?.snapshot.partial).toBe(true);

    // Same `.default(...)` discipline as `issueCount` (B5 review round 2): the
    // schema parse runs on the cache *read* path against a file an older
    // version may have written, and a bare required field would quarantine a
    // perfectly good cache entry as `.corrupt-<epoch>` on every upgrade.
    const cacheFile = path.join(
      dataDir,
      "disk-analysis",
      `${getMountCacheHash(mount)}.json`
    );
    const persisted = (await fs.readJson(cacheFile)) as {
      snapshot: { partial?: boolean };
    };
    delete persisted.snapshot.partial;
    await fs.writeJson(cacheFile, persisted, { spaces: 2 });

    diskAnalysis.__testing.resetState();
    diskAnalysis = await loadDiskAnalysisModule(dataDir);
    const legacy = await diskAnalysis.getCachedSnapshot(mount);

    expect(legacy).not.toBeNull();
    expect(legacy?.snapshot.partial).toBe(false);
    const files = await fs.readdir(path.join(dataDir, "disk-analysis"));
    expect(files.some((file) => file.includes(".corrupt-"))).toBe(false);

    await diskAnalysis.__testing.clearState();
    await fs.remove(dataDir);
    await fs.remove(mountDir);
  });

  test("a scan that reached everything does not claim to be partial", async () => {
    const dataDir = await createTempDir("deckos-disk-analysis-data-");
    const mountDir = await createTempDir("deckos-disk-analysis-mount-");
    await fs.writeFile(path.join(mountDir, "notes.txt"), "whole", "utf8");

    const diskAnalysis = await loadDiskAnalysisModule(dataDir);
    const mount = { mount: mountDir, fs: "testfs" };
    const start = await diskAnalysis.startScan(mount);
    const finalJob = await waitForTerminalJob(diskAnalysis, start.jobId);
    const snapshot = await diskAnalysis.getCachedSnapshot(mount);

    expect(finalJob?.phase).toBe("completed");
    expect(snapshot?.snapshot.partial).toBe(false);

    await diskAnalysis.__testing.clearState();
    await fs.remove(dataDir);
    await fs.remove(mountDir);
  });

  test("scan enforces the indexed-node budget and reports a partial result", async () => {
    // Was driven by DECKOS_DISK_ANALYSIS_MAX_PENDING_DIRECTORIES=1. That knob
    // no longer truncates anything: it bounds how many directories may sit in
    // the ready queue at once, and overflow now spills to a secondary FIFO
    // instead of being dropped, precisely so that a scheduling knob stops
    // deciding how much of the tree gets indexed. The assertions below are
    // unchanged; they are simply pointed at `maxIndexedNodes`, which is the
    // budget that genuinely does truncate a scan. The root counts as the first
    // indexed node, so a budget of 2 admits one child directory of three.
    process.env.DECKOS_DISK_ANALYSIS_MAX_INDEXED_NODES = "2";
    const dataDir = await createTempDir("deckos-disk-analysis-data-");
    const mountDir = await createTempDir("deckos-disk-analysis-mount-");
    await Promise.all([
      fs.ensureDir(path.join(mountDir, "a")),
      fs.ensureDir(path.join(mountDir, "b")),
      fs.ensureDir(path.join(mountDir, "c")),
    ]);
    await fs.writeFile(path.join(mountDir, "a", "one.txt"), "1", "utf8");
    await fs.writeFile(path.join(mountDir, "b", "two.txt"), "2", "utf8");
    await fs.writeFile(path.join(mountDir, "c", "three.txt"), "3", "utf8");

    const diskAnalysis = await loadDiskAnalysisModule(dataDir);
    const mount = { mount: mountDir, fs: "testfs" };
    const start = await diskAnalysis.startScan(mount);
    const finalJob = await waitForTerminalJob(diskAnalysis, start.jobId);
    const snapshot = await diskAnalysis.getCachedSnapshot(mount);

    expect(finalJob?.phase).toBe("partial");
    expect(snapshot?.snapshot.root.truncated).toBe(true);
    expect(
      snapshot?.snapshot.issues.some((issue) => issue.code === "partial-scan")
    ).toBe(true);
    expect(snapshot?.snapshot.totals.totalDirectories).toBeLessThan(4);

    await diskAnalysis.__testing.clearState();
    await fs.remove(dataDir);
    await fs.remove(mountDir);
  });

  test("bucketed small files do not consume the indexed node budget", async () => {
    process.env.DECKOS_DISK_ANALYSIS_MAX_INDEXED_NODES = "10";
    const dataDir = await createTempDir("deckos-disk-analysis-data-");
    const mountDir = await createTempDir("deckos-disk-analysis-mount-");
    await fs.ensureDir(path.join(mountDir, "tiny"));
    for (let index = 0; index < 50; index += 1) {
      await fs.writeFile(path.join(mountDir, "tiny", `file-${index}.txt`), "x", "utf8");
    }

    const diskAnalysis = await loadDiskAnalysisModule(dataDir);
    const mount = { mount: mountDir, fs: "testfs" };
    const start = await diskAnalysis.startScan(mount);
    const finalJob = await waitForTerminalJob(diskAnalysis, start.jobId);
    const snapshot = await diskAnalysis.getCachedSnapshot(mount);
    const tinyDir = snapshot?.snapshot.root.children.find((child) => child.path.endsWith("tiny"));
    const bucketNode =
      tinyDir?.type === "directory"
        ? tinyDir.children.find(
            (child) =>
              child.type === "file" &&
              child.path.includes("__deckos_small_files__") &&
              child.name.includes("x 50")
          )
        : undefined;

    expect(finalJob?.phase).toBe("completed");
    expect(snapshot?.snapshot.issues.some((issue) => issue.code === "partial-scan")).toBe(false);
    expect(tinyDir?.type).toBe("directory");
    expect(bucketNode).toBeTruthy();
    expect(snapshot?.snapshot.totals.totalFiles).toBe(50);

    await diskAnalysis.__testing.clearState();
    await fs.remove(dataDir);
    await fs.remove(mountDir);
  });

  test("adaptive small-file threshold buckets dense directories before hitting the node cap", async () => {
    process.env.DECKOS_DISK_ANALYSIS_MAX_INDEXED_NODES = "20";
    process.env.DECKOS_DISK_ANALYSIS_SMALL_FILE_THRESHOLD_BYTES = "1";
    const dataDir = await createTempDir("deckos-disk-analysis-data-");
    const mountDir = await createTempDir("deckos-disk-analysis-mount-");
    await fs.ensureDir(path.join(mountDir, "dense"));
    for (let index = 0; index < 1000; index += 1) {
      await fs.writeFile(path.join(mountDir, "dense", `f-${index}.bin`), "x", "utf8");
    }

    const diskAnalysis = await loadDiskAnalysisModule(dataDir);
    const mount = { mount: mountDir, fs: "testfs" };
    const start = await diskAnalysis.startScan(mount);
    const finalJob = await waitForTerminalJob(diskAnalysis, start.jobId);
    const snapshot = await diskAnalysis.getCachedSnapshot(mount);
    const denseDir = snapshot?.snapshot.root.children.find((child) => child.path.endsWith("dense"));

    expect(finalJob?.phase).toBe("completed");
    expect(snapshot?.snapshot.issues.some((issue) => issue.code === "partial-scan")).toBe(false);
    expect(snapshot?.snapshot.totals.totalFiles).toBe(1000);
    expect(
      denseDir?.type === "directory" &&
        denseDir.children.some((child) => child.path.includes("__deckos_small_files__"))
    ).toBe(true);

    await diskAnalysis.__testing.clearState();
    await fs.remove(dataDir);
    await fs.remove(mountDir);
  });

  test("a skipped nested mount is reported rather than silently omitted", async () => {
    const dataDir = await createTempDir("deckos-disk-analysis-data-");
    const mountDir = await createTempDir("deckos-disk-analysis-mount-");
    const nestedMountDir = path.join(mountDir, "sub");
    const localFilePath = path.join(mountDir, "keep.txt");
    const nestedFilePath = path.join(nestedMountDir, "x.bin");
    await fs.ensureDir(nestedMountDir);
    await fs.writeFile(localFilePath, "keep", "utf8");
    await fs.writeFile(nestedFilePath, Buffer.alloc(2048));

    // Force the device-boundary branch without needing a real mount: stat the
    // subdirectory (and the file inside it) onto a different st_dev, and fake the
    // file's reported size at terabyte scale so a leak into the totals would be
    // unmistakable rather than lost in rounding.
    const originalStat = fs.stat.bind(fs);
    const withDev = (stat: fs.Stats, dev: number, size: number = stat.size): fs.Stats =>
      Object.assign(Object.create(Object.getPrototypeOf(stat)) as fs.Stats, stat, {
        dev,
        size,
      });

    const subPath = path.resolve(nestedMountDir);
    const nestedFilePathResolved = path.resolve(nestedFilePath);
    const HUGE_FAKE_BYTES = 128 * 1024 * 1024 * 1024 * 1024; // 128 TB
    const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (target) => {
      const stat = await originalStat(target);
      const targetPath = path.resolve(typeof target === "string" ? target : String(target));
      if (targetPath === subPath) {
        return withDev(stat, stat.dev + 1);
      }
      if (targetPath === nestedFilePathResolved) {
        return withDev(stat, stat.dev + 1, HUGE_FAKE_BYTES);
      }
      return stat;
    });

    try {
      const diskAnalysis = await loadDiskAnalysisModule(dataDir);
      const mount = { mount: mountDir, fs: "ext4" };
      const start = await diskAnalysis.startScan(mount);
      const finalJob = await waitForTerminalJob(diskAnalysis, start.jobId);
      const snapshot = await diskAnalysis.getCachedSnapshot(mount);

      expect(finalJob).toBeTruthy();
      expect(snapshot).toBeTruthy();
      expect(snapshot?.snapshot.root.children.some((child) => child.name === "sub")).toBe(false);
      expect(
        snapshot?.snapshot.issues.some((issue) => issue.code === "nested-mount-skipped")
      ).toBe(true);
      expect(snapshot?.snapshot.root.truncated).toBe(true);
      // The 128 TB fabricated file lives entirely inside the skipped subtree. If it
      // ever leaked into the totals this would be off by many orders of magnitude.
      expect(snapshot?.snapshot.totals.totalFiles).toBe(1);
      expect(snapshot?.snapshot.totals.totalBytes).toBe(4);

      await diskAnalysis.__testing.clearState();
      await fs.remove(dataDir);
    } finally {
      statSpy.mockRestore();
      await fs.remove(mountDir);
    }
  }, 15000);

  test("multiple nested mounts under one parent produce a single aggregated issue", async () => {
    const dataDir = await createTempDir("deckos-disk-analysis-data-");
    const mountDir = await createTempDir("deckos-disk-analysis-mount-");
    const childNames = ["sub1", "sub2", "sub3", "sub4"];
    for (const name of childNames) {
      await fs.ensureDir(path.join(mountDir, name));
      await fs.writeFile(path.join(mountDir, name, "x.bin"), Buffer.alloc(64));
    }
    await fs.writeFile(path.join(mountDir, "keep.txt"), "keep", "utf8");

    // Force every child subdirectory onto a different st_dev than the root, so the
    // walker hits the device-boundary branch once per child.
    const originalStat = fs.stat.bind(fs);
    const withDev = (stat: fs.Stats, dev: number): fs.Stats =>
      Object.assign(Object.create(Object.getPrototypeOf(stat)) as fs.Stats, stat, { dev });

    const childPaths = new Set(
      childNames.map((name) => path.resolve(path.join(mountDir, name)))
    );
    const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (target) => {
      const stat = await originalStat(target);
      const targetPath = path.resolve(typeof target === "string" ? target : String(target));
      if (childPaths.has(targetPath)) {
        return withDev(stat, stat.dev + 1);
      }
      return stat;
    });

    try {
      const diskAnalysis = await loadDiskAnalysisModule(dataDir);
      const mount = { mount: mountDir, fs: "ext4" };
      const start = await diskAnalysis.startScan(mount);
      await waitForTerminalJob(diskAnalysis, start.jobId);
      const snapshot = await diskAnalysis.getCachedSnapshot(mount);

      const parentPath = path.resolve(mountDir);
      const nestedMountIssues = (snapshot?.snapshot.issues ?? []).filter(
        (issue) =>
          issue.code === "nested-mount-skipped" && path.resolve(issue.path) === parentPath
      );

      // One issue per parent directory, not one per skipped child -- a host with many
      // btrfs subvolumes or docker overlays under one directory must not fan out into
      // hundreds of near-identical issues.
      expect(nestedMountIssues).toHaveLength(1);
      expect(nestedMountIssues[0]?.message).toMatch(
        new RegExp(`for ${childNames.length} (entry|entries)`)
      );

      await diskAnalysis.__testing.clearState();
      await fs.remove(dataDir);
    } finally {
      statSpy.mockRestore();
      await fs.remove(mountDir);
    }
  }, 15000);

  test("extension totals never exceed the tree total once the node cap is hit", async () => {
    process.env.DECKOS_DISK_ANALYSIS_MAX_INDEXED_NODES = "10";
    process.env.DECKOS_DISK_ANALYSIS_SMALL_FILE_THRESHOLD_BYTES = "1";
    const dataDir = await createTempDir("deckos-disk-analysis-data-");
    const mountDir = await createTempDir("deckos-disk-analysis-mount-");
    for (let index = 0; index < 50; index += 1) {
      await fs.writeFile(path.join(mountDir, `f${index}.bin`), Buffer.alloc(1024));
    }

    const diskAnalysis = await loadDiskAnalysisModule(dataDir);
    const mount = { mount: mountDir, fs: "testfs" };
    const start = await diskAnalysis.startScan(mount);
    await waitForTerminalJob(diskAnalysis, start.jobId);
    const snapshot = await diskAnalysis.getCachedSnapshot(mount);

    expect(snapshot).toBeTruthy();
    const legendTotal = (snapshot?.snapshot.extensionLegend ?? []).reduce(
      (sum, entry) => sum + entry.totalBytes,
      0
    );

    // The sidebar cannot claim more bytes than the treemap shows for the whole mount.
    expect(legendTotal).toBeLessThanOrEqual(snapshot?.snapshot.totals.totalBytes ?? 0);

    await diskAnalysis.__testing.clearState();
    await fs.remove(dataDir);
    await fs.remove(mountDir);
  });

  test("cache file can be replaced by a later scan", async () => {
    const dataDir = await createTempDir("deckos-disk-analysis-data-");
    const mountDir = await createTempDir("deckos-disk-analysis-mount-");
    await fs.writeFile(path.join(mountDir, "first.bin"), Buffer.alloc(1024 * 1024 + 128));

    const diskAnalysis = await loadDiskAnalysisModule(dataDir);
    const mount = { mount: mountDir, fs: "testfs" };
    const firstStart = await diskAnalysis.startScan(mount);
    await waitForTerminalJob(diskAnalysis, firstStart.jobId);

    await fs.remove(path.join(mountDir, "first.bin"));
    await fs.writeFile(path.join(mountDir, "second.bin"), Buffer.alloc(2 * 1024 * 1024 + 64));

    const secondStart = await diskAnalysis.startScan(mount);
    await waitForTerminalJob(diskAnalysis, secondStart.jobId);
    const cached = await diskAnalysis.getCachedSnapshot(mount);

    expect(cached?.snapshot.root.children.some((child) => child.name === "first.bin")).toBe(false);
    expect(cached?.snapshot.root.children.some((child) => child.name === "second.bin")).toBe(true);

    await diskAnalysis.__testing.clearState();
    await fs.remove(dataDir);
    await fs.remove(mountDir);
  });

  test("ignores cancel requests for terminal jobs", async () => {
    const dataDir = await createTempDir("deckos-disk-analysis-data-");
    const mountDir = await createTempDir("deckos-disk-analysis-mount-");
    await fs.writeFile(path.join(mountDir, "done.txt"), "finished", "utf8");

    const diskAnalysis = await loadDiskAnalysisModule(dataDir);
    const mount = { mount: mountDir, fs: "testfs" };
    const started = await diskAnalysis.startScan(mount);
    const finalJob = await waitForTerminalJob(diskAnalysis, started.jobId);

    expect(finalJob?.phase).toBe("completed");
    expect(diskAnalysis.cancelScan(mount, started.jobId)).toBe(false);
    expect(diskAnalysis.getJob(started.jobId)?.phase).toBe("completed");

    await diskAnalysis.__testing.clearState();
    await fs.remove(dataDir);
    await fs.remove(mountDir);
  });

  test("a directory the scanner cannot read makes the scan partial, not completed", async () => {
    if (process.platform === "win32") return; // chmod is a no-op on Windows
    const dataDir = await createTempDir("deckos-disk-analysis-data-");
    const root = await createTempDir("deckos-disk-eacces-");
    const readable = path.join(root, "readable");
    const locked = path.join(root, "locked");
    await fs.ensureDir(readable);
    await fs.ensureDir(locked);
    await fs.writeFile(path.join(readable, "a.bin"), Buffer.alloc(1024));
    await fs.writeFile(path.join(locked, "hidden.bin"), Buffer.alloc(4096));
    await fs.chmod(locked, 0o000);

    try {
      const diskAnalysis = await loadDiskAnalysisModule(dataDir);
      const mount = { mount: root, fs: "testfs" };
      const start = await diskAnalysis.startScan(mount);
      const finished = await waitForTerminalJob(diskAnalysis, start.jobId);

      // The headline number is a lower bound, and the phase has to say so.
      expect(finished?.phase).toBe("partial");
      expect(finished?.issues.some((i) => i.code === "permission-denied")).toBe(true);

      await diskAnalysis.__testing.clearState();
      await fs.remove(dataDir);
    } finally {
      await fs.chmod(locked, 0o755);
      await fs.remove(root);
    }
  });

  test("assembling the tree materialises each node at most once, not once per ancestor", async () => {
    // A deep chain, so that "nodes x depth" is roughly thirty times "nodes".
    // Under per-ancestor deep copying every leaf is re-serialised once for each
    // level between it and the root and the count runs into five figures; under
    // reference attachment the only materialisations are the one node per
    // directory that finalisation produces plus the shallow live-branch copies.
    // The bound is therefore the node count itself, and it stays meaningful:
    // any extra whole-tree pass on the emit path pushes straight through it.
    process.env.DECKOS_DISK_ANALYSIS_MAX_INDEXED_NODES = "5000";
    process.env.DECKOS_DISK_ANALYSIS_SMALL_FILE_THRESHOLD_BYTES = "1";
    const dataDir = await createTempDir("deckos-disk-analysis-data-");
    const mountDir = await createTempDir("deckos-disk-copies-");

    const depth = 60;
    const filesPerDirectory = 10;
    let cursor = mountDir;
    for (let level = 0; level < depth; level += 1) {
      cursor = path.join(cursor, `d${level}`);
      await fs.ensureDir(cursor);
      const directory = cursor;
      await Promise.all(
        Array.from({ length: filesPerDirectory }, (_, index) =>
          fs.writeFile(path.join(directory, `f${index}.bin`), Buffer.alloc(64))
        )
      );
    }

    const diskAnalysis = await loadDiskAnalysisModule(dataDir);
    diskAnalysis.__testing.resetInstrumentation();

    const mount = { mount: mountDir, fs: "testfs" };
    const start = await diskAnalysis.startScan(mount);
    const finalJob = await waitForTerminalJob(diskAnalysis, start.jobId);
    const snapshot = await diskAnalysis.getCachedSnapshot(mount);

    expect(finalJob?.phase).toBe("completed");
    expect(snapshot?.snapshot.totals.totalFiles).toBe(depth * filesPerDirectory);
    expect(snapshot?.snapshot.totals.totalDirectories).toBe(depth + 1);

    const totalNodes =
      (snapshot?.snapshot.totals.totalFiles ?? 0) +
      (snapshot?.snapshot.totals.totalDirectories ?? 0);
    // Greater than zero first: a counter that nothing increments satisfies any
    // upper bound, and the test would stop testing anything the moment it went
    // green. This one is incremented on the live path, so it stays honest.
    expect(diskAnalysis.__testing.getNodeCopyCount()).toBeGreaterThan(0);
    expect(diskAnalysis.__testing.getNodeCopyCount()).toBeLessThanOrEqual(totalNodes);

    // The deepest file still has to arrive intact at the top of the tree.
    let deepest = snapshot?.snapshot.root;
    for (let level = 0; level < depth; level += 1) {
      deepest = deepest?.children.find((child) => child.name === `d${level}`);
    }
    expect(deepest?.children).toHaveLength(filesPerDirectory);
    expect(snapshot?.snapshot.totals.totalBytes).toBe(depth * filesPerDirectory * 64);

    await diskAnalysis.__testing.clearState();
    await fs.remove(dataDir);
    await fs.remove(mountDir);
  }, 120_000);

  test("child insertion does not scan the sibling array", async () => {
    // upsertChildBranch did a findIndex per insertion, so a directory with n
    // entries cost O(n^2) to build -- once to insert the placeholder and once to
    // replace it with the finished branch. A path-keyed index makes both O(1),
    // and the invariant is per-insertion cost: the sibling entries a lookup has
    // to compare must stay a small constant multiple of the number of lookups,
    // rather than growing with the directory's fan-out.
    process.env.DECKOS_DISK_ANALYSIS_MAX_PENDING_DIRECTORIES = "1024";
    process.env.DECKOS_DISK_ANALYSIS_MAX_INDEXED_NODES = "5000";
    process.env.DECKOS_DISK_ANALYSIS_SMALL_FILE_THRESHOLD_BYTES = "1";
    const dataDir = await createTempDir("deckos-disk-analysis-data-");
    const mountDir = await createTempDir("deckos-disk-wide-dir-");

    const width = 500;
    await Promise.all(
      Array.from({ length: width }, async (_, index) => {
        const directory = path.join(mountDir, `d${index}`);
        await fs.ensureDir(directory);
        await fs.writeFile(path.join(directory, "f.bin"), Buffer.alloc(64));
      })
    );

    const diskAnalysis = await loadDiskAnalysisModule(dataDir);
    diskAnalysis.__testing.resetInstrumentation();

    const mount = { mount: mountDir, fs: "testfs" };
    const start = await diskAnalysis.startScan(mount);
    const finalJob = await waitForTerminalJob(diskAnalysis, start.jobId);
    const snapshot = await diskAnalysis.getCachedSnapshot(mount);

    expect(finalJob?.phase).toBe("completed");
    expect(snapshot?.snapshot.root.children).toHaveLength(width);
    expect(snapshot?.snapshot.totals.totalFiles).toBe(width);

    const { lookups, candidates, maxIndexSize } =
      diskAnalysis.__testing.getChildLookupStats();

    // One lookup to insert each placeholder and one to replace it with the
    // finished branch, so a fan-out of 500 costs exactly 1000 lookups.
    expect(lookups).toBe(width * 2);
    // Exactly one candidate inspected per lookup. This is counted inside
    // findChildSlot rather than next to the call, so replacing the probe with a
    // scan of the sibling array takes it to 0 (call deleted) or to ~250000 (scan
    // counted honestly). Equality fails either way.
    expect(candidates).toBe(lookups);
    // And the index really is a populated path map rather than a renamed scan:
    // the widest directory holds one entry per directory child. Take the Map
    // away and this is 0 whatever the counters happen to say.
    expect(maxIndexSize).toBe(width);

    await diskAnalysis.__testing.clearState();
    await fs.remove(dataDir);
    await fs.remove(mountDir);
  }, 120_000);

  test("an extension longer than the schema cap still round-trips through the cache", async () => {
    // A 64+ character final dot-segment is ordinary: a content hash, a UUID, a
    // timestamp suffix. The schema caps `extension` at 64 on both the node and
    // the legend entry. With no parse left on the emit path to catch it, an
    // unclamped extension would be served, written to cache, reported "fresh" by
    // the shallow metadata check, then rejected and quarantined on every read --
    // a full-disk rescan loop.
    process.env.DECKOS_DISK_ANALYSIS_SMALL_FILE_THRESHOLD_BYTES = "1";
    const dataDir = await createTempDir("deckos-disk-analysis-data-");
    const mountDir = await createTempDir("deckos-disk-long-ext-");
    const longExtension = "a1b2c3d4".repeat(12); // 96 chars
    expect(longExtension.length).toBeGreaterThan(64);
    await fs.writeFile(path.join(mountDir, `backup.${longExtension}`), Buffer.alloc(64));

    const diskAnalysis = await loadDiskAnalysisModule(dataDir);
    const mount = { mount: mountDir, fs: "testfs" };
    const start = await diskAnalysis.startScan(mount);
    const finalJob = await waitForTerminalJob(diskAnalysis, start.jobId);

    // The scan itself has to survive it.
    expect(finalJob?.phase).toBe("completed");

    // And so does the cache: getCachedSnapshot re-parses the file, so a snapshot
    // that violates the schema comes back null with the file quarantined.
    const cached = await diskAnalysis.getCachedSnapshot(mount);
    expect(cached).not.toBeNull();
    expect(cached?.cache.state).toBe("fresh");
    expect(cached?.snapshot.totals.totalFiles).toBe(1);

    const fileNode = cached?.snapshot.root.children.find((child) => child.type === "file");
    expect(fileNode?.extension).toBe(longExtension.slice(0, 64));
    expect(cached?.snapshot.extensionLegend[0]?.extension).toBe(longExtension.slice(0, 64));

    const diskAnalysisDir = path.join(dataDir, "disk-analysis");
    const files = await fs.readdir(diskAnalysisDir);
    expect(files.some((file) => file.includes(".corrupt-"))).toBe(false);

    await diskAnalysis.__testing.clearState();
    await fs.remove(dataDir);
    await fs.remove(mountDir);
  });

  test("a cached snapshot that is shallow-valid but schema-invalid is still rejected", async () => {
    // The emit-path parse is gone; this one is the last line of defence and the
    // existing malformed-cache test does not reach it (that fixture trips the
    // shallow metadata check first). A negative recursiveSize passes every
    // shallow check -- root is an object with a path, a name, a type and a
    // children array -- and fails only the real schema.
    const dataDir = await createTempDir("deckos-disk-analysis-data-");
    const mountDir = await createTempDir("deckos-disk-analysis-mount-");
    await fs.writeFile(path.join(mountDir, "notes.txt"), "cached", "utf8");

    let diskAnalysis = await loadDiskAnalysisModule(dataDir);
    const mount = { mount: mountDir, fs: "testfs" };
    const start = await diskAnalysis.startScan(mount);
    await waitForTerminalJob(diskAnalysis, start.jobId);

    const cacheFile = path.join(dataDir, "disk-analysis", `${getMountCacheHash(mount)}.json`);
    const persisted = (await fs.readJson(cacheFile)) as {
      snapshot: { root: { recursiveSize: number; children: unknown[] } };
    };
    persisted.snapshot.root.recursiveSize = -1;
    await fs.writeJson(cacheFile, persisted, { spaces: 2 });

    diskAnalysis.__testing.resetState();
    diskAnalysis = await loadDiskAnalysisModule(dataDir);

    // The shallow check waves it through...
    const mountState = await diskAnalysis.getMountState(mount);
    expect(mountState.cache.state).toBe("fresh");

    // ...and the schema parse is what actually catches it.
    const snapshot = await diskAnalysis.getCachedSnapshot(mount);
    expect(snapshot).toBeNull();
    const files = await fs.readdir(path.join(dataDir, "disk-analysis"));
    expect(files.some((file) => file.includes(".corrupt-"))).toBe(true);

    await diskAnalysis.__testing.clearState();
    await fs.remove(dataDir);
    await fs.remove(mountDir);
  });

  test("a path longer than the message cap still produces a valid issue", async () => {
    const dataDir = await createTempDir("deckos-disk-analysis-data-");
    const diskAnalysis = (await loadDiskAnalysisModule(dataDir)) as DiskAnalysisModule & {
      createIssue: typeof import("./diskAnalysis.js").createIssue;
    };

    // The path schema allows 4096 chars; the message that embeds it allows 2048.
    // Nested node_modules or a deep backup tree reaches this without trying.
    const longPath = `/mnt/${"deep-directory-name/".repeat(120)}file.bin`;
    expect(longPath.length).toBeGreaterThan(2048);

    const issue = diskAnalysis.createIssue(
      "path-inaccessible",
      longPath,
      `Path inaccessible: ${longPath}`
    );

    expect(() => DiskAnalysisIssueSchema.parse(issue)).not.toThrow();
    expect(issue.message.length).toBeLessThanOrEqual(2048);

    await diskAnalysis.__testing.clearState();
    await fs.remove(dataDir);
  });

  describe("issue array bound and counter (DISK-1)", () => {
    test.skipIf(process.platform === "win32")(
      "progress events carry an issue count, not an unbounded issue array",
      async () => {
        const dataDir = await createTempDir("deckos-disk-analysis-data-");
        const mountDir = await createTempDir("deckos-disk-issue-cap-");
        // 500 symlinks, each of which is skipped. Aggregated per parent
        // directory this is one issue object, but 500 real problems.
        await fs.ensureDir(path.join(mountDir, "target"));
        for (let i = 0; i < 500; i += 1) {
          await fs.symlink(path.join(mountDir, "target"), path.join(mountDir, `link${i}`));
        }

        const diskAnalysis = await loadDiskAnalysisModule(dataDir);
        const mount = { mount: mountDir, fs: "testfs" };
        const start = await diskAnalysis.startScan(mount);

        const progressEvents: Extract<DiskAnalysisScanEvent, { event: "progress" }>[] = [];
        const unsubscribe = diskAnalysis.subscribeToJob(start.jobId, (event) => {
          if (event.event === "progress") {
            progressEvents.push(event);
          }
        });

        const finished = await waitForTerminalJob(diskAnalysis, start.jobId);
        unsubscribe();

        expect(finished?.phase).toBe("completed");
        // The counter is the truth: 500 skipped symlinks are 500 problems
        // encountered, even though they aggregate into a single issue object.
        expect(finished?.issueCount).toBeGreaterThanOrEqual(500);
        // Bounded: the array is for display, the counter is for truth.
        expect(finished?.issues.length).toBeLessThanOrEqual(
          diskAnalysis.__testing.MAX_RETAINED_ISSUES
        );

        const symlinkIssues = (finished?.issues ?? []).filter(
          (issue) => issue.code === "symlink-skipped"
        );
        expect(symlinkIssues).toHaveLength(1);
        expect(symlinkIssues[0]?.message).toMatch(/500/);

        // The finding: progress events must not carry the (growing) issues
        // array on every tick -- only the count. The bounded array belongs on
        // the final snapshot/status events, not on every live progress emit.
        expect(progressEvents.length).toBeGreaterThan(0);
        for (const event of progressEvents) {
          expect(event.job.issues.length).toBe(0);
        }
        expect(progressEvents.some((event) => (event.job.issueCount ?? 0) > 0)).toBe(true);

        await diskAnalysis.__testing.clearState();
        await fs.remove(dataDir);
        await fs.remove(mountDir);
      }
    );

    test(
      "caps the retained issue array at 100 while issueCount reflects the true total",
      async () => {
        // The symlink fixture above aggregates into a single issue object, so it
        // cannot exercise the 100-entry cap. This fixture produces issues that do
        // NOT aggregate together: one unreadable directory each, in 150 separate
        // parent directories.
        process.env.DECKOS_DISK_ANALYSIS_MAX_PENDING_DIRECTORIES = "1000";
        const dataDir = await createTempDir("deckos-disk-analysis-data-");
        const mountDir = await createTempDir("deckos-disk-analysis-mount-");
        const unreadableCount = 150;
        const unreadableDirs = new Set<string>();
        for (let i = 0; i < unreadableCount; i += 1) {
          const dirPath = path.join(mountDir, `bad${i}`);
          await fs.ensureDir(dirPath);
          unreadableDirs.add(path.resolve(dirPath));
        }
        await fs.writeFile(path.join(mountDir, "keep.txt"), "keep", "utf8");

        const originalReaddir = fs.readdir.bind(fs);
        const readdirSpy = vi
          .spyOn(fs, "readdir")
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .mockImplementation(async (target: any, options: any) => {
            const targetPath = path.resolve(
              typeof target === "string" ? target : String(target)
            );
            if (unreadableDirs.has(targetPath)) {
              const error = new Error("Permission denied") as NodeJS.ErrnoException;
              error.code = "EACCES";
              throw error;
            }
            return await originalReaddir(target, options);
          });

        try {
          const diskAnalysis = await loadDiskAnalysisModule(dataDir);
          const mount = { mount: mountDir, fs: "testfs" };
          const start = await diskAnalysis.startScan(mount);
          const finished = await waitForTerminalJob(diskAnalysis, start.jobId);

          expect(finished?.phase).toBe("partial");
          // 150 distinct, non-aggregating problems -- the counter has to say so.
          expect(finished?.issueCount).toBeGreaterThanOrEqual(unreadableCount);
          // Exactly at the cap, not merely under it: 150 distinct issues means
          // the array fills all its slots. `toBeLessThanOrEqual` alone would
          // pass even if nothing were retained at all -- it stops testing the
          // cap the moment a future regression retains zero issues.
          expect(finished?.issues.length).toBe(diskAnalysis.__testing.MAX_RETAINED_ISSUES);

          await diskAnalysis.__testing.clearState();
          await fs.remove(dataDir);
        } finally {
          readdirSpy.mockRestore();
          await fs.remove(mountDir);
        }
      },
      20000
    );

    test(
      "a partial-result issue that loses the retention race still marks the scan partial",
      async () => {
        // B5 review round 1, finding 1 (CRITICAL): the partial-result signal
        // used to be read back off the (capped) retained array. A directory
        // full of symlink-skipped notices -- which do NOT signal partiality,
        // by design, since a skipped symlink is a deliberate exclusion, not a
        // dropped subtree -- can fill all 100 slots before a real
        // permission-denied issue arrives. If that later issue simply isn't
        // retained, a scan that silently missed data would report
        // "completed" with a confident (wrong) total, and cache that for 24
        // hours -- exactly the failure PARTIAL_RESULT_CODES exists to catch.
        //
        // 120 directories each contribute one synthetic (mocked, not a real
        // OS symlink -- no elevation needed, cross-platform) symlink entry,
        // aggregating to 120 distinct retained-issue attempts that fill the
        // cap. A further directory is made unreadable and ordered to be
        // processed dead last (see the LIFO/pending-stack note below), so by
        // the time its permission-denied issue is recorded, the retained
        // array is already full of unrelated, non-partial-signalling issues.
        process.env.DECKOS_DISK_ANALYSIS_MAX_PENDING_DIRECTORIES = "1000";
        const dataDir = await createTempDir("deckos-disk-analysis-data-");
        const mountDir = await createTempDir("deckos-disk-analysis-mount-");
        const symlinkDirCount = 120;
        const symlinkDirNames = Array.from(
          { length: symlinkDirCount },
          (_, index) => `bad${index}`
        );
        for (const name of symlinkDirNames) {
          await fs.ensureDir(path.join(mountDir, name));
        }
        const deniedName = "denied";
        await fs.ensureDir(path.join(mountDir, deniedName));

        const mountDirResolved = path.resolve(mountDir);
        const deniedResolved = path.resolve(path.join(mountDir, deniedName));
        const symlinkDirResolved = new Set(
          symlinkDirNames.map((name) => path.resolve(path.join(mountDir, name)))
        );

        type FakeDirent = {
          name: string;
          isSymbolicLink: () => boolean;
          isDirectory: () => boolean;
          isFile: () => boolean;
          isBlockDevice: () => boolean;
          isCharacterDevice: () => boolean;
          isFIFO: () => boolean;
          isSocket: () => boolean;
        };
        const fakeDirent = (name: string, kind: "dir" | "symlink"): FakeDirent => ({
          name,
          isSymbolicLink: () => kind === "symlink",
          isDirectory: () => kind === "dir",
          isFile: () => false,
          isBlockDevice: () => false,
          isCharacterDevice: () => false,
          isFIFO: () => false,
          isSocket: () => false,
        });

        const readdirSpy = vi
          .spyOn(fs, "readdir")
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .mockImplementation(async (target: any): Promise<any> => {
            const targetPath = path.resolve(
              typeof target === "string" ? target : String(target)
            );
            if (targetPath === mountDirResolved) {
              // `denied` listed first: the walker pushes discovered
              // subdirectories onto a LIFO stack, so the first-listed entry
              // is the last one popped and processed. With maxWorkers=1 this
              // deterministically processes every symlink directory (filling
              // the retained-issue cap) before `denied` is ever touched.
              return [
                fakeDirent(deniedName, "dir"),
                ...symlinkDirNames.map((name) => fakeDirent(name, "dir")),
              ];
            }
            if (symlinkDirResolved.has(targetPath)) {
              // A synthetic symlink entry -- isSymbolicLink() is all the
              // walker checks before skipping it, so this needs no real
              // symlink (and therefore no Windows elevation) at all.
              return [fakeDirent("link", "symlink")];
            }
            if (targetPath === deniedResolved) {
              const error = new Error("Permission denied") as NodeJS.ErrnoException;
              error.code = "EACCES";
              throw error;
            }
            return [];
          });

        try {
          const diskAnalysis = await loadDiskAnalysisModule(dataDir);
          const mount = { mount: mountDir, fs: "testfs" };
          const start = await diskAnalysis.startScan(mount);
          const finished = await waitForTerminalJob(diskAnalysis, start.jobId);

          // The retained array is full of non-partial-signalling symlink
          // issues by the time `denied` is processed -- confirms the setup
          // actually exercises the retention race, not just the code path.
          expect(finished?.issues.length).toBe(diskAnalysis.__testing.MAX_RETAINED_ISSUES);
          expect(
            finished?.issues.every((issue) => issue.code === "symlink-skipped")
          ).toBe(true);

          // The point of this test: partiality must not depend on retention.
          expect(finished?.phase).toBe("partial");

          await diskAnalysis.__testing.clearState();
          await fs.remove(dataDir);
        } finally {
          readdirSpy.mockRestore();
          await fs.remove(mountDir);
        }
      },
      20000
    );

    test("a non-recoverable issue is never evicted by the retention cap", async () => {
      // B5 review round 1, finding 4: the scan-failure issue (the only
      // `recoverable: false` issue this file ever produces -- see the catch
      // block in runJob) must never be the one a FIFO cap drops. Driving a
      // genuine uncaught mid-scan failure through the public scan API isn't
      // practical: every foreseeable fs error along that path is already
      // caught and turned into a normal (recoverable) issue by design, so
      // this exercises `recordIssue`'s eviction logic directly via the
      // __testing hook added for exactly this purpose.
      const dataDir = await createTempDir("deckos-disk-analysis-data-");
      const diskAnalysis = (await loadDiskAnalysisModule(dataDir)) as DiskAnalysisModule & {
        createIssue: typeof import("./diskAnalysis.js").createIssue;
      };

      const job: {
        issues: DiskAnalysisIssue[];
        issueCount: number;
        partialResultDetected: boolean;
      } = { issues: [], issueCount: 0, partialResultDetected: false };
      const cap = diskAnalysis.__testing.MAX_RETAINED_ISSUES;
      const overfillCount = cap + 50;
      for (let i = 0; i < overfillCount; i += 1) {
        diskAnalysis.__testing.recordIssueForTesting(
          job,
          diskAnalysis.createIssue("path-inaccessible", `/mnt/x${i}`, `bad ${i}`)
        );
      }

      // Fills the cap with ordinary recoverable issues -- confirms the setup
      // actually exercises the "array is already full" scenario.
      expect(job.issues.length).toBe(cap);
      expect(job.issues.some((issue) => issue.recoverable === false)).toBe(false);

      diskAnalysis.__testing.recordIssueForTesting(
        job,
        diskAnalysis.createIssue("unknown", "/mnt", "scan failed", false)
      );

      // The point of this test: the array is still full (nothing grew past
      // the cap), but the non-recoverable issue made it in anyway -- some
      // recoverable issue was evicted to make room for it.
      expect(job.issues.length).toBe(cap);
      expect(
        job.issues.some((issue) => issue.code === "unknown" && issue.recoverable === false)
      ).toBe(true);

      await diskAnalysis.__testing.clearState();
      await fs.remove(dataDir);
    });
  });

  describe("analysis cache pruning (DISK-11)", () => {
    test("drops cache entries past the freshness window and expired corrupt files", async () => {
      const dataDir = await createTempDir("deckos-disk-analysis-data-");
      const diskAnalysis = await loadDiskAnalysisModule(dataDir);
      const cacheDir = diskAnalysis.getDiskAnalysisCacheDir();
      await fs.ensureDir(cacheDir);

      const stalePath = path.join(cacheDir, "stale-entry.json");
      await fs.writeJson(stalePath, {
        mount: { mount: "/mnt/old", fs: "ext4" },
        snapshot: { generatedAt: new Date().toISOString() },
      });
      const corruptPath = path.join(cacheDir, `old.json.corrupt-${Date.now() - 1000}`);
      await fs.writeFile(corruptPath, "{");

      const veryOld = new Date("2000-01-01T00:00:00.000Z");
      await fs.utimes(stalePath, veryOld, veryOld);
      await fs.utimes(corruptPath, veryOld, veryOld);

      await diskAnalysis.pruneDiskAnalysisCache();

      expect(await fs.pathExists(stalePath)).toBe(false);
      expect(await fs.pathExists(corruptPath)).toBe(false);

      await diskAnalysis.__testing.clearState();
      await fs.remove(dataDir);
    });

    test("a fresh, valid cache entry survives pruning", async () => {
      // A prune that deletes everything would pass every other test in this
      // file -- this is the one that catches it.
      const dataDir = await createTempDir("deckos-disk-analysis-data-");
      const mountDir = await createTempDir("deckos-disk-analysis-mount-");
      await fs.writeFile(path.join(mountDir, "notes.txt"), "keep", "utf8");

      const diskAnalysis = await loadDiskAnalysisModule(dataDir);
      const mount = { mount: mountDir, fs: "testfs" };
      const start = await diskAnalysis.startScan(mount);
      await waitForTerminalJob(diskAnalysis, start.jobId);

      const cacheDir = diskAnalysis.getDiskAnalysisCacheDir();
      const before = await fs.readdir(cacheDir);
      expect(before.some((file) => file.endsWith(".json"))).toBe(true);

      await diskAnalysis.pruneDiskAnalysisCache();

      const after = await fs.readdir(cacheDir);
      expect(after.sort()).toEqual(before.sort());

      const cached = await diskAnalysis.getCachedSnapshot(mount);
      expect(cached?.cache.state).toBe("fresh");

      await diskAnalysis.__testing.clearState();
      await fs.remove(dataDir);
      await fs.remove(mountDir);
    });

    test("evicts the oldest entries once the cache directory exceeds its size cap", async () => {
      process.env.DECKOS_DISK_ANALYSIS_CACHE_MAX_BYTES = "100";
      const dataDir = await createTempDir("deckos-disk-analysis-data-");
      const diskAnalysis = await loadDiskAnalysisModule(dataDir);
      const cacheDir = diskAnalysis.getDiskAnalysisCacheDir();
      await fs.ensureDir(cacheDir);

      const olderPath = path.join(cacheDir, "older.json");
      const newerPath = path.join(cacheDir, "newer.json");
      await fs.writeFile(olderPath, Buffer.alloc(80, "a"));
      await fs.writeFile(newerPath, Buffer.alloc(80, "b"));

      const older = new Date(Date.now() - 60_000);
      const newer = new Date();
      await fs.utimes(olderPath, older, older);
      await fs.utimes(newerPath, newer, newer);

      await diskAnalysis.pruneDiskAnalysisCache();

      expect(await fs.pathExists(olderPath)).toBe(false);
      expect(await fs.pathExists(newerPath)).toBe(true);

      await diskAnalysis.__testing.clearState();
      await fs.remove(dataDir);
    });

    test("tolerates a cache file vanishing mid-run instead of throwing", async () => {
      const dataDir = await createTempDir("deckos-disk-analysis-data-");
      const diskAnalysis = await loadDiskAnalysisModule(dataDir);
      const cacheDir = diskAnalysis.getDiskAnalysisCacheDir();
      await fs.ensureDir(cacheDir);

      const vanishingPath = path.join(cacheDir, "vanishing.json.corrupt-1");
      await fs.writeFile(vanishingPath, "{");
      const veryOld = new Date("2000-01-01T00:00:00.000Z");
      await fs.utimes(vanishingPath, veryOld, veryOld);

      const originalUnlink = fs.unlink.bind(fs);
      const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (target) => {
        const targetPath = typeof target === "string" ? target : String(target);
        if (path.resolve(targetPath) === path.resolve(vanishingPath)) {
          const error = new Error("gone") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        return await originalUnlink(target);
      });

      try {
        await expect(diskAnalysis.pruneDiskAnalysisCache()).resolves.toBeUndefined();
      } finally {
        unlinkSpy.mockRestore();
      }
      await diskAnalysis.__testing.clearState();
      await fs.remove(dataDir);
    });

    test.skipIf(process.platform === "win32")(
      "does not follow or delete a symlink inside the cache directory",
      async () => {
        const dataDir = await createTempDir("deckos-disk-analysis-data-");
        const outsideDir = await createTempDir("deckos-disk-outside-");
        const outsideFile = path.join(outsideDir, "sensitive.txt");
        await fs.writeFile(outsideFile, "do not touch", "utf8");
        // Make the *target* look old enough to prune. A buggy implementation
        // that lists the cache directory without withFileTypes and then calls
        // fs.stat (which follows links) on each entry would see this as a
        // stale candidate and try to remove it -- unlink never follows a
        // symlink, so it would delete the link itself, not the target. The
        // correct implementation must never get that far: it has to recognise
        // the directory entry as a symlink before ever stat-ing it.
        const veryOld = new Date("2000-01-01T00:00:00.000Z");
        await fs.utimes(outsideFile, veryOld, veryOld);

        const diskAnalysis = await loadDiskAnalysisModule(dataDir);
        const cacheDir = diskAnalysis.getDiskAnalysisCacheDir();
        await fs.ensureDir(cacheDir);

        const linkPath = path.join(cacheDir, "escape.json");
        await fs.symlink(outsideFile, linkPath);

        await diskAnalysis.pruneDiskAnalysisCache();

        // The link itself is skipped rather than followed and evaluated for
        // staleness -- it survives untouched, and so does whatever it points at.
        expect(await fs.pathExists(outsideFile)).toBe(true);
        expect(await fs.lstat(linkPath).catch(() => null)).not.toBeNull();

        await diskAnalysis.__testing.clearState();
        await fs.remove(dataDir);
        await fs.remove(outsideDir);
      }
    );
  });

  describe("observe-only state, guarded scans, real cancellation (DISK-3, DISK-6, DISK-12)", () => {
    test("getMountState never starts a scan", async () => {
      const dataDir = await createTempDir("deckos-disk-analysis-data-");
      const root = await createTempDir("deckos-disk-observe-");
      await fs.writeFile(path.join(root, "a.bin"), Buffer.alloc(512));

      const diskAnalysis = await loadDiskAnalysisModule(dataDir);
      const mount = { mount: root, fs: "testfs" };

      const state = await diskAnalysis.getMountState(mount);

      // Reading the page must not kick off work. Scanning is an explicit action.
      expect(state.activeJob).toBeNull();
      expect(state.cache.state).toBe("missing");

      // And not asynchronously either. Auto-start ran the walk from a
      // microtask, so a state object that looked clean was followed a few
      // milliseconds later by a finished scan and a cache file -- on this
      // fixture, and by hours of I/O on a real mount.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await diskAnalysis.getCachedSnapshot(mount)).toBeNull();
      expect((await diskAnalysis.getMountState(mount)).activeJob).toBeNull();

      await diskAnalysis.__testing.clearState();
      await fs.remove(dataDir);
      await fs.remove(root);
    });

    test("a stale cache is reported as stale without a background rescan", async () => {
      // Replaces "stale cached snapshot is served immediately and triggers a
      // background regeneration". The half of that test which still holds --
      // a stale entry is served instantly and without touching the mount --
      // is kept and, if anything, tightened. The regeneration half does not
      // survive the DISK-3 decision: `getMountState` is the only caller that
      // ever scheduled a refresh, so "refresh a stale cache in the
      // background" and "start a full filesystem scan because someone opened
      // the page" were the same code path under two names. Refreshing is now
      // the explicit scan that the user asks for.
      const dataDir = await createTempDir("deckos-disk-analysis-data-");
      const mountDir = await createTempDir("deckos-disk-analysis-mount-");
      await fs.writeFile(path.join(mountDir, "notes.txt"), "cached", "utf8");

      let diskAnalysis = await loadDiskAnalysisModule(dataDir);
      const mount = { mount: mountDir, fs: "testfs" };
      const start = await diskAnalysis.startScan(mount);
      await waitForTerminalJob(diskAnalysis, start.jobId);

      const cacheFile = path.join(dataDir, "disk-analysis", `${getMountCacheHash(mount)}.json`);
      const persisted = (await fs.readJson(cacheFile)) as {
        mount: DiskAnalysisMountIdentity;
        snapshot: { generatedAt: string };
      };
      persisted.snapshot.generatedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      await fs.writeJson(cacheFile, persisted, { spaces: 2 });

      // resetState, not clearState: the latter deletes the cache directory,
      // and the doctored entry is the whole fixture.
      diskAnalysis.__testing.resetState();
      diskAnalysis = await loadDiskAnalysisModule(dataDir);

      // Any stat of the mount root costs 50ms, so the elapsed time below is a
      // direct measurement of whether getMountState touched the filesystem.
      const originalStat = fs.stat.bind(fs);
      const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (target) => {
        const targetPath = typeof target === "string" ? target : String(target);
        if (path.resolve(targetPath) === path.resolve(mountDir)) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return await originalStat(target);
      });

      try {
        const snapshotBeforeRefresh = await diskAnalysis.getCachedSnapshot(mount);
        expect(snapshotBeforeRefresh?.cache.state).toBe("stale");

        const startedAt = Date.now();
        const state = await diskAnalysis.getMountState(mount);
        expect(Date.now() - startedAt).toBeLessThan(50);
        expect(state.cache.state).toBe("stale");
        expect(state.activeJob).toBeNull();

        // Nothing appears later either: the stale entry stays stale until a
        // scan is explicitly requested.
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect((await diskAnalysis.getMountState(mount)).activeJob).toBeNull();
        expect((await diskAnalysis.getCachedSnapshot(mount))?.cache.state).toBe("stale");

        // ...and an explicit scan is what refreshes it.
        const refresh = await diskAnalysis.startScan(mount);
        const refreshed = await waitForTerminalJob(diskAnalysis, refresh.jobId);
        expect(refreshed?.phase).toBe("completed");
        expect((await diskAnalysis.getCachedSnapshot(mount))?.cache.state).toBe("fresh");
      } finally {
        statSpy.mockRestore();
      }

      await diskAnalysis.__testing.clearState();
      await fs.remove(dataDir);
      await fs.remove(mountDir);
    });

    test.skipIf(process.platform === "win32")("a scan refuses a denylisted root", async () => {
      const dataDir = await createTempDir("deckos-disk-analysis-data-");
      const diskAnalysis = await loadDiskAnalysisModule(dataDir);

      // /proc/kcore stats at ~128 TB and poisons every total on the page.
      await expect(diskAnalysis.startScan({ mount: "/proc", fs: "proc" })).rejects.toThrow(
        /denied|protected/i
      );

      await diskAnalysis.__testing.clearState();
      await fs.remove(dataDir);
    });

    test.runIf(process.platform === "win32")(
      "a scan refuses a denylisted root on Windows",
      async () => {
        // The POSIX case above is the one DISK-6 names, but it cannot run
        // here. The Windows arm of the same denylist keeps the guard covered
        // on this platform rather than leaving it untested.
        const dataDir = await createTempDir("deckos-disk-analysis-data-");
        const diskAnalysis = await loadDiskAnalysisModule(dataDir);
        const denied = path.join(process.env.SystemDrive || "C:", "Windows");

        await expect(diskAnalysis.startScan({ mount: denied, fs: "ntfs" })).rejects.toThrow(
          /denied|protected/i
        );

        await diskAnalysis.__testing.clearState();
        await fs.remove(dataDir);
      }
    );

    test("the mount table refuses a pseudo-filesystem root and lets a real one through", async () => {
      // The denylist in files.ts is a prefix comparison on the path and says
      // so: it cannot see a bind mount of /proc at some other path (FILE-12).
      // The mount table can. The second half matters as much as the first --
      // a check that refuses everything would satisfy the first half alone.
      const dataDir = await createTempDir("deckos-disk-analysis-data-");
      const pseudoRoot = await createTempDir("deckos-disk-pseudo-");
      const realRoot = await createTempDir("deckos-disk-real-");
      await fs.writeFile(path.join(realRoot, "keep.bin"), Buffer.alloc(128));

      const escapeMountField = (value: string): string => value.replace(/ /g, "\\040");
      const mountTable = [
        "sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0",
        "/dev/sda1 / ext4 rw,relatime 0 0",
        `proc ${escapeMountField(path.resolve(pseudoRoot))} proc rw,nosuid,nodev,noexec 0 0`,
        `/dev/sdb1 ${escapeMountField(path.resolve(realRoot))} ext4 rw,relatime 0 0`,
        "",
      ].join("\n");

      const originalReadFile = fs.readFile.bind(fs);
      const readFileSpy = vi
        .spyOn(fs, "readFile")
        // `Parameters<typeof fs.readFile>` does not help here: fs-extra
        // declares readFile with callback overloads last, so the utility
        // resolves to the callback form and the mock is then required to
        // return void. `any` on the parameters is what lets one implementation
        // satisfy every overload.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockImplementation(async (target: any, options?: any): Promise<any> => {
          const targetPath = path.resolve(typeof target === "string" ? target : String(target));
          if (targetPath === path.resolve("/proc/self/mounts")) {
            return mountTable;
          }
          return await originalReadFile(target, options);
        });

      try {
        const diskAnalysis = await loadDiskAnalysisModule(dataDir);

        await expect(
          diskAnalysis.startScan({ mount: pseudoRoot, fs: "proc" })
        ).rejects.toThrow(/pseudo-filesystem/i);

        const allowed = await diskAnalysis.startScan({ mount: realRoot, fs: "ext4" });
        const finished = await waitForTerminalJob(diskAnalysis, allowed.jobId);
        expect(finished?.phase).toBe("completed");

        await diskAnalysis.__testing.clearState();
      } finally {
        readFileSpy.mockRestore();
        await fs.remove(dataDir);
        await fs.remove(pseudoRoot);
        await fs.remove(realRoot);
      }
    });

    test("a third concurrent scan is refused while two are already running", async () => {
      const dataDir = await createTempDir("deckos-disk-analysis-data-");
      const rootA = await createTempDir("deckos-disk-conc-a-");
      const rootB = await createTempDir("deckos-disk-conc-b-");
      const rootC = await createTempDir("deckos-disk-conc-c-");
      const roots = [rootA, rootB, rootC];
      for (const root of roots) {
        await fs.writeFile(path.join(root, "x.bin"), Buffer.alloc(64));
      }

      const gate = createGate();
      const held = new Set([rootA, rootB].map((root) => path.resolve(root)));
      const originalReaddir = fs.readdir.bind(fs);
      const readdirSpy = vi
        .spyOn(fs, "readdir")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockImplementation(async (target: any, options: any): Promise<any> => {
          if (held.has(path.resolve(typeof target === "string" ? target : String(target)))) {
            await gate.wait;
          }
          return await originalReaddir(target, options);
        });

      try {
        const diskAnalysis = await loadDiskAnalysisModule(dataDir);
        const first = await diskAnalysis.startScan({ mount: rootA, fs: "testfs" });
        const second = await diskAnalysis.startScan({ mount: rootB, fs: "testfs" });
        expect(second.jobId).not.toBe(first.jobId);

        // Two full-disk walks is already more than a homelab box wants to be
        // doing at once; a third would just make all three slower.
        await expect(diskAnalysis.startScan({ mount: rootC, fs: "testfs" })).rejects.toThrow(
          /already running/i
        );

        gate.open();
        await diskAnalysis.__testing.waitForJobSettled(first.jobId);
        await diskAnalysis.__testing.waitForJobSettled(second.jobId);

        // And the slot is genuinely released, not leaked.
        const third = await diskAnalysis.startScan({ mount: rootC, fs: "testfs" });
        expect((await waitForTerminalJob(diskAnalysis, third.jobId))?.phase).toBe("completed");

        await diskAnalysis.__testing.clearState();
      } finally {
        gate.open();
        readdirSpy.mockRestore();
        await fs.remove(dataDir);
        for (const root of roots) {
          await fs.remove(root);
        }
      }
    }, 30_000);

    test("a mount is not re-scanned until its previous scan has wound down", async () => {
      const dataDir = await createTempDir("deckos-disk-analysis-data-");
      const root = await createTempDir("deckos-disk-unsettled-");
      await fs.writeFile(path.join(root, "x.bin"), Buffer.alloc(64));

      // Parked on the scan's *mount-availability* probe rather than on a
      // worker's readdir, and that choice is the whole fixture.
      //
      // Every fs call inside the walk now races the job's abort signal, so
      // cancelling one unwinds it on the spot -- deliberately, because
      // otherwise a cancel on a stale mount waits out the full 30s timeout.
      // That leaves the walk with no externally observable winding-down
      // window. `ensureMountAvailable` is the exception: it runs before the
      // walk and is reached from `ensureJob` as well, where no job controller
      // exists yet, so it carries only its own timeout. Parking it holds the
      // run genuinely unsettled after the phase has gone terminal, which is
      // exactly the state guard 4 exists for.
      const gate = createGate();
      const resolvedRoot = path.resolve(root);
      let rootStatCalls = 0;
      const originalStat = fs.stat.bind(fs);
      const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (target) => {
        if (path.resolve(typeof target === "string" ? target : String(target)) === resolvedRoot) {
          rootStatCalls += 1;
          // The first probe belongs to `startScan` itself, which has to
          // succeed for there to be a job at all; the second is the scan's.
          if (rootStatCalls === 2) {
            await gate.enter();
          }
        }
        return await originalStat(target);
      });

      try {
        const diskAnalysis = await loadDiskAnalysisModule(dataDir);
        const mount = { mount: root, fs: "testfs" };
        const first = await diskAnalysis.startScan(mount);

        // Cancel only once the scan is actually parked. Cancelling before it
        // gets that far settles the run on the spot, so the window this test
        // is about would not exist.
        await gate.entered;
        expect(diskAnalysis.cancelScan(mount, first.jobId)).toBe(true);

        // The phase says cancelled straight away, but the run has not unwound.
        // Starting a second walk of the same mount now means two walks of it.
        expect(diskAnalysis.getJob(first.jobId)?.phase).toBe("cancelled");
        await expect(diskAnalysis.startScan(mount)).rejects.toThrow(/wound down|winding down/i);

        gate.open();
        const settled = await diskAnalysis.__testing.waitForJobSettled(first.jobId);
        expect(settled?.phase).toBe("cancelled");

        const second = await diskAnalysis.startScan(mount);
        expect(second.jobId).not.toBe(first.jobId);
        expect((await waitForTerminalJob(diskAnalysis, second.jobId))?.phase).toBe("completed");

        await diskAnalysis.__testing.clearState();
      } finally {
        gate.open();
        statSpy.mockRestore();
        await fs.remove(dataDir);
        await fs.remove(root);
      }
    }, 30_000);

    test("a cancelled scan does not publish the tree it was holding", async () => {
      // Scope, honestly: this parks a `stat` partway through a directory's
      // entry loop, so once that call rejects the loop's *next* iteration
      // reaches an abort check on its own. It therefore does not prove the
      // `finally`-based settle -- it would pass under the old `maybeAbort()`
      // architecture too. What it does cover is the publishing contract: a
      // cancelled scan emits no snapshot event and writes no cache file.
      //
      // The test that actually pins the settle is the next one, which parks
      // the `readdir` of the only in-flight directory so that no abort check
      // is ever reached at all.
      process.env.DECKOS_DISK_ANALYSIS_FS_TIMEOUT_MS = "1000";
      const dataDir = await createTempDir("deckos-disk-analysis-data-");
      const root = await createTempDir("deckos-disk-cancel-");
      // Sorts first, so the single worker parks on it almost immediately.
      const stuckPath = path.join(root, "aaa-stuck.bin");
      await fs.writeFile(stuckPath, Buffer.alloc(64));
      for (let i = 0; i < 200; i += 1) {
        await fs.writeFile(path.join(root, `f${i}.bin`), Buffer.alloc(64));
      }

      const gate = createGate();
      const resolvedStuck = path.resolve(stuckPath);
      const originalStat = fs.stat.bind(fs);
      const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (target) => {
        const targetPath = path.resolve(typeof target === "string" ? target : String(target));
        if (targetPath === resolvedStuck) {
          await gate.enter();
        }
        return await originalStat(target);
      });

      try {
        const diskAnalysis = await loadDiskAnalysisModule(dataDir);
        const mount = { mount: root, fs: "testfs" };
        const snapshotEvents: DiskAnalysisScanEvent[] = [];
        const start = await diskAnalysis.startScan(mount);
        diskAnalysis.subscribeToJob(start.jobId, (event) => {
          if (event.event === "snapshot") {
            snapshotEvents.push(event);
          }
        });

        // Cancel with the worker demonstrably parked in the stat that will
        // never return.
        await gate.entered;
        expect(diskAnalysis.cancelScan(mount, start.jobId)).toBe(true);

        const finished = await Promise.race([
          diskAnalysis.__testing.waitForJobSettled(start.jobId),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("never settled")), 10_000)
          ),
        ]);
        expect((finished as { phase: string }).phase).toBe("cancelled");

        // A cancelled scan must not publish the half-built tree it was
        // holding: no snapshot event, no cache file.
        expect(snapshotEvents).toHaveLength(0);
        expect(await diskAnalysis.getCachedSnapshot(mount)).toBeNull();

        await diskAnalysis.__testing.clearState();
      } finally {
        gate.open();
        statSpy.mockRestore();
        await fs.remove(dataDir);
        await fs.remove(root);
      }
    }, 30_000);

    test("a cancelled scan settles when its only worker is parked in readdir", async () => {
      // This is the case DISK-12 is actually about, and the one that pins the
      // `finally`-based settle.
      //
      // Park the `readdir` of the only in-flight directory. When that call
      // eventually rejects -- on the abort now that the signal is in the race,
      // on the timeout before it was -- the handler's first act is
      // `if (isAborted()) return;`, an early return out of a loop that was
      // never entered. There is no "next iteration" to notice the
      // cancellation from, because the directory's entries are still unknown.
      // The old architecture had nowhere left to settle, so the done promise
      // stayed pending forever with the partial tree pinned in its closure.
      // Settling from the worker's `finally` is what closes that.
      process.env.DECKOS_DISK_ANALYSIS_FS_TIMEOUT_MS = "500";
      const dataDir = await createTempDir("deckos-disk-analysis-data-");
      const root = await createTempDir("deckos-disk-cancel-readdir-");
      await fs.writeFile(path.join(root, "a.bin"), Buffer.alloc(64));
      await fs.writeFile(path.join(root, "b.bin"), Buffer.alloc(64));

      const gate = createGate();
      const resolvedRoot = path.resolve(root);
      const originalReaddir = fs.readdir.bind(fs);
      const readdirSpy = vi
        .spyOn(fs, "readdir")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockImplementation(async (target: any, options: any): Promise<any> => {
          if (path.resolve(typeof target === "string" ? target : String(target)) === resolvedRoot) {
            // Never opened during the test: a hard mount that has gone away.
            await gate.enter();
          }
          return await originalReaddir(target, options);
        });

      try {
        const diskAnalysis = await loadDiskAnalysisModule(dataDir);
        const mount = { mount: root, fs: "testfs" };
        const start = await diskAnalysis.startScan(mount);

        await gate.entered;
        expect(diskAnalysis.cancelScan(mount, start.jobId)).toBe(true);

        const finished = await Promise.race([
          diskAnalysis.__testing.waitForJobSettled(start.jobId),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("never settled")), 10_000)
          ),
        ]);
        expect((finished as { phase: string }).phase).toBe("cancelled");
        expect(await diskAnalysis.getCachedSnapshot(mount)).toBeNull();

        await diskAnalysis.__testing.clearState();
      } finally {
        gate.open();
        readdirSpy.mockRestore();
        await fs.remove(dataDir);
        await fs.remove(root);
      }
    }, 30_000);

    test("a failure mid-walk stops the other workers before releasing the mount", async () => {
      // This suite pins DECKOS_DISK_ANALYSIS_MAX_WORKERS to "1" in beforeEach
      // for determinism elsewhere. Two live workers are the entire point here,
      // so raise it: one walks the slow directory while the other fails.
      process.env.DECKOS_DISK_ANALYSIS_MAX_WORKERS = "2";
      // The generic failure path used to settle on the spot from the worker
      // catch-all, which defeated what the cancellation rewrite added:
      // `releasePartialTree` ran while other workers were still writing into
      // the tree, the controller was never aborted so those workers kept
      // walking with no way to stop them (`cancelScan` returns false once the
      // phase is terminal), and `runJob` returned immediately -- releasing the
      // mount's `unsettledJobIdByMount` entry and letting `startScan` admit a
      // second walk of a mount that was still being walked.
      //
      // The realistic trigger is a throwing SSE listener: `notifyListeners`
      // invokes subscriber callbacks unguarded, and `queueBranchEmit` reaches
      // it synchronously from a worker once the emit interval has elapsed.
      // Driving it that way is timing-dependent -- the emit is throttled to
      // PROGRESS_EMIT_INTERVAL_MS and would otherwise fire from a timer, off
      // the worker's stack -- so this provokes the identical code path
      // deterministically instead: a `stat` whose `isDirectory()` throws is
      // called outside the inner fs try/catch and lands in the same catch-all.
      const dataDir = await createTempDir("deckos-disk-analysis-data-");
      const root = await createTempDir("deckos-disk-failpath-");
      const badDir = path.join(root, "bad");
      const slowDir = path.join(root, "slow");
      await fs.ensureDir(badDir);
      await fs.ensureDir(slowDir);
      const boomPath = path.join(badDir, "boom.bin");
      await fs.writeFile(boomPath, Buffer.alloc(64));
      const slowFileCount = 60;
      for (let i = 0; i < slowFileCount; i += 1) {
        await fs.writeFile(path.join(slowDir, `f${i}.bin`), Buffer.alloc(64));
      }
      // 60 x 50ms of sequential statting: long enough that the walk is
      // unambiguously still in progress when the failure fires, and long
      // enough afterwards for "did it keep going?" to be an obvious yes or no.
      const slowStatDelayMs = 50;

      // The bad directory's `readdir` is held until the test opens it, so the
      // failure fires at a moment of the test's choosing -- with the sibling
      // walk demonstrably in progress -- rather than wherever the scheduler
      // happened to put it.
      const gate = createGate();
      const resolvedBad = path.resolve(badDir);
      const resolvedBoom = path.resolve(boomPath);
      const resolvedSlow = path.resolve(slowDir);
      // Scoped to the first scan: the follow-up scan that proves the slot was
      // released must not re-trigger the failure, nor pay 60 x 50ms again.
      let firstScan = true;
      let slowStatCount = 0;

      const originalReaddir = fs.readdir.bind(fs);
      const readdirSpy = vi
        .spyOn(fs, "readdir")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockImplementation(async (target: any, options: any): Promise<any> => {
          if (
            firstScan &&
            path.resolve(typeof target === "string" ? target : String(target)) === resolvedBad
          ) {
            await gate.enter();
          }
          return await originalReaddir(target, options);
        });

      const originalStat = fs.stat.bind(fs);
      const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (target) => {
        const targetPath = path.resolve(typeof target === "string" ? target : String(target));
        const realStat = await originalStat(target);
        if (firstScan && path.dirname(targetPath) === resolvedSlow) {
          slowStatCount += 1;
          await new Promise((resolve) => setTimeout(resolve, slowStatDelayMs));
          return realStat;
        }
        if (firstScan && targetPath === resolvedBoom) {
          // Proxied rather than replaced so `dev` still matches the root and
          // the entry is not skipped as a nested mount before it is reached.
          return new Proxy(realStat, {
            get(statTarget, property, receiver) {
              if (property === "isDirectory") {
                return () => {
                  throw new Error("simulated emit failure inside a worker");
                };
              }
              return Reflect.get(statTarget, property, receiver);
            },
          });
        }
        return realStat;
      });

      try {
        const diskAnalysis = await loadDiskAnalysisModule(dataDir);
        const mount = { mount: root, fs: "testfs" };
        const start = await diskAnalysis.startScan(mount);

        // Release the failure only once the sibling walk is observably under
        // way. Keying this off the walk's own progress rather than off a
        // sleep or off the order the scheduler happened to start the two
        // workers in is what keeps the test deterministic.
        for (let attempt = 0; attempt < 200 && slowStatCount < 3; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const statsBeforeFailure = slowStatCount;
        expect(statsBeforeFailure).toBeGreaterThanOrEqual(3);
        expect(statsBeforeFailure).toBeLessThan(slowFileCount);
        gate.open();

        const finished = await Promise.race([
          diskAnalysis.__testing.waitForJobSettled(start.jobId),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("never settled")), 10_000)
          ),
        ]);

        // A real error stays `failed`. Routing it through the abort machinery
        // must not relabel it as a user cancellation.
        expect((finished as { phase: string }).phase).toBe("failed");

        // The discriminating assertion. The failure aborts the controller, so
        // the sibling worker stops at its next abort check and the run settles
        // only once it has. Under the old behaviour nothing aborted it: the
        // run reported `failed` immediately and the walk carried on statting
        // its way through the remaining files with no way to stop it.
        const statsAtSettle = slowStatCount;
        expect(statsAtSettle).toBeLessThan(slowFileCount);
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(slowStatCount).toBe(statsAtSettle);

        // And the slot is released once -- and only once -- that has happened.
        firstScan = false;
        const second = await diskAnalysis.startScan(mount);
        expect(second.jobId).not.toBe(start.jobId);
        expect((await waitForTerminalJob(diskAnalysis, second.jobId))?.phase).toBe("completed");

        await diskAnalysis.__testing.clearState();
      } finally {
        gate.open();
        statSpy.mockRestore();
        readdirSpy.mockRestore();
        await fs.remove(dataDir);
        await fs.remove(root);
      }
    }, 30_000);

    test("a filesystem call that never returns degrades to an issue instead of stalling", async () => {
      // Same stale-mount shape, no cancellation: the scan itself has to make
      // progress past a parked call rather than sitting on it forever.
      process.env.DECKOS_DISK_ANALYSIS_FS_TIMEOUT_MS = "250";
      const dataDir = await createTempDir("deckos-disk-analysis-data-");
      const root = await createTempDir("deckos-disk-fstimeout-");
      const stuckPath = path.join(root, "aaa-stuck.bin");
      await fs.writeFile(stuckPath, Buffer.alloc(64));
      const keepPath = path.join(root, "keep.bin");
      await fs.writeFile(keepPath, Buffer.alloc(1024));
      // DISK-8: totals report bytes allocated on disk, not the file's
      // apparent length -- a 1024-byte write can occupy a full filesystem
      // block. Read the real allocation back from the fixture itself rather
      // than hard-coding a block size no two filesystems agree on.
      const keepStat = await fs.stat(keepPath);
      const expectedKeepBytes =
        Number.isFinite(keepStat.blocks) && keepStat.blocks > 0
          ? keepStat.blocks * 512
          : keepStat.size;

      const gate = createGate();
      const resolvedStuck = path.resolve(stuckPath);
      const originalStat = fs.stat.bind(fs);
      const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (target) => {
        const targetPath = path.resolve(typeof target === "string" ? target : String(target));
        if (targetPath === resolvedStuck) {
          await gate.wait;
        }
        return await originalStat(target);
      });

      try {
        const diskAnalysis = await loadDiskAnalysisModule(dataDir);
        const mount = { mount: root, fs: "testfs" };
        const start = await diskAnalysis.startScan(mount);
        const finished = await waitForTerminalJob(diskAnalysis, start.jobId);

        // A timed-out entry is data the scan did not see, so the totals are a
        // lower bound and the phase has to say so.
        expect(finished?.phase).toBe("partial");
        expect(finished?.issues.some((issue) => issue.code === "path-inaccessible")).toBe(true);

        // The rest of the directory still lands.
        const snapshot = await diskAnalysis.getCachedSnapshot(mount);
        expect(snapshot?.snapshot.totals.totalBytes).toBe(expectedKeepBytes);

        await diskAnalysis.__testing.clearState();
      } finally {
        gate.open();
        statSpy.mockRestore();
        await fs.remove(dataDir);
        await fs.remove(root);
      }
    }, 30_000);

    test("the pending-directory cap spills instead of dropping directories", async () => {
      process.env.DECKOS_DISK_ANALYSIS_MAX_PENDING_DIRECTORIES = "2";
      process.env.DECKOS_DISK_ANALYSIS_MAX_INDEXED_NODES = "5000";
      const dataDir = await createTempDir("deckos-disk-analysis-data-");
      const root = await createTempDir("deckos-disk-spill-");
      const width = 40;
      for (let i = 0; i < width; i += 1) {
        const directory = path.join(root, `d${i}`);
        await fs.ensureDir(directory);
        await fs.writeFile(path.join(directory, "f.bin"), Buffer.alloc(64));
      }

      const diskAnalysis = await loadDiskAnalysisModule(dataDir);
      const mount = { mount: root, fs: "testfs" };
      const start = await diskAnalysis.startScan(mount);
      const finished = await waitForTerminalJob(diskAnalysis, start.jobId);
      const snapshot = await diskAnalysis.getCachedSnapshot(mount);

      // The queue length is a scheduling knob, not a work budget. Overflow
      // waits its turn in a secondary FIFO; only `maxIndexedNodes` truncates.
      expect(finished?.phase).toBe("completed");
      expect(snapshot?.snapshot.totals.totalDirectories).toBe(width + 1);
      expect(snapshot?.snapshot.totals.totalFiles).toBe(width);
      expect(snapshot?.snapshot.totals.totalBytes).toBe(width * 64);
      expect(snapshot?.snapshot.root.truncated).toBe(false);
      expect(snapshot?.snapshot.issues.some((issue) => issue.code === "partial-scan")).toBe(false);

      await diskAnalysis.__testing.clearState();
      await fs.remove(dataDir);
      await fs.remove(root);
    }, 30_000);

    test("the same fixture scans to the same totals twice", async () => {
      // With the old queue-length cap, whether a directory was indexed or
      // dropped depended on how many siblings happened to be queued at the
      // instant it was examined -- i.e. on how four concurrent readdirs
      // interleaved. The same tree could therefore report two different sizes
      // on two runs. Four workers and a queue far smaller than the fan-out is
      // exactly that setup.
      process.env.DECKOS_DISK_ANALYSIS_MAX_WORKERS = "4";
      process.env.DECKOS_DISK_ANALYSIS_MAX_PENDING_DIRECTORIES = "3";
      process.env.DECKOS_DISK_ANALYSIS_MAX_INDEXED_NODES = "5000";
      const dataDir = await createTempDir("deckos-disk-analysis-data-");
      const root = await createTempDir("deckos-disk-stable-");

      const branches = 8;
      const depth = 3;
      const filesPerDirectory = 2;
      for (let branch = 0; branch < branches; branch += 1) {
        let cursor = root;
        for (let level = 0; level < depth; level += 1) {
          cursor = path.join(cursor, `b${branch}-l${level}`);
          await fs.ensureDir(cursor);
          for (let file = 0; file < filesPerDirectory; file += 1) {
            await fs.writeFile(path.join(cursor, `f${file}.bin`), Buffer.alloc(64));
          }
        }
      }

      const expectedDirectories = branches * depth + 1;
      const expectedFiles = branches * depth * filesPerDirectory;
      const expectedBytes = expectedFiles * 64;

      const diskAnalysis = await loadDiskAnalysisModule(dataDir);
      const mount = { mount: root, fs: "testfs" };

      const runs: { totalBytes: number; totalFiles: number; totalDirectories: number }[] = [];
      for (let run = 0; run < 2; run += 1) {
        const start = await diskAnalysis.startScan(mount);
        expect((await waitForTerminalJob(diskAnalysis, start.jobId))?.phase).toBe("completed");
        const snapshot = await diskAnalysis.getCachedSnapshot(mount);
        if (!snapshot) {
          throw new Error(`Expected a cached snapshot after run ${run}`);
        }
        runs.push(snapshot.snapshot.totals);
      }

      expect(runs[0]).toEqual(runs[1]);
      expect(runs[0]).toEqual({
        totalBytes: expectedBytes,
        totalFiles: expectedFiles,
        totalDirectories: expectedDirectories,
      });

      await diskAnalysis.__testing.clearState();
      await fs.remove(dataDir);
      await fs.remove(root);
    }, 60_000);
  });

  describe("hardlink and allocated-size accounting (DISK-8)", () => {
    // fs.link behaves differently on Windows (junctions/reparse points, and
    // nlink semantics that don't match POSIX), so the fixture this test
    // builds would not mean what it says there.
    test.skipIf(process.platform === "win32")(
      "hardlinked files are counted once",
      async () => {
        const dataDir = await createTempDir("deckos-disk-analysis-data-");
        const mountDir = await createTempDir("deckos-disk-hardlink-");
        const original = path.join(mountDir, "original.bin");
        await fs.writeFile(original, Buffer.alloc(1024 * 1024));
        // Borg, rsnapshot and Time Machine backup trees are built almost
        // entirely from hardlinks, so a 200 GB backup directory can
        // currently report as several terabytes.
        for (let i = 0; i < 9; i += 1) {
          await fs.link(original, path.join(mountDir, `link${i}.bin`));
        }

        const diskAnalysis = await loadDiskAnalysisModule(dataDir);
        const mount = { mount: mountDir, fs: "testfs" };
        const start = await diskAnalysis.startScan(mount);
        const finalJob = await waitForTerminalJob(diskAnalysis, start.jobId);
        const snapshot = await diskAnalysis.getCachedSnapshot(mount);

        expect(finalJob?.phase).toBe("completed");
        // One megabyte on disk, not ten -- the other nine paths are the same
        // inode and must not be summed as if they were distinct files.
        expect(snapshot?.snapshot.root.size).toBeLessThan(2 * 1024 * 1024);
        expect(snapshot?.snapshot.totals.totalBytes).toBeLessThan(2 * 1024 * 1024);

        await diskAnalysis.__testing.clearState();
        await fs.remove(dataDir);
        await fs.remove(mountDir);
      },
      15000
    );
  });
});
