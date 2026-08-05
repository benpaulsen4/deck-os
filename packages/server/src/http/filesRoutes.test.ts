import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vitest";
import { registerFilesRoutes } from "./filesRoutes.js";

/**
 * Busboy is wrapped rather than replaced: real parsing is preserved, but the options
 * the route passes can be asserted, and `fileSizeOverride` lets a test drive the real
 * per-file limit path without pushing 128 MB through CI.
 */
const busboyState = vi.hoisted(() => ({
  options: [] as Array<{ limits?: Record<string, number> }>,
  fileSizeOverride: null as number | null,
}));

vi.mock("busboy", async (importOriginal) => {
  const actual =
    await importOriginal<{ default: (options: Record<string, unknown>) => unknown }>();
  return {
    default: (options: Record<string, unknown>) => {
      busboyState.options.push(options as { limits?: Record<string, number> });
      const limits = { ...(options.limits as Record<string, number> | undefined) };
      if (busboyState.fileSizeOverride !== null) {
        limits.fileSize = busboyState.fileSizeOverride;
      }
      return actual.default({ ...options, limits });
    },
  };
});

const createdDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

function createApp() {
  const app = new Hono();
  registerFilesRoutes(app);
  return app;
}

const MULTIPART_BOUNDARY = "deckostestboundary";

/**
 * Hand-rolled multipart so tests can send filenames that FormData would normalize
 * away (traversal segments, NUL bytes).
 */
function buildMultipartBody(
  parts: Array<{ field: string; filename?: string; content: string }>
): string {
  const encodedParts = parts.map((part) => {
    const disposition =
      part.filename === undefined
        ? `Content-Disposition: form-data; name="${part.field}"`
        : `Content-Disposition: form-data; name="${part.field}"; filename="${part.filename}"`;
    return (
      `--${MULTIPART_BOUNDARY}\r\n${disposition}\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n${part.content}\r\n`
    );
  });
  return `${encodedParts.join("")}--${MULTIPART_BOUNDARY}--\r\n`;
}

async function uploadRaw(
  destination: string,
  parts: Array<{ field: string; filename?: string; content: string }>
) {
  const app = createApp();
  return await app.request(
    `http://localhost/api/files/upload?path=${encodeURIComponent(destination)}`,
    {
      method: "POST",
      headers: {
        "content-type": `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`,
      },
      body: buildMultipartBody(parts),
    }
  );
}

