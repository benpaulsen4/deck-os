import fs from "fs-extra";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { parse } from "yaml";
import type { App, AppMetadata } from "../lib/schema.js";
import { AppMetadataSchema, ComposeFileSchema } from "../lib/schema.js";
import { APPS_DIR, getAppDir, getMetadataPath, getComposePath } from "../lib/config.js";
import * as dockerService from "./docker.js";

async function ensureDataDir(): Promise<void> {
  await fs.ensureDir(APPS_DIR);
}

/**
 * Serializes work per app id so that two lifecycle operations (compose
 * up/down/restart/pull, compose file writes, delete) never run against the same
 * project concurrently.
 *
 * The lock is reentrant: acquiring the same app id from inside a critical
 * section runs inline instead of deadlocking (e.g. delete holds the lock while
 * calling a helper that also wants it). Locks for different app ids are
 * independent, so an operation touching two apps must acquire them one at a
 * time - never nest two *different* app locks, which is the only way to build a
 * cycle here.
 */
const heldAppLocks = new AsyncLocalStorage<ReadonlySet<string>>();
const appLockTails = new Map<string, Promise<void>>();

export async function withAppLock<T>(appId: string, fn: () => Promise<T>): Promise<T> {
  const held = heldAppLocks.getStore();
  if (held?.has(appId)) {
    return await fn();
  }

  const nextHeld = new Set(held ?? []);
  nextHeld.add(appId);
  const run = () => heldAppLocks.run(nextHeld, fn);

  const previous = appLockTails.get(appId) ?? Promise.resolve();
  const result = previous.then(run, run);
  const tail = result.then(
    () => undefined,
    () => undefined
  );
  appLockTails.set(appId, tail);

  try {
    return await result;
  } finally {
    if (appLockTails.get(appId) === tail) {
      appLockTails.delete(appId);
    }
  }
}

async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${crypto.randomBytes(6).toString("hex")}.tmp`
  );
  try {
    await fs.writeFile(tmpPath, contents, "utf-8");
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.remove(tmpPath).catch(() => {});
    throw error;
  }
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * The directory name is the app's identity: every compose/metadata path and the
 * compose project name derive from it. Metadata that disagrees is repaired in
 * memory so two directories can never surface as the same app id.
 */
function withDirectoryIdentity(appId: string, metadata: AppMetadata): AppMetadata {
  if (metadata.id === appId) return metadata;
  console.warn(
    `[deckos] App ${appId} has metadata claiming id "${metadata.id}"; using the directory name as identity`
  );
  return { ...metadata, id: appId };
}

export async function listApps(): Promise<App[]> {
  await ensureDataDir();
  const appDirs = await fs.readdir(APPS_DIR, { withFileTypes: true });
  const apps: App[] = [];

  for (const dir of appDirs) {
    if (!dir.isDirectory()) continue;

    const appId = dir.name;

    let metadataPath: string;
    let composePath: string;
    try {
      metadataPath = getMetadataPath(appId);
      composePath = getComposePath(appId);
    } catch {
      // Not a valid app id, so it cannot be a DeckOS app directory (e.g.
      // `lost+found`, or a folder created through the file browser). Skip it
      // rather than failing the whole listing.
      continue;
    }

    try {
      const metadataExists = await fs.pathExists(metadataPath);
      const composeExists = await fs.pathExists(composePath);

      if (!metadataExists || !composeExists) continue;

      const metadataJson = await fs.readJson(metadataPath);
      const metadata = withDirectoryIdentity(appId, AppMetadataSchema.parse(metadataJson));
      const composeYaml = await fs.readFile(composePath, "utf-8");

      apps.push({
        id: appId,
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
    const metadata = withDirectoryIdentity(id, AppMetadataSchema.parse(metadataJson));
    const composeYaml = await fs.readFile(composePath, "utf-8");

    return {
      id,
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

    await writeJsonAtomic(getMetadataPath(id), metadata);
    await writeFileAtomic(getComposePath(id), composeYaml);
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
  return await withAppLock(id, async () => {
    const existing = await getApp(id);
    if (!existing) return null;

    const updated = {
      ...existing.metadata,
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    const metadata = AppMetadataSchema.parse(updated);
    await writeJsonAtomic(getMetadataPath(id), metadata);

    return {
      id: existing.id,
      metadata,
      composeYaml: existing.composeYaml,
    };
  });
}

export async function updateCompose(id: string, composeYaml: string): Promise<App | null> {
  const parsed = parse(composeYaml);
  ComposeFileSchema.parse(parsed);

  return await withAppLock(id, async () => {
    const existing = await getApp(id);
    if (!existing) return null;

    await writeFileAtomic(getComposePath(id), composeYaml);

    return {
      id: existing.id,
      metadata: existing.metadata,
      composeYaml,
    };
  });
}

export async function deleteApp(id: string): Promise<boolean> {
  const appDir = getAppDir(id);
  const exists = await fs.pathExists(appDir);

  if (!exists) return false;

  await fs.remove(appDir);
  return true;
}

export type DeleteAppResult = {
  deleted: boolean;
  containersMayRemain: boolean;
  stopError?: string;
};

export class StackStillRunningError extends Error {
  constructor(
    readonly appId: string,
    readonly remainingContainers: number,
    readonly stopError: string
  ) {
    super(
      `Could not stop app ${appId}: ${remainingContainers} container(s) are still present (${stopError})`
    );
    this.name = "StackStillRunningError";
  }
}

/**
 * Stops the stack and only then removes the app directory. Removing the
 * directory while containers survive orphans them permanently: every lifecycle
 * call resolves the app from its metadata first, so DeckOS could never stop them
 * again, and their ports stay bound.
 *
 * If the stop fails we ask Docker whether any container of the project is still
 * present. Confirmed survivors abort the delete unless the caller passes
 * `force`. If Docker cannot answer (daemon unreachable), the delete proceeds -
 * refusing would make an app permanently undeletable whenever Docker is down,
 * which is also the rollback path used after a failed deploy - but the result
 * reports that containers may remain.
 */
export async function deleteAppWithStack(
  id: string,
  options: { force?: boolean } = {}
): Promise<DeleteAppResult> {
  return await withAppLock(id, async () => {
    let stopError: string | undefined;
    let containersMayRemain = false;

    try {
      await dockerService.stopStack(id);
    } catch (error) {
      stopError = error instanceof Error ? error.message : String(error);

      // `null` means Docker could not tell us, which is not the same as "none".
      let remaining: number | null;
      try {
        remaining = (await dockerService.getStackContainers(id)).length;
      } catch {
        remaining = null;
      }

      if (remaining !== null && remaining > 0 && !options.force) {
        throw new StackStillRunningError(id, remaining, stopError);
      }
      containersMayRemain = remaining === null || remaining > 0;
    }

    const deleted = await deleteApp(id);
    return { deleted, containersMayRemain, stopError };
  });
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
    await withAppLock(app.id, () =>
      writeJsonAtomic(getMetadataPath(app.id), app.metadata)
    );
  }

  const remaining = apps.filter((app) => !orderedIds.includes(app.id));
  for (let i = 0; i < remaining.length; i++) {
    const app = remaining[i];
    app.metadata.order = ordered.length + i;
    await withAppLock(app.id, () =>
      writeJsonAtomic(getMetadataPath(app.id), app.metadata)
    );
  }
}
