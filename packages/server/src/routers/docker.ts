import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../trpc/trpc.js";
import { z } from "zod";
import * as dockerService from "../services/docker.js";
import * as appsService from "../services/apps.js";
import { AppNotFoundError } from "../lib/errors.js";
import { AppIdSchema } from "../lib/schema.js";

function isUnknownContainerStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  if (normalized.includes("running") || normalized.includes("up")) return false;
  if (normalized.includes("stopped") || normalized.includes("exited")) return false;
  if (normalized.includes("restarting")) return false;
  return true;
}

export const dockerRouter = router({
  getContainerStats: protectedProcedure
    .input(z.object({ containerId: z.string() }))
    .query(async ({ input }) => {
      return await dockerService.getContainerStats(input.containerId);
    }),

  getStatuses: protectedProcedure
    .input(z.object({ appIds: z.array(AppIdSchema).max(500) }))
    .query(async ({ input }) => {
      const uniqueAppIds = Array.from(new Set(input.appIds));
      const docker = await dockerService.getDockerAsync();
      if (!docker) {
        return {
          available: false as const,
          statuses: Object.fromEntries(uniqueAppIds.map((appId) => [appId, null])),
        };
      }

      const entries = await Promise.all(
        uniqueAppIds.map(async (appId) => {
          try {
            const status = await dockerService.getStackStatus(appId);
            return [appId, status] as const;
          } catch {
            return [appId, null] as const;
          }
        })
      );

      const statuses: Record<
        string,
        Awaited<ReturnType<typeof dockerService.getStackStatus>> | null
      > = Object.fromEntries(entries);

      return { available: true as const, statuses };
    }),

  start: protectedProcedure
    .input(z.object({ appId: AppIdSchema }))
    .mutation(async ({ input }) => {
      const app = await appsService.getApp(input.appId);
      if (!app) {
        throw new AppNotFoundError(input.appId);
      }
      await dockerService.startStack(input.appId);
      return { success: true };
    }),

  stop: protectedProcedure
    .input(z.object({ appId: AppIdSchema }))
    .mutation(async ({ input }) => {
      const app = await appsService.getApp(input.appId);
      if (!app) {
        throw new AppNotFoundError(input.appId);
      }
      await dockerService.stopStack(input.appId);
      return { success: true };
    }),

  restart: protectedProcedure
    .input(z.object({ appId: AppIdSchema }))
    .mutation(async ({ input }) => {
      const app = await appsService.getApp(input.appId);
      if (!app) {
        throw new AppNotFoundError(input.appId);
      }
      await dockerService.restartStack(input.appId);
      return { success: true };
    }),

  removeContainer: protectedProcedure
    .input(z.object({ appId: AppIdSchema, containerId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const app = await appsService.getApp(input.appId);
      if (!app) {
        throw new AppNotFoundError(input.appId);
      }

      const containers = await dockerService.getStackContainers(input.appId);
      const container = containers.find((entry) => entry.id === input.containerId);

      if (!container) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Container not found in app stack",
        });
      }

      if (!isUnknownContainerStatus(container.state.status)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only containers in unknown state can be removed individually",
        });
      }

      await dockerService.removeContainer(input.containerId);
      return { success: true };
    }),

  pull: protectedProcedure
    .input(z.object({ appId: AppIdSchema }))
    .mutation(async ({ input }) => {
      const app = await appsService.getApp(input.appId);
      if (!app) {
        throw new AppNotFoundError(input.appId);
      }
      await dockerService.pullStack(input.appId, () => {});
      return { success: true };
    }),

  getContainers: protectedProcedure
    .input(z.object({ appId: AppIdSchema }))
    .query(async ({ input }) => {
      const app = await appsService.getApp(input.appId);
      if (!app) {
        throw new AppNotFoundError(input.appId);
      }
      return await dockerService.getStackContainers(input.appId);
    }),

  getStatus: protectedProcedure
    .input(z.object({ appId: AppIdSchema }))
    .query(async ({ input }) => {
      const app = await appsService.getApp(input.appId);
      if (!app) {
        throw new AppNotFoundError(input.appId);
      }
      return await dockerService.getStackStatus(input.appId);
    }),
});
