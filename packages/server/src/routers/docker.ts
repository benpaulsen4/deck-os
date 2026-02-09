import { router, publicProcedure } from "../trpc/trpc.js";
import { z } from "zod";
import * as dockerService from "../services/docker.js";
import * as appsService from "../services/apps.js";

export const dockerRouter = router({
  start: publicProcedure
    .input(z.object({ appId: z.string() }))
    .mutation(async ({ input }) => {
      const app = await appsService.getApp(input.appId);
      if (!app) {
        throw new Error("App not found");
      }
      await dockerService.startStack(input.appId);
      return { success: true };
    }),

  stop: publicProcedure
    .input(z.object({ appId: z.string() }))
    .mutation(async ({ input }) => {
      const app = await appsService.getApp(input.appId);
      if (!app) {
        throw new Error("App not found");
      }
      await dockerService.stopStack(input.appId);
      return { success: true };
    }),

  restart: publicProcedure
    .input(z.object({ appId: z.string() }))
    .mutation(async ({ input }) => {
      const app = await appsService.getApp(input.appId);
      if (!app) {
        throw new Error("App not found");
      }
      await dockerService.restartStack(input.appId);
      return { success: true };
    }),

  pull: publicProcedure
    .input(z.object({ appId: z.string() }))
    .mutation(async ({ input }) => {
      const app = await appsService.getApp(input.appId);
      if (!app) {
        throw new Error("App not found");
      }
      await dockerService.pullStack(input.appId, () => {});
      return { success: true };
    }),

  getContainers: publicProcedure
    .input(z.object({ appId: z.string() }))
    .query(async ({ input }) => {
      const app = await appsService.getApp(input.appId);
      if (!app) {
        throw new Error("App not found");
      }
      return await dockerService.getStackContainers(input.appId);
    }),

  getStatus: publicProcedure
    .input(z.object({ appId: z.string() }))
    .query(async ({ input }) => {
      const app = await appsService.getApp(input.appId);
      if (!app) {
        throw new Error("App not found");
      }
      return await dockerService.getStackStatus(input.appId);
    }),
});