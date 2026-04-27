import { Hono } from "hono";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, test, vi } from "vitest";

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
    expect(res.body).toBeTruthy();
    const reader = res.body!.getReader();
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
    const reader = res.body!.getReader();
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
    const reader = res.body!.getReader();
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
    const reader = res.body!.getReader();
    const first = await reader.read();
    await reader.cancel();
    const payload = new TextDecoder().decode(first.value);
    expect(payload).toContain("event: status");
    expect(payload).toContain('"phase":"scanning"');
    expect(diskAnalysisMock.subscribeToJob).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      expect.any(Function)
    );
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

    const reader = res.body!.getReader();
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
