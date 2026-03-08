import fs from "fs-extra";
import * as path from "node:path";
import { DATA_DIR } from "../lib/config.js";

type FileEntryType = "directory" | "file" | "symlink" | "other";

export interface FileEntry {
  name: string;
  path: string;
  type: FileEntryType;
  size: number | null;
  modifiedAt: string | null;
  createdAt: string | null;
}

export interface FilesListResult {
  cwd: string;
  parent: string | null;
  entries: FileEntry[];
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

export class FilesAlreadyExistsError extends Error {
  constructor(targetPath: string) {
    super(`Path already exists: ${targetPath}`);
    this.name = "FilesAlreadyExistsError";
  }
}

const FILES_DATA_DIR = path.join(DATA_DIR, "files");
const PINS_PATH = path.join(FILES_DATA_DIR, "pins.json");

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

export async function listDirectory(inputPath: string, showHidden: boolean): Promise<FilesListResult> {
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
  const entries: FileEntry[] = [];

  for (const dirent of directoryEntries) {
    if (!showHidden && dirent.name.startsWith(".")) {
      continue;
    }

    const entryPath = path.join(realPath, dirent.name);
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

      entries.push({
        name: dirent.name,
        path: entryPath,
        type: entryType,
        size: targetStat.isFile() ? targetStat.size : null,
        modifiedAt: toIsoTime(targetStat.mtimeMs),
        createdAt: toIsoTime(targetStat.birthtimeMs),
      });
    } catch {
      continue;
    }
  }

  entries.sort((a, b) => {
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (a.type !== "directory" && b.type === "directory") return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  return {
    cwd: realPath,
    parent: getParentPath(realPath),
    entries,
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

export async function rename(sourcePathInput: string, targetPathInput: string): Promise<void> {
  const sourcePath = await resolveExistingPath(sourcePathInput);
  const targetPath = await resolveTargetPath(targetPathInput);
  ensureNotRootPath(sourcePath);
  try {
    await fs.rename(sourcePath, targetPath);
  } catch (error) {
    normalizeFsError(error, targetPath);
  }
}

export async function copy(sourcePathInput: string, targetPathInput: string): Promise<void> {
  const sourcePath = await resolveExistingPath(sourcePathInput);
  const targetPath = await resolveTargetPath(targetPathInput);
  try {
    await fs.copy(sourcePath, targetPath, { overwrite: false, errorOnExist: true });
  } catch (error) {
    normalizeFsError(error, targetPath);
  }
}

export async function move(sourcePathInput: string, targetPathInput: string): Promise<void> {
  const sourcePath = await resolveExistingPath(sourcePathInput);
  const targetPath = await resolveTargetPath(targetPathInput);
  ensureNotRootPath(sourcePath);
  try {
    await fs.rename(sourcePath, targetPath);
    return;
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
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
