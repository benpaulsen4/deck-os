import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { trpcServer } from "@hono/trpc-server";
import { streamSSE } from "hono/streaming";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { serveStatic } from "@hono/node-server/serve-static";
import { z } from "zod";
import { appRouter } from "./trpc/router.js";
import { createContext } from "./trpc/context.js";
import * as metricsService from "./services/metrics.js";
import * as dockerService from "./services/docker.js";
import * as pullJobsService from "./services/pullJobs.js";
import * as templatesService from "./services/templates.js";
import * as filesService from "./services/files.js";
import * as authService from "./services/auth.js";
import { LOG_HISTORY_SIZE } from "./lib/config.js";
import { AppIdSchema } from "./lib/schema.js";
import { getCurrentVersion } from "./lib/version.js";
import { readFileSync, existsSync, createReadStream } from "fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { Readable } from "node:stream";
import type Dockerode from "dockerode";

dockerService.getDocker();

function toWebStream(fileStream: NodeJS.ReadableStream): ReadableStream {
  return Readable.toWeb(fileStream as unknown as Readable) as ReadableStream;
}

const MAX_UPLOAD_FILES = 32;
const MAX_UPLOAD_FILE_BYTES = 128 * 1024 * 1024;
const MAX_UPLOAD_TOTAL_BYTES = 512 * 1024 * 1024;

function isSafeUploadName(fileName: string): boolean {
  const safeName = basename(fileName);
  if (!safeName || safeName !== fileName) {
    return false;
  }
  if (
    safeName.includes("\0") ||
    safeName.includes("/") ||
    safeName.includes("\\") ||
    safeName === "." ||
    safeName === ".."
  ) {
    return false;
  }
  return true;
}

type FilesHttpStatusCode = 400 | 403 | 404 | 409 | 413 | 500;

function toFilesHttpErrorResponse(
  error: unknown,
  fallbackMessage: string
): { status: FilesHttpStatusCode; message: string } {
  const message = error instanceof Error ? error.message : fallbackMessage;
  if (error instanceof filesService.FilesAccessDeniedError) {
    return { status: 403, message };
  }
  if (error instanceof filesService.FilesNotFoundError) {
    return { status: 404, message };
  }
  if (
    error instanceof filesService.FilesNotDirectoryError ||
    error instanceof filesService.FilesNotFileError
  ) {
    return { status: 400, message };
  }
  if (error instanceof filesService.FilesAlreadyExistsError) {
    return { status: 409, message };
  }
  if (error instanceof Error && (error as NodeJS.ErrnoException).code === "EEXIST") {
    return { status: 409, message: "One or more files already exist" };
  }
  return { status: 500, message };
}

let fatalExitScheduled = false;

function scheduleFatalExit(
  kind: "uncaughtException" | "unhandledRejection",
  detail: unknown
) {
  const payload = detail instanceof Error ? detail.stack || detail.message : detail;
  console.error(`[deckos] Fatal ${kind}; exiting for supervised restart`, payload);
  if (fatalExitScheduled) {
    return;
  }
  fatalExitScheduled = true;
  process.exitCode = 1;
  setTimeout(() => {
    process.exit(1);
  }, 50).unref();
}

process.on("uncaughtException", (error) => {
  scheduleFatalExit("uncaughtException", error);
});

process.on("unhandledRejection", (reason) => {
  scheduleFatalExit("unhandledRejection", reason);
});

const app = new Hono();

