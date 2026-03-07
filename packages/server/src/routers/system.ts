import { router, publicProcedure } from "../trpc/trpc.js";
import si from "systeminformation";
import { z } from "zod";
import { spawn } from "node:child_process";
import * as metricsService from "../services/metrics.js";
import { getDockerAsync } from "../services/docker.js";
import { DATA_DIR } from "../lib/config.js";
import { getCurrentVersion } from "../lib/version.js";
import { checkForUpdatesNow, getUpdateStatus } from "../services/updates.js";
import { applyUpdate } from "../services/selfUpdate.js";

const POWER_COMMANDS = {
  linux: {
    restart: [
      { command: "systemctl", args: ["reboot"] },
      { command: "reboot", args: [] },
    ],
    shutdown: [
      { command: "systemctl", args: ["poweroff"] },
      { command: "shutdown", args: ["-h", "now"] },
      { command: "poweroff", args: [] },
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

async function runPowerAction(action: "restart" | "shutdown") {
  const platformCommands =
    POWER_COMMANDS[process.platform as keyof typeof POWER_COMMANDS] ?? POWER_COMMANDS.linux;
  const commands = platformCommands[action];
  const errors: string[] = [];

  for (const { command, args } of commands) {
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, { detached: true, stdio: "ignore" });
        child.once("error", (error) => reject(error));
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
      });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${command} ${args.join(" ")}: ${message}`);
    }
  }

  throw new Error(
    `Unable to execute ${action} command on ${process.platform}: ${errors.join(" | ")}`
  );
}

export const systemRouter = router({
  getDataDir: publicProcedure.query(async () => {
    return { dataDir: DATA_DIR };
  }),

  ping: publicProcedure.query(() => {
    return {
      status: "ok" as const,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  }),

  getInfo: publicProcedure.query(async () => {
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

  getMetrics: publicProcedure.query(async () => {
    return await metricsService.getOneShotMetrics();
  }),

  getUpdateStatus: publicProcedure.query(async () => {
    return await getUpdateStatus();
  }),

  checkForUpdates: publicProcedure.input(z.object({})).mutation(async () => {
    return await checkForUpdatesNow();
  }),

  applyUpdate: publicProcedure
    .input(z.object({ version: z.string().optional() }))
    .mutation(async ({ input }) => {
      return await applyUpdate(input.version);
    }),

  powerAction: publicProcedure
    .input(z.object({ action: z.enum(["shutdown", "restart"]) }))
    .mutation(async ({ input }) => {
      await runPowerAction(input.action);
      return { ok: true as const, action: input.action };
    }),
});
