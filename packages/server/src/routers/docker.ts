import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../trpc/trpc.js";
import { z } from "zod";
import * as dockerService from "../services/docker.js";
import * as appsService from "../services/apps.js";
import { AppNotFoundError } from "../lib/errors.js";
import { AppIdSchema } from "../lib/schema.js";

/**
 * Docker container ids are hex digests. Constraining the shape keeps arbitrary
 * strings out of the daemon paths dockerode builds by string concatenation.
 */
const ContainerIdSchema = z.string().regex(/^[0-9a-f]{12,64}$/, "Invalid container id");

async function assertAppExists(appId: string): Promise<void> {
  const app = await appsService.getApp(appId);
  if (!app) {
    throw new AppNotFoundError(appId);
  }
}

async function assertContainerInStack(appId: string, containerId: string): Promise<void> {
  await assertAppExists(appId);

  const containers = await dockerService.getStackContainers(appId);
  if (!containers.some((entry) => entry.id === containerId)) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Container not found in app stack",
    });
  }
}

function isUnknownContainerStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  if (normalized.includes("running") || normalized.includes("up")) return false;
  if (normalized.includes("stopped") || normalized.includes("exited")) return false;
  if (normalized.includes("restarting")) return false;
  return true;
}

export const dockerRouter = router({
  getContainerStats: protectedProcedure
    .input(z.object({ appId: AppIdSchema.optional(), containerId: ContainerIdSchema }))
    .query(async ({ input }) => {
      // `appId` is optional only so the existing client keeps working; it should
      // become required once the client passes the app it is rendering. Without
      // it we still refuse containers that no DeckOS compose project created.
      if (input.appId) {
        await assertContainerInStack(input.appId, input.containerId);
      } else if (!(await dockerService.isDeckosManagedContainer(input.containerId))) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Container is not managed by DeckOS",
        });
      }

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

  // Every compose invocation below runs inside the per-app lock: two clicks on
  // Start would otherwise run two concurrent `compose up` against the same
  // project, and a delete landing mid-start would pull the compose file out
  // from under a running command.
  start: protectedProcedure
    .input(z.object({ appId: AppIdSchema }))
    .mutation(async ({ input }) => {
      await appsService.withAppLock(input.appId, async () => {
        await assertAppExists(input.appId);
        await dockerService.startStack(input.appId);
      });
      return { success: true };
    }),

  stop: protectedProcedure
    .input(z.object({ appId: AppIdSchema }))
    .mutation(async ({ input }) => {
      await appsService.withAppLock(input.appId, async () => {
        await assertAppExists(input.appId);
        await dockerService.stopStack(input.appId);
      });
      return { success: true };
    }),

  restart: protectedProcedure
    .input(z.object({ appId: AppIdSchema }))
    .mutation(async ({ input }) => {
      await appsService.withAppLock(input.appId, async () => {
        await assertAppExists(input.appId);
        await dockerService.restartStack(input.appId);
      });
      return { success: true };
    }),

  removeContainer: protectedProcedure
    .input(z.object({ appId: AppIdSchema, containerId: ContainerIdSchema }))
    .mutation(async ({ input }) => {
      await appsService.withAppLock(input.appId, async () => {
        await assertAppExists(input.appId);

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
      });
      return { success: true };
    }),

  pull: protectedProcedure
    .input(z.object({ appId: AppIdSchema }))
    .mutation(async ({ input }) => {
      await appsService.withAppLock(input.appId, async () => {
        await assertAppExists(input.appId);
        await dockerService.pullStack(input.appId, () => {});
      });
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
