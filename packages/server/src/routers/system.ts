import { router, publicProcedure } from "../trpc/trpc.js";

export const systemRouter = router({
  ping: publicProcedure.query(() => {
    return {
      status: "ok" as const,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  }),

  getInfo: publicProcedure.query(() => {
    return {
      hostname: "deckos-dev",
      os: process.platform,
      nodeVersion: process.version,
      uptime: process.uptime(),
      // Docker version will be added in Phase 1
      dockerVersion: null,
    };
  }),
});
