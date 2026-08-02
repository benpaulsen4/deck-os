import fs from "fs-extra";
import * as path from "node:path";
import { open as openFile, opendir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "../lib/config.js";

type FileEntryType = "directory" | "file" | "symlink" | "other";

export interface FileEntry {
  name: string;
  path: string;
  type: FileEntryType;
  size: number | null;
  modifiedAt: string | null;
  createdAt: string | null;
  mimeType: string | null;
  /**
   * True when the entry itself is a symlink. `type` continues to describe what the
   * link resolves to so the UI can still navigate into a symlinked directory.
   */
  isSymlink: boolean;
  /** Resolved destination of a symlink, or null for ordinary entries. */
  linkTarget: string | null;
}

export interface FilesListResult {
  cwd: string;
  parent: string | null;
  entries: FileEntry[];
  /** True when the directory held more entries than the server is willing to return. */
  truncated: boolean;
}

export interface FilesListOptions {
  showHidden: boolean;
  directoriesOnly?: boolean;
  /** Lower the returned-entry cap below MAX_LIST_ENTRIES; it can never raise it. */
  maxEntries?: number;
}

export interface FileMeta {
  path: string;
  name: string;
  size: number;
  modifiedAt: string | null;
  createdAt: string | null;
  mimeType: string;
  isTextLike: boolean;
}

export interface ReadTextResult {
  content: string;
  encoding: "utf-8";
  truncated: boolean;
  readOnlySuggested: boolean;
}

export class FilesAccessDeniedError extends Error {
  constructor(targetPath: string) {
    super(`Access denied for protected path: ${targetPath}`);
    this.name = "FilesAccessDeniedError";
  }
}

export class FilesNotFoundError extends Error {
  constructor(targetPath: string) {
    super(`Path not found: ${targetPath}`);
    this.name = "FilesNotFoundError";
  }
}

export class FilesNotDirectoryError extends Error {
  constructor(targetPath: string) {
    super(`Path is not a directory: ${targetPath}`);
    this.name = "FilesNotDirectoryError";
  }
}

export class FilesNotFileError extends Error {
  constructor(targetPath: string, message?: string) {
    super(message ?? `Path is not a file: ${targetPath}`);
    this.name = "FilesNotFileError";
  }
}

/**
 * Raised when a text file is too large for the editor to load in full. Extending
 * FilesNotFileError keeps the existing error mapping intact (400 / BAD_REQUEST with
 * this message) while giving callers a distinct type to branch on.
 */
export class FilesTextTooLargeError extends FilesNotFileError {
  readonly size: number;
  readonly maxSize: number;

  constructor(targetPath: string, size: number, maxSize: number) {
    super(
      targetPath,
      `File is too large to edit safely: ${targetPath} is ${size} bytes and the editor limit is ${maxSize} bytes`
    );
    this.name = "FilesTextTooLargeError";
    this.size = size;
    this.maxSize = maxSize;
  }
}

export class FilesAlreadyExistsError extends Error {
  constructor(targetPath: string) {
    super(`Path already exists: ${targetPath}`);
    this.name = "FilesAlreadyExistsError";
  }
}

const FILES_DATA_DIR = path.join(DATA_DIR, "files");
const PINS_PATH = path.join(FILES_DATA_DIR, "pins.json");
const SECURITY_DATA_DIR = path.join(DATA_DIR, "security");
const LARGE_TEXT_READONLY_BYTES = 512 * 1024;
const LIST_DIRECTORY_CONCURRENCY = 24;

/** Largest text payload readText will return, and the largest file writeText will replace. */
export const MAX_TEXT_READ_BYTES = 2 * 1024 * 1024;
/** Largest number of entries a single listDirectory response will contain. */
export const MAX_LIST_ENTRIES = 10_000;
/** Largest number of directory entries examined before a listing is reported truncated. */
export const MAX_LIST_SCAN_ENTRIES = 100_000;

function normalizeComparePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isSameOrChildPath(target: string, base: string): boolean {
  const normalizedTarget = normalizeComparePath(target);
  const normalizedBase = normalizeComparePath(base);
  return (
    normalizedTarget === normalizedBase ||
    normalizedTarget.startsWith(`${normalizedBase}${path.sep}`)
  );
}

/**
 * Paths the file browser refuses to touch.
 *
 * This is a guard-rail, not a security boundary. It is a prefix comparison over a
 * path string, so:
 *   - it cannot see through bind mounts. `realpath` does not unwind them, so a
 *     container that bind-mounts the host's `/proc` at `/host/proc` produces a
 *     resolved path matching none of these prefixes (FILE-12).
 *   - callers re-open the resolved path afterwards (streams, stat, rename), so a
 *     path that passes this check can in principle be swapped underneath us before
 *     it is used. Both cases need a local foothold on the host, which already
 *     implies more privilege than the panel grants.
 *
 * It deliberately does not try to enumerate every sensitive directory on the host:
 * DeckOS runs as a root-equivalent service user by design and browsing `/etc` is a
 * feature, not a bug. `DATA_DIR/security` is the exception — the panel must not be
 * able to read or rewrite its own credential store through the file browser.
 */
function getProtectedPathDenylist(): string[] {
  if (process.platform === "win32") {
    const systemDrive = process.env.SystemDrive || "C:";
    return [
      path.join(systemDrive, "Windows"),
      path.join(systemDrive, "Program Files"),
      path.join(systemDrive, "Program Files (x86)"),
      path.join(systemDrive, "ProgramData"),
      SECURITY_DATA_DIR,
    ];
  }
  return ["/proc", "/sys", "/dev", "/run", "/var/run", SECURITY_DATA_DIR];
}

export function isDeniedPath(targetPath: string): boolean {
  return getProtectedPathDenylist().some((deniedPath) =>
    isSameOrChildPath(targetPath, deniedPath)
  );
}

/**
 * Throws FilesAccessDeniedError when `targetPath` is inside a protected location.
 * Exported so other services (for example disk analysis) apply the same denylist
 * instead of maintaining a second copy of it.
 */
export function assertNotDeniedPath(targetPath: string): void {
  if (isDeniedPath(targetPath)) {
    throw new FilesAccessDeniedError(targetPath);
  }
}

function ensureAbsolutePath(inputPath: string): string {
  if (!path.isAbsolute(inputPath)) {
    throw new FilesNotFoundError(inputPath);
  }
  return path.resolve(inputPath);
}

function ensureNotRootPath(targetPath: string): void {
  const parsed = path.parse(targetPath);
  if (normalizeComparePath(parsed.root) === normalizeComparePath(targetPath)) {
    throw new FilesAccessDeniedError(targetPath);
  }
}

function getRootPath(): string {
  if (process.platform === "win32") {
    const parsed = path.parse(process.cwd());
    return parsed.root || "C:\\";
  }
  return "/";
}

function getParentPath(targetPath: string): string | null {
  const parent = path.dirname(targetPath);
  if (normalizeComparePath(parent) === normalizeComparePath(targetPath)) {
    return null;
  }
  return parent;
}

function toIsoTime(timestampMs: number): string | null {
  if (!Number.isFinite(timestampMs)) {
    return null;
  }
  return new Date(timestampMs).toISOString();
}

function getMimeTypeFromPath(targetPath: string): string {
  const extension = path.extname(targetPath).toLowerCase();
  if (extension === ".txt" || extension === ".log" || extension === ".md")
    return "text/plain";
  if (extension === ".json") return "application/json";
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs")
    return "text/javascript";
  if (extension === ".ts" || extension === ".tsx") return "text/typescript";
  if (extension === ".jsx") return "text/jsx";
  if (extension === ".sh" || extension === ".bash" || extension === ".zsh")
    return "text/x-shellscript";
  if (
    extension === ".ps1" ||
    extension === ".psm1" ||
    extension === ".psd1" ||
    extension === ".ps1xml"
  )
    return "text/x-powershell";
  if (extension === ".bat" || extension === ".cmd") return "text/plain";
  if (extension === ".css") return "text/css";
  if (extension === ".html" || extension === ".htm") return "text/html";
  if (extension === ".xml") return "application/xml";
  if (extension === ".yaml" || extension === ".yml") return "application/yaml";
  if (extension === ".csv") return "text/csv";
  if (extension === ".zip") return "application/zip";
  if (extension === ".7z") return "application/x-7z-compressed";
  if (extension === ".rar") return "application/vnd.rar";
  if (extension === ".tar") return "application/x-tar";
  if (extension === ".gz") return "application/gzip";
  if (extension === ".bz2") return "application/x-bzip2";
  if (extension === ".xz") return "application/x-xz";
  if (extension === ".doc") return "application/msword";
  if (extension === ".docx")
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (extension === ".xls") return "application/vnd.ms-excel";
  if (extension === ".xlsx")
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (extension === ".ppt") return "application/vnd.ms-powerpoint";
  if (extension === ".pptx")
    return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (extension === ".pdf") return "application/pdf";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".gif") return "image/gif";
  if (extension === ".webp") return "image/webp";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".mp4") return "video/mp4";
  if (extension === ".webm") return "video/webm";
  if (extension === ".ogg") return "video/ogg";
  if (extension === ".mp3") return "audio/mpeg";
  if (extension === ".wav") return "audio/wav";
  if (extension === ".m4a") return "audio/mp4";
  if (extension === ".flac") return "audio/flac";
  return "application/octet-stream";
}

function isTextLikeMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml" ||
    mimeType === "application/yaml" ||
    mimeType === "text/typescript" ||
    mimeType === "text/javascript" ||
    mimeType === "text/jsx"
  );
}

function getDefaultPins(): string[] {
  const rootPath = getRootPath();
  const defaults = [rootPath, DATA_DIR];
  return [...new Set(defaults)];
}

async function loadPinsRaw(): Promise<string[]> {
  const exists = await fs.pathExists(PINS_PATH);
  if (!exists) {
    return getDefaultPins();
  }
  const raw = await fs.readJson(PINS_PATH);
  if (!Array.isArray(raw)) {
    return getDefaultPins();
  }
  const items = raw.filter((value): value is string => typeof value === "string");
  return items.length > 0 ? items : getDefaultPins();
}

async function mapWithConcurrencyLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const workers = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let index = 0;
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (true) {
        const currentIndex = index;
        index += 1;
        if (currentIndex >= items.length) {
          return;
        }
        results[currentIndex] = await mapper(items[currentIndex]);
      }
    })
  );
  return results;
}

async function toDirectoryEntry(
  basePath: string,
  dirent: fs.Dirent
): Promise<FileEntry | null> {
  const entryPath = path.join(basePath, dirent.name);
  try {
    const entryLstat = await fs.lstat(entryPath);
    const isSymlink = entryLstat.isSymbolicLink();
    let targetStat = entryLstat;
    let linkTarget: string | null = null;

    if (isSymlink) {
      const symlinkTarget = await fs.realpath(entryPath).catch(() => null);
      if (symlinkTarget) {
        assertNotDeniedPath(symlinkTarget);
        linkTarget = symlinkTarget;
        targetStat = await fs.stat(entryPath).catch(() => entryLstat);
      }
    } else {
      assertNotDeniedPath(entryPath);
    }

    // `type` describes what the entry resolves to, so a symlinked directory stays
    // navigable; `isSymlink` / `linkTarget` let the UI badge it as a link (FILE-3).
    const entryType: FileEntryType = targetStat.isDirectory()
      ? "directory"
      : targetStat.isFile()
        ? "file"
        : isSymlink
          ? "symlink"
          : "other";

    return {
      name: dirent.name,
      path: entryPath,
      type: entryType,
      size: targetStat.isFile() ? targetStat.size : null,
      modifiedAt: toIsoTime(targetStat.mtimeMs),
      createdAt: toIsoTime(targetStat.birthtimeMs),
      mimeType: targetStat.isFile() ? getMimeTypeFromPath(entryPath) : null,
      isSymlink,
      linkTarget,
    };
  } catch {
    return null;
  }
}

