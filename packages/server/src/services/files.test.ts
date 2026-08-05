import { test, expect, vi } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "../lib/config.js";
import {
  FilesAccessDeniedError,
  FilesAlreadyExistsError,
  FilesNotDirectoryError,
  FilesNotFileError,
  FilesNotFoundError,
  FilesTextTooLargeError,
  MAX_TEXT_READ_BYTES,
  assertNotDeniedPath,
  copy,
  isDeniedPath,
  listDirectory,
  mkdir,
  move,
  readText,
  remove,
  rename,
  resolveExistingDirectoryPath,
  resolveExistingFilePath,
  resolveExistingPath,
  resolveTargetPath,
  writeText,
} from "./files.js";

async function createTempDir(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return root;
}

/** A denied path that exists on the current platform, for symlink-escape tests. */
const DENIED_SYSTEM_DIR =
  process.platform === "win32"
    ? path.join(process.env.SystemDrive || "C:", "Windows")
    : "/proc";

/**
 * Creating symlinks needs elevation or developer mode on Windows, so tests that need
 * one probe first and skip rather than fail on a machine that cannot make them.
 */
async function canCreateSymlink(root: string): Promise<boolean> {
  const probeTarget = path.join(root, "symlink-probe-target");
  const probeLink = path.join(root, "symlink-probe-link");
  await fs.ensureDir(probeTarget);
  try {
    await fs.symlink(probeTarget, probeLink, "dir");
    await fs.unlink(probeLink);
    return true;
  } catch {
    return false;
  } finally {
    await fs.remove(probeTarget).catch(() => undefined);
  }
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

test("the denylist covers the auth store and matches on path segments, not string prefixes", () => {
  // FILE-5: the passcode store must not be readable or writable through the browser.
  expect(() => assertNotDeniedPath(path.join(DATA_DIR, "security"))).toThrow(
    FilesAccessDeniedError
  );
  expect(() => assertNotDeniedPath(path.join(DATA_DIR, "security", "passcode.json"))).toThrow(
    FilesAccessDeniedError
  );
  // The rest of DATA_DIR stays browsable; it is a pinned location in the UI.
  expect(() => assertNotDeniedPath(path.join(DATA_DIR, "apps"))).not.toThrow();

  // FILE-8: a sibling that merely shares a string prefix is not denied ("/data" must
  // not match "/database").
  expect(() => assertNotDeniedPath(`${path.join(DATA_DIR, "security")}-backup`)).not.toThrow();
  if (process.platform === "win32") {
    const systemDrive = process.env.SystemDrive || "C:";
    expect(() => assertNotDeniedPath(path.join(systemDrive, "Windows", "System32"))).toThrow(
      FilesAccessDeniedError
    );
    expect(() => assertNotDeniedPath(path.join(systemDrive, "WindowsApps"))).not.toThrow();
    return;
  }
  expect(() => assertNotDeniedPath("/run/lock")).toThrow(FilesAccessDeniedError);
  expect(() => assertNotDeniedPath("/runner")).not.toThrow();
  expect(() => assertNotDeniedPath("/sysfoo")).not.toThrow();
});

test("isDeniedPath is the predicate form of the same denylist", () => {
  // Exported for batch B (disk analysis), which wants to skip a subtree rather than
  // abort a scan, so it is worth pinning independently of assertNotDeniedPath.
  expect(isDeniedPath(path.join(DATA_DIR, "security", "passcode.json"))).toBe(true);
  expect(isDeniedPath(path.join(DATA_DIR, "apps"))).toBe(false);
  expect(isDeniedPath(DENIED_SYSTEM_DIR)).toBe(true);
  expect(isDeniedPath(path.join(DENIED_SYSTEM_DIR, "nested", "deeper"))).toBe(true);
  expect(isDeniedPath(`${DENIED_SYSTEM_DIR}-sibling`)).toBe(false);
});

test("traversal segments cannot walk back into a denied path", async () => {
  const root = await createTempDir("deckos-files-traversal-");
  const nested = path.join(root, "nested");
  await fs.ensureDir(nested);

  // ".." is normalized before the denylist runs, so it cannot be used to smuggle a
  // denied path past the check.
  const traversedIntoDenied = path.join(DENIED_SYSTEM_DIR, "..", path.basename(DENIED_SYSTEM_DIR));
  await expect(resolveExistingPath(traversedIntoDenied)).rejects.toBeInstanceOf(
    FilesAccessDeniedError
  );
  await expect(
    resolveTargetPath(path.join(DENIED_SYSTEM_DIR, "..", path.basename(DENIED_SYSTEM_DIR), "x"))
  ).rejects.toBeInstanceOf(FilesAccessDeniedError);

  // Traversal inside allowed territory is normalized rather than reflected back.
  const resolved = await resolveExistingPath(path.join(nested, "..", "nested"));
  expect(resolved).toBe(await fs.realpath(nested));
  const listed = await listDirectory(path.join(nested, "..", "nested"), { showHidden: false });
  expect(listed.cwd).toBe(await fs.realpath(nested));

  await fs.remove(root);
});

test("relative paths are rejected everywhere a path is accepted", async () => {
  await expect(resolveExistingPath("relative/path")).rejects.toBeInstanceOf(FilesNotFoundError);
  await expect(resolveTargetPath("relative/path")).rejects.toBeInstanceOf(FilesNotFoundError);
  await expect(listDirectory("./relative", { showHidden: false })).rejects.toBeInstanceOf(
    FilesNotFoundError
  );
  await expect(remove("relative/path")).rejects.toBeInstanceOf(FilesNotFoundError);
});

test("a symlink into a denied path is refused and hidden from listings", async (ctx) => {
  const root = await createTempDir("deckos-files-symlink-denied-");
  if (!(await canCreateSymlink(root))) {
    await fs.remove(root);
    ctx.skip();
    return;
  }
  const escapeLink = path.join(root, "escape");
  await fs.symlink(DENIED_SYSTEM_DIR, escapeLink, "dir");

  await expect(resolveExistingPath(escapeLink)).rejects.toBeInstanceOf(FilesAccessDeniedError);
  await expect(remove(escapeLink)).rejects.toBeInstanceOf(FilesAccessDeniedError);

  const listed = await listDirectory(root, { showHidden: false });
  expect(listed.entries.find((entry) => entry.name === "escape")).toBeUndefined();

  await fs.remove(root);
});

test("listings mark symlinks without hiding what they resolve to", async (ctx) => {
  const root = await createTempDir("deckos-files-symlink-list-");
  if (!(await canCreateSymlink(root))) {
    await fs.remove(root);
    ctx.skip();
    return;
  }
  const targetDir = path.join(root, "target");
  await fs.ensureDir(targetDir);
  const linkPath = path.join(root, "link");
  await fs.symlink(targetDir, linkPath, "dir");

  const listed = await listDirectory(root, { showHidden: false });
  const linkEntry = listed.entries.find((entry) => entry.name === "link");
  const plainEntry = listed.entries.find((entry) => entry.name === "target");

  // FILE-3: `type` stays "directory" so the client can still navigate into it, but the
  // entry is now identifiable as a link.
  expect(linkEntry?.type).toBe("directory");
  expect(linkEntry?.isSymlink).toBe(true);
  expect(linkEntry?.linkTarget).toBe(await fs.realpath(targetDir));
  expect(plainEntry?.isSymlink).toBe(false);
  expect(plainEntry?.linkTarget).toBe(null);

  await fs.remove(root);
});

test("deleting a symlink detaches the link and leaves its target alone", async (ctx) => {
  const root = await createTempDir("deckos-files-symlink-remove-");
  if (!(await canCreateSymlink(root))) {
    await fs.remove(root);
    ctx.skip();
    return;
  }
  const libraryDir = path.join(root, "library");
  const keptFile = path.join(libraryDir, "keep.txt");
  await fs.ensureDir(libraryDir);
  await fs.writeFile(keptFile, "irreplaceable", "utf8");
  const dirLink = path.join(root, "media");
  await fs.symlink(libraryDir, dirLink, "dir");

  const plainFile = path.join(root, "notes.txt");
  await fs.writeFile(plainFile, "notes", "utf8");
  const fileLink = path.join(root, "notes-link.txt");
  await fs.symlink(plainFile, fileLink, "file");

  // FILE-3: the pre-fix code resolved the link first and recursively removed the real
  // directory behind it.
  await remove(dirLink);
  expect(await fs.pathExists(dirLink)).toBe(false);
  expect(await fs.readFile(keptFile, "utf8")).toBe("irreplaceable");

  await remove(fileLink);
  expect(await fs.pathExists(fileLink)).toBe(false);
  expect(await fs.readFile(plainFile, "utf8")).toBe("notes");

  // The ordinary path still deletes recursively.
  await remove(libraryDir);
  expect(await fs.pathExists(libraryDir)).toBe(false);

  await fs.remove(root);
});

test("renaming and moving a symlink moves the link, not its target", async (ctx) => {
  const root = await createTempDir("deckos-files-symlink-rename-");
  if (!(await canCreateSymlink(root))) {
    await fs.remove(root);
    ctx.skip();
    return;
  }
  const libraryDir = path.join(root, "library");
  await fs.ensureDir(libraryDir);
  await fs.writeFile(path.join(libraryDir, "keep.txt"), "keep", "utf8");
  const linkPath = path.join(root, "media");
  await fs.symlink(libraryDir, linkPath, "dir");

  const renamedLink = path.join(root, "media-renamed");
  await rename(linkPath, renamedLink);
  expect((await fs.lstat(renamedLink)).isSymbolicLink()).toBe(true);
  expect(await fs.realpath(renamedLink)).toBe(await fs.realpath(libraryDir));
  expect(await fs.pathExists(path.join(libraryDir, "keep.txt"))).toBe(true);

  const movedLink = path.join(root, "media-moved");
  await move(renamedLink, movedLink);
  expect((await fs.lstat(movedLink)).isSymbolicLink()).toBe(true);
  expect(await fs.pathExists(path.join(libraryDir, "keep.txt"))).toBe(true);

  await fs.remove(root);
});

test("copying a symlink copies the link rather than everything behind it", async (ctx) => {
  const root = await createTempDir("deckos-files-symlink-copy-");
  if (!(await canCreateSymlink(root))) {
    await fs.remove(root);
    ctx.skip();
    return;
  }
  const libraryDir = path.join(root, "library");
  await fs.ensureDir(libraryDir);
  await fs.writeFile(path.join(libraryDir, "keep.txt"), "keep", "utf8");
  const linkPath = path.join(root, "media");
  await fs.symlink(libraryDir, linkPath, "dir");

  const copiedLink = path.join(root, "media-copy");
  await copy(linkPath, copiedLink);
  expect((await fs.lstat(copiedLink)).isSymbolicLink()).toBe(true);
  expect(await fs.realpath(copiedLink)).toBe(await fs.realpath(libraryDir));

  await fs.remove(root);
});

test("rename, move and copy refuse to overwrite an existing destination", async () => {
  const root = await createTempDir("deckos-files-overwrite-");
  const sourcePath = path.join(root, "source.txt");
  const occupiedPath = path.join(root, "occupied.txt");
  const occupiedDir = path.join(root, "occupied-dir");
  await fs.writeFile(sourcePath, "source", "utf8");
  await fs.writeFile(occupiedPath, "precious", "utf8");
  await fs.ensureDir(occupiedDir);

  // FILE-4: rename(2) would have replaced the destination atomically and silently.
  await expect(rename(sourcePath, occupiedPath)).rejects.toBeInstanceOf(
    FilesAlreadyExistsError
  );
  await expect(move(sourcePath, occupiedPath)).rejects.toBeInstanceOf(
    FilesAlreadyExistsError
  );
  await expect(copy(sourcePath, occupiedPath)).rejects.toBeInstanceOf(
    FilesAlreadyExistsError
  );
  await expect(rename(sourcePath, occupiedDir)).rejects.toBeInstanceOf(
    FilesAlreadyExistsError
  );
  expect(await fs.readFile(occupiedPath, "utf8")).toBe("precious");
  expect(await fs.readFile(sourcePath, "utf8")).toBe("source");

  // Renaming onto a free name still works.
  const freePath = path.join(root, "free.txt");
  await rename(sourcePath, freePath);
  expect(await fs.readFile(freePath, "utf8")).toBe("source");

  await fs.remove(root);
});

test("a case-only rename is allowed even where the filesystem folds case", async () => {
  const root = await createTempDir("deckos-files-case-rename-");
  const lowerPath = path.join(root, "notes.txt");
  const upperPath = path.join(root, "NOTES.TXT");
  await fs.writeFile(lowerPath, "content", "utf8");

  // On a case-insensitive filesystem the destination already "exists" — it is the same
  // inode — so identity has to be compared by dev/ino rather than by path string.
  await rename(lowerPath, upperPath);

  const entries = await fs.readdir(root);
  expect(entries).toEqual(["NOTES.TXT"]);
  expect(await fs.readFile(upperPath, "utf8")).toBe("content");

  await fs.remove(root);
});

test("renaming an entry onto its own path through a symlinked parent is not a collision", async (ctx) => {
  const root = await createTempDir("deckos-files-same-entry-");
  if (!(await canCreateSymlink(root))) {
    await fs.remove(root);
    ctx.skip();
    return;
  }
  const realDir = path.join(root, "real");
  await fs.ensureDir(realDir);
  const linkedDir = path.join(root, "linked");
  await fs.symlink(realDir, linkedDir, "dir");
  await fs.writeFile(path.join(realDir, "notes.txt"), "content", "utf8");

  // The source keeps its literal spelling while the destination is rebased onto the
  // parent's real path, so the two sides disagree as strings while naming one entry.
  // Comparing device and inode is what makes this a no-op rather than a false 409.
  await rename(path.join(linkedDir, "notes.txt"), path.join(linkedDir, "notes.txt"));
  expect(await fs.readFile(path.join(realDir, "notes.txt"), "utf8")).toBe("content");

  await fs.remove(root);
});

test("rename refuses a destination occupied by a dangling symlink", async (ctx) => {
  const root = await createTempDir("deckos-files-dangling-");
  if (!(await canCreateSymlink(root))) {
    await fs.remove(root);
    ctx.skip();
    return;
  }
  const sourcePath = path.join(root, "source.txt");
  await fs.writeFile(sourcePath, "source", "utf8");
  const danglingLink = path.join(root, "dangling.txt");
  await fs.symlink(path.join(root, "missing.txt"), danglingLink, "file");

  await expect(rename(sourcePath, danglingLink)).rejects.toBeInstanceOf(
    FilesAlreadyExistsError
  );
  expect((await fs.lstat(danglingLink)).isSymbolicLink()).toBe(true);

  // A dangling link is still removable even though it resolves to nothing.
  await remove(danglingLink);
  expect(await fs.pathExists(path.join(root, "missing.txt"))).toBe(false);

  await fs.remove(root);
});

test("creating and renaming under a symlinked parent works", async (ctx) => {
  const root = await createTempDir("deckos-files-symlink-parent-");
  if (!(await canCreateSymlink(root))) {
    await fs.remove(root);
    ctx.skip();
    return;
  }
  const realDir = path.join(root, "real");
  await fs.ensureDir(realDir);
  const linkedDir = path.join(root, "linked");
  await fs.symlink(realDir, linkedDir, "dir");

  // FILE-13: this used to fail the containment check and surface a 403 naming a path
  // that is on no denylist.
  await mkdir(path.join(linkedDir, "created"));
  expect(await fs.pathExists(path.join(realDir, "created"))).toBe(true);

  await rename(path.join(linkedDir, "created"), path.join(linkedDir, "renamed"));
  expect(await fs.pathExists(path.join(realDir, "renamed"))).toBe(true);

  await fs.remove(root);
});

test("listDirectory caps the entries it returns and reports truncation", async () => {
  const root = await createTempDir("deckos-files-list-cap-");
  await Promise.all(
    Array.from({ length: 12 }, (_unused, index) =>
      fs.writeFile(path.join(root, `entry-${index}.txt`), "x", "utf8")
    )
  );

  // FILE-11: the cap itself is MAX_LIST_ENTRIES; the option can only lower it, which
  // keeps this test cheap without weakening the production limit.
  const capped = await listDirectory(root, { showHidden: false, maxEntries: 5 });
  expect(capped.entries.length).toBe(5);
  expect(capped.truncated).toBe(true);

  const full = await listDirectory(root, { showHidden: false });
  expect(full.entries.length).toBe(12);
  expect(full.truncated).toBe(false);

  await fs.remove(root);
});

test("listDirectory stops scanning long before it can exhaust memory", async () => {
  const root = await createTempDir("deckos-files-list-scan-");
  await Promise.all(
    Array.from({ length: 12 }, (_unused, index) =>
      fs.writeFile(path.join(root, `.hidden-${index}`), "x", "utf8")
    )
  );

  // The scan cap bounds work even when nothing survives the hidden-file filter, which
  // is the case the returned-entry cap alone cannot cover.
  const scanned = await listDirectory(root, { showHidden: false, maxScanEntries: 3 });
  expect(scanned.entries).toEqual([]);
  expect(scanned.truncated).toBe(true);

  const withHidden = await listDirectory(root, { showHidden: true, maxScanEntries: 3 });
  expect(withHidden.entries.length).toBe(3);
  expect(withHidden.truncated).toBe(true);

  await fs.remove(root);
});

test("writeText refuses to save a file larger than it can read back", async () => {
  const root = await createTempDir("deckos-files-write-large-");
  const largePath = path.join(root, "large.log");
  const payload = `${"x".repeat(MAX_TEXT_READ_BYTES)}TAIL`;
  await fs.writeFile(largePath, payload, "utf8");

  const read = await readText(largePath, true);
  expect(read.truncated).toBe(true);

  // FILE-6: saving the truncated buffer would have destroyed everything after 2 MB.
  await expect(writeText(largePath, read.content)).rejects.toBeInstanceOf(
    FilesTextTooLargeError
  );
  expect(await fs.readFile(largePath, "utf8")).toBe(payload);

  await fs.remove(root);
});

test("writeText replaces content atomically and leaves no temp files behind", async () => {
  const root = await createTempDir("deckos-files-write-");
  const targetPath = path.join(root, "notes.txt");
  await fs.writeFile(targetPath, "original", "utf8");

  await writeText(targetPath, "updated");
  expect(await fs.readFile(targetPath, "utf8")).toBe("updated");
  expect(await fs.readdir(root)).toEqual(["notes.txt"]);

  await fs.remove(root);
});

test("writeText restores the original file mode onto the replacement", async (ctx) => {
  if (process.platform === "win32") {
    // Windows only models the read-only bit, so there is no mode to preserve.
    ctx.skip();
    return;
  }
  const root = await createTempDir("deckos-files-write-mode-");
  const targetPath = path.join(root, "config.yaml");
  await fs.writeFile(targetPath, "original", "utf8");
  await fs.chmod(targetPath, 0o640);
  const before = await fs.stat(targetPath);

  // The replacement is a new inode created under the service user's umask, so mode and
  // ownership are copied across explicitly.
  await writeText(targetPath, "updated");

  const after = await fs.stat(targetPath);
  expect(after.mode & 0o777).toBe(0o640);
  expect(after.uid).toBe(before.uid);
  expect(after.gid).toBe(before.gid);

  await fs.remove(root);
});

test("readText reports truncation when the file grows after it is measured", async () => {
  const root = await createTempDir("deckos-files-read-grow-");
  const logPath = path.join(root, "live.log");
  await fs.writeFile(logPath, "x".repeat(512 * 1024), "utf8");

  // Simulates an append landing between getMeta's stat and the read, which is the
  // normal case for the live logs this editor gets pointed at: the stat reports a
  // stale, much smaller size.
  const originalStat = fs.stat.bind(fs);
  const statSpy = vi.spyOn(fs, "stat").mockImplementation((async (target: fs.PathLike) => {
    const stats = await originalStat(target as string);
    if (typeof target === "string" && path.resolve(target) === path.resolve(logPath)) {
      stats.size = 64;
    }
    return stats;
  }) as unknown as typeof fs.stat);

  try {
    const result = await readText(logPath, true);
    // The content is a prefix of a larger file, so it must not be labelled complete —
    // the editor's read-only handling keys off this flag.
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBeGreaterThan(64);
  } finally {
    statSpy.mockRestore();
  }

  await fs.remove(root);
});

test("readText only allocates what the file holds", async () => {
  const root = await createTempDir("deckos-files-read-small-");
  const smallPath = path.join(root, "small.txt");
  await fs.writeFile(smallPath, "tiny", "utf8");

  const result = await readText(smallPath, false);
  expect(result.content).toBe("tiny");
  expect(result.truncated).toBe(false);

  const emptyPath = path.join(root, "empty.txt");
  await fs.writeFile(emptyPath, "", "utf8");
  const empty = await readText(emptyPath, false);
  expect(empty.content).toBe("");
  expect(empty.truncated).toBe(false);

  await fs.remove(root);
});
