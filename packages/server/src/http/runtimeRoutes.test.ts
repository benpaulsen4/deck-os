import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as authService from "../services/auth.js";
import {
  DATA_DIR,
  LOG_LINE_MAX_CHARS,
  LOG_WRITE_QUEUE_MAX_MESSAGES,
  LOG_WRITE_QUEUE_PAUSE_AT,
} from "../lib/config.js";

const metricsMock = vi.hoisted(() => ({
  getCachedMetrics: vi.fn<() => unknown | null>(() => null),
  getOneShotMetrics: vi.fn(async () => undefined),
  subscribeToMetrics: vi.fn(() => () => undefined),
}));

const dockerMock = vi.hoisted(() => ({
  getDockerAsync: vi.fn(),
}));

const pullJobsMock = vi.hoisted(() => ({
  startPullJob: vi.fn(),
  getPullJob: vi.fn(),
  subscribeToPullJob: vi.fn(() => () => undefined),
}));

const diskAnalysisMock = vi.hoisted(() => ({
  getJobStreamInitialEvent: vi.fn(),
  subscribeToJob: vi.fn(() => () => undefined),
  getJobKeepaliveEvent: vi.fn((jobId: string) => ({ event: "keepalive", jobId })),
  DiskAnalysisJobNotFoundError: class DiskAnalysisJobNotFoundError extends Error {},
}));

const versionMock = vi.hoisted(() => ({
  getCurrentVersion: vi.fn(() => "0.0.0-test"),
}));

// Lets a single test make the real `stream.writeSSE()` reject, to prove a
// caller that doesn't await it still gets the rejection handled rather than
// leaking an unhandled rejection. Everything else passes through to the real
// `hono/streaming` implementation unchanged.
const sseInterceptor = vi.hoisted(() => ({ rejectNext: 0 }));

vi.mock("../services/metrics.js", () => metricsMock);
vi.mock("../services/docker.js", () => dockerMock);
vi.mock("../services/pullJobs.js", () => pullJobsMock);
vi.mock("../services/diskAnalysis.js", () => diskAnalysisMock);
vi.mock("../lib/version.js", () => versionMock);
vi.mock("hono/streaming", async (importOriginal) => {
  const actual = await importOriginal<typeof import("hono/streaming")>();
  return {
    ...actual,
    streamSSE: (
      c: Parameters<typeof actual.streamSSE>[0],
      cb: Parameters<typeof actual.streamSSE>[1],
      onError?: Parameters<typeof actual.streamSSE>[2]
    ) =>
      actual.streamSSE(
        c,
        (stream) => {
          const originalWriteSSE = stream.writeSSE.bind(stream);
          stream.writeSSE = (message) => {
            if (sseInterceptor.rejectNext > 0) {
              sseInterceptor.rejectNext -= 1;
              return Promise.reject(new Error("simulated writeSSE failure"));
            }
            return originalWriteSSE(message);
          };
          return cb(stream);
        },
        onError
      ),
  };
});

import { registerRuntimeRoutes } from "./runtimeRoutes.js";

function createApp() {
  const app = new Hono();
  registerRuntimeRoutes(app);
  return app;
}

function getResponseReader(response: Response) {
  if (!response.body) {
    throw new Error("Expected response body stream");
  }
  return response.body.getReader();
}