function isHttpsRequest(url: string, forwardedProto?: string): boolean {
  if (forwardedProto?.toLowerCase().startsWith("https")) {
    return true;
  }
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

function getSessionToken(c: Parameters<typeof getCookie>[0]) {
  return getCookie(c, authService.getAuthCookieName()) ?? null;
}

function setSessionCookie(
  c: Parameters<typeof setCookie>[0],
  sessionToken: string,
  sessionDurationMs: number
) {
  setCookie(c, authService.getAuthCookieName(), sessionToken, {
    httpOnly: true,
    sameSite: "Lax",
    secure: isHttpsRequest(c.req.url, c.req.header("x-forwarded-proto")),
    path: "/",
    maxAge: Math.floor(sessionDurationMs / 1000),
  });
}

function clearSessionCookie(c: Parameters<typeof deleteCookie>[0]) {
  deleteCookie(c, authService.getAuthCookieName(), {
    path: "/",
  });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isProduction = process.env.NODE_ENV === "production";
const clientDistPath = isProduction
  ? join(__dirname, "../../client/dist")
  : join(__dirname, "../../../client/dist");

// tRPC handler
app.use(
  "/api/trpc/*",
  trpcServer({
    endpoint: "/api/trpc",
    router: appRouter,
    createContext: (_opts, c) => createContext(c),
  })
);

app.use("/api/*", async (c, next) => {
  const path = c.req.path;
  if (path === "/api/health" || path.startsWith("/api/auth/")) {
    await next();
    return;
  }
  const sessionToken = getSessionToken(c);
  const status = await authService.getAuthStatus(sessionToken);
  if (!status.unlocked) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

app.get("/api/auth/status", async (c) => {
  const status = await authService.getAuthStatus(getSessionToken(c));
  return c.json(status);
});

app.post("/api/auth/unlock", async (c) => {
  const body = await c.req.json().catch(() => null);
  const passcode = typeof body?.passcode === "string" ? body.passcode : "";
  const forwardedFor = c.req.header("x-forwarded-for");
  const ip = forwardedFor?.split(",")[0].trim() || c.req.header("x-real-ip") || "unknown";
  try {
    const result = await authService.unlock({ passcode, ip });
    setSessionCookie(c, result.token, result.sessionDurationMs);
    return c.json({
      enabled: true,
      unlocked: true,
      sessionDurationMs: result.sessionDurationMs,
      expiresAt: result.expiresAt,
    });
  } catch (error: unknown) {
    if (error instanceof authService.AuthRateLimitedError) {
      return c.json({ error: error.message, retryAfterMs: error.retryAfterMs }, 429);
    }
    if (error instanceof authService.AuthInvalidPasscodeError) {
      return c.json({ error: error.message }, 401);
    }
    if (
      error instanceof authService.AuthNotEnabledError ||
      error instanceof authService.AuthValidationError
    ) {
      return c.json({ error: error.message }, 400);
    }
    return c.json({ error: "Unlock failed" }, 500);
  }
});

app.post("/api/auth/lock", async (c) => {
  authService.revokeSession(getSessionToken(c));
  clearSessionCookie(c);
  const status = await authService.getAuthStatus(null);
  return c.json(status);
});

app.post("/api/auth/configure", async (c) => {
  const body = await c.req.json().catch(() => null);
  try {
    const result = await authService.configureAuth({
      passcode: typeof body?.passcode === "string" ? body.passcode : "",
      sessionDurationMs: Number(body?.sessionDurationMs),
    });
    return c.json(result);
  } catch (error: unknown) {
    if (error instanceof authService.AuthValidationError) {
      return c.json({ error: error.message }, 400);
    }
    return c.json(
      { error: error instanceof Error ? error.message : "Configure failed" },
      500
    );
  }
});

app.post("/api/auth/change", async (c) => {
  const sessionToken = getSessionToken(c);
  const status = await authService.getAuthStatus(sessionToken);
  if (!status.unlocked) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const body = await c.req.json().catch(() => null);
  try {
    const result = await authService.changePasscode({
      currentPasscode:
        typeof body?.currentPasscode === "string" ? body.currentPasscode : "",
      nextPasscode: typeof body?.nextPasscode === "string" ? body.nextPasscode : "",
      sessionDurationMs:
        body?.sessionDurationMs === undefined
          ? undefined
          : Number(body.sessionDurationMs),
    });
    authService.revokeSession(sessionToken);
    clearSessionCookie(c);
    return c.json(result);
  } catch (error: unknown) {
    if (error instanceof authService.AuthInvalidPasscodeError) {
      return c.json({ error: error.message }, 401);
    }
    if (
      error instanceof authService.AuthValidationError ||
      error instanceof authService.AuthNotEnabledError
    ) {
      return c.json({ error: error.message }, 400);
    }
    return c.json({ error: "Passcode update failed" }, 500);
  }
});

app.post("/api/auth/session-duration", async (c) => {
  const sessionToken = getSessionToken(c);
  const status = await authService.getAuthStatus(sessionToken);
  if (!status.unlocked) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const body = await c.req.json().catch(() => null);
  try {
    const result = await authService.updateSessionDuration({
      currentPasscode:
        typeof body?.currentPasscode === "string" ? body.currentPasscode : "",
      sessionDurationMs: Number(body?.sessionDurationMs),
    });
    authService.revokeSession(sessionToken);
    clearSessionCookie(c);
    return c.json(result);
  } catch (error: unknown) {
    if (error instanceof authService.AuthInvalidPasscodeError) {
      return c.json({ error: error.message }, 401);
    }
    if (
      error instanceof authService.AuthValidationError ||
      error instanceof authService.AuthNotEnabledError
    ) {
      return c.json({ error: error.message }, 400);
    }
    return c.json({ error: "Session duration update failed" }, 500);
  }
});

app.post("/api/auth/disable", async (c) => {
  const sessionToken = getSessionToken(c);
  const status = await authService.getAuthStatus(sessionToken);
  if (!status.unlocked) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const body = await c.req.json().catch(() => null);
  try {
    const result = await authService.disableAuth(
      typeof body?.currentPasscode === "string" ? body.currentPasscode : ""
    );
    authService.revokeSession(sessionToken);
    clearSessionCookie(c);
    return c.json(result);
  } catch (error: unknown) {
    if (error instanceof authService.AuthInvalidPasscodeError) {
      return c.json({ error: error.message }, 401);
    }
    if (
      error instanceof authService.AuthValidationError ||
      error instanceof authService.AuthNotEnabledError
    ) {
      return c.json({ error: error.message }, 400);
    }
    return c.json({ error: "Disable auth failed" }, 500);
  }
});

// Health check
app.get("/api/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/api/version", (c) => {
  return c.json({ version: getCurrentVersion(), timestamp: new Date().toISOString() });
});

// Docker connectivity check
app.get("/api/docker/status", async (c) => {
  const docker = await dockerService.getDockerAsync();
  const isWindows = process.platform === "win32";

  const dockerStatus = {
    available: !!docker,
    platform: process.platform,
    message: docker ? "Docker is accessible" : "Docker is not accessible",
  };

  if (!docker && isWindows) {
    dockerStatus.message += ". Ensure Docker Desktop is running";
  }

  return c.json(dockerStatus);
});

app.get("/api/templates/assets/:templateId/*", async (c) => {
  const { templateId } = c.req.param();
  const reqPath = c.req.path;
  const prefixEncoded = `/api/templates/assets/${encodeURIComponent(templateId)}/`;
  const prefixDecoded = `/api/templates/assets/${templateId}/`;
  const rawRel = reqPath.startsWith(prefixEncoded)
    ? reqPath.slice(prefixEncoded.length)
    : reqPath.startsWith(prefixDecoded)
      ? reqPath.slice(prefixDecoded.length)
      : "";
  let assetRel = "";
  if (rawRel) {
    try {
      assetRel = decodeURIComponent(rawRel);
    } catch {
      return c.json({ error: "Invalid asset path" }, 400);
    }
  }
  if (!assetRel) return c.json({ error: "Not found" }, 404);

  const assetPath = await templatesService.getTemplateAssetPath(templateId, assetRel);
  if (!assetPath) {
    return c.json({ error: "Not found" }, 404);
  }

  const ext = assetPath.split(".").pop()?.toLowerCase();
  const contentType =
    ext === "png"
      ? "image/png"
      : ext === "jpg" || ext === "jpeg"
        ? "image/jpeg"
        : ext === "webp"
          ? "image/webp"
          : ext === "gif"
            ? "image/gif"
            : ext === "svg"
              ? "image/svg+xml"
              : "application/octet-stream";

  const buf = await readFile(assetPath);
  c.header("Content-Type", contentType);
  return c.body(buf);
});

app.post("/api/files/upload", async (c) => {
  const destinationParam = c.req.query("path");
  if (!destinationParam) {
    return c.json({ error: "Missing destination path" }, 400);
  }
  try {
    const destinationPath =
      await filesService.resolveExistingDirectoryPath(destinationParam);

    const formData = await c.req.raw.formData();
    const allEntries = formData.getAll("files");
    const allFiles: Array<{ name: string; arrayBuffer: () => Promise<ArrayBuffer> }> = [];
    for (const entry of allEntries) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const candidate = entry as { name?: unknown; arrayBuffer?: unknown };
      if (
        typeof candidate.name === "string" &&
        typeof candidate.arrayBuffer === "function"
      ) {
        allFiles.push(entry as { name: string; arrayBuffer: () => Promise<ArrayBuffer> });
      }
    }

    if (allFiles.length === 0) {
      return c.json({ error: "No files uploaded" }, 400);
    }
    if (allFiles.length > MAX_UPLOAD_FILES) {
      return c.json({ error: `Too many files. Maximum is ${MAX_UPLOAD_FILES}.` }, 400);
    }

    const uploaded: string[] = [];
    let totalBytes = 0;
    for (const file of allFiles) {
      const safeName = basename(file.name);
      if (!isSafeUploadName(file.name) || !safeName) {
        return c.json({ error: `Invalid file name: ${file.name}` }, 400);
      }
      const targetPath = await filesService.resolveTargetPath(
        join(destinationPath, safeName)
      );
      const arrayBuffer = await file.arrayBuffer();
      const fileBytes = arrayBuffer.byteLength;
      totalBytes += fileBytes;
      if (fileBytes > MAX_UPLOAD_FILE_BYTES) {
        return c.json({ error: `File too large: ${safeName}` }, 413);
      }
      if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) {
        return c.json({ error: "Total upload size exceeded" }, 413);
      }
      await writeFile(targetPath, Buffer.from(arrayBuffer), { flag: "wx" });
      uploaded.push(safeName);
    }
    return c.json({ uploaded });
  } catch (error: unknown) {
    const response = toFilesHttpErrorResponse(error, "Upload failed");
    return c.json({ error: response.message }, response.status);
  }
});

app.get("/api/files/download", async (c) => {
  const targetParam = c.req.query("path");
  if (!targetParam) {
    return c.json({ error: "Missing path" }, 400);
  }
  try {
    const filePath = await filesService.resolveExistingFilePath(targetParam);
    const fileStat = await stat(filePath);
    c.header("Content-Disposition", `attachment; filename="${basename(filePath)}"`);
    c.header("Content-Type", "application/octet-stream");
    c.header("Content-Length", String(fileStat.size));
    c.header("X-Content-Type-Options", "nosniff");
    return c.body(toWebStream(createReadStream(filePath)));
  } catch (error: unknown) {
    const response = toFilesHttpErrorResponse(error, "Download failed");
    return c.json({ error: response.message }, response.status);
  }
});

app.get("/api/files/content", async (c) => {
  const targetParam = c.req.query("path");
  if (!targetParam) {
    return c.json({ error: "Missing path" }, 400);
  }
  try {
    const filePath = await filesService.resolveExistingFilePath(targetParam);
    const fileStat = await stat(filePath);

    const mimeType = filesService.getPathMimeType(filePath);
    const totalSize = fileStat.size;
    const rangeHeader = c.req.header("range");

    c.header("Accept-Ranges", "bytes");
    c.header("Content-Type", mimeType);
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");

    if (!rangeHeader) {
      c.header("Content-Length", String(totalSize));
      return c.body(toWebStream(createReadStream(filePath)));
    }

    const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
    if (!match) {
      c.header("Content-Range", `bytes */${totalSize}`);
      return c.body("Requested Range Not Satisfiable", 416);
    }

    const startRaw = match[1];
    const endRaw = match[2];
    let start = startRaw ? Number.parseInt(startRaw, 10) : 0;
    let end = endRaw ? Number.parseInt(endRaw, 10) : totalSize - 1;

    if (!startRaw && endRaw) {
      const suffixLength = Number.parseInt(endRaw, 10);
      start = Math.max(totalSize - suffixLength, 0);
      end = totalSize - 1;
    }

    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end < start ||
      start >= totalSize
    ) {
      c.header("Content-Range", `bytes */${totalSize}`);
      return c.body("Requested Range Not Satisfiable", 416);
    }

    end = Math.min(end, totalSize - 1);
    const chunkSize = end - start + 1;
    c.header("Content-Range", `bytes ${start}-${end}/${totalSize}`);
    c.header("Content-Length", String(chunkSize));
    return c.body(toWebStream(createReadStream(filePath, { start, end })), 206);
  } catch (error: unknown) {
    const response = toFilesHttpErrorResponse(error, "Content read failed");
    return c.json({ error: response.message }, response.status);
  }
});

// SSE endpoint for streaming metrics
app.get("/api/metrics/stream", async (c) => {
  metricsService.startMetricsPolling();

  return streamSSE(c, async (stream) => {
    let metrics = metricsService.getCachedMetrics();
    if (!metrics) {
      await metricsService.getOneShotMetrics();
      metrics = metricsService.getCachedMetrics();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (metrics) {
      try {
        stream.writeSSE({
          data: JSON.stringify(metrics),
          event: "metrics",
          id: Date.now().toString(),
        });
      } catch (error) {
        console.error("[deckos] Error sending initial metrics:", error);
        return;
      }
    }

    const unsubscribe = metricsService.subscribeToMetrics((newMetrics) => {
      try {
        stream.writeSSE({
          data: JSON.stringify(newMetrics),
          event: "metrics",
          id: Date.now().toString(),
        });
      } catch (error) {
        console.error("[deckos] Error sending metrics:", error);
        unsubscribe();
      }
    });

    // Send keepalive every 30 seconds
    const keepaliveInterval = setInterval(() => {
      try {
        stream.writeSSE({
          data: "keepalive",
          event: "keepalive",
          id: Date.now().toString(),
        });
      } catch (error) {
        console.error("[deckos] Error sending keepalive:", error);
      }
    }, 30000);

    stream.onAbort(() => {
      clearInterval(keepaliveInterval);
      unsubscribe();
    });

    try {
      await stream.sleep(1000000);
    } catch (error) {
      console.error("[deckos] Stream sleep error:", error);
    }
  });
});

// SSE endpoint for Docker events
app.get("/api/docker/events", async (c) => {
  const docker = await dockerService.getDockerAsync();
  if (!docker) {
    return c.json({ error: "Docker is not available" }, 503);
  }

  return streamSSE(c, async (stream) => {
    const eventStream = (await docker.getEvents({})) as unknown as Readable;

    let buffer = "";
    eventStream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const event = JSON.parse(trimmed);
          stream.writeSSE({
            data: JSON.stringify(event),
            event: "docker-event",
            id: Date.now().toString(),
          });
        } catch (err) {
          console.error("[deckos] Docker event parse error:", err);
        }
      }
    });

    eventStream.on("error", (err) => {
      console.error("Docker events error:", err);
    });

    stream.onAbort(() => {
      eventStream.destroy();
    });

    await stream.sleep(1000000);
  });
});

