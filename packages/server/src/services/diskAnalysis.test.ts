import fs from "fs-extra";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DiskAnalysisScanEvent, DiskAnalysisMountIdentity } from "@deckos/contracts";
import { DiskAnalysisIssueSchema } from "@deckos/contracts";

type DiskAnalysisModule = typeof import("./diskAnalysis.js");

const DEFAULT_ENV = {
  workers: process.env.DECKOS_DISK_ANALYSIS_MAX_WORKERS,
  pending: process.env.DECKOS_DISK_ANALYSIS_MAX_PENDING_DIRECTORIES,
  nodes: process.env.DECKOS_DISK_ANALYSIS_MAX_INDEXED_NODES,
  smallThreshold: process.env.DECKOS_DISK_ANALYSIS_SMALL_FILE_THRESHOLD_BYTES,
};

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

  test("stale cached snapshot is served immediately and triggers a background regeneration", async () => {
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
      snapshot: { generatedAt: string };
    };
    persisted.snapshot.generatedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await fs.writeJson(cacheFile, persisted, { spaces: 2 });

    diskAnalysis.__testing.resetState();
    diskAnalysis = await loadDiskAnalysisModule(dataDir);

    const originalStat = fs.stat.bind(fs);
    const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (target) => {
      const targetPath = typeof target === "string" ? target : String(target);
      if (path.resolve(targetPath) === path.resolve(mountDir)) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return await originalStat(target);
    });

    const snapshotBeforeRefresh = await diskAnalysis.getCachedSnapshot(mount);
    expect(snapshotBeforeRefresh?.cache.state).toBe("stale");

    const startedAt = Date.now();
    const state = await diskAnalysis.getMountState(mount);
    const elapsedMs = Date.now() - startedAt;
    expect(state.cache.state).toBe("stale");
    expect(elapsedMs).toBeLessThan(50);
    expect(state.activeJob).toBeNull();

    let refreshState = diskAnalysis.getJob(state.activeJob?.jobId ?? "");
    for (let attempt = 0; attempt < 20 && refreshState === null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const nextState = await diskAnalysis.getMountState(mount);
      refreshState = nextState.activeJob ? diskAnalysis.getJob(nextState.activeJob.jobId) : null;
    }
    expect(refreshState).not.toBeNull();
    if (!refreshState) {
      throw new Error("Expected background refresh job");
    }

    const refreshedJob = await waitForTerminalJob(diskAnalysis, refreshState.jobId);
    expect(refreshedJob?.phase).toBe("completed");
    const refreshedSnapshot = await diskAnalysis.getCachedSnapshot(mount);
    expect(refreshedSnapshot?.cache.state).toBe("fresh");
    statSpy.mockRestore();

    await diskAnalysis.__testing.clearState();
    await fs.remove(dataDir);
    await fs.remove(mountDir);
  });

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
    expect(mountState.activeJob).not.toBeNull();
    expect(snapshot).toBeNull();
    expect(files.some((file) => file.includes(".corrupt-"))).toBe(true);

    await diskAnalysis.__testing.clearState();
    await fs.remove(dataDir);
    await fs.remove(mountDir);
  });

  test("scan enforces traversal limits and reports a partial result", async () => {
    process.env.DECKOS_DISK_ANALYSIS_MAX_PENDING_DIRECTORIES = "1";
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
});