describe("runtimeRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dockerMock.getDockerAsync.mockResolvedValue(null);
    sseInterceptor.rejectNext = 0;
  });

  test("health endpoint returns ok payload", async () => {
    const app = createApp();
    const res = await app.request("http://localhost/api/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ok",
      timestamp: expect.any(String),
    });
  });

  test("version endpoint returns current version payload", async () => {
    const app = createApp();
    const res = await app.request("http://localhost/api/version");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      version: "0.0.0-test",
      timestamp: expect.any(String),
    });
  });

  test("docker status reports unavailable docker", async () => {
    const app = createApp();
    const res = await app.request("http://localhost/api/docker/status");
    const body = (await res.json()) as {
      available: boolean;
      message: string;
    };

    expect(res.status).toBe(200);
    expect(body.available).toBe(false);
    expect(body.message).toContain("Docker is not accessible");
  });

  test("pull start validates app id", async () => {
    const app = createApp();
    const res = await app.request("http://localhost/api/apps/Bad App/pull/start", {
      method: "POST",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid app id" });
  });

  test("pull start maps app not found errors to 404", async () => {
    pullJobsMock.startPullJob.mockRejectedValue(new Error("App not found"));
    const app = createApp();
    const res = await app.request("http://localhost/api/apps/my-app/pull/start", {
      method: "POST",
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "App not found" });
  });

  test("pull start does not disclose host filesystem layout on unexpected errors", async () => {
    pullJobsMock.startPullJob.mockRejectedValue(
      new Error(
        "ENOENT: no such file or directory, open '/var/lib/deckos/apps/my-app/docker-compose.yml'"
      )
    );
    const app = createApp();
    const res = await app.request("http://localhost/api/apps/my-app/pull/start", {
      method: "POST",
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to start pull" });
  });

  test("pull status returns json snapshot when accept is not SSE", async () => {
    pullJobsMock.getPullJob.mockReturnValue({
      jobId: "job-1",
      appId: "my-app",
      status: "running",
      progress: {
        currentBytes: null,
        totalBytes: null,
        percent: 10,
        completedImages: 0,
        totalImages: 1,
        indeterminate: true,
      },
    });
    const app = createApp();

    const res = await app.request("http://localhost/api/pull/job-1");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      jobId: "job-1",
      appId: "my-app",
      status: "running",
      progress: {
        currentBytes: null,
        totalBytes: null,
        percent: 10,
        completedImages: 0,
        totalImages: 1,
        indeterminate: true,
      },
    });
  });

  test("pull status streams initial SSE snapshot for event-stream requests", async () => {
    pullJobsMock.getPullJob.mockReturnValue({
      jobId: "job-2",
      appId: "my-app",
      status: "running",
      progress: {
        currentBytes: null,
        totalBytes: null,
        percent: 33,
        completedImages: 0,
        totalImages: 3,
        indeterminate: true,
      },
    });
    pullJobsMock.subscribeToPullJob.mockReturnValue(() => undefined);
    const app = createApp();

    const res = await app.request("http://localhost/api/pull/job-2", {
      headers: {
        accept: "text/event-stream",
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = getResponseReader(res);
    const chunk = await reader.read();
    await reader.cancel();
    const payload = new TextDecoder().decode(chunk.value);
    expect(payload).toContain("event: pull");
    expect(payload).toContain('"jobId":"job-2"');
  });

  test("metrics stream sends initial cached metrics event", async () => {
    metricsMock.getCachedMetrics.mockReturnValue({
      cpuPercent: 12,
      memory: { used: 100, total: 200, percent: 50 },
    });
    const unsubscribe = vi.fn();
    metricsMock.subscribeToMetrics.mockReturnValue(unsubscribe);
    const app = createApp();

    const res = await app.request("http://localhost/api/metrics/stream");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = getResponseReader(res);
    const first = await reader.read();
    await reader.cancel();
    const payload = new TextDecoder().decode(first.value);
    expect(payload).toContain("event: metrics");
    expect(payload).toContain('"cpuPercent":12');
  });

  test("docker events stream emits parsed event payloads", async () => {
    const eventsStream = new PassThrough();
    const getEvents = vi.fn(async () => eventsStream);
    dockerMock.getDockerAsync.mockResolvedValue({
      getEvents,
    });
    const app = createApp();

    const res = await app.request("http://localhost/api/docker/events");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = getResponseReader(res);
    eventsStream.write('{"status":"start","id":"c1"}\n');
    const first = await reader.read();
    await reader.cancel();
    const payload = new TextDecoder().decode(first.value);
    expect(payload).toContain("event: docker-event");
    expect(payload).toContain('"status":"start"');
    expect(getEvents).toHaveBeenCalledTimes(1);
  });

  test("disk analysis events endpoint rejects non-SSE requests", async () => {
    const app = createApp();
    const res = await app.request(
      "http://localhost/api/disk-analysis/jobs/job-1/events?mount=C%3A%5C&fs=ntfs"
    );

    expect(res.status).toBe(406);
    expect(await res.json()).toEqual({
      error: "This endpoint only supports SSE subscriptions",
    });
  });

  test("disk analysis events endpoint rejects invalid mount identities", async () => {
    const app = createApp();
    const res = await app.request(
      "http://localhost/api/disk-analysis/jobs/job-1/events?mount=.&fs=ntfs",
      {
        headers: {
          accept: "text/event-stream",
        },
      }
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Invalid disk analysis mount identity",
    });
  });

  test("disk analysis events endpoint maps missing jobs to 404", async () => {
    diskAnalysisMock.getJobStreamInitialEvent.mockImplementation(() => {
      throw new diskAnalysisMock.DiskAnalysisJobNotFoundError("missing-job");
    });
    const app = createApp();
    const res = await app.request(
      "http://localhost/api/disk-analysis/jobs/missing-job/events?mount=C%3A%5C&fs=ntfs",
      {
        headers: {
          accept: "text/event-stream",
        },
      }
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "missing-job",
    });
  });

  test("disk analysis events endpoint maps unexpected subscription errors to 500 without leaking host paths", async () => {
    diskAnalysisMock.getJobStreamInitialEvent.mockImplementation(() => {
      throw new Error(
        "ENOENT: no such file or directory, open '/var/lib/deckos/disk-analysis/job-1.json'"
      );
    });
    const app = createApp();
    const res = await app.request(
      "http://localhost/api/disk-analysis/jobs/job-1/events?mount=C%3A%5C&fs=ntfs",
      {
        headers: {
          accept: "text/event-stream",
        },
      }
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "Failed to subscribe to disk analysis job",
    });
  });

  test("disk analysis events endpoint streams initial SSE payloads", async () => {
    diskAnalysisMock.getJobStreamInitialEvent.mockReturnValue({
      event: "status",
      job: {
        jobId: "11111111-1111-1111-1111-111111111111",
        mount: { mount: "C:\\", fs: "ntfs" },
        phase: "scanning",
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        progress: {
          directoriesDiscovered: 1,
          directoriesCompleted: 0,
          filesDiscovered: 0,
          bytesProcessed: 0,
        },
        issues: [],
        limits: {
          maxWorkers: 2,
          maxPendingDirectories: 10,
          maxIndexedNodes: 100,
        },
      },
    });
    const app = createApp();

    const res = await app.request(
      "http://localhost/api/disk-analysis/jobs/11111111-1111-1111-1111-111111111111/events?mount=C%3A%5C&fs=ntfs",
      {
        headers: {
          accept: "text/event-stream",
        },
      }
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = getResponseReader(res);
    const first = await reader.read();
    await reader.cancel();
    const payload = new TextDecoder().decode(first.value);
    expect(payload).toContain("event: status");
    expect(payload).toContain('"phase":"scanning"');
    expect(diskAnalysisMock.subscribeToJob).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      expect.any(Function)
    );
    expect(diskAnalysisMock.subscribeToJob.mock.invocationCallOrder[0]).toBeLessThan(
      diskAnalysisMock.getJobStreamInitialEvent.mock.invocationCallOrder[0]
    );
  });

  test("disk analysis events endpoint does not lose events emitted during subscription setup", async () => {
    diskAnalysisMock.getJobStreamInitialEvent.mockReturnValue({
      event: "status",
      job: {
        jobId: "11111111-1111-1111-1111-111111111111",
        mount: { mount: "C:\\", fs: "ntfs" },
        phase: "scanning",
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        progress: {
          directoriesDiscovered: 1,
          directoriesCompleted: 0,
          filesDiscovered: 0,
          bytesProcessed: 0,
        },
        issues: [],
        limits: {
          maxWorkers: 2,
          maxPendingDirectories: 10,
          maxIndexedNodes: 100,
        },
      },
    });
    diskAnalysisMock.subscribeToJob.mockImplementationOnce(
      ((...args: unknown[]) => {
        const listener = args[1] as (event: unknown) => void;
        listener({
          event: "status",
          job: {
            jobId: "11111111-1111-1111-1111-111111111111",
            mount: { mount: "C:\\", fs: "ntfs" },
            phase: "completed",
            startedAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:01:00.000Z",
            progress: {
              directoriesDiscovered: 1,
              directoriesCompleted: 1,
              filesDiscovered: 1,
              bytesProcessed: 128,
            },
            issues: [],
            limits: {
              maxWorkers: 2,
              maxPendingDirectories: 10,
              maxIndexedNodes: 100,
            },
          },
        });
        return () => undefined;
      }) as unknown as () => () => undefined
    );
    const app = createApp();

    const res = await app.request(
      "http://localhost/api/disk-analysis/jobs/11111111-1111-1111-1111-111111111111/events?mount=C%3A%5C&fs=ntfs",
      {
        headers: {
          accept: "text/event-stream",
        },
      }
    );

    expect(res.status).toBe(200);
    const reader = getResponseReader(res);
    const first = await reader.read();
    const second = await reader.read();
    await reader.cancel();
    const payload = `${new TextDecoder().decode(first.value)}${new TextDecoder().decode(second.value)}`;
    expect(payload).toContain('"phase":"scanning"');
    expect(payload).toContain('"phase":"completed"');
  });

  test("disk analysis events endpoint tears down the subscription when writeSSE rejects, without leaking an unhandled rejection", async () => {
    diskAnalysisMock.getJobStreamInitialEvent.mockReturnValue({
      event: "status",
      job: {
        jobId: "11111111-1111-1111-1111-111111111111",
        mount: { mount: "C:\\", fs: "ntfs" },
        phase: "scanning",
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        progress: {
          directoriesDiscovered: 1,
          directoriesCompleted: 0,
          filesDiscovered: 0,
          bytesProcessed: 0,
        },
        issues: [],
        limits: {
          maxWorkers: 2,
          maxPendingDirectories: 10,
          maxIndexedNodes: 100,
        },
      },
    });

    const unsubscribeSpy = vi.fn();
    let capturedListener: ((event: unknown) => void) | undefined;
    diskAnalysisMock.subscribeToJob.mockImplementationOnce(
      ((...args: unknown[]) => {
        capturedListener = args[1] as (event: unknown) => void;
        return unsubscribeSpy;
      }) as unknown as () => () => undefined
    );

    const app = createApp();
    const res = await app.request(
      "http://localhost/api/disk-analysis/jobs/11111111-1111-1111-1111-111111111111/events?mount=C%3A%5C&fs=ntfs",
      {
        headers: {
          accept: "text/event-stream",
        },
      }
    );

    expect(res.status).toBe(200);
    const reader = getResponseReader(res);
    await reader.read();

    expect(capturedListener).toBeDefined();

    // Make the *next* writeSSE call reject, then simulate a live event
    // arriving through the job listener. `writeEvent` calls `writeSSE`
    // without awaiting it -- this proves that rejection is still handled
    // (logged, subscription torn down) instead of becoming an unhandled
    // promise rejection that vitest would otherwise fail this test for.
    sseInterceptor.rejectNext = 1;
    capturedListener?.({
      event: "status",
      job: {
        jobId: "11111111-1111-1111-1111-111111111111",
        mount: { mount: "C:\\", fs: "ntfs" },
        phase: "completed",
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:01:00.000Z",
        progress: {
          directoriesDiscovered: 1,
          directoriesCompleted: 1,
          filesDiscovered: 1,
          bytesProcessed: 128,
        },
        issues: [],
        limits: {
          maxWorkers: 2,
          maxPendingDirectories: 10,
          maxIndexedNodes: 100,
        },
      },
    });

    // Let the rejected writeSSE promise's rejection handler (or, pre-fix,
    // vitest's unhandled-rejection detector) run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Asserted *before* cancelling the reader: cancelling triggers the
    // stream's own `onAbort` -> `unsubscribe()` path, which would call
    // `unsubscribeSpy` regardless of whether the writeSSE rejection is
    // handled. Checking here isolates the rejection-handling teardown from
    // that unrelated abort-triggered teardown.
    expect(unsubscribeSpy).toHaveBeenCalledTimes(1);

    await reader.cancel();
  });

  test("disk analysis events endpoint skips an unparsable event instead of wedging the stream", async () => {
    diskAnalysisMock.getJobStreamInitialEvent.mockReturnValue({
      event: "status",
      job: {
        jobId: "11111111-1111-1111-1111-111111111111",
        mount: { mount: "C:\\", fs: "ntfs" },
        phase: "scanning",
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        progress: {
          directoriesDiscovered: 1,
          directoriesCompleted: 0,
          filesDiscovered: 0,
          bytesProcessed: 0,
        },
        issues: [],
        limits: {
          maxWorkers: 2,
          maxPendingDirectories: 10,
          maxIndexedNodes: 100,
        },
      },
    });
    diskAnalysisMock.subscribeToJob.mockImplementationOnce(
      ((...args: unknown[]) => {
        const listener = args[1] as (event: unknown) => void;
        // Malformed: fails DiskAnalysisScanEventSchema entirely (no matching
        // discriminant). A single bad event must not stop later, valid events
        // from reaching the client.
        listener({ event: "not-a-real-event" });
        listener({
          event: "status",
          job: {
            jobId: "11111111-1111-1111-1111-111111111111",
            mount: { mount: "C:\\", fs: "ntfs" },
            phase: "completed",
            startedAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:01:00.000Z",
            progress: {
              directoriesDiscovered: 1,
              directoriesCompleted: 1,
              filesDiscovered: 1,
              bytesProcessed: 128,
            },
            issues: [],
            limits: {
              maxWorkers: 2,
              maxPendingDirectories: 10,
              maxIndexedNodes: 100,
            },
          },
        });
        return () => undefined;
      }) as unknown as () => () => undefined
    );
    const app = createApp();

    const res = await app.request(
      "http://localhost/api/disk-analysis/jobs/11111111-1111-1111-1111-111111111111/events?mount=C%3A%5C&fs=ntfs",
      {
        headers: {
          accept: "text/event-stream",
        },
      }
    );

    expect(res.status).toBe(200);
    const reader = getResponseReader(res);
    const first = await reader.read();
    const second = await reader.read();
    await reader.cancel();
    const payload = `${new TextDecoder().decode(first.value)}${new TextDecoder().decode(second.value)}`;
    expect(payload).toContain('"phase":"scanning"');
    expect(payload).toContain('"phase":"completed"');
  });

  test("logs endpoint validates tail query before docker lookup", async () => {
    const app = createApp();
    const res = await app.request("http://localhost/api/logs/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef?tail=0");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid tail parameter" });
    expect(dockerMock.getDockerAsync).not.toHaveBeenCalled();
  });

  test("logs endpoint rejects invalid container ids before touching docker", async () => {
    const app = createApp();
    const res = await app.request(
      "http://localhost/api/logs/not-a-real-container-id?tail=100"
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid container id" });
    expect(dockerMock.getDockerAsync).not.toHaveBeenCalled();
  });

  test("logs endpoint returns 503 when docker is unavailable", async () => {
    const app = createApp();
    const res = await app.request("http://localhost/api/logs/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef?tail=100");

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Docker is not available" });
  });

  test("logs endpoint streams demultiplexed non-tty docker log frames", async () => {
    const logStream = new PassThrough();
    const container = {
      inspect: vi.fn(async () => ({ Config: { Tty: false } })),
      logs: vi.fn(async () => logStream),
    };
    dockerMock.getDockerAsync.mockResolvedValue({
      getContainer: vi.fn(() => container),
    });
    const app = createApp();

    const res = await app.request("http://localhost/api/logs/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef?tail=100");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = getResponseReader(res);
    const line = Buffer.from("line-one\n", "utf8");
    const header = Buffer.alloc(8);
    header.writeUInt8(1, 0);
    header.writeUInt32BE(line.length, 4);
    logStream.write(Buffer.concat([header, line]));

    const first = await reader.read();
    await reader.cancel();
    const payload = new TextDecoder().decode(first.value);
    expect(payload).toContain("event: log");
    expect(payload).toContain('"line":"line-one"');
  });
});

describe("runtimeRoutes session lock (AUTH-6)", () => {
  const createdDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    dockerMock.getDockerAsync.mockResolvedValue(null);
    sseInterceptor.rejectNext = 0;
  });

  afterEach(async () => {
    vi.useRealTimers();
    // Restores the storage path to production's default (this also resets
    // in-memory auth state) so a later-appended describe block never inherits
    // a path pointing at a temp dir this block has already removed.
    authService.setAuthStoragePathForTests(DATA_DIR);
    await Promise.all(createdDirs.splice(0).map((dir) => fs.remove(dir)));
  });

  /**
   * Drains pending microtasks without advancing the fake clock. Needed after
   * resolving a promise created outside vitest's fake-timer machinery (like a
   * manually deferred Docker call): `vi.advanceTimersByTimeAsync` flushes the
   * timer queue it manages, but is not a general-purpose microtask drain, so a
   * multi-hop `await` chain resuming from an externally-resolved promise can
   * still be mid-flight when it returns.
   */
  async function flushMicrotasks(hops = 10) {
    for (let i = 0; i < hops; i++) {
      await Promise.resolve();
    }
  }

  /** Configures a real passcode and returns a genuinely valid session cookie. */
  async function setupUnlockedSession() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "deckos-runtime-lock-"));
    createdDirs.push(root);
    authService.setAuthStoragePathForTests(root);
    await authService.configureAuth({ passcode: "1234", sessionDurationMs: 3_600_000 });
    const { token } = await authService.unlock({ passcode: "1234", ip: "127.0.0.1" });
    return { cookie: `deckos_session=${token}`, token };
  }

  test("closes the metrics stream when the session is locked", async () => {
    const { cookie, token } = await setupUnlockedSession();
    metricsMock.getCachedMetrics.mockReturnValue({ cpuPercent: 5 });
    const app = createApp();

    vi.useFakeTimers();
    const res = await app.request("http://localhost/api/metrics/stream", {
      headers: { cookie },
    });
    expect(res.status).toBe(200);

    const reader = getResponseReader(res);
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toContain("event: metrics");

    authService.revokeSession(token);
    await vi.advanceTimersByTimeAsync(31_000);

    const second = await reader.read();
    expect(second.done).toBe(true);
  });

  test("keeps the metrics stream open when no passcode is configured", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "deckos-runtime-lock-"));
    createdDirs.push(root);
    authService.setAuthStoragePathForTests(root);
    metricsMock.getCachedMetrics.mockReturnValue({ cpuPercent: 5 });
    const app = createApp();

    vi.useFakeTimers();
    const res = await app.request("http://localhost/api/metrics/stream");
    expect(res.status).toBe(200);

    const reader = getResponseReader(res);
    const first = await reader.read();
    expect(first.done).toBe(false);

    await vi.advanceTimersByTimeAsync(31_000);

    const second = await reader.read();
    expect(second.done).toBe(false);
    expect(new TextDecoder().decode(second.value)).toContain("event: keepalive");

    await reader.cancel();
  });

  test("closes the pull status stream when the session is locked", async () => {
    const { cookie, token } = await setupUnlockedSession();
    pullJobsMock.getPullJob.mockReturnValue({
      jobId: "job-lock",
      appId: "my-app",
      status: "running",
      progress: {
        currentBytes: null,
        totalBytes: null,
        percent: 10,
        completedImages: 0,
        totalImages: 1,
        indeterminate: true,
      },
    });
    const app = createApp();

    vi.useFakeTimers();
    const res = await app.request("http://localhost/api/pull/job-lock", {
      headers: { cookie, accept: "text/event-stream" },
    });
    expect(res.status).toBe(200);

    const reader = getResponseReader(res);
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toContain("event: pull");

    authService.revokeSession(token);
    await vi.advanceTimersByTimeAsync(31_000);

    const second = await reader.read();
    expect(second.done).toBe(true);
  });

  test("closes the disk analysis events stream when the session is locked", async () => {
    const { cookie, token } = await setupUnlockedSession();
    diskAnalysisMock.getJobStreamInitialEvent.mockReturnValue({
      event: "status",
      job: {
        jobId: "11111111-1111-1111-1111-111111111111",
        mount: { mount: "C:\\", fs: "ntfs" },
        phase: "scanning",
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        progress: {
          directoriesDiscovered: 1,
          directoriesCompleted: 0,
          filesDiscovered: 0,
          bytesProcessed: 0,
        },
        issues: [],
        limits: {
          maxWorkers: 2,
          maxPendingDirectories: 10,
          maxIndexedNodes: 100,
        },
      },
    });
    const app = createApp();

    vi.useFakeTimers();
    const res = await app.request(
      "http://localhost/api/disk-analysis/jobs/11111111-1111-1111-1111-111111111111/events?mount=C%3A%5C&fs=ntfs",
      {
        headers: { cookie, accept: "text/event-stream" },
      }
    );
    expect(res.status).toBe(200);

    const reader = getResponseReader(res);
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toContain("event: status");

    authService.revokeSession(token);
    await vi.advanceTimersByTimeAsync(31_000);

    const second = await reader.read();
    expect(second.done).toBe(true);
  });

  test("closes the docker events stream when the session is locked", async () => {
    const { cookie, token } = await setupUnlockedSession();
    const eventsStream = new PassThrough();
    dockerMock.getDockerAsync.mockResolvedValue({
      getEvents: vi.fn(async () => eventsStream),
    });
    const app = createApp();

    vi.useFakeTimers();
    const res = await app.request("http://localhost/api/docker/events", {
      headers: { cookie },
    });
    expect(res.status).toBe(200);

    const reader = getResponseReader(res);
    eventsStream.write('{"status":"start","id":"c1"}\n');
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toContain("event: docker-event");

    authService.revokeSession(token);
    await vi.advanceTimersByTimeAsync(31_000);

    const second = await reader.read();
    expect(second.done).toBe(true);
  });

  test("closes the container logs stream when the session is locked", async () => {
    const { cookie, token } = await setupUnlockedSession();
    const logStream = new PassThrough();
    const container = {
      inspect: vi.fn(async () => ({ Config: { Tty: false } })),
      logs: vi.fn(async () => logStream),
    };
    dockerMock.getDockerAsync.mockResolvedValue({
      getContainer: vi.fn(() => container),
    });
    const app = createApp();

    vi.useFakeTimers();
    const res = await app.request("http://localhost/api/logs/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef?tail=100", {
      headers: { cookie },
    });
    expect(res.status).toBe(200);

    const reader = getResponseReader(res);
    const line = Buffer.from("line-one\n", "utf8");
    const header = Buffer.alloc(8);
    header.writeUInt8(1, 0);
    header.writeUInt32BE(line.length, 4);
    logStream.write(Buffer.concat([header, line]));
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toContain("event: log");

    authService.revokeSession(token);
    await vi.advanceTimersByTimeAsync(31_000);

    const second = await reader.read();
    expect(second.done).toBe(true);
  });

  test("clears the session-check interval when the client disconnects while docker events is still loading", async () => {
    const { cookie } = await setupUnlockedSession();
    let resolveGetEvents!: (stream: PassThrough) => void;
    const getEventsPromise = new Promise<PassThrough>((resolve) => {
      resolveGetEvents = resolve;
    });
    dockerMock.getDockerAsync.mockResolvedValue({
      getEvents: vi.fn(() => getEventsPromise),
    });
    const app = createApp();

    vi.useFakeTimers();
    // The route awaits `dockerService.getDockerAsync()` and returns the SSE
    // response before its streamSSE callback ever reaches `docker.getEvents()`,
    // so this resolves while that call is still pending.
    const res = await app.request("http://localhost/api/docker/events", {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const timersBeforeConnect = vi.getTimerCount();

    // Simulate the client disconnecting while `docker.getEvents()` is still
    // in flight -- this is what fires `stream.abort()` before the handler has
    // reached the point where it registers its session-check interval.
    const reader = getResponseReader(res);
    await reader.cancel();

    // Now let the deferred Docker call resolve so the callback resumes past
    // the await and reaches the (already-aborted) interval registration.
    const eventsStream = new PassThrough();
    const destroySpy = vi.spyOn(eventsStream, "destroy");
    resolveGetEvents(eventsStream);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);

    // The strongest signal available here: vi.getTimerCount() reflects every
    // timer vitest's fake clock is holding. The callback still unconditionally
    // reaches `stream.sleep(1000000)` after the (already-aborted) session
    // check, registering one setTimeout that this finding does not touch and
    // is not what is under test -- so the accounted-for total is exactly one
    // more than before the connection opened. If the session-check interval
    // also leaked, this would be two more, not one.
    expect(vi.getTimerCount()).toBe(timersBeforeConnect + 1);

    // The route's own `eventStream.destroy()` cleanup is registered by a
    // separate `stream.onAbort(...)` call positioned exactly where the
    // interval was -- after the awaited `docker.getEvents()`. It shares the
    // same race, and there is no way to observe it directly (it is not
    // exposed outside the route closure), so this asserts on the mock's
    // `destroy` spy instead: the strongest available signal that the actual
    // Docker event source was torn down rather than left running.
    expect(destroySpy).toHaveBeenCalled();
  });

  test("clears the session-check interval when the client disconnects while container logs are still loading", async () => {
    const { cookie } = await setupUnlockedSession();
    let resolveLogs!: (stream: PassThrough) => void;
    const logsPromise = new Promise<PassThrough>((resolve) => {
      resolveLogs = resolve;
    });
    const container = {
      inspect: vi.fn(async () => ({ Config: { Tty: false } })),
      logs: vi.fn(() => logsPromise),
    };
    dockerMock.getDockerAsync.mockResolvedValue({
      getContainer: vi.fn(() => container),
    });
    const app = createApp();

    vi.useFakeTimers();
    const res = await app.request("http://localhost/api/logs/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef?tail=100", {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const timersBeforeConnect = vi.getTimerCount();

    // Disconnect while `container.logs()` is still in flight -- the same race
    // as the docker-events test above, at the other new-interval call site.
    const reader = getResponseReader(res);
    await reader.cancel();

    const logStream = new PassThrough();
    const destroySpy = vi.spyOn(logStream, "destroy");
    resolveLogs(logStream);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);

    // See the docker-events test above: +1 accounts for the unconditional
    // `stream.sleep(1000000)` setTimeout, not the interval under test.
    expect(vi.getTimerCount()).toBe(timersBeforeConnect + 1);

    // Same reasoning as the docker-events test above: `logStream.destroy()`
    // is registered by its own `stream.onAbort(...)` call at the same
    // too-late position, so this is the strongest available signal that it
    // ran rather than leaving the container log source open.
    expect(destroySpy).toHaveBeenCalled();
  });

  test("clears the metrics subscription when the client disconnects while the initial metrics fetch is still pending", async () => {
    metricsMock.getCachedMetrics.mockReturnValue(null);
    let resolveOneShot!: () => void;
    const oneShotPromise = new Promise<undefined>((resolve) => {
      resolveOneShot = () => resolve(undefined);
    });
    metricsMock.getOneShotMetrics.mockReturnValue(oneShotPromise);
    const unsubscribe = vi.fn();
    metricsMock.subscribeToMetrics.mockReturnValue(unsubscribe);
    const app = createApp();

    vi.useFakeTimers();
    // No cached metrics, so the handler awaits `getOneShotMetrics()` and then a
    // 100ms settle delay before it ever calls `subscribeToMetrics()`.
    const res = await app.request("http://localhost/api/metrics/stream");
    expect(res.status).toBe(200);

    // Disconnect while `getOneShotMetrics()` is still in flight -- this fires
    // `stream.abort()` before the handler has reached `subscribeToMetrics()`
    // or registered any cleanup for the subscription it is about to create.
    const reader = getResponseReader(res);
    await reader.cancel();

    // Let the deferred one-shot fetch resolve, then the 100ms settle delay, so
    // the callback resumes past both awaits and reaches `subscribeToMetrics()`
    // and the (already-aborted) `withSessionCheck()` registration.
    resolveOneShot();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(100);
    await flushMicrotasks();

    // The subscription this handler creates only after those awaits must still
    // be torn down: `withSessionCheck`'s synchronous `stream.aborted` guard is
    // the only thing positioned early enough to catch an abort that already
    // happened by the time `subscribeToMetrics()` runs.
    expect(unsubscribe).toHaveBeenCalled();
  });
});

