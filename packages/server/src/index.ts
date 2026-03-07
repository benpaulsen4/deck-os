import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { trpcServer } from "@hono/trpc-server";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "@hono/node-server/serve-static";
import { z } from "zod";
import { appRouter } from "./trpc/router.js";
import { createContext } from "./trpc/context.js";
import * as metricsService from "./services/metrics.js";
import * as dockerService from "./services/docker.js";
import * as pullJobsService from "./services/pullJobs.js";
import * as templatesService from "./services/templates.js";
import { LOG_HISTORY_SIZE } from "./lib/config.js";
import { AppIdSchema } from "./lib/schema.js";
import { readFileSync, existsSync } from "fs";
import { readFile } from "node:fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { Readable } from "node:stream";
import type Dockerode from "dockerode";

dockerService.getDocker();

// Global error handler
process.on("uncaughtException", (error) => {
  console.error("[deckos] Uncaught exception:", error);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[deckos] Unhandled rejection at:", promise, "reason:", reason);
});

const app = new Hono();

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
    createContext: (_opts, _c) => createContext(),
  })
);

// Health check
app.get("/api/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
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

  const parsedSinceResult = z.coerce.number().int().min(0).safeParse(sinceQuery ?? 0);
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