app.post("/api/apps/:appId/pull/start", async (c) => {
  const { appId } = c.req.param();
  const appIdResult = AppIdSchema.safeParse(appId);
  if (!appIdResult.success) {
    return c.json({ error: "Invalid app id" }, 400);
  }
  try {
    const job = await pullJobsService.startPullJob(appIdResult.data);
    return c.json(job);
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "App not found") {
      return c.json({ error: err.message }, 404);
    }
    return c.json(
      { error: err instanceof Error ? err.message : "Failed to start pull" },
      500
    );
  }
});

app.get("/api/pull/:jobId", async (c) => {
  const { jobId } = c.req.param();
  const job = pullJobsService.getPullJob(jobId);
  if (!job) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.json(job);
});

// SSE endpoint for container logs
app.get("/api/logs/:containerId", async (c) => {
  const { containerId } = c.req.param();
  const tailQuery = c.req.query("tail") || "2000";
  const sinceQuery = c.req.query("since");
  const TailSchema = z.coerce.number().int().min(1).max(LOG_HISTORY_SIZE);
  const parsedTailResult = TailSchema.safeParse(tailQuery);
  if (!parsedTailResult.success) {
    return c.json({ error: "Invalid tail parameter" }, 400);
  }

  const parsedSinceResult = z.coerce
    .number()
    .int()
    .min(0)
    .safeParse(sinceQuery ?? 0);
  if (!parsedSinceResult.success) {
    return c.json({ error: "Invalid since parameter" }, 400);
  }
  const parsedTail = parsedTailResult.data;
  const since = sinceQuery ? parsedSinceResult.data : undefined;

  const docker = await dockerService.getDockerAsync();
  if (!docker) {
    return c.json({ error: "Docker is not available" }, 503);
  }
  const container = docker.getContainer(containerId);

  return streamSSE(c, async (stream) => {
    let isTty = false;
    try {
      const inspect = await container.inspect();
      isTty = !!inspect?.Config?.Tty;
    } catch (err) {
      console.warn("[deckos] Failed to inspect container for logs:", err);
    }

    const logOptions: Dockerode.ContainerLogsOptions & { follow: true } = {
      follow: true,
      stdout: true,
      stderr: true,
      timestamps: false,
    };

    logOptions.tail = parsedTail;
    if (since !== undefined) {
      logOptions.since = since;
    }

    const logStream = (await container.logs(logOptions)) as unknown as Readable;

    let lineBuffer = "";
    let binaryBuffer = Buffer.alloc(0);

    logStream.on("data", (chunk: Buffer) => {
      if (isTty) {
        lineBuffer += chunk.toString("utf-8");
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";

        for (const line of lines) {
          const cleanLine = line.endsWith("\r") ? line.slice(0, -1) : line;
          if (!cleanLine) continue;
          try {
            stream.writeSSE({
              data: JSON.stringify({ line: cleanLine }),
              event: "log",
              id: Date.now().toString(),
            });
          } catch (err) {
            console.error("[deckos] Error streaming logs:", err);
            return;
          }
        }
        return;
      }

      binaryBuffer = Buffer.concat([binaryBuffer, chunk]);

      while (binaryBuffer.length >= 8) {
        const header = binaryBuffer.subarray(0, 8);
        // const type = header.readUInt8(0); // 1 = stdout, 2 = stderr
        const size = header.readUInt32BE(4);

        if (binaryBuffer.length < 8 + size) {
          break;
        }

        const payload = binaryBuffer.subarray(8, 8 + size);
        const text = payload.toString("utf-8");

        lineBuffer += text;
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";

        for (const line of lines) {
          const cleanLine = line.endsWith("\r") ? line.slice(0, -1) : line;
          if (!cleanLine) continue;
          try {
            stream.writeSSE({
              data: JSON.stringify({ line: cleanLine }),
              event: "log",
              id: Date.now().toString(),
            });
          } catch (err) {
            console.error("[deckos] Error streaming logs:", err);
            return;
          }
        }

        binaryBuffer = binaryBuffer.subarray(8 + size);
      }
    });

    logStream.on("error", (err) => {
      console.error("Container logs error:", err);
    });

    stream.onAbort(() => {
      logStream.destroy();
    });

    await stream.sleep(1000000);
  });
});

