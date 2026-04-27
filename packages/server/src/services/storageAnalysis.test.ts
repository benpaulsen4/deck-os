import { mkdtemp, writeFile, mkdir, readFile, stat, lstat, opendir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { StorageAnalysisResponse, StorageAnalysisStreamEvent } from "../lib/schema.js";

type ServiceModule = typeof import("./storageAnalysis.js");

async function loadStorageModule(tempDataDir: string): Promise<ServiceModule> {
  vi.resetModules();
  vi.doMock("../lib/config.js", async () => {
    const actual = await vi.importActual<typeof import("../lib/config.js")>("../lib/config.js");
    return {
      ...actual,
      DATA_DIR: tempDataDir,
    };
  });
  return await import("./storageAnalysis.js");
}

async function waitForReady(
  fn: () => Promise<StorageAnalysisResponse>
): Promise<StorageAnalysisResponse> {
  for (let index = 0; index < 100; index += 1) {
    const value = await fn();
    if (value.status === "ready" || value.status === "stale") {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for analysis result");
}

async function waitForFailed(
  fn: () => Promise<StorageAnalysisResponse>
): Promise<StorageAnalysisResponse> {
  for (let index = 0; index < 100; index += 1) {
    const value = await fn();
    if (value.status === "failed") {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for failed analysis result");
}

async function waitForCondition<T>(fn: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  for (let index = 0; index < 100; index += 1) {
    const value = await fn();
    if (predicate(value)) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

describe("storage analysis service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.doUnmock("../lib/config.js");
  });

  test("creates a scan snapshot and reuses the cache", async () => {
    const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "deckos-storage-analysis-"));
    const fixtureRoot = path.join(tempDataDir, "fixture");
    await mkdir(path.join(fixtureRoot, "logs"), { recursive: true });
    await writeFile(path.join(fixtureRoot, "logs", "server.log"), "hello");
    await writeFile(path.join(fixtureRoot, "config.yml"), "name: deckos\n");

    const storage = await loadStorageModule(tempDataDir);
    await storage.clearStorageAnalysisState();

    const deps = {
      fsSize: vi.fn(async () => [
        {
          fs: "/dev/sda1",
          mount: fixtureRoot,
          size: 1000,
          used: 500,
          available: 500,
          use: 50,
          rw: true,
          type: "ext4",
        },
      ]),
      statImpl: stat,
      lstatImpl: lstat,
      opendirImpl: opendir,
      now: () => Date.now(),
    };

    const initial = await storage.getStorageAnalysis(
      { mount: fixtureRoot, fs: "/dev/sda1" },
      deps
    );
    expect(initial.status).toBe("scanning");
    expect(initial.startedAt).toBeNull();

    const started = await storage.startStorageAnalysis({ mount: fixtureRoot, fs: "/dev/sda1" }, deps);
    expect(started.job.status).toBe("scanning");
    expect(started.job.startedAt).not.toBeNull();

    const ready = await waitForReady(() =>
      storage.getStorageAnalysis({ mount: fixtureRoot, fs: "/dev/sda1" }, deps)
    );
    expect(ready.status).toBe("ready");
    expect(ready.analyzer).toBe("scan");
    expect(ready.root?.children.some((child) => child.name === "logs")).toBe(true);
    expect(ready.extensionHistogram.some((entry) => entry.extension === ".log")).toBe(true);
    expect(ready.warningCode).toBeNull();
    expect(ready.warning).toBeNull();

    const mountKey = storage.__storageAnalysisTestUtils.createMountKey("/dev/sda1", fixtureRoot);
    const snapshotPath = storage.__storageAnalysisTestUtils.getSnapshotPath(mountKey);
    const metaPath = storage.__storageAnalysisTestUtils.getMetaPath(mountKey);
    expect(await (await import("fs-extra")).pathExists(snapshotPath)).toBe(true);
    expect(await (await import("fs-extra")).pathExists(metaPath)).toBe(true);
  });

  test("serves stale snapshots immediately until an explicit refresh starts", async () => {
    const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "deckos-storage-analysis-"));
    const fixtureRoot = path.join(tempDataDir, "fixture");
    await mkdir(fixtureRoot, { recursive: true });
    await writeFile(path.join(fixtureRoot, "notes.txt"), "initial");

    const storage = await loadStorageModule(tempDataDir);
    await storage.clearStorageAnalysisState();

    const deps = {
      fsSize: vi.fn(async () => [
        {
          fs: "/dev/sda1",
          mount: fixtureRoot,
          size: 1000,
          used: 500,
          available: 500,
          use: 50,
          rw: true,
          type: "ext4",
        },
      ]),
      statImpl: stat,
      lstatImpl: lstat,
      opendirImpl: opendir,
      now: () => Date.now(),
    };

    await storage.startStorageAnalysis({ mount: fixtureRoot, fs: "/dev/sda1" }, deps);
    await waitForReady(() =>
      storage.getStorageAnalysis({ mount: fixtureRoot, fs: "/dev/sda1" }, deps)
    );

    const mountKey = storage.__storageAnalysisTestUtils.createMountKey("/dev/sda1", fixtureRoot);
    const snapshotPath = storage.__storageAnalysisTestUtils.getSnapshotPath(mountKey);
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as {
      completedAt: string;
      generatedAt: string;
    };
    snapshot.completedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    snapshot.generatedAt = snapshot.completedAt;
    await (await import("fs-extra")).writeJson(snapshotPath, snapshot);

    const stale = await storage.getStorageAnalysis({ mount: fixtureRoot, fs: "/dev/sda1" }, deps);
    expect(stale.status).toBe("stale");
    expect(stale.refreshing).toBe(false);
    expect(stale.root?.name).toBe("fixture");

    const refreshed = await storage.refreshStorageAnalysis({ mount: fixtureRoot, fs: "/dev/sda1" }, deps);
    expect(refreshed.refreshing).toBe(true);
  });

  test("streams node patches while a long scan is still running", async () => {
    const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "deckos-storage-analysis-"));
    const fixtureRoot = path.join(tempDataDir, "fixture");
    const fastDir = path.join(fixtureRoot, "fast");
    const slowDir = path.join(fixtureRoot, "slow");
    await mkdir(fastDir, { recursive: true });
    await mkdir(slowDir, { recursive: true });
    await writeFile(path.join(fastDir, "fast.log"), "fast");
    await writeFile(path.join(slowDir, "slow-a.log"), "slow-a");
    await writeFile(path.join(slowDir, "slow-b.log"), "slow-b");

    const storage = await loadStorageModule(tempDataDir);
    await storage.clearStorageAnalysisState();

    const delayedLstat: typeof lstat = (async (targetPath: Parameters<typeof lstat>[0]) => {
      const target = String(targetPath);
      if (target.endsWith("slow-a.log")) {
        await new Promise((resolve) => setTimeout(resolve, 180));
      }
      if (target.endsWith("slow")) {
        await new Promise((resolve) => setTimeout(resolve, 90));
      }
      if (target.endsWith("slow-b.log")) {
        await new Promise((resolve) => setTimeout(resolve, 450));
      }
      return await lstat(targetPath);
    }) as unknown as typeof lstat;

    const deps = {
      fsSize: vi.fn(async () => [
        {
          fs: "/dev/sda1",
          mount: fixtureRoot,
          size: 1000,
          used: 500,
          available: 500,
          use: 50,
          rw: true,
          type: "ext4",
        },
      ]),
      statImpl: stat,
      lstatImpl: delayedLstat,
      opendirImpl: opendir,
      now: () => Date.now(),
    };

    const started = await storage.startStorageAnalysis({ mount: fixtureRoot, fs: "/dev/sda1" }, deps);
    const events: StorageAnalysisStreamEvent[] = [];
    const unsubscribe = storage.subscribeToStorageAnalysisJob(
      started.job.jobId,
      null,
      (_eventId, event) => {
        events.push(event);
      }
    );
    expect(unsubscribe).not.toBeNull();

    await waitForCondition(
      async () => events,
      (value) =>
        value.some(
          (event) =>
            event.type === "node" &&
            (event.node.name === "fast" || event.node.name === "fast.log")
        )
    );

    await waitForCondition(
      async () => events,
      (value) =>
        value.some(
          (event) =>
            event.type === "node" &&
            (event.node.name === "slow" || event.node.name === "slow-a.log")
        )
    );

    const ready = await waitForReady(() =>
      storage.getStorageAnalysis({ mount: fixtureRoot, fs: "/dev/sda1" }, deps)
    );
    expect(ready.status).toBe("ready");
    unsubscribe?.();
  });

  test("does not persist scanning snapshots to disk while a scan is in progress", async () => {
    const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "deckos-storage-analysis-"));
    const fixtureRoot = path.join(tempDataDir, "fixture");
    const slowDir = path.join(fixtureRoot, "slow");
    await mkdir(slowDir, { recursive: true });
    await writeFile(path.join(slowDir, "slow.log"), "slow");

    const storage = await loadStorageModule(tempDataDir);
    await storage.clearStorageAnalysisState();

    const delayedLstat: typeof lstat = (async (targetPath: Parameters<typeof lstat>[0]) => {
      if (String(targetPath).endsWith("slow.log")) {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      return await lstat(targetPath);
    }) as unknown as typeof lstat;

    const deps = {
      fsSize: vi.fn(async () => [
        {
          fs: "/dev/sda1",
          mount: fixtureRoot,
          size: 1000,
          used: 500,
          available: 500,
          use: 50,
          rw: true,
          type: "ext4",
        },
      ]),
      statImpl: stat,
      lstatImpl: delayedLstat,
      opendirImpl: opendir,
      now: () => Date.now(),
    };

    await storage.startStorageAnalysis({ mount: fixtureRoot, fs: "/dev/sda1" }, deps);
    await new Promise((resolve) => setTimeout(resolve, 80));

    const mountKey = storage.__storageAnalysisTestUtils.createMountKey("/dev/sda1", fixtureRoot);
    const snapshotPath = storage.__storageAnalysisTestUtils.getSnapshotPath(mountKey);
    expect(await (await import("fs-extra")).pathExists(snapshotPath)).toBe(false);

    const ready = await waitForReady(() =>
      storage.getStorageAnalysis({ mount: fixtureRoot, fs: "/dev/sda1" }, deps)
    );
    expect(ready.status).toBe("ready");
    expect(await (await import("fs-extra")).pathExists(snapshotPath)).toBe(true);
  });

  test("returns a warning when nested paths are skipped for permissions", async () => {
    const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "deckos-storage-analysis-"));
    const fixtureRoot = path.join(tempDataDir, "fixture");
    const privateDir = path.join(fixtureRoot, "private");
    await mkdir(fixtureRoot, { recursive: true });
    await mkdir(privateDir, { recursive: true });
    await writeFile(path.join(fixtureRoot, "blob.bin"), "1234567890");

    const storage = await loadStorageModule(tempDataDir);
    await storage.clearStorageAnalysisState();

    const lstatWithDeniedPath: typeof lstat = (async (targetPath: Parameters<typeof lstat>[0]) => {
      if (String(targetPath) === privateDir) {
        const error = new Error("denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return await lstat(targetPath);
    }) as typeof lstat;

    const deps = {
      fsSize: vi.fn(async () => [
        {
          fs: "/dev/sda1",
          mount: fixtureRoot,
          size: 1000,
          used: 500,
          available: 500,
          use: 50,
          rw: true,
          type: "ext4",
        },
      ]),
      statImpl: stat,
      lstatImpl: lstatWithDeniedPath,
      opendirImpl: opendir,
      now: () => Date.now(),
    };

    await storage.startStorageAnalysis({ mount: fixtureRoot, fs: "/dev/sda1" }, deps);
    const ready = await waitForReady(() =>
      storage.getStorageAnalysis({ mount: fixtureRoot, fs: "/dev/sda1" }, deps)
    );

    expect(ready.status).toBe("ready");
    expect(ready.analyzer).toBe("scan");
    expect(ready.warningCode).toBe("partial-permissions");
    expect(ready.warning).toContain("Skipped 1 path");
  });

  test("returns a permission-denied failure when the mount root is unreadable", async () => {
    const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "deckos-storage-analysis-"));
    const fixtureRoot = path.join(tempDataDir, "fixture");
    await mkdir(fixtureRoot, { recursive: true });

    const storage = await loadStorageModule(tempDataDir);
    await storage.clearStorageAnalysisState();

    const lstatDeniedRoot: typeof lstat = (async (targetPath: Parameters<typeof lstat>[0]) => {
      if (String(targetPath) === fixtureRoot) {
        const error = new Error("denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return await lstat(targetPath);
    }) as typeof lstat;

    const deps = {
      fsSize: vi.fn(async () => [
        {
          fs: "/dev/sda1",
          mount: fixtureRoot,
          size: 1000,
          used: 500,
          available: 500,
          use: 50,
          rw: true,
          type: "ext4",
        },
      ]),
      statImpl: stat,
      lstatImpl: lstatDeniedRoot,
      opendirImpl: opendir,
      now: () => Date.now(),
    };

    await storage.startStorageAnalysis({ mount: fixtureRoot, fs: "/dev/sda1" }, deps);
    const failed = await waitForFailed(() =>
      storage.getStorageAnalysis({ mount: fixtureRoot, fs: "/dev/sda1" }, deps)
    );
    expect(failed.status).toBe("failed");
    expect(failed.errorCode).toBe("permission-denied");
    expect(failed.error).toContain("cannot read this mount");
  });

  test("returns an unsupported failure when no stable device boundary is available", async () => {
    const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "deckos-storage-analysis-"));
    const fixtureRoot = path.join(tempDataDir, "fixture");
    await mkdir(fixtureRoot, { recursive: true });

    const storage = await loadStorageModule(tempDataDir);
    await storage.clearStorageAnalysisState();

    const statWithoutDeviceBoundary: typeof stat = (async () => {
      const stats = await stat(fixtureRoot);
      Object.assign(stats, { dev: Number.NaN });
      return stats;
    }) as unknown as typeof stat;

    const deps = {
      fsSize: vi.fn(async () => [
        {
          fs: "/dev/sda1",
          mount: fixtureRoot,
          size: 1000,
          used: 500,
          available: 500,
          use: 50,
          rw: true,
          type: "ext4",
        },
      ]),
      statImpl: statWithoutDeviceBoundary,
      lstatImpl: lstat,
      opendirImpl: opendir,
      now: () => Date.now(),
    };

    const failed = await storage.getStorageAnalysis({ mount: fixtureRoot, fs: "/dev/sda1" }, deps);
    expect(failed.status).toBe("failed");
    expect(failed.errorCode).toBe("unsupported");
    expect(failed.error).toContain("stable device boundary");
  });
});
