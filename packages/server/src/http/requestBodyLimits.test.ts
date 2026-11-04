import fs from "fs-extra";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { DATA_DIR } from "../lib/config.js";
import * as authService from "../services/auth.js";
import { createServerApp } from "./appWiring.js";
import { MAX_AUTH_BODY_BYTES, MAX_TRPC_BODY_BYTES } from "./securityMiddleware.js";

const MEBIBYTE = 1024 * 1024;
const WRITE_TEXT_ROUTE = "/api/trpc/files.writeText";
// Larger than the tRPC limit, to prove uploads are not subject to it.
const LARGE_UPLOAD_BYTES = 20 * MEBIBYTE;

const JSON_HEADERS = { "content-type": "application/json" };

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "deckos-body-limits-"));
  authService.setAuthStoragePathForTests(root);
});

afterEach(async () => {
  authService.setAuthStoragePathForTests(DATA_DIR);
  await fs.remove(root);
});

/**
 * A body that hands out chunks only when asked and records how much was asked for,
 * so a test can tell "rejected without reading" apart from "read, then rejected".
 */
function countingBody(chunkBytes: number, totalBytes: number) {
  const state = { bytesRead: 0 };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (state.bytesRead >= totalBytes) {
          controller.close();
          return;
        }
        state.bytesRead += chunkBytes;
        controller.enqueue(new Uint8Array(chunkBytes).fill(0x20));
      },
    },
    { highWaterMark: 0 }
  );
  return { state, stream };
}

function postJson(
  route: string,
  body: string | ReadableStream<Uint8Array>,
  headers: Record<string, string> = {}
) {
  return createServerApp().request(
    new Request(`http://localhost${route}`, {
      method: "POST",
      headers: { ...JSON_HEADERS, ...headers },
      body,
      duplex: "half",
    } as RequestInit)
  );
}

describe("tRPC request body limit", () => {
  test("rejects a declared oversized body without reading any of it", async () => {
    const { state, stream } = countingBody(MEBIBYTE, MAX_TRPC_BODY_BYTES + MEBIBYTE);

    const response = await postJson(WRITE_TEXT_ROUTE, stream, {
      "content-length": String(MAX_TRPC_BODY_BYTES + 1),
    });

    expect(response.status).toBe(413);
    expect(state.bytesRead).toBe(0);
  });

  test("stops reading an oversized body of undeclared length at the limit", async () => {
    const { state, stream } = countingBody(MEBIBYTE, 10 * MAX_TRPC_BODY_BYTES);

    const response = await postJson(WRITE_TEXT_ROUTE, stream);

    expect(response.status).toBe(413);
    expect(state.bytesRead).toBeLessThanOrEqual(MAX_TRPC_BODY_BYTES + MEBIBYTE);
  });

  test("passes the largest text save the schema allows, in the widest common encoding", async () => {
    const target = path.join(root, "cjk.txt");
    await fs.writeFile(target, "");
    // writeText allows 4 Mi UTF-16 units; CJK text takes 3 UTF-8 bytes for each.
    const content = "語".repeat(4 * MEBIBYTE);

    const response = await postJson(
      WRITE_TEXT_ROUTE,
      JSON.stringify({ path: target, content })
    );

    expect(response.status).toBe(200);
    expect((await fs.stat(target)).size).toBe(12 * MEBIBYTE);
  });

  test("leaves a text save over the schema limit for the schema to explain", async () => {
    const response = await postJson(
      WRITE_TEXT_ROUTE,
      JSON.stringify({
        path: path.join(root, "too-long.txt"),
        content: "x".repeat(4 * MEBIBYTE + 1),
      })
    );

    expect(response.status).toBe(400);
  });

  test("passes a normal body of undeclared length through intact", async () => {
    const target = path.join(root, "chunked.txt");
    await fs.writeFile(target, "");
    const encoded = new TextEncoder().encode(
      JSON.stringify({ path: target, content: "hello" })
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.subarray(0, 10));
        controller.enqueue(encoded.subarray(10));
        controller.close();
      },
    });

    const response = await postJson(WRITE_TEXT_ROUTE, stream);

    expect(response.status).toBe(200);
    await expect(fs.readFile(target, "utf-8")).resolves.toBe("hello");
  });

  test("does not affect queries, which carry no body", async () => {
    const response = await createServerApp().request("/api/trpc/system.getUpdateStatus");

    expect(response.status).not.toBe(413);
  });
});

