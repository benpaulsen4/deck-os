import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { trpcServer } from "@hono/trpc-server";
import { streamSSE } from "hono/streaming";
import { appRouter } from "./trpc/router.js";
import { createContext } from "./trpc/context.js";
import * as metricsService from "./services/metrics.js";
import * as dockerService from "./services/docker.js";

const app = new Hono();

// CORS for development (client on :5173, server on :3001)
app.use(
  "/api/*",
  cors({
    origin: "http://localhost:5173",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  })
);

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

// SSE endpoint for streaming metrics
app.get("/api/metrics/stream", async (c) => {
  metricsService.startMetricsPolling();
  
  return streamSSE(c, async (stream) => {
    let metrics = metricsService.getCachedMetrics();
    if (!metrics) {
      await new Promise(resolve => setTimeout(resolve, 100));
      metrics = metricsService.getCachedMetrics();
    }
    
    if (metrics) {
      stream.writeSSE({
        data: JSON.stringify(metrics),
        event: "metrics",
        id: Date.now().toString(),
      });
    }
    
    const unsubscribe = metricsService.subscribeToMetrics((newMetrics) => {
      stream.writeSSE({
        data: JSON.stringify(newMetrics),
        event: "metrics",
        id: Date.now().toString(),
      });
    });

    stream.onAbort(() => {
      unsubscribe();
    });

    await stream.sleep(1000000);
  });
});

// SSE endpoint for Docker events
app.get("/api/docker/events", async (c) => {
  const docker = dockerService.getDocker();
  
  return streamSSE(c, async (stream) => {
    const eventStream = await docker.getEvents({}) as NodeJS.ReadableStream;
    
    eventStream.on("data", (chunk: Buffer) => {
      const event = JSON.parse(chunk.toString());
      stream.writeSSE({
        data: JSON.stringify(event),
        event: "docker-event",
        id: Date.now().toString(),
      });
    });

    eventStream.on("error", (err) => {
      console.error("Docker events error:", err);
    });

    stream.onAbort(() => {
      const s = eventStream as any;
      if (s.destroy) s.destroy();
    });

    await stream.sleep(1000000);
  });
});

// SSE endpoint for container logs
app.get("/api/logs/:containerId", async (c) => {
  const { containerId } = c.req.param();
  const tail = c.req.query("tail") || "200";
  
  const docker = dockerService.getDocker();
  const container = docker.getContainer(containerId);
  
  return streamSSE(c, async (stream) => {
    const logStream = await container.logs({
      follow: true,
      tail: parseInt(tail, 10),
      stdout: true,
      stderr: true,
      timestamps: false,
    }) as NodeJS.ReadableStream;

    let buffer = "";
    
    logStream.on("data", (chunk: Buffer) => {
      let offset = 0;
      while (offset < chunk.length) {
        if (chunk.length - offset < 8) break;
        chunk.readUInt8(offset);
        offset++;
        offset += 3;
        const size = chunk.readUInt32BE(offset);
        offset += 4;
        
        if (offset + size > chunk.length) break;
        
        const payload = chunk.slice(offset, offset + size).toString('utf-8');
        offset += size;
        
        buffer += payload;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        
        for (const line of lines) {
          if (line) {
            stream.writeSSE({
              data: JSON.stringify({ line }),
              event: "log",
              id: Date.now().toString(),
            });
          }
        }
      }
    });

    logStream.on("error", (err) => {
      console.error("Container logs error:", err);
    });

    stream.onAbort(() => {
      const s = logStream as any;
      if (s.destroy) s.destroy();
    });

    await stream.sleep(1000000);
  });
});

const port = 3001;
console.log(`[deckos] server running on http://localhost:${port}`);

serve({
  fetch: app.fetch,
  port,
});
