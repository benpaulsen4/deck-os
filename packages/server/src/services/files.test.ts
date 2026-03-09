import test from "node:test";
import assert from "node:assert/strict";
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
  assert.ok(fileEntry);
  assert.equal(fileEntry.mimeType, "text/plain");
  assert.ok(dirEntry);
  assert.equal(dirEntry.mimeType, null);

  const dirsOnly = await listDirectory(root, {
    showHidden: false,
    directoriesOnly: true,
  });
  assert.ok(dirsOnly.entries.length > 0);
  assert.ok(dirsOnly.entries.every((entry) => entry.type === "directory"));

  await fs.remove(root);
});

test("readText truncates large files safely", async () => {
  const root = await createTempDir("deckos-files-read-");
  const largePath = path.join(root, "large.txt");
  const payload = "x".repeat(2 * 1024 * 1024 + 128);
  await fs.writeFile(largePath, payload, "utf8");

  const result = await readText(largePath, false);
  assert.equal(result.truncated, true);
  assert.equal(result.content.length, 2 * 1024 * 1024);

  await fs.remove(root);
});

test("resolveExistingFilePath and resolveExistingDirectoryPath enforce expected target types", async () => {
  const root = await createTempDir("deckos-files-resolve-");
  const nestedDir = path.join(root, "nested");
  const textPath = path.join(root, "notes.txt");
  await fs.ensureDir(nestedDir);
  await fs.writeFile(textPath, "ok", "utf8");

  assert.equal(await resolveExistingFilePath(textPath), textPath);
  assert.equal(await resolveExistingDirectoryPath(nestedDir), nestedDir);
  await assert.rejects(resolveExistingFilePath(nestedDir), FilesNotFileError);
  await assert.rejects(resolveExistingDirectoryPath(textPath), FilesNotDirectoryError);

  await fs.remove(root);
});

test("denylist protection blocks protected system paths", async () => {
  if (process.platform === "win32") {
    const systemDrive = process.env.SystemDrive || "C:";
    await assert.rejects(
      resolveExistingPath(path.join(systemDrive, "Windows")),
      FilesAccessDeniedError
    );
    return;
  }
  await assert.rejects(resolveExistingPath("/proc"), FilesAccessDeniedError);
});
