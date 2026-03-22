import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, test } from "vitest";
import { registerFilesRoutes } from "./filesRoutes.js";

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

describe("filesRoutes", () => {
  afterEach(async () => {
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
