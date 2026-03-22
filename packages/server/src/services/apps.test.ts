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

async function loadAppsModule(dataDir: string) {
  vi.resetModules();
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

  test("listApps skips invalid app directories and continues", async () => {
    const dataDir = await createTempDir("deckos-apps-list-skip-");
    const apps = await loadAppsModule(dataDir);
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
});
