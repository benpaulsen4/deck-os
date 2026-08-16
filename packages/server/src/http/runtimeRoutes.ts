import type { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import { z } from "zod";
import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type Dockerode from "dockerode";
import { AppIdSchema } from "../lib/schema.js";
import { ContainerIdSchema } from "../routers/docker.js";
import { getCurrentVersion } from "../lib/version.js";
import {
  LOG_HISTORY_SIZE,
  LOG_LINE_MAX_CHARS,
  LOG_WRITE_QUEUE_MAX_MESSAGES,
  LOG_WRITE_QUEUE_PAUSE_AT,
  LOG_WRITE_QUEUE_RESUME_AT,
} from "../lib/config.js";
import * as metricsService from "../services/metrics.js";
import * as dockerService from "../services/docker.js";
import * as pullJobsService from "../services/pullJobs.js";
import * as authService from "../services/auth.js";
import {
  DiskAnalysisMountIdentitySchema,
  DiskAnalysisScanEventSchema,
} from "@deckos/contracts";
import * as diskAnalysisService from "../services/diskAnalysis.js";

const SESSION_CHECK_INTERVAL_MS = 30000;

/**
 * Re-validates, on a repeating timer, the session that opened this SSE
 * connection -- reusing `authService.getAuthStatus`, the same helper
 * `protectedProcedure` and the `/api/*` guard use, so an unlocked box
 * (`config.enabled === false`) always reports unlocked and this never closes
 * a stream that has no passcode configured. While the session stays valid,
 * `onTick` runs each interval (omit it for streams that only need the lock
 * check, not a keepalive payload); once it doesn't, the stream is aborted and
 * the interval stops.
 *
 * `stream.abort()` runs the same `stream.onAbort` cleanup a real client
 * disconnect triggers, never throws (Hono swallows write errors on an aborted
 * stream), and closes the response body the client is reading from.
 *
 * Hono's `abort()` is guarded (`if (!this.aborted)`), so a listener added via
 * `stream.onAbort` *after* abort already ran is never invoked. A client that
 * disconnects while an earlier `await` in the route handler is still pending
 * (the Docker round-trip in `/api/docker/events` and `/api/logs/:containerId`,
 * both of which call this function only after `await`ing a Dockerode call)
 * triggers exactly that: `abort()` can run before this function's
 * `setInterval`/`onAbort` calls execute, so cleanup registered here would
 * silently never fire and the interval -- and everything its closure keeps
 * alive -- would leak for the life of the process. Checking `stream.aborted`
 * immediately after registering, with no `await` in between, closes that
 * window: nothing can run between `setInterval` and this check, so it always
 * catches an abort that already happened, while an abort that happens *after*
 * this point is still caught by the `onAbort` listener itself.
 *
 * `onCleanup` (e.g. destroying the underlying Docker stream) runs through
 * this exact same guard rather than a caller's own separate `stream.onAbort`
 * call, so it is never exposed to the too-late-registration race above --
 * that race is what this function exists to close.
 */
function withSessionCheck(
  stream: SSEStreamingApi,
  sessionToken: string | null,
  { onTick, onCleanup }: { onTick?: () => void; onCleanup?: () => void } = {}
): void {
  const interval = setInterval(() => {
    authService
      .getAuthStatus(sessionToken)
      .then((status) => {
        if (!status.unlocked) {
          stream.abort();
          return;
        }
        onTick?.();
      })
      .catch((error) => {
        console.error("[deckos] Error checking session status:", error);
      });
  }, SESSION_CHECK_INTERVAL_MS);

  stream.onAbort(() => {
    clearInterval(interval);
    onCleanup?.();
  });

  if (stream.aborted) {
    clearInterval(interval);
    onCleanup?.();
  }
}

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
    const sessionToken = getCookie(c, authService.getAuthCookieName()) ?? null;

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

      withSessionCheck(stream, sessionToken, {
        onTick: () => {
          try {
            stream.writeSSE({
              data: "keepalive",
              event: "keepalive",
              id: Date.now().toString(),
            });
          } catch (error) {
            console.error("[deckos] Error sending keepalive:", error);
          }
        },
        onCleanup: () => unsubscribe(),
      });

      try {
        await stream.sleep(1000000);
      } catch (error) {
        console.error("[deckos] Stream sleep error:", error);
      }
    });
  });

  app.get("/api/docker/events", async (c) => {
    const sessionToken = getCookie(c, authService.getAuthCookieName()) ?? null;
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

      withSessionCheck(stream, sessionToken, {
        onCleanup: () => eventStream.destroy(),
      });

      await stream.sleep(1000000);
    });
  });

  app.get("/api/disk-analysis/jobs/:jobId/events", async (c) => {
    const sessionToken = getCookie(c, authService.getAuthCookieName()) ?? null;
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
      console.error("[deckos] Error subscribing to disk analysis job:", error);
      return c.json({ error: "Failed to subscribe to disk analysis job" }, 500);
    }

    return streamSSE(c, async (stream) => {
      let streamClosed = false;
      // Server-authored data, validated only as a defence against a bug
      // upstream -- JSON.stringify never mutates, so a failure here reflects
      // a schema/payload mismatch, not anything a client influenced. A parse
      // failure on one event is not allowed to be fatal to the stream: it is
      // logged and the event is dropped, and the caller (whether flushing a
      // buffered batch or forwarding a live update) carries on to whatever
      // comes next instead of unsubscribing or tearing down the connection.
      const writeEvent = (event: unknown) => {
        const result = DiskAnalysisScanEventSchema.safeParse(event);
        if (!result.success) {
          console.error("[deckos] Dropping unparsable disk analysis event:", result.error);
          return;
        }
        // `writeEvent` stays synchronous -- its callers (the buffered-event
        // loop below and the live `diskAnalysisService.subscribeToJob`
        // listener, itself a synchronous callback whose return value is
        // ignored) can't await it. That means a rejection from `writeSSE`
        // can't be caught by a caller's `try/catch` either, since that only
        // ever sees a *synchronous* throw. Attaching `.catch()` here routes a
        // rejection into the same handling a synchronous throw already gets
        // one level up, in `writeBufferedEvent` -- mirroring the detached
        // write in the log route's `enqueue`/`drain` above.
        stream
          .writeSSE({
            data: JSON.stringify(result.data),
            event: result.data.event,
            id: Date.now().toString(),
          })
          .catch((error) => {
            console.error("[deckos] Error sending disk analysis event:", error);
            unsubscribe();
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

      withSessionCheck(stream, sessionToken, {
        onTick: () => {
          try {
            writeEvent(diskAnalysisService.getJobKeepaliveEvent(jobId));
          } catch (error) {
            console.error("[deckos] Error sending disk analysis keepalive:", error);
          }
        },
      });

      stream.onAbort(() => {
        streamClosed = true;
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
      console.error("[deckos] Error starting pull job:", err);
      return c.json({ error: "Failed to start pull" }, 500);
    }
  });

  app.get("/api/pull/:jobId", async (c) => {
    const sessionToken = getCookie(c, authService.getAuthCookieName()) ?? null;
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

      withSessionCheck(stream, sessionToken, {
        onTick: () => {
          try {
            stream.writeSSE({
              data: "keepalive",
              event: "keepalive",
              id: Date.now().toString(),
            });
          } catch (error) {
            console.error("[deckos] Error sending pull keepalive:", error);
          }
        },
      });

      stream.onAbort(() => {
        unsubscribe();
      });

      await stream.sleep(1000000);
    });
  });

  app.get("/api/logs/:containerId", async (c) => {
    const sessionToken = getCookie(c, authService.getAuthCookieName()) ?? null;
    const { containerId } = c.req.param();
    const containerIdResult = ContainerIdSchema.safeParse(containerId);
    if (!containerIdResult.success) {
      return c.json({ error: "Invalid container id" }, 400);
    }
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
    const container = docker.getContainer(containerIdResult.data);

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

      // --- SSE write queue -------------------------------------------------
      // `writeSSE` returns a promise that only settles once the underlying
      // TransformStream has room. Firing it and walking away (as this route
      // used to) throws that backpressure signal away: a chatty container and
      // a slow reader accumulate pending write promises until the process runs
      // out of memory. Serialising the writes through this queue is what makes
      // the signal observable -- `writeQueue.length` is how far behind the
      // client is -- and gives somewhere to enforce a bound.
      const writeQueue: { data: string; event: string; id: string }[] = [];
      let draining = false;
      let sourcePaused = false;
      let droppedLines = 0;

      const resumeSource = () => {
        if (sourcePaused && writeQueue.length <= LOG_WRITE_QUEUE_RESUME_AT) {
          sourcePaused = false;
          logStream.resume();
        }
      };

      const drain = async () => {
        if (draining) return;
        draining = true;
        try {
          while (!stream.aborted && !stream.closed) {
            if (droppedLines > 0) {
              const dropped = droppedLines;
              droppedLines = 0;
              // Sent as a `line` payload because that is the only field the log
              // viewer renders. The gap sits exactly here -- the discarded
              // messages were the ones ahead of whatever is now at the front of
              // the queue -- so the notice lands in the right place in the
              // output rather than the client silently missing output.
              await stream.writeSSE({
                data: JSON.stringify({
                  line: `[deckos] dropped ${dropped} log line${dropped === 1 ? "" : "s"}: this container is producing output faster than the browser can read it`,
                  dropped,
                }),
                event: "log-dropped",
                id: Date.now().toString(),
              });
              continue;
            }

            const message = writeQueue.shift();
            if (!message) break;
            await stream.writeSSE(message);
            resumeSource();
          }
        } finally {
          draining = false;
          resumeSource();
        }
      };

      const enqueue = (message: { data: string; event: string; id: string }) => {
        if (stream.aborted || stream.closed) return;
        writeQueue.push(message);

        if (writeQueue.length > LOG_WRITE_QUEUE_MAX_MESSAGES) {
          // Drop oldest. For a live log tail the newest lines are the ones the
          // user is watching, and discarding from the front also bounds how
          // stale the surviving queue can be. Only reachable when a single
          // Docker chunk expands past the cap, since the pause below stops the
          // source between chunks.
          droppedLines += writeQueue.length - LOG_WRITE_QUEUE_MAX_MESSAGES;
          writeQueue.splice(0, writeQueue.length - LOG_WRITE_QUEUE_MAX_MESSAGES);
        }

        if (!sourcePaused && writeQueue.length >= LOG_WRITE_QUEUE_PAUSE_AT) {
          // Real backpressure: pausing the Docker stream lets it propagate to
          // the daemon rather than blocking this handler, which is the one
          // thing awaiting `writeSSE` inline here could not do safely.
          sourcePaused = true;
          logStream.pause();
        }

        // Dormant today: `writeSSE` cannot reject here, since Hono's `write`
        // swallows every writer error and its only throw path is CR/LF
        // validation on `event`/`id`, both hardcoded safe above. Caught anyway
        // because this loop is detached -- an unhandled rejection here would
        // take down the whole process, every route and every other container's
        // log stream with it, not just this one connection.
        void drain().catch((err) => {
          console.error("[deckos] Log stream write queue failed:", err);
        });
      };

      // --- line assembly ---------------------------------------------------
      // Held as an array of pieces with a running length, joined once per
      // emitted line. Re-splitting a growing string on every chunk (what this
      // route used to do) is O(n^2) in the length of the line.
      let pendingLine: string[] = [];
      let pendingLineChars = 0;

      const takePendingLine = () => {
        if (pendingLineChars === 0) return "";
        const text = pendingLine.join("");
        pendingLine = [];
        pendingLineChars = 0;
        return text;
      };

      const emitLine = (line: string, truncated: boolean) => {
        // A truncated piece is a mid-line fragment, so a trailing `\r` is
        // content there rather than a line ending.
        const cleanLine = !truncated && line.endsWith("\r") ? line.slice(0, -1) : line;
        if (!cleanLine) return;
        enqueue({
          data: JSON.stringify(truncated ? { line: cleanLine, truncated } : { line: cleanLine }),
          event: "log",
          id: Date.now().toString(),
        });
      };

      // Buffers `text[from, to)`, flushing at the cap: a container emitting one
      // endless line would otherwise grow this without limit. Flushing (rather
      // than discarding) means the bound costs line framing and never bytes --
      // the client gets every character, marked as a continuation.
      //
      // The flush happens on the way *in*, only once there is more content to
      // add, rather than eagerly the moment the buffer fills. That is what
      // makes `truncated` honest: a line whose length is an exact multiple of
      // the cap is full and complete at the same instant, and flushing eagerly
      // would label the finished line a continuation of something that never
      // follows. Deferring means a full buffer is only ever declared truncated
      // once a further character proves the line really does continue -- which
      // also covers the case where that character arrives in a later chunk, so
      // a caller-supplied "this range ends at a newline" flag could not.
      const appendPendingLine = (text: string, from: number, to: number) => {
        let offset = from;
        while (offset < to) {
          if (pendingLineChars >= LOG_LINE_MAX_CHARS) {
            emitLine(takePendingLine(), true);
          }
          const take = Math.min(LOG_LINE_MAX_CHARS - pendingLineChars, to - offset);
          pendingLine.push(text.slice(offset, offset + take));
          pendingLineChars += take;
          offset += take;
        }
      };

      const pushText = (text: string) => {
        if (!text) return;
        let offset = 0;

        for (;;) {
          const index = text.indexOf("\n", offset);
          if (index === -1) break;
          // Routed through the same capped append rather than emitted directly,
          // so a line that arrives already terminated inside one chunk obeys the
          // cap too instead of becoming a single oversized message. An empty
          // line leaves nothing pending and `emitLine` skips it, as before.
          appendPendingLine(text, offset, index);
          emitLine(takePendingLine(), false);
          offset = index + 1;
        }

        appendPendingLine(text, offset, text.length);
      };

      // Emits whatever unterminated text is still buffered. Deferring the cap
      // flush (above) means a full buffer waits for proof that the line
      // continues -- so if the container stops producing output, or the log
      // stream ends, that proof never comes and the fragment would otherwise
      // sit here forever. This is the other half of that bargain, and it also
      // closes a loss that predates the buffering work entirely: *any*
      // trailing line without a newline used to be discarded at end of stream,
      // not just an exact-cap one.
      //
      // Not a continuation: nothing follows it, so it is flagged as a complete
      // line. Idempotent -- `takePendingLine` clears the buffer, so the
      // `end`/`close` pair only ever emits once. Safe on dead streams too:
      // `enqueue` no-ops once the SSE stream is aborted or closed, so a flush
      // on a teardown path that can no longer write cannot throw and cannot
      // wedge the drain loop.
      const flushPendingLine = () => {
        const trailing = takePendingLine();
        if (trailing) emitLine(trailing, false);
      };

      // --- docker frame demultiplexing -------------------------------------
      // Payload bytes are fed to the line assembler as they arrive rather than
      // buffered until the frame is complete, so the only per-frame state is a
      // partial 8-byte header plus whatever partial UTF-8 sequence the decoder
      // holds (at most 3 bytes). That removes the `Buffer.concat`-per-chunk
      // growth entirely, and, unlike decoding each frame independently, keeps
      // a multi-byte character split across two frames intact.
      const decoder = new StringDecoder("utf8");
      const frameHeader = Buffer.alloc(8);
      let frameHeaderBytes = 0;
      let framePayloadRemaining = 0;

      logStream.on("data", (chunk: Buffer) => {
        if (isTty) {
          pushText(decoder.write(chunk));
          return;
        }

        let offset = 0;
        while (offset < chunk.length) {
          if (framePayloadRemaining > 0) {
            const take = Math.min(framePayloadRemaining, chunk.length - offset);
            pushText(decoder.write(chunk.subarray(offset, offset + take)));
            offset += take;
            framePayloadRemaining -= take;
            continue;
          }

          const take = Math.min(8 - frameHeaderBytes, chunk.length - offset);
          chunk.copy(frameHeader, frameHeaderBytes, offset, offset + take);
          frameHeaderBytes += take;
          offset += take;
          if (frameHeaderBytes === 8) {
            framePayloadRemaining = frameHeader.readUInt32BE(4);
            frameHeaderBytes = 0;
          }
        }
      });

      // `end` is the case that matters: the container stopped producing output
      // but the client is still attached, so the SSE stream is open and the
      // trailing fragment can still be delivered. `close` covers the rest
      // (error, destroy) and is a no-op once `end` has already flushed.
      logStream.on("end", flushPendingLine);
      logStream.on("close", flushPendingLine);

      logStream.on("error", (err) => {
        console.error("Container logs error:", err);
      });

      withSessionCheck(stream, sessionToken, {
        onCleanup: () => {
          // Flushes rather than discards. F1 only ever runs `onCleanup` with
          // the stream already aborted -- from the `onAbort` subscriber or the
          // synchronous `stream.aborted` guard -- so in practice `enqueue`
          // no-ops here and this just clears the buffer. It is written as a
          // flush anyway so that the buffer has exactly one disposal path, and
          // so this stays correct if a teardown route that can still write is
          // ever added.
          flushPendingLine();
          writeQueue.length = 0;
          logStream.destroy();
        },
      });

      await stream.sleep(1000000);
    });
  });
}