describe("runtimeRoutes log stream bounds (DOCK-10)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dockerMock.getDockerAsync.mockResolvedValue(null);
    sseInterceptor.rejectNext = 0;
  });

  type SseEvent = { event: string | undefined; data: string };

  /** Wraps a payload in Docker's 8-byte stdout multiplexing header. */
  function dockerFrame(payload: string): Buffer {
    const body = Buffer.from(payload, "utf8");
    const header = Buffer.alloc(8);
    header.writeUInt8(1, 0);
    header.writeUInt32BE(body.length, 4);
    return Buffer.concat([header, body]);
  }

  function mountLogStream() {
    const logStream = new PassThrough();
    const container = {
      inspect: vi.fn(async () => ({ Config: { Tty: false } })),
      logs: vi.fn(async () => logStream),
    };
    dockerMock.getDockerAsync.mockResolvedValue({
      getContainer: vi.fn(() => container),
    });
    return logStream;
  }

  /**
   * Reads the SSE body into parsed events, stopping as soon as `until` is
   * satisfied or `maxReads` chunks have been consumed. The read cap is what
   * keeps a regression fast and legible: against unbounded code these
   * assertions fail on the collected events rather than blocking forever on a
   * notice that is never sent.
   */
  async function collectSse(
    response: Response,
    { until, maxReads }: { until: (events: SseEvent[]) => boolean; maxReads: number }
  ): Promise<SseEvent[]> {
    const reader = getResponseReader(response);
    const decoder = new TextDecoder();
    const events: SseEvent[] = [];
    let buffer = "";

    try {
      for (let i = 0; i < maxReads; i += 1) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          let event: string | undefined;
          const dataLines: string[] = [];
          for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) event = line.slice(7);
            else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
          }
          events.push({ event, data: dataLines.join("\n") });
        }

        if (until(events)) break;
      }
    } finally {
      await reader.cancel();
    }

    return events;
  }

  /**
   * Collects SSE events until the stream goes quiet for `quietMs`.
   *
   * The end-of-stream cases have no sentinel to read towards: the route keeps
   * the SSE connection open after the Docker log stream ends (it is still
   * parked on `stream.sleep`), so against code that drops the trailing
   * fragment the correct observation is "nothing further ever arrives", which
   * only a quiet period can make. Reading towards a marker would block until
   * the suite timed out instead of failing on its assertion.
   */
  async function collectUntilQuiet(
    response: Response,
    { quietMs = 200, maxReads = 50 }: { quietMs?: number; maxReads?: number } = {}
  ): Promise<SseEvent[]> {
    const reader = getResponseReader(response);
    const decoder = new TextDecoder();
    const events: SseEvent[] = [];
    let buffer = "";

    try {
      for (let i = 0; i < maxReads; i += 1) {
        let timer: NodeJS.Timeout | undefined;
        const quiet = new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), quietMs);
        });
        const result = await Promise.race([reader.read(), quiet]);
        clearTimeout(timer);
        if (!result || result.done) break;
        buffer += decoder.decode(result.value, { stream: true });

        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          let event: string | undefined;
          const dataLines: string[] = [];
          for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) event = line.slice(7);
            else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
          }
          events.push({ event, data: dataLines.join("\n") });
        }
      }
    } finally {
      await reader.cancel();
    }

    return events;
  }

  function parsedLines(events: SseEvent[]): { line: string; truncated?: boolean }[] {
    return events
      .filter((event) => event.event === "log")
      .map((event) => JSON.parse(event.data) as { line: string; truncated?: boolean });
  }

  test("emits a container's endless line in bounded pieces instead of buffering it", async () => {
    const logStream = mountLogStream();
    const app = createApp();

    const res = await app.request("http://localhost/api/logs/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef?tail=100");
    expect(res.status).toBe(200);

    // Eight frames of one repeated character, no newline anywhere: exactly the
    // shape a progress bar or a stuck process produces. Nothing in the route
    // may hold all of it at once.
    const frameChars = 64 * 1024;
    const frameCount = 8;
    for (let i = 0; i < frameCount; i += 1) {
      logStream.write(dockerFrame("a".repeat(frameChars)));
    }
    // A terminated marker line so this test never depends on a read that would
    // block: unbounded code flushes its one giant line when this newline
    // arrives, so the assertions below run either way.
    logStream.write(dockerFrame("\nTAIL\n"));

    const events = await collectSse(res, {
      until: (collected) =>
        parsedLines(collected).some((payload) => payload.line === "TAIL"),
      maxReads: 200,
    });

    const lines = parsedLines(events);
    const filler = lines.filter((payload) => payload.line.startsWith("a"));

    // Unbounded code emits the whole run as a single line, so it produces one
    // filler payload of 512 KiB rather than several capped ones.
    expect(filler.length).toBeGreaterThanOrEqual(
      (frameChars * frameCount) / LOG_LINE_MAX_CHARS
    );
    for (const payload of filler) {
      expect(payload.line.length).toBeLessThanOrEqual(LOG_LINE_MAX_CHARS);
    }
    // Capping must reframe the output, never discard it.
    expect(filler.reduce((total, payload) => total + payload.line.length, 0)).toBe(
      frameChars * frameCount
    );
    // Every piece that is a continuation says so -- and only those. The last
    // piece is terminated by the newline in the marker frame that follows it,
    // so it ends a real line and must not claim a continuation.
    expect(filler.slice(0, -1).every((payload) => payload.truncated === true)).toBe(true);
    expect(filler.at(-1)?.truncated).toBeUndefined();
    expect(lines.some((payload) => payload.line === "TAIL")).toBe(true);
  });

  test("caps a long line that arrives already terminated in a single chunk", async () => {
    const logStream = mountLogStream();
    const app = createApp();

    const res = await app.request("http://localhost/api/logs/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef?tail=100");
    expect(res.status).toBe(200);

    // The endless-line case flushes at the cap because the cap is reached
    // before any newline shows up. This is the other half: the newline is
    // already in the same chunk, so the line is emitted on the newline path
    // instead -- which must respect the same bound rather than handing the
    // client one oversized message.
    const lineChars = LOG_LINE_MAX_CHARS + 36 * 1024;
    logStream.write(dockerFrame(`${"b".repeat(lineChars)}\nTAIL\n`));

    const events = await collectSse(res, {
      until: (collected) =>
        parsedLines(collected).some((payload) => payload.line === "TAIL"),
      maxReads: 200,
    });

    const lines = parsedLines(events);
    const filler = lines.filter((payload) => payload.line.startsWith("b"));

    for (const payload of filler) {
      expect(payload.line.length).toBeLessThanOrEqual(LOG_LINE_MAX_CHARS);
    }
    expect(filler.reduce((total, payload) => total + payload.line.length, 0)).toBe(
      lineChars
    );
    // The final piece completes a real line, so it is not a continuation.
    expect(filler.at(-1)?.truncated).toBeUndefined();
    expect(lines.some((payload) => payload.line === "TAIL")).toBe(true);
  });

  test("does not mark a complete line as truncated when its length is an exact multiple of the cap", async () => {
    const logStream = mountLogStream();
    const app = createApp();

    const res = await app.request("http://localhost/api/logs/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef?tail=100");
    expect(res.status).toBe(200);

    // `truncated` means "this piece is a mid-line fragment, more is coming".
    // A line that ends exactly on the cap is the case where the buffer is full
    // and complete at the same instant, so the flush must not claim a
    // continuation that never arrives. The other bound tests deliberately land
    // off the boundary, which is why this needs its own case.
    logStream.write(dockerFrame(`${"b".repeat(LOG_LINE_MAX_CHARS)}\n`));
    logStream.write(dockerFrame(`${"c".repeat(LOG_LINE_MAX_CHARS * 2)}\nTAIL\n`));

    const events = await collectSse(res, {
      until: (collected) =>
        parsedLines(collected).some((payload) => payload.line === "TAIL"),
      maxReads: 200,
    });

    const lines = parsedLines(events);

    // Exactly one cap's worth, complete: one piece, and not a continuation.
    const single = lines.filter((payload) => payload.line.startsWith("b"));
    expect(single).toHaveLength(1);
    expect(single[0]?.line.length).toBe(LOG_LINE_MAX_CHARS);
    expect(single[0]?.truncated).toBeUndefined();

    // Two caps' worth, complete: the first piece really is a fragment, the
    // second one ends the line and must not be flagged.
    const doubled = lines.filter((payload) => payload.line.startsWith("c"));
    expect(doubled).toHaveLength(2);
    expect(doubled[0]?.truncated).toBe(true);
    expect(doubled[1]?.truncated).toBeUndefined();
    expect(doubled.reduce((total, payload) => total + payload.line.length, 0)).toBe(
      LOG_LINE_MAX_CHARS * 2
    );
  });

  test("delivers an exact-cap trailing fragment when the log stream ends", async () => {
    const logStream = mountLogStream();
    const app = createApp();

    const res = await app.request("http://localhost/api/logs/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef?tail=100");
    expect(res.status).toBe(200);

    // A container that writes exactly one cap's worth and then stops, with no
    // trailing newline. The buffer is full and the line is over at the same
    // instant, and nothing further will ever arrive to push it out -- so the
    // end of the stream is the only thing that can flush it. Losing it would
    // be 64 KiB of real output silently dropped.
    logStream.write(dockerFrame("b".repeat(LOG_LINE_MAX_CHARS)));
    logStream.end();

    const lines = parsedLines(await collectUntilQuiet(res));

    expect(lines).toHaveLength(1);
    expect(lines[0]?.line.length).toBe(LOG_LINE_MAX_CHARS);
    // Nothing continues it, so it is not a continuation.
    expect(lines[0]?.truncated).toBeUndefined();
  });

  test("delivers a short unterminated trailing fragment when the log stream ends", async () => {
    const logStream = mountLogStream();
    const app = createApp();

    const res = await app.request("http://localhost/api/logs/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef?tail=100");
    expect(res.status).toBe(200);

    // The general case, and a loss that predates any of the buffering work:
    // a container whose final line has no trailing newline had that line
    // discarded when the stream ended, whatever its length.
    logStream.write(dockerFrame("first-line\ntrailing-without-newline"));
    logStream.end();

    const lines = parsedLines(await collectUntilQuiet(res)).map((entry) => entry.line);

    expect(lines).toContain("first-line");
    expect(lines).toContain("trailing-without-newline");
  });

  test("pauses the docker log stream while queued writes are ahead of the client", async () => {
    const logStream = mountLogStream();
    const app = createApp();

    const res = await app.request("http://localhost/api/logs/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef?tail=100");
    expect(res.status).toBe(200);

    // Above the pause mark but below the hard cap, so this exercises flow
    // control alone -- nothing here should be dropped.
    const lineCount = LOG_WRITE_QUEUE_PAUSE_AT + 72;
    const payload = Array.from(
      { length: lineCount },
      (_unused, index) => `log-line-${index}`
    ).join("\n");
    logStream.write(dockerFrame(`${payload}\n`));

    // Let the route's data handler run without reading a single byte of the
    // response: the client is deliberately not keeping up.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(logStream.isPaused()).toBe(true);

    const events = await collectSse(res, {
      until: (collected) =>
        parsedLines(collected).some(
          (entry) => entry.line === `log-line-${lineCount - 1}`
        ),
      maxReads: lineCount * 2,
    });

    expect(parsedLines(events).some((entry) => entry.line === "log-line-0")).toBe(true);
    // Draining the queue has to hand the source back, or the log view freezes
    // permanently after the first burst.
    expect(logStream.isPaused()).toBe(false);
  });

  test("tells the client how many log lines were dropped when the queue overflows", async () => {
    const logStream = mountLogStream();
    const app = createApp();

    const res = await app.request("http://localhost/api/logs/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef?tail=100");
    expect(res.status).toBe(200);

    // One Docker chunk that expands past the hard cap. The source can only be
    // paused between chunks, so this is the case flow control cannot catch and
    // the queue bound has to.
    const lineCount = LOG_WRITE_QUEUE_MAX_MESSAGES * 10;
    const payload = Array.from(
      { length: lineCount },
      (_unused, index) => `log-line-${index}`
    ).join("\n");
    logStream.write(dockerFrame(`${payload}\n`));

    const events = await collectSse(res, {
      // Reads one event past the notice, so the surviving-tail assertion below
      // has something to look at.
      until: (collected) => {
        const index = collected.findIndex((event) => event.event === "log-dropped");
        return (
          index !== -1 && collected.slice(index + 1).some((event) => event.event === "log")
        );
      },
      maxReads: 12,
    });

    const noticeIndex = events.findIndex((event) => event.event === "log-dropped");
    expect(noticeIndex).toBeGreaterThanOrEqual(0);
    const parsed = JSON.parse(events[noticeIndex]?.data ?? "{}") as {
      line?: string;
      dropped?: number;
    };
    expect(parsed.dropped).toBeGreaterThan(0);
    // Delivered as a `line` payload because that is the only field the log
    // viewer renders -- a gap the user cannot see is the thing being fixed.
    expect(parsed.line).toContain("dropped");
    expect(parsed.line).toContain(String(parsed.dropped));

    // The oldest queued lines are the ones discarded, so what survives is the
    // live tail rather than a stale head.
    const firstAfterNotice = events
      .slice(noticeIndex + 1)
      .find((event) => event.event === "log");
    expect(firstAfterNotice).toBeDefined();
    const survivor = JSON.parse(firstAfterNotice?.data ?? "{}") as { line?: string };
    expect(Number(String(survivor.line).replace("log-line-", ""))).toBeGreaterThan(
      lineCount - LOG_WRITE_QUEUE_MAX_MESSAGES - 2
    );
  });
});
