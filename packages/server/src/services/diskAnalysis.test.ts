import fs from "fs-extra";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DiskAnalysisScanEvent, DiskAnalysisMountIdentity } from "../lib/diskAnalysisContract.js";

type DiskAnalysisModule = typeof import("./diskAnalysis.js");

const DEFAULT_ENV = {
  workers: process.env.DECKOS_DISK_ANALYSIS_MAX_WORKERS,
  pending: process.env.DECKOS_DISK_ANALYSIS_MAX_PENDING_DIRECTORIES,
  nodes: process.env.DECKOS_DISK_ANALYSIS_MAX_INDEXED_NODES,
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
  return crypto
    .createHash("sha1")
    .update(`${normalizedMount}::${mount.fs.trim().toLowerCase()}`)
    .digest("hex");
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
      events.some((event) => event.event === "branch" && event.branch.path.endsWith("alpha"))
    ).toBe(true);
    expect(
      events.some((event) => event.event === "branch" && event.branch.path.endsWith("beta"))
    ).toBe(true);

    const cached = await diskAnalysis.getCachedSnapshot(mount);
    expect(cached?.cache.state).toBe("fresh");
    expect(cached?.snapshot.totals.totalFiles).toBe(2);
    expect(cached?.snapshot.extensionLegend.map((entry) => entry.extension)).toEqual([
      "mkv",
      "txt",
    ]);

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

    const snapshotBeforeRefresh = await diskAnalysis.getCachedSnapshot(mount);
    expect(snapshotBeforeRefresh?.cache.state).toBe("stale");

    const state = await diskAnalysis.getMountState(mount);
    expect(state.cache.state).toBe("stale");
    expect(state.activeJob).not.toBeNull();

    const refreshedJob = await waitForTerminalJob(diskAnalysis, state.activeJob!.jobId);
    expect(refreshedJob?.phase).toBe("completed");
    const refreshedSnapshot = await diskAnalysis.getCachedSnapshot(mount);
    expect(refreshedSnapshot?.cache.state).toBe("fresh");

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
});
