import { router, publicProcedure } from "../trpc/trpc.js";
import si from "systeminformation";
import * as metricsService from "../services/metrics.js";
import { getDockerAsync } from "../services/docker.js";
import { DATA_DIR } from "../lib/config.js";

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
});