/**
 * Streams a directory instead of materializing every entry, and stops at
 * MAX_LIST_ENTRIES kept entries / MAX_LIST_SCAN_ENTRIES examined entries so a
 * directory with millions of children cannot exhaust the process (FILE-11).
 */
async function collectDirents(
  realPath: string,
  showHidden: boolean,
  maxEntries: number
): Promise<{ dirents: fs.Dirent[]; truncated: boolean }> {
  const dirents: fs.Dirent[] = [];
  let scanned = 0;
  let truncated = false;
  const directoryHandle = await opendir(realPath);
  try {
    for await (const dirent of directoryHandle) {
      scanned += 1;
      if (scanned > MAX_LIST_SCAN_ENTRIES) {
        truncated = true;
        break;
      }
      if (!showHidden && dirent.name.startsWith(".")) {
        continue;
      }
      if (dirents.length >= maxEntries) {
        truncated = true;
        break;
      }
      dirents.push(dirent);
    }
  } finally {
    // Breaking out of the async iterator already closes the handle.
    await directoryHandle.close().catch(() => undefined);
  }
  return { dirents, truncated };
}

export async function listDirectory(
  inputPath: string,
  options: FilesListOptions
): Promise<FilesListResult> {
  const { showHidden, directoriesOnly = false } = options;
  const maxEntries = Math.max(
    1,
    Math.min(options.maxEntries ?? MAX_LIST_ENTRIES, MAX_LIST_ENTRIES)
  );
  const basePath = inputPath.trim().length > 0 ? inputPath : getRootPath();
  const requestedPath = ensureAbsolutePath(basePath);
  assertNotDeniedPath(requestedPath);

  const exists = await fs.pathExists(requestedPath);
  if (!exists) {
    throw new FilesNotFoundError(requestedPath);
  }

  const realPath = await fs.realpath(requestedPath).catch(() => requestedPath);
  assertNotDeniedPath(realPath);

  const dirStat = await fs.stat(realPath);
  if (!dirStat.isDirectory()) {
    throw new FilesNotDirectoryError(realPath);
  }

  const { dirents: visibleEntries, truncated } = await collectDirents(
    realPath,
    showHidden,
    maxEntries
  );
  const resolvedEntries = await mapWithConcurrencyLimit(
    visibleEntries,
    LIST_DIRECTORY_CONCURRENCY,
    async (dirent) => await toDirectoryEntry(realPath, dirent)
  );
  const entries = resolvedEntries.filter((entry): entry is FileEntry => !!entry);
  const scopedEntries = directoriesOnly
    ? entries.filter((entry) => entry.type === "directory")
    : entries;

  scopedEntries.sort((a, b) => {
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (a.type !== "directory" && b.type === "directory") return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  return {
    cwd: realPath,
    parent: getParentPath(realPath),
    entries: scopedEntries,
    truncated,
  };
}

export async function resolveExistingPath(inputPath: string): Promise<string> {
  const requestedPath = ensureAbsolutePath(inputPath);
  assertNotDeniedPath(requestedPath);

  const exists = await fs.pathExists(requestedPath);
  if (!exists) {
    throw new FilesNotFoundError(requestedPath);
  }

  const realPath = await fs.realpath(requestedPath).catch(() => requestedPath);
  assertNotDeniedPath(realPath);
  return realPath;
}

export async function resolveExistingFilePath(inputPath: string): Promise<string> {
  const realPath = await resolveExistingPath(inputPath);
  const targetStat = await fs.stat(realPath);
  if (!targetStat.isFile()) {
    throw new FilesNotFileError(realPath);
  }
  return realPath;
}

export async function resolveExistingDirectoryPath(inputPath: string): Promise<string> {
  const realPath = await resolveExistingPath(inputPath);
  const targetStat = await fs.stat(realPath);
  if (!targetStat.isDirectory()) {
    throw new FilesNotDirectoryError(realPath);
  }
  return realPath;
}

export interface ResolvedMutationPath {
  /** Absolute input path with the final component's symlink left intact. */
  path: string;
  /** Fully resolved path, used for denylist and containment checks only. */
  realPath: string;
  /** True when the final path component is itself a symlink. */
  isSymlink: boolean;
}

/**
 * Resolves a path for a destructive operation. Containment and the denylist are
 * checked against the real path, but the returned `path` still points at the literal
 * entry so that deleting/renaming a symlink acts on the link and never on whatever it
 * points at (FILE-3). Unlike resolveExistingPath this uses `lstat`, so a dangling
 * symlink is treated as an existing entry that can be removed.
 */
export async function resolveExistingMutationPath(
  inputPath: string
): Promise<ResolvedMutationPath> {
  const requestedPath = ensureAbsolutePath(inputPath);
  assertNotDeniedPath(requestedPath);

  const linkStat = await fs.lstat(requestedPath).catch(() => null);
  if (!linkStat) {
    throw new FilesNotFoundError(requestedPath);
  }

  const realPath = await fs.realpath(requestedPath).catch(() => requestedPath);
  assertNotDeniedPath(realPath);

  return { path: requestedPath, realPath, isSymlink: linkStat.isSymbolicLink() };
}

export async function resolveTargetPath(inputPath: string): Promise<string> {
  const requestedPath = ensureAbsolutePath(inputPath);
  assertNotDeniedPath(requestedPath);
  const parentPath = path.dirname(requestedPath);
  const parentRealPath = await resolveExistingPath(parentPath);
  // Rebase onto the parent's real path: with /srv/link -> /mnt/data, a target of
  // /srv/link/new is legitimate even though it does not sit under its own realpath,
  // and the joined path is what the operation should actually act on (FILE-13).
  const targetPath = path.join(parentRealPath, path.basename(requestedPath));
  if (!isSameOrChildPath(targetPath, parentRealPath)) {
    throw new FilesAccessDeniedError(requestedPath);
  }
  assertNotDeniedPath(targetPath);
  return targetPath;
}

function isSameEntryPath(left: string, right: string): boolean {
  return normalizeComparePath(left) === normalizeComparePath(right);
}

/**
 * rename(2) replaces an existing destination atomically and silently, so mkdir/copy
 * were the only operations that refused to clobber. Reject up front instead (FILE-4).
 * `lstat` is deliberate: a dangling symlink at the destination would also be replaced.
 */
async function assertTargetDoesNotExist(targetPath: string): Promise<void> {
  const existing = await fs.lstat(targetPath).catch(() => null);
  if (existing) {
    throw new FilesAlreadyExistsError(targetPath);
  }
}

function normalizeFsError(error: unknown, fallbackPath: string): never {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new FilesNotFoundError(fallbackPath);
    }
    if (code === "EEXIST") {
      throw new FilesAlreadyExistsError(fallbackPath);
    }
  }
  throw error;
}

