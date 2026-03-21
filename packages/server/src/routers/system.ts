import { router, protectedProcedure } from "../trpc/trpc.js";
import si from "systeminformation";
import { z } from "zod";
import { spawn } from "node:child_process";
import * as metricsService from "../services/metrics.js";
import { getDockerAsync } from "../services/docker.js";
import { DATA_DIR } from "../lib/config.js";
import { getCurrentVersion } from "../lib/version.js";
import { checkForUpdatesNow, getUpdateStatus } from "../services/updates.js";
import { applyUpdate } from "../services/selfUpdate.js";

type PowerCommand = {
  command: string;
  args: readonly string[];
  requiresRoot?: boolean;
};

const POWER_COMMANDS = {
  linux: {
    restart: [
      { command: "/usr/bin/systemctl", args: ["reboot"], requiresRoot: true },
      { command: "/usr/sbin/reboot", args: [], requiresRoot: true },
      { command: "/sbin/reboot", args: [], requiresRoot: true },
    ],
    shutdown: [
      { command: "/usr/bin/systemctl", args: ["poweroff"], requiresRoot: true },
      { command: "/usr/sbin/shutdown", args: ["-h", "now"], requiresRoot: true },
      { command: "/usr/sbin/poweroff", args: [], requiresRoot: true },
      { command: "/sbin/poweroff", args: [], requiresRoot: true },
    ],
  },
  darwin: {
    restart: [{ command: "shutdown", args: ["-r", "now"] }],
    shutdown: [{ command: "shutdown", args: ["-h", "now"] }],
  },
  win32: {
    restart: [{ command: "shutdown", args: ["/r", "/t", "0", "/f"] }],
    shutdown: [{ command: "shutdown", args: ["/s", "/t", "0", "/f"] }],
  },
} as const;

async function executePowerCommand(
  spawnImpl: typeof spawn,
  command: string,
  args: readonly string[]
) {
  await new Promise<void>((resolve, reject) => {
    const child = spawnImpl(command, args, { stdio: "ignore" });
    child.once("error", (error) => {
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(`exit code ${code ?? "null"}${signal ? ` signal ${signal}` : ""}`)
      );
    });
  });
}

function getUid() {
  if (typeof process.getuid !== "function") {
    return null;
  }

  return process.getuid();
}

function buildPowerAttempts(
  powerCommand: PowerCommand,
  platform: keyof typeof POWER_COMMANDS,
  uid: number | null
) {
  const attempts: PowerCommand[] = [];
  const requiresSudo =
    platform !== "win32" &&
    powerCommand.requiresRoot === true &&
    uid !== null &&
    uid !== 0;
  if (requiresSudo) {
    attempts.push({
      command: "sudo",
      args: ["-n", powerCommand.command, ...powerCommand.args],
    });
  }

  attempts.push(powerCommand);
  return attempts;
}

export async function runPowerAction(
  action: "restart" | "shutdown",
  options?: {
    spawnImpl?: typeof spawn;
    platform?: NodeJS.Platform;
    uid?: number | null;
  }
) {
  const spawnImpl = options?.spawnImpl ?? spawn;
  const platformValue = options?.platform ?? process.platform;
  const platform =
    platformValue === "linux" || platformValue === "darwin" || platformValue === "win32"
      ? platformValue
      : "linux";
  const uid = options?.uid ?? getUid();
  const platformCommands =
    POWER_COMMANDS[platform as keyof typeof POWER_COMMANDS] ?? POWER_COMMANDS.linux;
  const commands = platformCommands[action];
  const errors: string[] = [];

  for (const powerCommand of commands) {
    const attempts = buildPowerAttempts(powerCommand, platform, uid);
    for (const { command, args } of attempts) {
      try {
        await executePowerCommand(spawnImpl, command, args);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${command} ${args.join(" ")}: ${message}`);
      }
    }
  }

  throw new Error(
    `Unable to execute ${action} command on ${platform}: ${errors.join(" | ")}`
  );
}

export const systemRouter = router({
  getDataDir: protectedProcedure.query(async () => {
    return { dataDir: DATA_DIR };
  }),

  ping: protectedProcedure.query(() => {
    return {
      status: "ok" as const,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  }),

  getInfo: protectedProcedure.query(async () => {
    const [osInfo, time] = await Promise.all([si.osInfo(), si.time()]);

    let dockerVersion: string | null = null;
    try {
      const docker = await getDockerAsync();
      if (docker) {
        const dockerInfo = await docker.info();
        dockerVersion = dockerInfo.ServerVersion || null;
      }
    } catch {
      dockerVersion = null;
    }

    return {
      appVersion: getCurrentVersion(),
      hostname: osInfo.hostname,
      os: osInfo.platform,
      osDistro: osInfo.distro,
      osRelease: osInfo.release,
      osArch: osInfo.arch,
      nodeVersion: process.version,
      uptime: time.uptime,
      dockerVersion,
    };
  }),

  getMetrics: protectedProcedure.query(async () => {
    return await metricsService.getOneShotMetrics();
  }),

  getUpdateStatus: protectedProcedure.query(async () => {
    return await getUpdateStatus();
  }),

  checkForUpdates: protectedProcedure.input(z.object({})).mutation(async () => {
    return await checkForUpdatesNow();
  }),

  applyUpdate: protectedProcedure
    .input(z.object({ version: z.string().optional() }))
    .mutation(async ({ input }) => {
      return await applyUpdate(input.version);
    }),

  powerAction: protectedProcedure
    .input(z.object({ action: z.enum(["shutdown", "restart"]) }))
    .mutation(async ({ input }) => {
      await runPowerAction(input.action);
      return { ok: true as const, action: input.action };
    }),
});