describe("filesRoutes", () => {
  afterEach(async () => {
    busboyState.options.length = 0;
    busboyState.fileSizeOverride = null;
    await Promise.all(createdDirs.splice(0).map((dir) => fs.remove(dir)));
  });

  test("upload requires destination path query", async () => {
    const app = createApp();
    const res = await app.request("http://localhost/api/files/upload", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=test" },
      body: "--test--",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing destination path" });
  });

  test("upload requires multipart content-type", async () => {
    const app = createApp();
    const destination = await createTempDir("deckos-files-upload-");
    const res = await app.request(
      `http://localhost/api/files/upload?path=${encodeURIComponent(destination)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: "x" }),
      }
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Content-Type must be multipart/form-data",
    });
  });

  test("upload stores multipart files in destination directory", async () => {
    const app = createApp();
    const destination = await createTempDir("deckos-files-upload-ok-");
    const form = new FormData();
    form.append("files", new Blob(["hello upload"]), "hello.txt");
    form.append("files", new Blob(["second"]), "second.txt");

    const res = await app.request(
      `http://localhost/api/files/upload?path=${encodeURIComponent(destination)}`,
      {
        method: "POST",
        body: form,
      }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      uploaded: ["hello.txt", "second.txt"],
    });
    expect(await fs.readFile(path.join(destination, "hello.txt"), "utf8")).toBe(
      "hello upload"
    );
    expect(await fs.readFile(path.join(destination, "second.txt"), "utf8")).toBe("second");
  });

  test("upload rejects multipart body without files field", async () => {
    const app = createApp();
    const destination = await createTempDir("deckos-files-upload-empty-");
    const form = new FormData();
    form.append("note", "no files payload");

    const res = await app.request(
      `http://localhost/api/files/upload?path=${encodeURIComponent(destination)}`,
      {
        method: "POST",
        body: form,
      }
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "No files uploaded" });
  });

  test("download returns attachment headers and file body", async () => {
    const app = createApp();
    const root = await createTempDir("deckos-files-download-");
    const filePath = path.join(root, "hello.txt");
    await fs.writeFile(filePath, "hello world", "utf8");

    const res = await app.request(
      `http://localhost/api/files/download?path=${encodeURIComponent(filePath)}`
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain('filename="hello.txt"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("hello world");
  });

  test("content endpoint supports byte range reads", async () => {
    const app = createApp();
    const root = await createTempDir("deckos-files-range-");
    const filePath = path.join(root, "range.txt");
    await fs.writeFile(filePath, "abcdef", "utf8");

    const res = await app.request(
      `http://localhost/api/files/content?path=${encodeURIComponent(filePath)}`,
      {
        headers: {
          range: "bytes=1-3",
        },
      }
    );

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 1-3/6");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("bcd");
  });

  test("content endpoint returns 416 for invalid range", async () => {
    const app = createApp();
    const root = await createTempDir("deckos-files-range-invalid-");
    const filePath = path.join(root, "range.txt");
    await fs.writeFile(filePath, "abcdef", "utf8");

    const res = await app.request(
      `http://localhost/api/files/content?path=${encodeURIComponent(filePath)}`,
      {
        headers: {
          range: "bytes=20-30",
        },
      }
    );

    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */6");
    expect(await res.text()).toBe("Requested Range Not Satisfiable");
  });

  test("upload does not delete the file it collides with", async () => {
    const destination = await createTempDir("deckos-files-upload-collide-");
    const existingPath = path.join(destination, "notes.txt");
    await fs.writeFile(existingPath, "the admin's only copy", "utf8");

    const res = await uploadRaw(destination, [
      { field: "files", filename: "notes.txt", content: "replacement" },
    ]);

    // FILE-2: the write correctly refused to clobber, but the failure path then
    // unlinked the pre-existing file anyway.
    expect(res.status).toBe(409);
    expect(await fs.readFile(existingPath, "utf8")).toBe("the admin's only copy");
    const body = (await res.json()) as { error: string; uploaded: string[] };
    expect(body.error).toBe("One or more files already exist");
    expect(body.uploaded).toEqual([]);
  });

  test("two parts sharing one filename are refused rather than clobbering", async () => {
    const destination = await createTempDir("deckos-files-upload-dupe-");

    const res = await uploadRaw(destination, [
      { field: "files", filename: "dupe.txt", content: "first" },
      { field: "files", filename: "dupe.txt", content: "second" },
    ]);

    expect(res.status).toBe(409);
    // Both tasks await resolveTargetPath before opening, so which of the two wins the
    // `open(..., "wx")` race is genuinely nondeterministic — the loser gets EEXIST and,
    // correctly, does not unlink a file it did not create. What is deterministic is the
    // shape: at most one dupe.txt survives and it holds exactly one part's bytes, never
    // a mix and never a partial write.
    const entries = await fs.readdir(destination);
    expect(entries.length).toBeLessThanOrEqual(1);
    if (entries.length === 1) {
      expect(entries[0]).toBe("dupe.txt");
      const written = await fs.readFile(path.join(destination, "dupe.txt"), "utf8");
      expect(["first", "second"]).toContain(written);
    }
  });

  test("a traversal filename cannot escape the destination directory", async () => {
    const destination = await createTempDir("deckos-files-upload-traversal-");
    const parentDir = path.dirname(destination);
    const escapedPath = path.join(parentDir, "evil");
    await fs.remove(escapedPath);

    const res = await uploadRaw(destination, [
      { field: "files", filename: "../evil", content: "payload" },
    ]);

    // busboy applies its own basename() to the filename before the route ever sees it,
    // so this arrives as "evil" and is stored, not rejected. What matters is that it
    // lands inside the destination and nothing appears in its parent.
    expect(res.status).toBe(200);
    expect(await fs.readFile(path.join(destination, "evil"), "utf8")).toBe("payload");
    expect(await fs.pathExists(escapedPath)).toBe(false);
  });

  test("upload rejects filenames that survive normalization as unsafe", async () => {
    const destination = await createTempDir("deckos-files-upload-name-");

    // A NUL byte makes busboy reject the part header outright, so the route never sees
    // the name at all; it must still be a 400 rather than a generic 500.
    const nul = await uploadRaw(destination, [
      { field: "files", filename: "ev\0il.txt", content: "payload" },
    ]);
    expect(nul.status).toBe(400);
    expect(((await nul.json()) as { error: string }).error).toBe(
      "Malformed multipart request"
    );

    // busboy reduces a bare ".." to an empty name, which is rejected as well.
    const dotdot = await uploadRaw(destination, [
      { field: "files", filename: "..", content: "payload" },
    ]);
    expect(dotdot.status).toBe(400);
    expect(((await dotdot.json()) as { error: string }).error).toContain("Invalid file name");

    expect(await fs.readdir(destination)).toEqual([]);
  });

  test("upload aborts on an unexpected field name instead of draining it", async () => {
    const destination = await createTempDir("deckos-files-upload-field-");

    // FILE-9: this part used to be resume()d and drained with no size cap at all.
    const res = await uploadRaw(destination, [
      { field: "notfiles", filename: "sneaky.txt", content: "payload" },
    ]);

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "Unexpected upload field: notfiles"
    );
    expect(await fs.readdir(destination)).toEqual([]);
  });

  test("upload rejects more parts than the file-count cap allows", async () => {
    const destination = await createTempDir("deckos-files-upload-count-");
    const parts = Array.from({ length: 33 }, (_unused, index) => ({
      field: "files",
      filename: `file-${index}.txt`,
      content: "x",
    }));

    const res = await uploadRaw(destination, parts);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; uploaded: string[] };
    expect(body.error).toBe("Too many files. Maximum is 32.");
    expect(Array.isArray(body.uploaded)).toBe(true);
  });

  test("upload passes explicit limits to the multipart parser", async () => {
    const destination = await createTempDir("deckos-files-upload-limits-");
    await uploadRaw(destination, [
      { field: "files", filename: "ok.txt", content: "ok" },
    ]);

    // FILE-9: every one of these defaults to Infinity when omitted.
    expect(busboyState.options).toHaveLength(1);
    expect(busboyState.options[0]?.limits).toEqual({
      files: 32,
      fileSize: 128 * 1024 * 1024,
      parts: 40,
      fields: 8,
      fieldSize: 64 * 1024,
      fieldNameSize: 200,
    });
  });

  test("a file over the per-file cap is rejected and its partial write removed", async () => {
    const destination = await createTempDir("deckos-files-upload-toobig-");
    busboyState.fileSizeOverride = 8;

    const res = await uploadRaw(destination, [
      { field: "files", filename: "big.txt", content: "x".repeat(4096) },
    ]);

    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe("File too large: big.txt");
    // FILE-10: the partial file must not survive the failed request.
    expect(await fs.readdir(destination)).toEqual([]);
  });

  test("download encodes non-Latin-1 filenames instead of throwing", async () => {
    const app = createApp();
    const root = await createTempDir("deckos-files-download-unicode-");
    const fileName = "日本語-🚀-notes.txt";
    const filePath = path.join(root, fileName);
    await fs.writeFile(filePath, "unicode body", "utf8");

    const res = await app.request(
      `http://localhost/api/files/download?path=${encodeURIComponent(filePath)}`
    );

    // FILE-7: Headers.set throws above U+00FF, so this used to be a generic 500.
    expect(res.status).toBe(200);
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent(fileName)}`);
    const fallback = /^attachment; filename="([^"]*)"/.exec(disposition)?.[1] ?? "";
    expect(fallback).toMatch(/^[\x20-\x7E]*$/);
    expect(fallback).toContain("notes.txt");
    expect(await res.text()).toBe("unicode body");
  });

  test("download sanitizes quotes in the ASCII filename fallback", async (ctx) => {
    if (process.platform === "win32") {
      // Windows does not allow quotes in filenames, so there is nothing to sanitize.
      ctx.skip();
      return;
    }
    const app = createApp();
    const root = await createTempDir("deckos-files-download-quote-");
    const fileName = 'we"ird.txt';
    const filePath = path.join(root, fileName);
    await fs.writeFile(filePath, "quoted", "utf8");

    const res = await app.request(
      `http://localhost/api/files/download?path=${encodeURIComponent(filePath)}`
    );

    expect(res.status).toBe(200);
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toContain('filename="we_ird.txt"');
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent(fileName)}`);
  });

  test("template asset endpoint serves known icon with image content-type", async () => {
    const app = createApp();
    const res = await app.request(
      "http://localhost/api/templates/assets/actualbudget/assets/icon.png"
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
  });
});
