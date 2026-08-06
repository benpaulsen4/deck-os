import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";

type MockContainerSummary = {
  Id: string;
  Names: string[];
  Image: string;
  ImageID: string;
  Command: string;
  Created: number;
  Status: string;
  Labels: Record<string, string>;
};

type MockContainerHandle = {
  inspect?: () => Promise<unknown>;
  stats?: () => Promise<unknown>;
  remove?: (options: { force: boolean }) => Promise<void>;
};

const execFileMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());

const dockerClient = vi.hoisted(() => ({
  ping: vi.fn(async () => undefined),
  pull: vi.fn(),
  modem: {
    followProgress: vi.fn(),
  },
  listContainers: vi.fn<() => Promise<MockContainerSummary[]>>(async () => []),
  getContainer: vi.fn<(id: string) => MockContainerHandle>(),
}));

const listContainersMock = vi.mocked(dockerClient.listContainers);
const getContainerMock = vi.mocked(dockerClient.getContainer);

vi.mock("child_process", () => ({
  execFile: execFileMock,
  spawn: spawnMock,
}));
vi.mock("util", async () => {
  const actual = await vi.importActual<typeof import("util")>("util");
  return {
    ...actual,
    promisify: () => (...args: unknown[]) => execFileMock(...args),
  };
});
// NOTE: lib/config.js is deliberately NOT mocked. Mocking it meant
// assertValidAppId was never exercised through any docker-service path, and the
// async mocks of its sync helpers hid that pullStack builds its argv without
// awaiting them.
vi.mock("dockerode", () => ({
  default: vi.fn(() => dockerClient),
}));

const createdDirs: string[] = [];
const envBackup = { ...process.env };

const APP_ID = "app-abc123";

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

/**
 * Loads the docker service against the real lib/config.js, rooted at a temp
 * data dir, so the argv assertions below cover real path/project-name
 * derivation (and its app id validation).
 */
async function loadDockerModule(dataDir: string) {
  vi.resetModules();
  process.env.DECKOS_DATA_DIR = dataDir;
  return await import("./docker.js");
}

function expectedComposePath(dataDir: string, appId = APP_ID): string {
  return path.join(dataDir, "apps", appId, "docker-compose.yml");
}

function makeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: () => void;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

