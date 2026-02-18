import Docker from "dockerode";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import type { ContainerInfo, StackStatus } from "../lib/schema.js";
import { getComposePath, getComposeProjectName } from "../lib/config.js";

const execFileAsync = promisify(execFile);

interface DockerPullEvent {
  id?: string;
  status?: string;
  progress?: string;
  progressDetail?: {
    current?: number;
    total?: number;
  };
}

interface DockerContainerStats {
  cpu_stats: {
    cpu_usage: {
      total_usage: number;
    };
    system_cpu_usage: number;
    online_cpus: number;
  };
  precpu_stats: {
    cpu_usage: {
      total_usage: number;
    };
    system_cpu_usage: number;
  };
  memory_stats: {
    usage: number;
    limit: number;
  };
}

interface DockerModem {
  followProgress(
    stream: NodeJS.ReadableStream,
    onFinished: (err: Error | null) => void,
    onProgress: (event: DockerPullEvent) => void
  ): void;
}

let docker: Docker | null = null;
let dockerCheckPromise: Promise<Docker | null> | null = null;

export function getDocker(): Docker | null {
  if (docker) {
    return docker;
  }

  if (!dockerCheckPromise) {
    dockerCheckPromise = initializeDocker();
  }

  return docker;
}

async function initializeDocker(): Promise<Docker | null> {
  try {
    const isWindows = process.platform === "win32";
    let client: Docker;

    if (process.env.DOCKER_HOST) {
      client = new Docker();
    } else if (isWindows) {
      client = new Docker({ socketPath: "\\\\.\\pipe\\docker_engine" });
    } else if (process.env.DOCKER_SOCKET_PATH) {
      client = new Docker({ socketPath: process.env.DOCKER_SOCKET_PATH });
    } else {
      client = new Docker({ socketPath: "/var/run/docker.sock" });
    }

    await client.ping();
    docker = client;
    return docker;
  } catch (error) {
    const isWindows = process.platform === "win32";
    console.warn(
      "[deckos] Docker not accessible - Docker features will be disabled:",
      error instanceof Error ? error.message : String(error)
    );
    console.warn(`[deckos] Platform: ${isWindows ? "Windows" : "Unix/Linux"}`);
    if (isWindows) {
      console.warn("[deckos] Ensure Docker Desktop is running");
    }
    docker = null;
    return null;
  } finally {
    dockerCheckPromise = null;
  }
}

export async function getDockerAsync(): Promise<Docker | null> {
  if (docker) {
    return docker;
  }
  if (dockerCheckPromise) {
    return dockerCheckPromise;
  }
  return initializeDocker();
}

function ensureDockerAvailable(): Docker {
  const client = getDocker();
  if (!client) {
    throw new Error(
      "Docker is not available. Please ensure Docker is running and the socket is accessible."
    );
  }
  return client;
}

export async function startStack(appId: string): Promise<void> {
  const projectName = await getComposeProjectName(appId);
  const composePath = await getComposePath(appId);

  const args = ["compose", "-f", composePath, "-p", projectName, "up", "-d"];

  await execFileAsync("docker", args);
}

export async function stopStack(appId: string): Promise<void> {
  const projectName = await getComposeProjectName(appId);
  const composePath = await getComposePath(appId);

  const args = ["compose", "-f", composePath, "-p", projectName, "down"];

  await execFileAsync("docker", args);
}

export async function restartStack(appId: string): Promise<void> {
  const projectName = await getComposeProjectName(appId);
  const composePath = await getComposePath(appId);

  const args = ["compose", "-f", composePath, "-p", projectName, "restart"];

  await execFileAsync("docker", args);
}

export async function pullStack(
  appId: string,
  onOutput?: (line: string) => void,
  signal?: AbortSignal
): Promise<void> {
  const outputCallback = onOutput ?? (() => {});

  return new Promise((resolve, reject) => {
    const projectName = getComposeProjectName(appId);
    const composePath = getComposePath(appId);

    const args = ["compose", "-f", composePath, "-p", projectName, "pull"];

    const child = spawn("docker", args);

    if (signal) {
      if (signal.aborted) {
        child.kill();
      } else {
        signal.addEventListener("abort", () => {
          child.kill();
        });
      }
    }

    child.stdout?.on("data", (data) => {
      outputCallback(data.toString());
    });

    child.stderr?.on("data", (data) => {
      outputCallback(data.toString());
    });

    child.on("close", (code, sig) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `docker compose pull failed (code=${code ?? "null"}, signal=${sig ?? "null"})`
        )
      );
    });

    child.on("error", (err) => {
      reject(err);
    });
  });
}

