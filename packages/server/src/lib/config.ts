import * as path from "node:path";

const DEFAULT_DATA_DIR =
  process.platform === "linux" ? "/var/lib/deckos" : path.join(process.cwd(), "data");

export const DATA_DIR = process.env.DECKOS_DATA_DIR || DEFAULT_DATA_DIR;

export const APPS_DIR = path.join(DATA_DIR, "apps");

export const METADATA_FILE = "metadata.json";
export const COMPOSE_FILE = "docker-compose.yml";

export function getAppDir(appId: string): string {
  return path.join(APPS_DIR, appId);
}

export function getMetadataPath(appId: string): string {
  return path.join(getAppDir(appId), METADATA_FILE);
}

export function getComposePath(appId: string): string {
  return path.join(getAppDir(appId), COMPOSE_FILE);
}

export function getComposeProjectName(appId: string): string {
  return `deckos-${appId}`;
}

export const POLL_INTERVAL_MS = 2000;
export const METRICS_HISTORY_SIZE = 60;
export const LOG_HISTORY_SIZE = 5000;
