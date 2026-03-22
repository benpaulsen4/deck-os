import { beforeEach, describe, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const execFileMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());
const getComposePathMock = vi.hoisted(() => vi.fn(async () => "/tmp/app/docker-compose.yml"));
const getComposeProjectNameMock = vi.hoisted(() => vi.fn(async () => "app-project"));

const dockerClient = vi.hoisted(() => ({
  ping: vi.fn(async () => undefined),
  pull: vi.fn(),
  modem: {
    followProgress: vi.fn(),
  },
  listContainers: vi.fn(async () => []),
  getContainer: vi.fn(),
}));

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
vi.mock("../lib/config.js", () => ({
  getComposePath: getComposePathMock,
  getComposeProjectName: getComposeProjectNameMock,
}));
vi.mock("dockerode", () => ({
  default: vi.fn(() => dockerClient),
}));

import {
  getContainerStats,
  getStackContainers,
  getStackStatus,
  pullStack,
  pullImagesWithProgress,
  restartStack,
  startStack,
  stopStack,
} from "./docker.js";

describe("docker service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execFileMock.mockResolvedValue({ stdout: "", stderr: "" });
  });

  test("start/stop/restart run compose commands with expected args", async () => {
    await startStack("app-id");
    await stopStack("app-id");
    await restartStack("app-id");

    expect(execFileMock).toHaveBeenNthCalledWith(
      1,
      "docker",
      ["compose", "-f", "/tmp/app/docker-compose.yml", "-p", "app-project", "up", "-d"]
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      "docker",
      ["compose", "-f", "/tmp/app/docker-compose.yml", "-p", "app-project", "down"]
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      3,
      "docker",
      ["compose", "-f", "/tmp/app/docker-compose.yml", "-p", "app-project", "restart"]
    );
  });

  test("pullImagesWithProgress reports parsed progress and completes image", async () => {
    dockerClient.pull.mockImplementation(
      (_image: string, cb: (err: Error | null, stream: NodeJS.ReadableStream | null) => void) =>
        cb(null, { destroy: vi.fn() } as unknown as NodeJS.ReadableStream)
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
    await pullImagesWithProgress(["nginx:latest", " nginx:latest "], (progress) => {
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

  test("getStackContainers maps docker inspect data to API shape", async () => {
    (dockerClient.listContainers as any).mockResolvedValue([
      {
        Id: "cid-1",
        Names: ["/app-web-1"],
        Image: "nginx:latest",
        ImageID: "img-1",
        Command: "nginx -g daemon off;",
        Created: 123,
        Status: "Up 10s",
        Labels: { "com.docker.compose.project": "app-project" },
      },
    ]);
    (dockerClient.getContainer as any).mockReturnValue({
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

    const containers = await getStackContainers("app-id");

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

  test("getStackStatus aggregates running/stopped/restarting counts", async () => {
    (dockerClient.listContainers as any).mockResolvedValue([
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
    (dockerClient.getContainer as any).mockImplementation((id: string) => ({
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

    const status = await getStackStatus("app-id");

    expect(status.running).toBe(1);
    expect(status.restarting).toBe(1);
    expect(status.stopped).toBe(1);
  });

  test("getContainerStats computes rounded percentages and handles failures", async () => {
    (dockerClient.getContainer as any).mockReturnValue({
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

    const stats = await getContainerStats("cid-1");
    expect(stats).toEqual({
      cpu: 100,
      memory: 40,
      memoryBytes: 400,
    });

    (dockerClient.getContainer as any).mockReturnValue({
      stats: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const failed = await getContainerStats("cid-2");
    expect(failed).toBeNull();
  });

  test("pullStack streams output and resolves/rejects by exit code", async () => {
    const childSuccess = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => void;
    };
    childSuccess.stdout = new PassThrough();
    childSuccess.stderr = new PassThrough();
    childSuccess.kill = vi.fn();

    spawnMock.mockReturnValueOnce(childSuccess);
    const outputs: string[] = [];
    const promiseOk = pullStack("app-id", (line) => outputs.push(line));
    childSuccess.stdout.write("line-a");
    childSuccess.stderr.write("line-b");
    childSuccess.emit("close", 0, null);
    await promiseOk;
    expect(outputs.join("")).toContain("line-a");

    const childFail = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => void;
    };
    childFail.stdout = new PassThrough();
    childFail.stderr = new PassThrough();
    childFail.kill = vi.fn();
    spawnMock.mockReturnValueOnce(childFail);
    const promiseFail = pullStack("app-id");
    childFail.emit("close", 1, null);
    await expect(promiseFail).rejects.toThrow("docker compose pull failed");
  });
});