export type PullOverallProgress = {
  currentBytes: number | null;
  totalBytes: number | null;
  percent: number;
  completedImages: number;
  totalImages: number;
  activeImage?: string;
  indeterminate: boolean;
};

function unitToMultiplier(unit: string): number {
  const u = unit.toUpperCase();
  if (u === "B") return 1;
  if (u === "KB" || u === "KIB") return 1024;
  if (u === "MB" || u === "MIB") return 1024 ** 2;
  if (u === "GB" || u === "GIB") return 1024 ** 3;
  if (u === "TB" || u === "TIB") return 1024 ** 4;
  return 1;
}

function parseBytesToken(token: string): number | null {
  const trimmed = token.trim();
  const match = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]{1,3})$/.exec(trimmed);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const mult = unitToMultiplier(match[2]);
  return Math.round(value * mult);
}

function parseProgressBytes(progress: unknown): {
  current?: number;
  total?: number;
} {
  if (typeof progress !== "string") return {};
  const match =
    /(\d+(?:\.\d+)?)\s*([a-zA-Z]{1,3})\s*\/\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]{1,3})/.exec(
      progress
    );
  if (!match) return {};
  const current = parseBytesToken(`${match[1]}${match[2]}`);
  const total = parseBytesToken(`${match[3]}${match[4]}`);
  return { current: current ?? undefined, total: total ?? undefined };
}