export async function mkdir(targetPathInput: string): Promise<void> {
  const targetPath = await resolveTargetPath(targetPathInput);
  try {
    await fs.mkdir(targetPath, { recursive: false });
  } catch (error) {
    normalizeFsError(error, targetPath);
  }
}

function assertMutableSource(source: ResolvedMutationPath): void {
  ensureNotRootPath(source.path);
  if (!source.isSymlink) {
    // A symlink is only ever detached from its parent, so its target being a root is
    // irrelevant; for everything else the resolved path is what would be moved.
    ensureNotRootPath(source.realPath);
  }
}

export async function rename(
  sourcePathInput: string,
  targetPathInput: string
): Promise<void> {
  const source = await resolveExistingMutationPath(sourcePathInput);
  const targetPath = await resolveTargetPath(targetPathInput);
  assertMutableSource(source);
  if (!isSameEntryPath(source.path, targetPath)) {
    // Skipped when both sides name the same entry so case-only renames still work on
    // case-insensitive filesystems.
    await assertTargetDoesNotExist(targetPath);
  }
  try {
    await fs.rename(source.path, targetPath);
  } catch (error) {
    normalizeFsError(error, targetPath);
  }
}

export async function copy(
  sourcePathInput: string,
  targetPathInput: string
): Promise<void> {
  const source = await resolveExistingMutationPath(sourcePathInput);
  const targetPath = await resolveTargetPath(targetPathInput);
  // fs-extra's symlink branch honours neither `overwrite` nor `errorOnExist`, so the
  // destination has to be checked here before the copy starts.
  await assertTargetDoesNotExist(targetPath);
  try {
    await fs.copy(source.path, targetPath, {
      overwrite: false,
      errorOnExist: true,
      // Copy a link as a link rather than duplicating everything it points at.
      dereference: false,
    });
  } catch (error) {
    normalizeFsError(error, targetPath);
  }
}