describe("docker service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...envBackup };
    execFileMock.mockResolvedValue({ stdout: "", stderr: "" });
  });

  afterEach(async () => {
    process.env = { ...envBackup };
    await Promise.all(createdDirs.splice(0).map((dir) => fs.remove(dir)));
  });

  test("start/stop/restart run compose with the real derived argv", async () => {
    const dataDir = await createTempDir("deckos-docker-args-");
    const docker = await loadDockerModule(dataDir);
    const composePath = expectedComposePath(dataDir);

    await docker.startStack(APP_ID);
    await docker.stopStack(APP_ID);
    await docker.restartStack(APP_ID);

    expect(execFileMock).toHaveBeenNthCalledWith(
      1,
      "docker",
      ["compose", "-f", composePath, "-p", `deckos-${APP_ID}`, "up", "-d"],
      expect.any(Object)
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      "docker",
      ["compose", "-f", composePath, "-p", `deckos-${APP_ID}`, "down"],
      expect.any(Object)
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      3,
      "docker",
      ["compose", "-f", composePath, "-p", `deckos-${APP_ID}`, "restart"],
      expect.any(Object)
    );

    // No argument may be a stringified promise: the config helpers are sync.
    for (const call of execFileMock.mock.calls) {
      for (const arg of call[1] as string[]) {
        expect(arg).not.toContain("[object Promise]");
      }
    }
  });

  test("compose commands run with an explicit timeout and a large maxBuffer", async () => {
    const dataDir = await createTempDir("deckos-docker-limits-");
    const docker = await loadDockerModule(dataDir);

    await docker.startStack(APP_ID);

    const options = execFileMock.mock.calls[0]?.[2] as {
      timeout: number;
      maxBuffer: number;
    };
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.maxBuffer).toBeGreaterThan(1024 * 1024);
  });

  test("compose commands reject app ids that fail validation", async () => {
    const dataDir = await createTempDir("deckos-docker-badid-");
    const docker = await loadDockerModule(dataDir);

    for (const badId of ["../escape", "Uppercase", "with space", "lost+found", ""]) {
      await expect(docker.startStack(badId)).rejects.toThrow(/Invalid app id/);
      await expect(docker.stopStack(badId)).rejects.toThrow(/Invalid app id/);
      await expect(docker.restartStack(badId)).rejects.toThrow(/Invalid app id/);
      await expect(docker.pullStack(badId)).rejects.toThrow(/Invalid app id/);
    }
    expect(execFileMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("DOCKER_SOCKET_PATH is translated to DOCKER_HOST for the compose CLI", async () => {
    const dataDir = await createTempDir("deckos-docker-env-");
    const platform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      process.env.DECKOS_DATA_DIR = dataDir;
      process.env.DOCKER_SOCKET_PATH = "/run/user/1000/docker.sock";
      delete process.env.DOCKER_HOST;
      const docker = await loadDockerModule(dataDir);

      await docker.startStack(APP_ID);
      const options = execFileMock.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv };
      expect(options.env.DOCKER_HOST).toBe("unix:///run/user/1000/docker.sock");

      // An explicit DOCKER_HOST always wins.
      process.env.DOCKER_HOST = "tcp://127.0.0.1:2375";
      await docker.startStack(APP_ID);
      const second = execFileMock.mock.calls[1]?.[2] as { env: NodeJS.ProcessEnv };
      expect(second.env.DOCKER_HOST).toBe("tcp://127.0.0.1:2375");
    } finally {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
    }
  });

  test("pullStack spawns compose pull with the real argv and the docker CLI env", async () => {
    const dataDir = await createTempDir("deckos-docker-pull-");
    const docker = await loadDockerModule(dataDir);
    const child = makeChild();
    spawnMock.mockReturnValueOnce(child);

    const outputs: string[] = [];
    const promise = docker.pullStack(APP_ID, (line) => outputs.push(line));
    child.stdout.write("line-a");
    child.stderr.write("line-b");
    child.emit("close", 0, null);
    await promise;

    expect(spawnMock).toHaveBeenCalledWith(
      "docker",
      [
        "compose",
        "-f",
        expectedComposePath(dataDir),
        "-p",
        `deckos-${APP_ID}`,
        "pull",
      ],
      expect.objectContaining({ env: expect.any(Object) })
    );
    expect(outputs.join("")).toContain("line-a");
    expect(outputs.join("")).toContain("line-b");
  });

  test("pullStack rejects on a non-zero exit code", async () => {
    const dataDir = await createTempDir("deckos-docker-pullfail-");
    const docker = await loadDockerModule(dataDir);
    const child = makeChild();
    spawnMock.mockReturnValueOnce(child);

    const promise = docker.pullStack(APP_ID);
    child.emit("close", 1, null);
    await expect(promise).rejects.toThrow("docker compose pull failed");
  });

  test("pullImagesWithProgress reports parsed progress and completes image", async () => {
    const dataDir = await createTempDir("deckos-docker-progress-");
    const docker = await loadDockerModule(dataDir);

    dockerClient.pull.mockImplementation(
      (
        _image: string,
        cb: (err: Error | null, stream: NodeJS.ReadableStream | null) => void
      ) => cb(null, { destroy: vi.fn() } as unknown as NodeJS.ReadableStream)
    );
    dockerClient.modem.followProgress.mockImplementation(
      (
        _stream: NodeJS.ReadableStream,
        onFinished: (err: Error | null) => void,
        onProgress: (event: {
          id?: string;
          progress?: string;
          progressDetail?: { current?: number; total?: number };
        }) => void
      ) => {
        onProgress({ id: "layer-1", progress: "5MB / 10MB" });
        onFinished(null);
      }
    );

    const progressCalls: Array<{
      percent: number;
      totalImages: number;
      completedImages: number;
      indeterminate: boolean;
    }> = [];
    await docker.pullImagesWithProgress(["nginx:latest", " nginx:latest "], (progress) => {
      progressCalls.push({
        percent: progress.percent,
        totalImages: progress.totalImages,
        completedImages: progress.completedImages,
        indeterminate: progress.indeterminate,
      });
    });

    expect(dockerClient.pull).toHaveBeenCalledTimes(1);
    expect(progressCalls[0]?.totalImages).toBe(1);
    expect(progressCalls.some((call) => call.indeterminate === false)).toBe(true);
    expect(progressCalls.some((call) => call.completedImages === 1)).toBe(true);
    expect(progressCalls.at(-1)?.percent).toBeGreaterThanOrEqual(50);
  });

  test("an aborted pull rejects even though followProgress reports success", async () => {
    const dataDir = await createTempDir("deckos-docker-abort-");
    const docker = await loadDockerModule(dataDir);
    const controller = new AbortController();

    // Mirrors the real docker-modem: destroying the stream ends followProgress
    // with no error, which previously read as a completed pull.
    dockerClient.pull.mockImplementation(
      (
        _image: string,
        cb: (err: Error | null, stream: NodeJS.ReadableStream | null) => void
      ) => cb(null, { destroy: vi.fn() } as unknown as NodeJS.ReadableStream)
    );
    dockerClient.modem.followProgress.mockImplementation(
      (_stream: NodeJS.ReadableStream, onFinished: (err: Error | null) => void) => {
        controller.abort();
        onFinished(null);
      }
    );

    await expect(
      docker.pullImagesWithProgress(["nginx:latest"], () => {}, controller.signal)
    ).rejects.toThrow("Pull aborted");
  });

  test("getStackContainers maps docker inspect data to API shape", async () => {
    const dataDir = await createTempDir("deckos-docker-map-");
    const docker = await loadDockerModule(dataDir);

    listContainersMock.mockResolvedValue([
      {
        Id: "cid-1",
        Names: ["/app-web-1"],
        Image: "nginx:latest",
        ImageID: "img-1",
        Command: "nginx -g daemon off;",
        Created: 123,
        Status: "Up 10s",
        Labels: { "com.docker.compose.project": `deckos-${APP_ID}` },
      },
    ]);
    getContainerMock.mockReturnValue({
      inspect: vi.fn(async () => ({
        State: {
          Status: "running",
          Running: true,
          Paused: false,
          Restarting: false,
          Dead: false,
          Pid: 1234,
          ExitCode: 0,
          Error: "",
          StartedAt: "now",
          FinishedAt: "",
        },
        NetworkSettings: {
          Ports: {
            "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }],
          },
        },
      })),
    });

    const containers = await docker.getStackContainers(APP_ID);

    expect(listContainersMock).toHaveBeenCalledWith({
      all: true,
      filters: { label: [`com.docker.compose.project=deckos-${APP_ID}`] },
    });
    expect(containers).toHaveLength(1);
    expect(containers[0]?.id).toBe("cid-1");
    expect(containers[0]?.state.running).toBe(true);
    expect(containers[0]?.ports?.[0]).toEqual({
      private: 80,
      public: 8080,
      type: "tcp",
      ip: "0.0.0.0",
    });
  });

  test("getStackContainers skips containers that vanish between list and inspect", async () => {
    const dataDir = await createTempDir("deckos-docker-vanish-");
    const docker = await loadDockerModule(dataDir);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    listContainersMock.mockResolvedValue([
      {
        Id: "cid-gone",
        Names: ["/gone"],
        Image: "one",
        ImageID: "one",
        Command: "run",
        Created: 1,
        Status: "Up",
        Labels: {},
      },
      {
        Id: "cid-alive",
        Names: ["/alive"],
        Image: "two",
        ImageID: "two",
        Command: "run",
        Created: 1,
        Status: "Up",
        Labels: {},
      },
    ]);
    getContainerMock.mockImplementation((id: string) => ({
      inspect: vi.fn(async () => {
        if (id === "cid-gone") {
          throw Object.assign(new Error("No such container: cid-gone"), {
            statusCode: 404,
          });
        }
        return {
          State: { Status: "running", Running: true, Pid: 1 },
          NetworkSettings: { Ports: {} },
        };
      }),
    }));

    const status = await docker.getStackStatus(APP_ID);

    expect(status.containers.map((c) => c.id)).toEqual(["cid-alive"]);
    expect(status.running).toBe(1);
  });

  test("getStackStatus aggregates running/stopped/restarting counts", async () => {
    const dataDir = await createTempDir("deckos-docker-status-");
    const docker = await loadDockerModule(dataDir);

    listContainersMock.mockResolvedValue([
      {
        Id: "cid-run",
        Names: ["/run"],
        Image: "one",
        ImageID: "one",
        Command: "run",
        Created: 1,
        Status: "Up",
        Labels: {},
      },
      {
        Id: "cid-restart",
        Names: ["/restart"],
        Image: "two",
        ImageID: "two",
        Command: "run",
        Created: 1,
        Status: "Restarting",
        Labels: {},
      },
    ]);
    getContainerMock.mockImplementation((id: string) => ({
      inspect: vi.fn(async () =>
        id === "cid-run"
          ? {
              State: {
                Status: "running",
                Running: true,
                Paused: false,
                Restarting: false,
                Dead: false,
                Pid: 1,
              },
              NetworkSettings: { Ports: {} },
            }
          : {
              State: {
                Status: "restarting",
                Running: false,
                Paused: false,
                Restarting: true,
                Dead: false,
                Pid: 0,
              },
              NetworkSettings: { Ports: {} },
            }
      ),
    }));

    const status = await docker.getStackStatus(APP_ID);

    expect(status.running).toBe(1);
    expect(status.restarting).toBe(1);
    expect(status.stopped).toBe(1);
  });

  test("isDeckosManagedContainer only accepts DeckOS compose projects", async () => {
    const dataDir = await createTempDir("deckos-docker-owned-");
    const docker = await loadDockerModule(dataDir);

    listContainersMock.mockResolvedValue([
      {
        Id: "cid-ours",
        Names: ["/ours"],
        Image: "one",
        ImageID: "one",
        Command: "run",
        Created: 1,
        Status: "Up",
        Labels: { "com.docker.compose.project": `deckos-${APP_ID}` },
      },
    ]);
    await expect(docker.isDeckosManagedContainer("cid-ours")).resolves.toBe(true);

    listContainersMock.mockResolvedValue([
      {
        Id: "cid-theirs",
        Names: ["/theirs"],
        Image: "one",
        ImageID: "one",
        Command: "run",
        Created: 1,
        Status: "Up",
        Labels: { "com.docker.compose.project": "someone-elses-stack" },
      },
    ]);
    await expect(docker.isDeckosManagedContainer("cid-theirs")).resolves.toBe(false);

    listContainersMock.mockResolvedValue([]);
    await expect(docker.isDeckosManagedContainer("cid-missing")).resolves.toBe(false);
  });

  test("getContainerStats computes rounded percentages and handles failures", async () => {
    const dataDir = await createTempDir("deckos-docker-stats-");
    const docker = await loadDockerModule(dataDir);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    getContainerMock.mockReturnValue({
      stats: vi.fn(async () => ({
        cpu_stats: {
          cpu_usage: { total_usage: 2500 },
          system_cpu_usage: 5000,
          online_cpus: 2,
        },
        precpu_stats: {
          cpu_usage: { total_usage: 500 },
          system_cpu_usage: 1000,
        },
        memory_stats: {
          usage: 400,
          limit: 1000,
        },
      })),
    });

    const stats = await docker.getContainerStats("cid-1");
    expect(stats).toEqual({
      cpu: 100,
      memory: 40,
      memoryBytes: 400,
    });

    getContainerMock.mockReturnValue({
      stats: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const failed = await docker.getContainerStats("cid-2");
    expect(failed).toBeNull();
  });

  test("removeContainer forces removal for a single container id", async () => {
    const dataDir = await createTempDir("deckos-docker-remove-");
    const docker = await loadDockerModule(dataDir);
    const removeMock = vi.fn(async () => undefined);
    getContainerMock.mockReturnValue({
      remove: removeMock,
    });

    await docker.removeContainer("cid-remove");

    expect(dockerClient.getContainer).toHaveBeenCalledWith("cid-remove");
    expect(removeMock).toHaveBeenCalledWith({ force: true });
  });
});
