import fs from "fs-extra";
import * as path from "node:path";
import { open as openFile } from "node:fs/promises";
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
}

export interface FilesListResult {
  cwd: string;
  parent: string | null;
  entries: FileEntry[];
}

export interface FilesListOptions {
  showHidden: boolean;
  directoriesOnly?: boolean;
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
  constructor(targetPath: string) {
    super(`Path is not a file: ${targetPath}`);
    this.name = "FilesNotFileError";
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
const LARGE_TEXT_READONLY_BYTES = 512 * 1024;
const MAX_TEXT_READ_BYTES = 2 * 1024 * 1024;
const LIST_DIRECTORY_CONCURRENCY = 24;

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

function getProtectedPathDenylist(): string[] {
  if (process.platform === "win32") {
    const systemDrive = process.env.SystemDrive || "C:";
    return [
      path.join(systemDrive, "Windows"),
      path.join(systemDrive, "Program Files"),
      path.join(systemDrive, "Program Files (x86)"),
      path.join(systemDrive, "ProgramData"),
    ];
  }
  return ["/proc", "/sys", "/dev", "/run", "/var/run"];
}

function assertNotDeniedPath(targetPath: string): void {
  for (const deniedPath of getProtectedPathDenylist()) {
    if (isSameOrChildPath(targetPath, deniedPath)) {
      throw new FilesAccessDeniedError(targetPath);
    }
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

    if (isSymlink) {
      const symlinkTarget = await fs.realpath(entryPath).catch(() => null);
      if (symlinkTarget) {
        assertNotDeniedPath(symlinkTarget);
        targetStat = await fs.stat(entryPath).catch(() => entryLstat);
      }
    } else {
      assertNotDeniedPath(entryPath);
    }

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
    };
  } catch {
    return null;
  }
}

export async function listDirectory(
  inputPath: string,
  options: FilesListOptions
): Promise<FilesListResult> {
  const { showHidden, directoriesOnly = false } = options;
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

  const directoryEntries = await fs.readdir(realPath, { withFileTypes: true });
  const visibleEntries = directoryEntries.filter(
    (dirent) => showHidden || !dirent.name.startsWith(".")
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

export async function resolveTargetPath(inputPath: string): Promise<string> {
  const targetPath = ensureAbsolutePath(inputPath);
  assertNotDeniedPath(targetPath);
  const parentPath = path.dirname(targetPath);
  const parentRealPath = await resolveExistingPath(parentPath);
  if (!isSameOrChildPath(targetPath, parentRealPath)) {
    throw new FilesAccessDeniedError(targetPath);
  }
  return targetPath;
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

export async function rename(
  sourcePathInput: string,
  targetPathInput: string
): Promise<void> {
  const sourcePath = await resolveExistingPath(sourcePathInput);
  const targetPath = await resolveTargetPath(targetPathInput);
  ensureNotRootPath(sourcePath);
  try {
    await fs.rename(sourcePath, targetPath);
  } catch (error) {
    normalizeFsError(error, targetPath);
  }
}

export async function copy(
  sourcePathInput: string,
  targetPathInput: string
): Promise<void> {
  const sourcePath = await resolveExistingPath(sourcePathInput);
  const targetPath = await resolveTargetPath(targetPathInput);
  try {
    await fs.copy(sourcePath, targetPath, { overwrite: false, errorOnExist: true });
  } catch (error) {
    normalizeFsError(error, targetPath);
  }
}

export async function move(
  sourcePathInput: string,
  targetPathInput: string
): Promise<void> {
  const sourcePath = await resolveExistingPath(sourcePathInput);
  const targetPath = await resolveTargetPath(targetPathInput);
  ensureNotRootPath(sourcePath);
  try {
    await fs.rename(sourcePath, targetPath);
    return;
  } catch (error) {
    const code =
      error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code !== "EXDEV") {
      normalizeFsError(error, targetPath);
    }
  }
  await copy(sourcePath, targetPath);
  await fs.remove(sourcePath);
}

export async function remove(targetPathInput: string): Promise<void> {
  const targetPath = await resolveExistingPath(targetPathInput);
  ensureNotRootPath(targetPath);
  await fs.remove(targetPath);
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
  const buffer = Buffer.alloc(MAX_TEXT_READ_BYTES + 1);
  const bytesRead = await (async () => {
    try {
      const result = await fileHandle.read(buffer, 0, MAX_TEXT_READ_BYTES + 1, 0);
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
  await fs.writeFile(fileMeta.path, content, "utf8");
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