export async function pullImagesWithProgress(
  images: string[],
  onProgress: (progress: PullOverallProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  const dockerClient = ensureDockerAvailable();
  const modem = (dockerClient as unknown as { modem: DockerModem }).modem;
  const uniqueImages = Array.from(new Set(images.map((i) => i.trim()).filter(Boolean)));

  const state = new Map<
    string,
    {
      layers: Map<string, { current?: number; total?: number }>;
      done?: boolean;
    }
  >();

  const emit = (activeImage?: string) => {
    let currentBytes = 0;
    let totalBytes = 0;
    let hasTotals = false;
    let completedImages = 0;
    let imagesWithTotals = 0;
    let sumImagePercents = 0;

    for (const image of uniqueImages) {
      const p = state.get(image);
      if (p?.done) completedImages++;

      const layers = p?.layers;
      if (!layers || layers.size === 0) {
        sumImagePercents += p?.done ? 1 : 0;
        continue;
      }

      let imgCurrent = 0;
      let imgTotal = 0;
      let layersWithTotals = 0;
      let doneLayers = 0;

      for (const layer of layers.values()) {
        if (typeof layer.total === "number" && layer.total > 0) {
          layersWithTotals++;
          imgTotal += layer.total;
          imgCurrent += Math.min(layer.current ?? 0, layer.total);
          if ((layer.current ?? 0) >= layer.total) doneLayers++;
        }
      }

      if (imgTotal > 0) {
        hasTotals = true;
        imagesWithTotals++;
        totalBytes += imgTotal;
        currentBytes += imgCurrent;
        sumImagePercents += imgCurrent / imgTotal;
      } else if (layersWithTotals > 0) {
        sumImagePercents += doneLayers / layersWithTotals;
      } else {
        sumImagePercents += p?.done ? 1 : 0;
      }
    }

    const totalImages = uniqueImages.length;
    const percent =
      totalImages > 0
        ? Math.max(0, Math.min(100, (sumImagePercents / totalImages) * 100))
        : 100;

    onProgress({
      currentBytes: hasTotals ? currentBytes : null,
      totalBytes: hasTotals ? totalBytes : null,
      percent,
      completedImages,
      totalImages,
      activeImage,
      indeterminate: !hasTotals,
    });
  };

  emit();

  for (const image of uniqueImages) {
    if (signal?.aborted) {
      throw new Error("Pull aborted");
    }

    await new Promise<void>((resolve, reject) => {
      dockerClient.pull(
        image,
        (err: Error | null, stream: NodeJS.ReadableStream | null) => {
          if (err) {
            reject(err);
            return;
          }

          if (!stream) {
            reject(new Error("No stream returned from pull"));
            return;
          }

          const destroyableStream = stream as NodeJS.ReadableStream & {
            destroy: () => void;
          };

          if (signal) {
            if (signal.aborted) {
              destroyableStream.destroy();
            } else {
              signal.addEventListener(
                "abort",
                () => {
                  destroyableStream.destroy();
                },
                { once: true }
              );
            }
          }

          modem.followProgress(
            stream,
            (followErr: Error | null) => {
              if (followErr) {
                reject(followErr);
                return;
              }
              const existing = state.get(image) || {
                layers: new Map<string, { current?: number; total?: number }>(),
              };
              state.set(image, { ...existing, done: true });
              emit(image);
              resolve();
            },
            (event: DockerPullEvent) => {
              const detail = event?.progressDetail;
              const id =
                typeof event?.id === "string" && event.id.trim()
                  ? event.id.trim()
                  : undefined;
              const current =
                typeof detail?.current === "number" ? detail.current : undefined;
              const total = typeof detail?.total === "number" ? detail.total : undefined;
              const fromText = parseProgressBytes(event?.progress);
              const mergedCurrent = current ?? fromText.current;
              const mergedTotal = total ?? fromText.total;

              const existing = state.get(image) || {
                layers: new Map<string, { current?: number; total?: number }>(),
              };
              if (id) {
                const prevLayer = existing.layers.get(id) || {};
                existing.layers.set(id, {
                  ...prevLayer,
                  current: mergedCurrent,
                  total: mergedTotal,
                });
              }
              state.set(image, existing);
              emit(image);
            }
          );
        }
      );
    });
  }

  emit();
}

export async function getStackContainers(appId: string): Promise<ContainerInfo[]> {
  const dockerClient = ensureDockerAvailable();
  const projectName = await getComposeProjectName(appId);

  const containers = await dockerClient.listContainers({
    all: true,
    filters: {
      label: [`com.docker.compose.project=${projectName}`],
    },
  });

  const result: ContainerInfo[] = [];

  for (const container of containers) {
    const containerObj = dockerClient.getContainer(container.Id);
    const inspect = await containerObj.inspect();

    const state = inspect.State;
    const portBindings = inspect.NetworkSettings.Ports || {};

    const ports: Array<{
      private: number;
      public?: number;
      type?: string;
      ip?: string;
    }> = [];
    for (const [port, bindings] of Object.entries(portBindings)) {
      if (bindings) {
        const binding = Array.isArray(bindings) ? bindings[0] : bindings;
        if (binding) {
          const hostPort =
            typeof binding.HostPort === "string" ? binding.HostPort : undefined;
          const hostIp = typeof binding.HostIp === "string" ? binding.HostIp : "0.0.0.0";
          ports.push({
            private: parseInt(port.split("/")[0], 10),
            public: hostPort ? parseInt(hostPort, 10) : undefined,
            type: port.split("/")[1] || "tcp",
            ip: hostIp,
          });
        }
      }
    }

    result.push({
      id: container.Id,
      names: container.Names,
      image: container.Image,
      imageId: container.ImageID,
      command: container.Command,
      created: container.Created,
      state: {
        status: state.Status || "unknown",
        running: state.Running || false,
        paused: state.Paused || false,
        restarting: state.Restarting || false,
        dead: state.Dead || false,
        pid: state.Pid || 0,
        exitCode: state.ExitCode,
        error: state.Error,
        startedAt: state.StartedAt,
        finishedAt: state.FinishedAt,
      },
      status: container.Status,
      ports: ports.length > 0 ? ports : undefined,
      labels: container.Labels,
    });
  }

  return result;
}

export async function getStackStatus(appId: string): Promise<StackStatus> {
  const containers = await getStackContainers(appId);

  const running = containers.filter((c) => c.state.running).length;
  const stopped = containers.filter((c) => c.state.dead || !c.state.running).length;
  const restarting = containers.filter((c) => c.state.restarting).length;

  return {
    running,
    stopped,
    restarting,
    containers,
  };
}

export async function getContainerStats(
  containerId: string
): Promise<{ cpu: number; memory: number; memoryBytes: number } | null> {
  try {
    const dockerClient = ensureDockerAvailable();
    const container = dockerClient.getContainer(containerId);
    const stats = (await container.stats({
      stream: false,
    })) as unknown as DockerContainerStats;

    const cpuDelta =
      stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const systemDelta =
      stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const cpuPercent = (cpuDelta / systemDelta) * stats.cpu_stats.online_cpus * 100;

    const memoryUsage = stats.memory_stats.usage || 0;
    const memoryLimit = stats.memory_stats.limit || 1;
    const memoryPercent = (memoryUsage / memoryLimit) * 100;

    return {
      cpu: Math.round(cpuPercent),
      memory: Math.round(memoryPercent),
      memoryBytes: memoryUsage,
    };
  } catch (error) {
    console.error(`Failed to get stats for container ${containerId}:`, error);
    return null;
  }
}