export async function move(
  sourcePathInput: string,
  targetPathInput: string
): Promise<void> {
  const source = await resolveExistingMutationPath(sourcePathInput);
  const targetPath = await resolveTargetPath(targetPathInput);
  assertMutableSource(source);
  if (!isSameEntryPath(source.path, targetPath)) {
    await assertTargetDoesNotExist(targetPath);
  }
  try {
    await fs.rename(source.path, targetPath);
    return;
  } catch (error) {
    const code =
      error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code !== "EXDEV") {
      normalizeFsError(error, targetPath);
    }
  }
  // Cross-filesystem fallback: copy-then-delete, still treating a link as a link.
  try {
    await fs.copy(source.path, targetPath, {
      overwrite: false,
      errorOnExist: true,
      dereference: false,
    });
  } catch (error) {
    normalizeFsError(error, targetPath);
  }
  await removeResolved(source);
}

async function removeResolved(target: ResolvedMutationPath): Promise<void> {
  if (target.isSymlink) {
    // Detach the link only. Recursing into it would destroy the real directory it
    // points at, which is what the UI showed as an ordinary folder (FILE-3).
    await fs.unlink(target.path);
    return;
  }
  await fs.remove(target.path);
}

export async function remove(targetPathInput: string): Promise<void> {
  const target = await resolveExistingMutationPath(targetPathInput);
  assertMutableSource(target);
  await removeResolved(target);
}

