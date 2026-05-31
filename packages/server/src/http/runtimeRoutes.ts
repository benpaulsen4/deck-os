import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { Readable } from "node:stream";
import type Dockerode from "dockerode";
import { AppIdSchema } from "../lib/schema.js";
import { getCurrentVersion } from "../lib/version.js";
import { LOG_HISTORY_SIZE } from "../lib/config.js";
import * as metricsService from "../services/metrics.js";
import * as dockerService from "../services/docker.js";
import * as pullJobsService from "../services/pullJobs.js";
import {
  DiskAnalysisMountIdentitySchema,
  DiskAnalysisScanEventSchema,
} from "@deckos/contracts";
import * as diskAnalysisService from "../services/diskAnalysis.js";

export function registerRuntimeRoutes(app: Hono) {
  app.get("/api/health", (c) => {
    return c.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.get("/api/version", (c) => {
    return c.json({ version: getCurrentVersion(), timestamp: new Date().toISOString() });
  });

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

  app.get("/api/disk-analysis/jobs/:jobId/events", async (c) => {
    const accept = c.req.header("accept") ?? "";
    if (!accept.toLowerCase().includes("text/event-stream")) {
      return c.json({ error: "This endpoint only supports SSE subscriptions" }, 406);
    }

    const mountParse = DiskAnalysisMountIdentitySchema.safeParse({
      mount: c.req.query("mount"),
      fs: c.req.query("fs"),
    });
    if (!mountParse.success) {
      return c.json({ error: "Invalid disk analysis mount identity" }, 400);
    }

    const { jobId } = c.req.param();
    const bufferedEvents: unknown[] = [];
    let writeBufferedEvent: ((event: unknown) => void) | null = null;
    const unsubscribe = diskAnalysisService.subscribeToJob(jobId, (event) => {
      if (writeBufferedEvent) {
        writeBufferedEvent(event);
        return;
      }
      bufferedEvents.push(event);
    });

    let initialEvent;
    try {
      initialEvent = diskAnalysisService.getJobStreamInitialEvent(jobId, mountParse.data);
    } catch (error) {
      unsubscribe();
      if (error instanceof diskAnalysisService.DiskAnalysisJobNotFoundError) {
        return c.json({ error: error.message }, 404);
      }
      return c.json(
        { error: error instanceof Error ? error.message : "Failed to subscribe" },
        500
      );
    }

    return streamSSE(c, async (stream) => {
      let streamClosed = false;
      const writeEvent = (event: unknown) => {
        const payload = DiskAnalysisScanEventSchema.parse(event);
        stream.writeSSE({
          data: JSON.stringify(payload),
          event: payload.event,
          id: Date.now().toString(),
        });
      };

      writeBufferedEvent = (event) => {
        if (streamClosed) {
          return;
        }
        try {
          writeEvent(event);
        } catch (error) {
          console.error("[deckos] Error sending disk analysis event:", error);
          unsubscribe();
        }
      };

      try {
        writeEvent(initialEvent);
        for (const event of bufferedEvents) {
          writeEvent(event);
        }
      } catch (error) {
        console.error("[deckos] Error sending initial disk analysis event:", error);
        unsubscribe();
        return;
      }

      const keepaliveInterval = setInterval(() => {
        try {
          writeEvent(diskAnalysisService.getJobKeepaliveEvent(jobId));
        } catch (error) {
          console.error("[deckos] Error sending disk analysis keepalive:", error);
        }
      }, 30000);

      stream.onAbort(() => {
        streamClosed = true;
        clearInterval(keepaliveInterval);
        unsubscribe();
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
    const accept = c.req.header("accept") ?? "";
    if (!accept.toLowerCase().includes("text/event-stream")) {
      return c.json(job);
    }
    return streamSSE(c, async (stream) => {
      try {
        stream.writeSSE({
          data: JSON.stringify(job),
          event: "pull",
          id: Date.now().toString(),
        });
      } catch (error) {
        console.error("[deckos] Error sending initial pull status:", error);
        return;
      }

      const unsubscribe = pullJobsService.subscribeToPullJob(jobId, (snapshot) => {
        try {
          stream.writeSSE({
            data: JSON.stringify(snapshot),
            event: "pull",
            id: Date.now().toString(),
          });
        } catch (error) {
          console.error("[deckos] Error sending pull status:", error);
          unsubscribe();
        }
      });

      const keepaliveInterval = setInterval(() => {
        try {
          stream.writeSSE({
            data: "keepalive",
            event: "keepalive",
            id: Date.now().toString(),
          });
        } catch (error) {
          console.error("[deckos] Error sending pull keepalive:", error);
        }
      }, 30000);

      stream.onAbort(() => {
        clearInterval(keepaliveInterval);
        unsubscribe();
      });

      await stream.sleep(1000000);
    });
  });

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
}
