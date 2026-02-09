import Docker from "dockerode";
import { execFile, spawn } from "child_process";
import * as path from "path";
import { promisify } from "util";
import type { ContainerInfo, StackStatus } from "../lib/schema.js";

const execFileAsync = promisify(execFile);

const docker = new Docker({
  socketPath: process.env.DOCKER_SOCKET_PATH || "/var/run/docker.sock",
});

const DATA_DIR = process.env.DECKOS_DATA_DIR || path.join(process.cwd(), "data", "apps");

async function getComposeProjectName(appId: string): Promise<string> {
  return `deckos-${appId}`;
}

async function getComposeFilePath(appId: string): Promise<string> {
  return path.join(DATA_DIR, appId, "docker-compose.yml");
}

export async function startStack(appId: string): Promise<void> {
  const projectName = await getComposeProjectName(appId);
  const composePath = await getComposeFilePath(appId);

  const args = [
    "compose",
    "-f",
    composePath,
    "-p",
    projectName,
    "up",
    "-d",
  ];

  await execFileAsync("docker", args);
}

export async function stopStack(appId: string): Promise<void> {
  const projectName = await getComposeProjectName(appId);
  const composePath = await getComposeFilePath(appId);

  const args = [
    "compose",
    "-f",
    composePath,
    "-p",
    projectName,
    "down",
  ];

  await execFileAsync("docker", args);
}

export async function restartStack(appId: string): Promise<void> {
  const projectName = await getComposeProjectName(appId);
  const composePath = await getComposeFilePath(appId);

  const args = [
    "compose",
    "-f",
    composePath,
    "-p",
    projectName,
    "restart",
  ];

  await execFileAsync("docker", args);
}

export async function pullStack(appId: string, onOutput?: (line: string) => void): Promise<void> {
  if (!onOutput) {
    onOutput = () => {};
  }

  return new Promise((resolve, reject) => {
    const projectName = Promise.resolve().then(() => getComposeProjectName(appId));
    const composePath = Promise.resolve().then(() => getComposeFilePath(appId));

    Promise.all([projectName, composePath]).then(async ([project, p]) => {
      const args = [
        "compose",
        "-f",
        p,
        "-p",
        project,
        "pull",
      ];

      const child = spawn("docker", args);

      const outputCallback = onOutput!;

      child.stdout?.on("data", (data) => {
        outputCallback(data.toString());
      });

      child.stderr?.on("data", (data) => {
        outputCallback(data.toString());
      });

      child.on("close", () => {
        resolve();
      });

      child.on("error", (err) => {
        reject(err);
      });
    }).catch(reject);
  });
}

export async function getStackContainers(appId: string): Promise<ContainerInfo[]> {
  const projectName = await getComposeProjectName(appId);

  const containers = await docker.listContainers({
    all: true,
    filters: {
      label: [`com.docker.compose.project=${projectName}`],
    },
  });

  const result: ContainerInfo[] = [];

  for (const container of containers) {
    const containerObj = docker.getContainer(container.Id);
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
          const hostPort = typeof binding.HostPort === "string" ? binding.HostPort : undefined;
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

export function getDocker(): Docker {
  return docker;
}