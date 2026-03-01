import fs from "fs-extra";
import * as crypto from "node:crypto";
import { parse } from "yaml";
import type { App, AppMetadata } from "../lib/schema.js";
import { AppMetadataSchema, ComposeFileSchema } from "../lib/schema.js";
import { APPS_DIR, getAppDir, getMetadataPath, getComposePath } from "../lib/config.js";

async function ensureDataDir(): Promise<void> {
  await fs.ensureDir(APPS_DIR);
}

export async function listApps(): Promise<App[]> {
  await ensureDataDir();
  const appDirs = await fs.readdir(APPS_DIR, { withFileTypes: true });
  const apps: App[] = [];

  for (const dir of appDirs) {
    if (!dir.isDirectory()) continue;

    const appId = dir.name;
    const metadataPath = getMetadataPath(appId);
    const composePath = getComposePath(appId);

    try {
      const metadataExists = await fs.pathExists(metadataPath);
      const composeExists = await fs.pathExists(composePath);

      if (!metadataExists || !composeExists) continue;

      const metadataJson = await fs.readJson(metadataPath);
      const metadata = AppMetadataSchema.parse(metadataJson);
      const composeYaml = await fs.readFile(composePath, "utf-8");

      apps.push({
        id: metadata.id,
        metadata,
        composeYaml,
      });
    } catch (error) {
      console.error(`Error reading app ${appId}:`, error);
    }
  }

  apps.sort((a, b) => a.metadata.order - b.metadata.order);
  return apps;
}

export async function getApp(id: string): Promise<App | null> {
  await ensureDataDir();
  const metadataPath = getMetadataPath(id);
  const composePath = getComposePath(id);

  const metadataExists = await fs.pathExists(metadataPath);
  const composeExists = await fs.pathExists(composePath);

  if (!metadataExists || !composeExists) return null;

  try {
    const metadataJson = await fs.readJson(metadataPath);
    const metadata = AppMetadataSchema.parse(metadataJson);
    const composeYaml = await fs.readFile(composePath, "utf-8");

    return {
      id: metadata.id,
      metadata,
      composeYaml,
    };
  } catch (error) {
    console.error(`Error reading app ${id}:`, error);
    return null;
  }
}

export async function createApp(
  name: string,
  description: string,
  icon: string,
  url: string,
  composeYaml: string
): Promise<App> {
  await ensureDataDir();

  const id = `app-${crypto.randomBytes(4).toString("hex")}`;
  const now = new Date().toISOString();

  const metadata: AppMetadata = AppMetadataSchema.parse({
    id,
    name,
    icon,
    url,
    description,
    order: (await listApps()).length,
    createdAt: now,
    updatedAt: now,
  });

  const parsed = parse(composeYaml);
  ComposeFileSchema.parse(parsed);

  const appDir = getAppDir(id);
  try {
    await fs.ensureDir(appDir);

    await fs.writeJson(getMetadataPath(id), metadata, { spaces: 2 });
    await fs.writeFile(getComposePath(id), composeYaml, "utf-8");
  } catch (err) {
    await fs.remove(appDir).catch(() => {});
    throw err;
  }

  return {
    id,
    metadata,
    composeYaml,
  };
}

export async function updateApp(
  id: string,
  updates: Partial<{
    name: string;
    description: string;
    icon: string;
    url: string;
  }>
): Promise<App | null> {
  const existing = await getApp(id);
  if (!existing) return null;

  const updated = {
    ...existing.metadata,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  const metadata = AppMetadataSchema.parse(updated);
  await fs.writeJson(getMetadataPath(id), metadata, { spaces: 2 });

  return {
    id: existing.id,
    metadata,
    composeYaml: existing.composeYaml,
  };
}

export async function updateCompose(
  id: string,
  composeYaml: string
): Promise<App | null> {
  const existing = await getApp(id);
  if (!existing) return null;

  const parsed = parse(composeYaml);
  ComposeFileSchema.parse(parsed);

  await fs.writeFile(getComposePath(id), composeYaml, "utf-8");

  return {
    id: existing.id,
    metadata: existing.metadata,
    composeYaml,
  };
}

export async function deleteApp(id: string): Promise<boolean> {
  const appDir = getAppDir(id);
  const exists = await fs.pathExists(appDir);

  if (!exists) return false;

  await fs.remove(appDir);
  return true;
}

export async function reorderApps(orderedIds: string[]): Promise<void> {
  const apps = await listApps();
  const appMap = new Map(apps.map((app) => [app.id, app]));
  const existingIds = new Set(apps.map((app) => app.id));

  const ordered: App[] = [];
  for (let i = 0; i < orderedIds.length; i++) {
    const id = orderedIds[i];
    if (existingIds.has(id)) {
      const app = appMap.get(id);
      if (app) {
        app.metadata.order = i;
        ordered.push(app);
      }
    }
  }

  for (const app of ordered) {
    await fs.writeJson(getMetadataPath(app.id), app.metadata, { spaces: 2 });
  }

  const remaining = apps.filter((app) => !orderedIds.includes(app.id));
  for (let i = 0; i < remaining.length; i++) {
    const app = remaining[i];
    app.metadata.order = ordered.length + i;
    await fs.writeJson(getMetadataPath(app.id), app.metadata, { spaces: 2 });
  }
}
