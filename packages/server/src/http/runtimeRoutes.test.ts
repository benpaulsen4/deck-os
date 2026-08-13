import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as authService from "../services/auth.js";
import { DATA_DIR } from "../lib/config.js";

const metricsMock = vi.hoisted(() => ({
  startMetricsPolling: vi.fn(),
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

vi.mock("../services/metrics.js", () => metricsMock);
vi.mock("../services/docker.js", () => dockerMock);
vi.mock("../services/pullJobs.js", () => pullJobsMock);
vi.mock("../services/diskAnalysis.js", () => diskAnalysisMock);
vi.mock("../lib/version.js", () => versionMock);

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
    expect(metricsMock.startMetricsPolling).toHaveBeenCalledTimes(1);
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

  test("disk analysis events endpoint maps unexpected subscription errors to 500", async () => {
    diskAnalysisMock.getJobStreamInitialEvent.mockImplementation(() => {
      throw new Error("boom");
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
      error: "boom",
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

  test("logs endpoint validates tail query before docker lookup", async () => {
    const app = createApp();
    const res = await app.request("http://localhost/api/logs/container-1?tail=0");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid tail parameter" });
    expect(dockerMock.getDockerAsync).not.toHaveBeenCalled();
  });

  test("logs endpoint returns 503 when docker is unavailable", async () => {
    const app = createApp();
    const res = await app.request("http://localhost/api/logs/container-1?tail=100");

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

    const res = await app.request("http://localhost/api/logs/container-1?tail=100");
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
    const res = await app.request("http://localhost/api/logs/container-1?tail=100", {
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
    const res = await app.request("http://localhost/api/logs/container-1?tail=100", {
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
});