export async function getMeta(inputPath: string): Promise<FileMeta> {
  const targetPath = await resolveExistingFilePath(inputPath);
  const targetStat = await fs.stat(targetPath);
  const mimeType = getMimeTypeFromPath(targetPath);
  return {
    path: targetPath,
    name: path.basename(targetPath),
    size: targetStat.size,
    modifiedAt: toIsoTime(targetStat.mtimeMs),
    createdAt: toIsoTime(targetStat.birthtimeMs),
    mimeType,
    isTextLike: isTextLikeMimeType(mimeType),
  };
}

export async function readText(
  inputPath: string,
  forceEditable: boolean
): Promise<ReadTextResult> {
  const fileMeta = await getMeta(inputPath);
  if (!fileMeta.isTextLike) {
    throw new FilesNotFileError(fileMeta.path);
  }
  const fileHandle = await openFile(fileMeta.path, "r");
  // One byte past the cap is enough to detect truncation; never allocate more than the
  // file actually holds.
  const readLength = Math.min(fileMeta.size, MAX_TEXT_READ_BYTES + 1);
  const buffer = Buffer.alloc(readLength);
  const bytesRead = await (async () => {
    try {
      const result = await fileHandle.read(buffer, 0, readLength, 0);
      return result.bytesRead;
    } finally {
      await fileHandle.close();
    }
  })();
  const truncated = bytesRead > MAX_TEXT_READ_BYTES;
  const contentBuffer = truncated
    ? buffer.subarray(0, MAX_TEXT_READ_BYTES)
    : buffer.subarray(0, bytesRead);
  const readOnlySuggested = !forceEditable && fileMeta.size > LARGE_TEXT_READONLY_BYTES;
  return {
    content: contentBuffer.toString("utf8"),
    encoding: "utf-8",
    truncated,
    readOnlySuggested,
  };
}

export async function writeText(inputPath: string, content: string): Promise<void> {
  const fileMeta = await getMeta(inputPath);
  if (!fileMeta.isTextLike) {
    throw new FilesNotFileError(fileMeta.path);
  }
  // readText only ever returned the first MAX_TEXT_READ_BYTES of a larger file, so a
  // save from the editor would write that prefix over the whole file. Refuse instead of
  // truncating; the caller cannot have the rest of the content to send back (FILE-6).
  if (fileMeta.size > MAX_TEXT_READ_BYTES) {
    throw new FilesTextTooLargeError(fileMeta.path, fileMeta.size, MAX_TEXT_READ_BYTES);
  }

  const targetPath = fileMeta.path;
  const targetStat = await fs.stat(targetPath);
  // Write to a sibling temp file and rename over the target so a failed or partial
  // write cannot leave the original half-rewritten.
  const tempPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.deckos-${randomUUID()}.tmp`
  );
  try {
    await fs.writeFile(tempPath, content, "utf8");
    // Best-effort ownership/permission preservation: the temp file is created with the
    // service user's umask, not the original file's mode.
    await fs.chmod(tempPath, targetStat.mode & 0o777).catch(() => undefined);
    await fs.chown(tempPath, targetStat.uid, targetStat.gid).catch(() => undefined);
    await fs.rename(tempPath, targetPath);
  } catch (error) {
    await fs.remove(tempPath).catch(() => undefined);
    normalizeFsError(error, targetPath);
  }
}

export function getPathMimeType(targetPath: string): string {
  return getMimeTypeFromPath(targetPath);
}

export async function getPins(): Promise<string[]> {
  const rawPins = await loadPinsRaw();
  const normalized: string[] = [];
  for (const pin of rawPins) {
    if (!path.isAbsolute(pin)) {
      continue;
    }
    const resolved = path.resolve(pin);
    try {
      assertNotDeniedPath(resolved);
      normalized.push(resolved);
    } catch {
      continue;
    }
  }
  const unique = [...new Set(normalized)];
  return unique.length > 0 ? unique : getDefaultPins();
}

export async function setPins(items: string[]): Promise<string[]> {
  const normalized: string[] = [];
  for (const item of items) {
    const resolved = ensureAbsolutePath(item);
    assertNotDeniedPath(resolved);
    normalized.push(resolved);
  }
  const unique = [...new Set(normalized)];
  await fs.ensureDir(FILES_DATA_DIR);
  await fs.writeJson(PINS_PATH, unique, { spaces: 2 });
  return unique;
}
