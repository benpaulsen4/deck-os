import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { spawn } from "node:child_process";
import type { StorageAnalysisResponse } from "../lib/schema.js";

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

function createSpawnStub(plan: Array<{ code?: number; error?: string }>): typeof spawn {
  let index = 0;
  return ((command: string, args: readonly string[]) => {
    void command;
    void args;
    const child = new EventEmitter() as ReturnType<typeof spawn>;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdout.setEncoding("utf8");
    stderr.setEncoding("utf8");
    child.stdout = stdout;
    child.stderr = stderr;
    const next = plan[index++] ?? { code: 0 };
    queueMicrotask(() => {
      if (next.error) {
        child.emit("error", new Error(next.error));
        return;
      }
      child.emit("exit", next.code ?? 0, null);
    });
    return child;
  }) as unknown as typeof spawn;
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

describe("storage analysis service", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  test("creates a fallback snapshot and reuses the cache for non-btrfs mounts", async () => {
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
      spawnImpl: createSpawnStub([]),
      statImpl: (await import("node:fs/promises")).stat,
      lstatImpl: (await import("node:fs/promises")).lstat,
      opendirImpl: (await import("node:fs/promises")).opendir,
      now: () => Date.now(),
    };

    const initial = await storage.getStorageAnalysis(
      { mount: fixtureRoot, fs: "/dev/sda1" },
      deps
    );
    expect(initial.status).toBe("scanning");

    const ready = await waitForReady(() =>
      storage.getStorageAnalysis({ mount: fixtureRoot, fs: "/dev/sda1" }, deps)
    );
    expect(ready.status).toBe("ready");
    expect(ready.analyzer).toBe("fallback");
    expect(ready.root?.children.some((child) => child.name === "logs")).toBe(true);
    expect(ready.extensionHistogram.some((entry) => entry.extension === ".log")).toBe(true);
    expect(ready.fallbackReason).toBe("Filesystem is not btrfs.");

    const mountKey = storage.__storageAnalysisTestUtils.createMountKey("/dev/sda1", fixtureRoot);
    const snapshotPath = storage.__storageAnalysisTestUtils.getSnapshotPath(mountKey);
    const metaPath = storage.__storageAnalysisTestUtils.getMetaPath(mountKey);
    expect(await (await import("fs-extra")).pathExists(snapshotPath)).toBe(true);
    expect(await (await import("fs-extra")).pathExists(metaPath)).toBe(true);
  });

  test("serves stale snapshots immediately and refreshes in the background", async () => {
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
      spawnImpl: createSpawnStub([]),
      statImpl: (await import("node:fs/promises")).stat,
      lstatImpl: (await import("node:fs/promises")).lstat,
      opendirImpl: (await import("node:fs/promises")).opendir,
      now: () => Date.now(),
    };

    await storage.getStorageAnalysis({ mount: fixtureRoot, fs: "/dev/sda1" }, deps);
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
    expect(stale.refreshing).toBe(true);
    expect(stale.root?.name).toBe("fixture");
  });

  test("records btrfs analyzer fallback reason when btdu is unavailable", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "deckos-storage-analysis-"));
    const fixtureRoot = path.join(tempDataDir, "fixture");
    await mkdir(fixtureRoot, { recursive: true });
    await writeFile(path.join(fixtureRoot, "blob.bin"), "1234567890");

    const storage = await loadStorageModule(tempDataDir);
    await storage.clearStorageAnalysisState();

    const deps = {
      fsSize: vi.fn(async () => [
        {
          fs: "/dev/nvme0n1p1",
          mount: fixtureRoot,
          size: 1000,
          used: 500,
          available: 500,
          use: 50,
          rw: true,
          type: "btrfs",
        },
      ]),
      spawnImpl: createSpawnStub([{ error: "ENOENT" }]),
      statImpl: (await import("node:fs/promises")).stat,
      lstatImpl: (await import("node:fs/promises")).lstat,
      opendirImpl: (await import("node:fs/promises")).opendir,
      now: () => Date.now(),
    };

    await storage.getStorageAnalysis({ mount: fixtureRoot, fs: "/dev/nvme0n1p1" }, deps);
    const ready = await waitForReady(() =>
      storage.getStorageAnalysis({ mount: fixtureRoot, fs: "/dev/nvme0n1p1" }, deps)
    );

    expect(ready.status).toBe("ready");
    expect(ready.analyzer).toBe("fallback");
    expect(ready.fallbackReason).toBe("btdu is not installed.");
  });
});
