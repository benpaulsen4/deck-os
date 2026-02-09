import { router, publicProcedure } from "../trpc/trpc.js";
import si from "systeminformation";
import * as metricsService from "../services/metrics.js";

export const systemRouter = router({
  ping: publicProcedure.query(() => {
    return {
      status: "ok" as const,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  }),

  getInfo: publicProcedure.query(async () => {
    const [osInfo, time] = await Promise.all([
      si.osInfo(),
      si.time(),
    ]);

    let dockerVersion: string | null = null;
    try {
      const dockerInfo = await si.dockerInfo() as { version?: string };
      dockerVersion = dockerInfo.version || null;
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