describe("auth request body limit", () => {
  test.each([
    "/api/auth/unlock",
    "/api/auth/configure",
    "/api/auth/change",
    "/api/auth/session-duration",
    "/api/auth/disable",
  ])("%s rejects an oversized body", async (route) => {
    const response = await postJson(route, " ".repeat(MAX_AUTH_BODY_BYTES + 1));

    expect(response.status).toBe(413);
  });

  test("a normal first-time setup still succeeds", async () => {
    const response = await postJson(
      "/api/auth/configure",
      JSON.stringify({ passcode: "123456", sessionDurationMs: 3_600_000 })
    );

    expect(response.status).toBe(200);
  });
});

describe("file upload", () => {
  test("is not subject to the tRPC limit", async () => {
    const destination = path.join(root, "uploads");
    await fs.ensureDir(destination);
    const form = new FormData();
    form.append("files", new Blob([new Uint8Array(LARGE_UPLOAD_BYTES)]), "large.bin");

    const response = await createServerApp().request(
      `/api/files/upload?path=${encodeURIComponent(destination)}`,
      { method: "POST", body: form }
    );

    expect(response.status).toBe(200);
    expect((await fs.stat(path.join(destination, "large.bin"))).size).toBe(
      LARGE_UPLOAD_BYTES
    );
  });
});

/**
 * `app.request` skips `@hono/node-server`, whose `Request` is its own lazily built
 * wrapper around the socket. The limit replaces the request when a body has no
 * declared length, so that path has to be proven against the real adapter too.
 */
describe("over a real socket", () => {
  let server: ReturnType<typeof serve>;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = serve(
        { fetch: createServerApp().fetch, port: 0, hostname: "127.0.0.1" },
        () => {
          resolve();
        }
      );
    });
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  /**
   * Omitting `content-length` from `headers` makes Node send the body chunked. Each
   * request gets its own connection: after answering a rejected body the adapter drops
   * the socket once its drain window ends, which a reused socket would report as a reset.
   */
  function send(
    route: string,
    headers: Record<string, string>,
    chunks: Buffer[]
  ): Promise<{ status: number; body: string }> {
    const { port } = server.address() as AddressInfo;
    return new Promise((resolve, reject) => {
      const request = http.request(
        { host: "127.0.0.1", port, path: route, method: "POST", headers, agent: false },
        (response) => {
          const received: Buffer[] = [];
          response.on("data", (chunk: Buffer) => received.push(chunk));
          response.on("end", () => {
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(received).toString("utf-8"),
            });
          });
        }
      );
      // The server may close its side once it has answered a rejected body.
      request.on("error", reject);
      for (const chunk of chunks) {
        request.write(chunk);
      }
      request.end();
    });
  }

  const oversized = () =>
    Array.from({ length: MAX_TRPC_BODY_BYTES / MEBIBYTE + 1 }, () =>
      Buffer.alloc(MEBIBYTE, 0x20)
    );

  test("rejects a declared oversized body", async () => {
    const chunks = oversized();

    const response = await send(
      WRITE_TEXT_ROUTE,
      {
        ...JSON_HEADERS,
        "content-length": String(chunks.length * MEBIBYTE),
      },
      chunks
    );

    expect(response.status).toBe(413);
    expect(JSON.parse(response.body)).toEqual({ error: expect.any(String) });
  });

  test("rejects a chunked oversized body", async () => {
    const response = await send(WRITE_TEXT_ROUTE, JSON_HEADERS, oversized());

    expect(response.status).toBe(413);
  });

  test("passes a normal chunked body through intact", async () => {
    const target = path.join(root, "socket.txt");
    await fs.writeFile(target, "");
    const encoded = Buffer.from(JSON.stringify({ path: target, content: "hello" }));

    const response = await send(WRITE_TEXT_ROUTE, JSON_HEADERS, [
      encoded.subarray(0, 10),
      encoded.subarray(10),
    ]);

    expect(response.status).toBe(200);
    await expect(fs.readFile(target, "utf-8")).resolves.toBe("hello");
  });

  test("accepts an upload larger than the tRPC limit", async () => {
    const destination = path.join(root, "socket-uploads");
    await fs.ensureDir(destination);
    const boundary = "deckostestboundary";
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="large.bin"\r\n` +
        "Content-Type: application/octet-stream\r\n\r\n"
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);

    const response = await send(
      `/api/files/upload?path=${encodeURIComponent(destination)}`,
      { "content-type": `multipart/form-data; boundary=${boundary}` },
      [head, Buffer.alloc(LARGE_UPLOAD_BYTES), tail]
    );

    expect(response.status).toBe(200);
    expect((await fs.stat(path.join(destination, "large.bin"))).size).toBe(
      LARGE_UPLOAD_BYTES
    );
  });
});
