import { test, expect } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import {
  FilesAccessDeniedError,
  FilesNotDirectoryError,
  FilesNotFileError,
  listDirectory,
  readText,
  resolveExistingDirectoryPath,
  resolveExistingFilePath,
  resolveExistingPath,
} from "./files.js";

async function createTempDir(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return root;
}

test("listDirectory returns mime metadata and supports directoriesOnly mode", async () => {
  const root = await createTempDir("deckos-files-list-");
  const nestedDir = path.join(root, "nested");
  const textPath = path.join(root, "notes.txt");
  await fs.ensureDir(nestedDir);
  await fs.writeFile(textPath, "hello world", "utf8");

  const allEntries = await listDirectory(root, {
    showHidden: false,
    directoriesOnly: false,
  });
  const fileEntry = allEntries.entries.find((entry) => entry.path === textPath);
  const dirEntry = allEntries.entries.find((entry) => entry.path === nestedDir);
  expect(fileEntry).toBeDefined();
  expect(fileEntry?.mimeType).toBe("text/plain");
  expect(dirEntry).toBeDefined();
  expect(dirEntry?.mimeType).toBe(null);

  const dirsOnly = await listDirectory(root, {
    showHidden: false,
    directoriesOnly: true,
  });
  expect(dirsOnly.entries.length).toBeGreaterThan(0);
  expect(dirsOnly.entries.every((entry) => entry.type === "directory")).toBe(true);

  await fs.remove(root);
});

test("readText truncates large files safely", async () => {
  const root = await createTempDir("deckos-files-read-");
  const largePath = path.join(root, "large.txt");
  const payload = "x".repeat(2 * 1024 * 1024 + 128);
  await fs.writeFile(largePath, payload, "utf8");

  const result = await readText(largePath, false);
  expect(result.truncated).toBe(true);
  expect(result.content.length).toBe(2 * 1024 * 1024);

  await fs.remove(root);
});

test("resolveExistingFilePath and resolveExistingDirectoryPath enforce expected target types", async () => {
  const root = await createTempDir("deckos-files-resolve-");
  const nestedDir = path.join(root, "nested");
  const textPath = path.join(root, "notes.txt");
  await fs.ensureDir(nestedDir);
  await fs.writeFile(textPath, "ok", "utf8");

  expect(await resolveExistingFilePath(textPath)).toBe(textPath);
  expect(await resolveExistingDirectoryPath(nestedDir)).toBe(nestedDir);
  await expect(resolveExistingFilePath(nestedDir)).rejects.toBeInstanceOf(FilesNotFileError);
  await expect(resolveExistingDirectoryPath(textPath)).rejects.toBeInstanceOf(
    FilesNotDirectoryError
  );

  await fs.remove(root);
});

test("denylist protection blocks protected system paths", async () => {
  if (process.platform === "win32") {
    const systemDrive = process.env.SystemDrive || "C:";
    await expect(
      resolveExistingPath(path.join(systemDrive, "Windows")),
    ).rejects.toBeInstanceOf(FilesAccessDeniedError);
    return;
  }
  await expect(resolveExistingPath("/proc")).rejects.toBeInstanceOf(FilesAccessDeniedError);
});
