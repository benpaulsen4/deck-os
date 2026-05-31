import { beforeEach, describe, expect, test, vi } from "vitest";
import type { App } from "../lib/schema.js";
import type { PullOverallProgress } from "./docker.js";

function createMockApp(): App {
  return {
    id: "my-app",
    metadata: {
      id: "my-app",
      name: "My App",
      icon: "",
      url: "",
      description: "",
      order: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    composeYaml: "services:\n  web:\n    image: nginx:latest\n",
  };
}

async function loadPullJobsModule() {
  vi.resetModules();
  vi.doMock("./apps.js", () => ({
    getApp: vi.fn(),
  }));
  vi.doMock("./docker.js", () => ({
    pullImagesWithProgress: vi.fn(),
  }));
  const pullJobs = await import("./pullJobs.js");
  const apps = await import("./apps.js");
  const docker = await import("./docker.js");
  return {
    pullJobs,
    getAppMock: vi.mocked(apps.getApp),
    pullImagesWithProgressMock: vi.mocked(docker.pullImagesWithProgress),
  };
}

describe("pullJobs service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("startPullJob rejects when app does not exist", async () => {
    const { pullJobs, getAppMock } = await loadPullJobsModule();
    getAppMock.mockResolvedValue(null);

    await expect(pullJobs.startPullJob("missing-app")).rejects.toThrow("App not found");
  });

  test("startPullJob deduplicates active jobs per app and publishes completion", async () => {
    const { pullJobs, getAppMock, pullImagesWithProgressMock } = await loadPullJobsModule();
    getAppMock.mockResolvedValue(createMockApp());

    let resolvePull: () => void = () => undefined;
    pullImagesWithProgressMock.mockImplementation(
      (_images: string[], onProgress: (progress: PullOverallProgress) => void) =>
        new Promise<void>((resolve) => {
          resolvePull = resolve;
          onProgress({
            currentBytes: 10,
            totalBytes: 100,
            percent: 10,
            completedImages: 0,
            totalImages: 1,
            activeImage: "nginx:latest",
            indeterminate: false,
          });
        })
    );

    const first = await pullJobs.startPullJob("my-app");
    const second = await pullJobs.startPullJob("my-app");

    expect(second.jobId).toBe(first.jobId);
    expect(pullImagesWithProgressMock).toHaveBeenCalledTimes(1);

    const updates: Array<{ status: string; percent: number }> = [];
    const unsubscribe = pullJobs.subscribeToPullJob(first.jobId, (snapshot) => {
      updates.push({ status: snapshot.status, percent: snapshot.progress.percent });
    });

    resolvePull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    unsubscribe();

    const done = pullJobs.getPullJob(first.jobId);
    expect(done?.status).toBe("done");
    expect(done?.progress.percent).toBe(100);
    expect(updates.some((entry) => entry.status === "done")).toBe(true);
  });

  test("cancelPullJob aborts running job and error state is observable", async () => {
    const { pullJobs, getAppMock, pullImagesWithProgressMock } = await loadPullJobsModule();
    getAppMock.mockResolvedValue(createMockApp());

    let capturedSignal: AbortSignal | undefined;
    pullImagesWithProgressMock.mockImplementation(
      (
        _images: string[],
        _onProgress: (progress: PullOverallProgress) => void,
        signal?: AbortSignal
      ) =>
        new Promise<void>((_resolve, reject) => {
          capturedSignal = signal;
          signal?.addEventListener("abort", () => reject(new Error("Pull aborted")));
        })
    );

    const job = await pullJobs.startPullJob("my-app");
    const cancelled = pullJobs.cancelPullJob(job.jobId);
    expect(cancelled).toBe(true);
    expect(capturedSignal?.aborted).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const snapshot = pullJobs.getPullJob(job.jobId);
    expect(snapshot?.status).toBe("error");
    expect(snapshot?.error).toBe("Pull aborted");
  });
});
