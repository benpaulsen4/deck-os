import * as path from "node:path";

const DEFAULT_DATA_DIR =
  process.platform === "linux" ? "/var/lib/deckos" : path.join(process.cwd(), "data");

export const DATA_DIR = process.env.DECKOS_DATA_DIR || DEFAULT_DATA_DIR;

export const APPS_DIR = path.join(DATA_DIR, "apps");

export const METADATA_FILE = "metadata.json";
export const COMPOSE_FILE = "docker-compose.yml";

const APP_ID_REGEX = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function assertValidAppId(appId: string): string {
  if (!APP_ID_REGEX.test(appId)) {
    throw new Error(`Invalid app id: ${appId}`);
  }
  return appId;
}

export function getAppDir(appId: string): string {
  const safeAppId = assertValidAppId(appId);
  const baseDir = path.resolve(APPS_DIR);
  const resolved = path.resolve(baseDir, safeAppId);
  if (!resolved.startsWith(`${baseDir}${path.sep}`)) {
    throw new Error(`Invalid app id: ${appId}`);
  }
  return resolved;
}

export function getMetadataPath(appId: string): string {
  return path.join(getAppDir(appId), METADATA_FILE);
}

export function getComposePath(appId: string): string {
  return path.join(getAppDir(appId), COMPOSE_FILE);
}

export function getComposeProjectName(appId: string): string {
  const safeAppId = assertValidAppId(appId);
  return `deckos-${safeAppId}`;
}

export const POLL_INTERVAL_MS = 2000;
export const METRICS_HISTORY_SIZE = 60;
export const LOG_HISTORY_SIZE = 5000;

/**
 * Live log streaming bounds. `LOG_HISTORY_SIZE` caps the `tail` *request*
 * parameter only -- once the stream is following, nothing above bounded what a
 * container could make the server hold in memory (DOCK-10).
 *
 * `LOG_LINE_MAX_CHARS` caps the not-yet-terminated line that the demultiplexer
 * accumulates while it waits for a newline. A container emitting one endless
 * line (a progress bar, a stuck process, a binary blob) grows that buffer
 * forever otherwise. At the cap the partial line is emitted as its own SSE
 * message flagged `truncated`, so the bound costs line framing, never bytes.
 *
 * `LOG_WRITE_QUEUE_*` bound the SSE writes waiting on a slow client.
 * `PAUSE_AT`/`RESUME_AT` are the flow-control marks: crossing `PAUSE_AT` pauses
 * the Docker log stream so backpressure reaches the source, and dropping back
 * to `RESUME_AT` resumes it. `MAX_MESSAGES` is the hard cap for the one case
 * pausing cannot prevent -- a single Docker chunk that expands into more
 * messages than the mark allows, since the source can only be paused between
 * chunks. Past it the oldest queued messages are discarded and the client is
 * told how many, so a gap is always reported rather than silently produced.
 */
export const LOG_LINE_MAX_CHARS = 64 * 1024;
export const LOG_WRITE_QUEUE_MAX_MESSAGES = 512;
export const LOG_WRITE_QUEUE_PAUSE_AT = 128;
export const LOG_WRITE_QUEUE_RESUME_AT = 32;
