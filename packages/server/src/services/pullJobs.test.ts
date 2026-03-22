import { beforeEach, describe, expect, test, vi } from "vitest";

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
    apps: apps as any,
    docker: docker as any,
  };
}

describe("pullJobs service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("startPullJob rejects when app does not exist", async () => {
    const { pullJobs, apps } = await loadPullJobsModule();
    apps.getApp.mockResolvedValue(null);

    await expect(pullJobs.startPullJob("missing-app")).rejects.toThrow("App not found");
  });

  test("startPullJob deduplicates active jobs per app and publishes completion", async () => {
    const { pullJobs, apps, docker } = await loadPullJobsModule();
    apps.getApp.mockResolvedValue({
      id: "my-app",
      composeYaml: "services:\n  web:\n    image: nginx:latest\n",
    });

    let resolvePull: () => void = () => undefined;
    docker.pullImagesWithProgress.mockImplementation(
      (_images: string[], onProgress: (p: unknown) => void) =>
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
    expect(docker.pullImagesWithProgress).toHaveBeenCalledTimes(1);

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
    const { pullJobs, apps, docker } = await loadPullJobsModule();
    apps.getApp.mockResolvedValue({
      id: "my-app",
      composeYaml: "services:\n  web:\n    image: nginx:latest\n",
    });

    let capturedSignal: AbortSignal | undefined;
    docker.pullImagesWithProgress.mockImplementation(
      (_images: string[], _onProgress: (p: unknown) => void, signal?: AbortSignal) =>
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
