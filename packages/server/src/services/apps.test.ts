import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const createdDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

const dockerMocks = {
  stopStack: vi.fn(async () => undefined),
  getStackContainers: vi.fn(async () => [] as Array<{ id: string }>),
};

async function loadAppsModule(dataDir: string) {
  vi.resetModules();
  dockerMocks.stopStack = vi.fn(async () => undefined);
  dockerMocks.getStackContainers = vi.fn(async () => [] as Array<{ id: string }>);
  vi.doMock("./docker.js", () => ({
    stopStack: (...args: unknown[]) =>
      (dockerMocks.stopStack as unknown as (...a: unknown[]) => Promise<undefined>)(
        ...args
      ),
    getStackContainers: (...args: unknown[]) =>
      (
        dockerMocks.getStackContainers as unknown as (
          ...a: unknown[]
        ) => Promise<Array<{ id: string }>>
      )(...args),
  }));
  process.env.DECKOS_DATA_DIR = dataDir;
  return await import("./apps.js");
}

describe("apps service", () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...envBackup };
  });

  afterEach(async () => {
    process.env = { ...envBackup };
    await Promise.all(createdDirs.splice(0).map((dir) => fs.remove(dir)));
  });

  test("create/get/list app with valid compose", async () => {
    const dataDir = await createTempDir("deckos-apps-create-");
    const apps = await loadAppsModule(dataDir);
    const compose = "services:\n  web:\n    image: nginx:latest\n";

    const created = await apps.createApp("Web", "Demo", "", "", compose);
    const loaded = await apps.getApp(created.id);
    const listed = await apps.listApps();

    expect(created.id).toMatch(/^app-[a-f0-9]{8}$/);
    expect(loaded?.id).toBe(created.id);
    expect(loaded?.composeYaml).toContain("nginx:latest");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(created.id);
    expect(created.metadata.order).toBe(0);
  });

  test("createApp rejects invalid compose and keeps app dir clean", async () => {
    const dataDir = await createTempDir("deckos-apps-invalid-compose-");
    const apps = await loadAppsModule(dataDir);
    const badCompose = "services:\n  web:\n    ports: 'not-an-array'\n";

    await expect(apps.createApp("Bad", "", "", "", badCompose)).rejects.toThrow();
    const appDirs = await fs.readdir(path.join(dataDir, "apps")).catch(() => []);
    expect(appDirs.length).toBe(0);
  });

  test("updateApp and updateCompose return null for unknown ids", async () => {
    const dataDir = await createTempDir("deckos-apps-update-missing-");
    const apps = await loadAppsModule(dataDir);

    const updated = await apps.updateApp("app-missing", { name: "Renamed" });
    const composeUpdated = await apps.updateCompose(
      "app-missing",
      "services:\n  web:\n    image: nginx:latest\n"
    );

    expect(updated).toBeNull();
    expect(composeUpdated).toBeNull();
  });

  test("updateApp persists metadata changes and updates timestamp", async () => {
    const dataDir = await createTempDir("deckos-apps-update-");
    const apps = await loadAppsModule(dataDir);
    const created = await apps.createApp(
      "Original",
      "desc",
      "https://example.com/icon.png",
      "https://example.com",
      "services:\n  web:\n    image: nginx:latest\n"
    );

    const updated = await apps.updateApp(created.id, {
      name: "Updated Name",
      description: "updated",
    });
    const loaded = await apps.getApp(created.id);

    expect(updated?.metadata.name).toBe("Updated Name");
    expect(updated?.metadata.description).toBe("updated");
    expect(updated?.metadata.updatedAt).not.toBe(created.metadata.updatedAt);
    expect(loaded?.metadata.name).toBe("Updated Name");
  });

  test("updateCompose validates compose and persists new content", async () => {
    const dataDir = await createTempDir("deckos-apps-compose-");
    const apps = await loadAppsModule(dataDir);
    const created = await apps.createApp(
      "Compose App",
      "",
      "",
      "",
      "services:\n  web:\n    image: nginx:latest\n"
    );

    const nextCompose = "services:\n  api:\n    image: node:20\n";
    const updated = await apps.updateCompose(created.id, nextCompose);
    expect(updated?.composeYaml).toContain("node:20");

    await expect(apps.updateCompose(created.id, "services:\n  api: invalid")).rejects.toThrow();
  });

  test("deleteApp removes existing app and returns false for missing app", async () => {
    const dataDir = await createTempDir("deckos-apps-delete-");
    const apps = await loadAppsModule(dataDir);
    const created = await apps.createApp(
      "Delete Me",
      "",
      "",
      "",
      "services:\n  web:\n    image: nginx:latest\n"
    );

    expect(await apps.deleteApp(created.id)).toBe(true);
    expect(await apps.getApp(created.id)).toBeNull();
    expect(await apps.deleteApp(created.id)).toBe(false);
  });

  test("reorderApps applies explicit order and appends unspecified apps", async () => {
    const dataDir = await createTempDir("deckos-apps-reorder-");
    const apps = await loadAppsModule(dataDir);
    const compose = "services:\n  web:\n    image: nginx:latest\n";

    const first = await apps.createApp("First", "", "", "", compose);
    const second = await apps.createApp("Second", "", "", "", compose);
    const third = await apps.createApp("Third", "", "", "", compose);

    await apps.reorderApps([third.id, first.id]);
    const listed = await apps.listApps();

    expect(listed.map((item) => item.id)).toEqual([third.id, first.id, second.id]);
    expect(listed.map((item) => item.metadata.order)).toEqual([0, 1, 2]);
  });

  test("listApps skips directories whose contents are invalid and continues", async () => {
    const dataDir = await createTempDir("deckos-apps-list-skip-");
    const apps = await loadAppsModule(dataDir);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const compose = "services:\n  web:\n    image: nginx:latest\n";
    const created = await apps.createApp("Healthy", "", "", "", compose);
    const appsDir = path.join(dataDir, "apps");
    const invalidDir = path.join(appsDir, "app-invalid");
    await fs.ensureDir(invalidDir);
    await fs.writeJson(path.join(invalidDir, "metadata.json"), { not: "schema" });
    await fs.writeFile(path.join(invalidDir, "docker-compose.yml"), compose, "utf8");

    const listed = await apps.listApps();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(created.id);
  });

  test("listApps skips directory names that are not valid app ids", async () => {
    const dataDir = await createTempDir("deckos-apps-list-badnames-");
    const apps = await loadAppsModule(dataDir);
    const compose = "services:\n  web:\n    image: nginx:latest\n";
    const created = await apps.createApp("Healthy", "", "", "", compose);
    const appsDir = path.join(dataDir, "apps");

    // `lost+found` appears on its own for free when /var/lib/deckos is an ext4
    // mount; the others are creatable straight from the file browser.
    for (const name of ["lost+found", "Backups", "my app", "under_score"]) {
      await fs.ensureDir(path.join(appsDir, name));
    }

    const listed = await apps.listApps();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(created.id);
  });

  test("createApp still works when an unlistable directory exists", async () => {
    const dataDir = await createTempDir("deckos-apps-create-badnames-");
    const apps = await loadAppsModule(dataDir);
    await fs.ensureDir(path.join(dataDir, "apps", "lost+found"));

    const created = await apps.createApp(
      "Healthy",
      "",
      "",
      "",
      "services:\n  web:\n    image: nginx:latest\n"
    );

    expect(created.metadata.order).toBe(0);
    expect(await apps.listApps()).toHaveLength(1);
  });

  test("directory name is the app identity even when metadata claims another id", async () => {
    const dataDir = await createTempDir("deckos-apps-identity-");
    const apps = await loadAppsModule(dataDir);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const compose = "services:\n  web:\n    image: nginx:latest\n";
    const first = await apps.createApp("First", "", "", "", compose);
    const second = await apps.createApp("Second", "", "", "", compose);

    // Impersonate the first app from the second app's metadata.
    const secondMetadataPath = path.join(dataDir, "apps", second.id, "metadata.json");
    const metadata = await fs.readJson(secondMetadataPath);
    await fs.writeJson(secondMetadataPath, { ...metadata, id: first.id });

    const listed = await apps.listApps();
    const ids = listed.map((app) => app.id);

    expect(listed).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain(second.id);
    expect(listed.every((app) => app.metadata.id === app.id)).toBe(true);

    const loaded = await apps.getApp(second.id);
    expect(loaded?.id).toBe(second.id);
    expect(loaded?.metadata.id).toBe(second.id);
  });

  test("metadata writes are atomic (temp file plus rename, no leftovers)", async () => {
    const dataDir = await createTempDir("deckos-apps-atomic-");
    const apps = await loadAppsModule(dataDir);
    const created = await apps.createApp(
      "Atomic",
      "",
      "",
      "",
      "services:\n  web:\n    image: nginx:latest\n"
    );

    const renameSpy = vi.spyOn(fs, "rename");
    await apps.updateApp(created.id, { name: "Renamed" });
    expect(renameSpy).toHaveBeenCalled();
    renameSpy.mockRestore();

    const entries = await fs.readdir(path.join(dataDir, "apps", created.id));
    expect(entries.sort()).toEqual(["docker-compose.yml", "metadata.json"]);
    const reloaded = await apps.getApp(created.id);
    expect(reloaded?.metadata.name).toBe("Renamed");
  });

  test("withAppLock serializes same-app work, runs different apps concurrently, and is reentrant", async () => {
    const dataDir = await createTempDir("deckos-apps-lock-");
    const apps = await loadAppsModule(dataDir);

    const events: string[] = [];
    const defer = () => {
      let release: () => void = () => undefined;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    };

    // Same app id: the second call must not start until the first finishes.
    const first = defer();
    const firstRun = apps.withAppLock("app-a", async () => {
      events.push("a1:start");
      await first.promise;
      events.push("a1:end");
    });
    const secondRun = apps.withAppLock("app-a", async () => {
      events.push("a2:start");
    });

    // A different app id must not be blocked by app-a's critical section.
    await apps.withAppLock("app-b", async () => {
      events.push("b:ran");
    });
    expect(events).toEqual(["a1:start", "b:ran"]);

    first.release();
    await Promise.all([firstRun, secondRun]);
    expect(events).toEqual(["a1:start", "b:ran", "a1:end", "a2:start"]);

    // A rejected critical section must not wedge the queue.
    await expect(
      apps.withAppLock("app-a", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    await expect(apps.withAppLock("app-a", async () => "after-failure")).resolves.toBe(
      "after-failure"
    );

    // Reentrant acquisition must run inline rather than deadlock.
    await expect(
      apps.withAppLock("app-a", async () =>
        apps.withAppLock("app-a", async () => "nested")
      )
    ).resolves.toBe("nested");
  });

  test("deleteAppWithStack refuses to delete when containers survive a failed stop", async () => {
    const dataDir = await createTempDir("deckos-apps-delete-running-");
    const apps = await loadAppsModule(dataDir);
    const created = await apps.createApp(
      "Stubborn",
      "",
      "",
      "",
      "services:\n  web:\n    image: nginx:latest\n"
    );

    dockerMocks.stopStack.mockRejectedValue(new Error("compose down failed"));
    dockerMocks.getStackContainers.mockResolvedValue([{ id: "cid-1" }, { id: "cid-2" }]);

    await expect(apps.deleteAppWithStack(created.id)).rejects.toThrow(
      apps.StackStillRunningError
    );
    expect(await apps.getApp(created.id)).not.toBeNull();

    const forced = await apps.deleteAppWithStack(created.id, { force: true });
    expect(forced.deleted).toBe(true);
    expect(forced.containersMayRemain).toBe(true);
    expect(forced.stopError).toContain("compose down failed");
    expect(await apps.getApp(created.id)).toBeNull();
  });

  test("deleteAppWithStack deletes when the stop fails but nothing is running", async () => {
    const dataDir = await createTempDir("deckos-apps-delete-stopped-");
    const apps = await loadAppsModule(dataDir);
    const created = await apps.createApp(
      "Rollback",
      "",
      "",
      "",
      "services:\n  web:\n    image: nginx:latest\n"
    );

    dockerMocks.stopStack.mockRejectedValue(new Error("no such file"));
    dockerMocks.getStackContainers.mockResolvedValue([]);

    const result = await apps.deleteAppWithStack(created.id);
    expect(result.deleted).toBe(true);
    expect(result.containersMayRemain).toBe(false);
    expect(await apps.getApp(created.id)).toBeNull();
  });

  test("deleteAppWithStack proceeds but flags uncertainty when Docker cannot be reached", async () => {
    const dataDir = await createTempDir("deckos-apps-delete-nodocker-");
    const apps = await loadAppsModule(dataDir);
    const created = await apps.createApp(
      "No Docker",
      "",
      "",
      "",
      "services:\n  web:\n    image: nginx:latest\n"
    );

    dockerMocks.stopStack.mockRejectedValue(new Error("Docker is not available"));
    dockerMocks.getStackContainers.mockRejectedValue(new Error("Docker is not available"));

    const result = await apps.deleteAppWithStack(created.id);
    expect(result.deleted).toBe(true);
    expect(result.containersMayRemain).toBe(true);
    expect(await apps.getApp(created.id)).toBeNull();
  });

  test("deleteAppWithStack stops the stack before removing the directory", async () => {
    const dataDir = await createTempDir("deckos-apps-delete-order-");
    const apps = await loadAppsModule(dataDir);
    const created = await apps.createApp(
      "Ordered",
      "",
      "",
      "",
      "services:\n  web:\n    image: nginx:latest\n"
    );

    const order: string[] = [];
    dockerMocks.stopStack.mockImplementation(async () => {
      order.push("stop");
      return undefined;
    });

    const result = await apps.deleteAppWithStack(created.id);
    order.push("deleted");

    expect(order).toEqual(["stop", "deleted"]);
    expect(dockerMocks.stopStack).toHaveBeenCalledWith(created.id);
    expect(result).toEqual({
      deleted: true,
      containersMayRemain: false,
      stopError: undefined,
    });
  });
});