if (isProduction) {
  app.use("*", serveStatic({ root: clientDistPath }));

  app.notFound((c) => {
    const path = c.req.path;

    if (path.startsWith("/api/")) {
      return c.json({ error: "Not found" }, 404);
    }

    const indexPath = join(clientDistPath, "index.html");
    try {
      const html = readFileSync(indexPath, "utf-8");
      return c.html(html);
    } catch (err) {
      console.error("Failed to serve index.html:", err);
      return c.json({ error: "Server configuration error" }, 500);
    }
  });
}

const portEnv = process.env.PORT ? parseInt(process.env.PORT, 10) : NaN;
const port = Number.isFinite(portEnv) ? portEnv : isProduction ? 3000 : 3001;

if (isProduction) {
  const indexPath = join(clientDistPath, "index.html");
  try {
    if (!existsSync(indexPath)) {
      throw new Error("File not found");
    }
  } catch {
    console.error(`[ERROR] Client build not found at: ${clientDistPath}`);
    console.error('Run "npm run build" before starting in production mode.');
    process.exit(1);
  }
}

try {
  const server = serve({
    fetch: app.fetch,
    port,
  });

  server.on("listening", () => {
    console.log(`[deckos] server running on http://localhost:${port}`);
  });

  server.on("error", (error) => {
    console.error("[deckos] Server error:", error);
    process.exit(1);
  });
} catch (error) {
  console.error("[deckos] Failed to start server:", error);
  process.exit(1);
}
