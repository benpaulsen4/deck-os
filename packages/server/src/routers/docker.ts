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
 *
 * Full 64-character ids only. Every id reaching these procedures comes from
 * `getStackContainers`, which returns `container.Id` in full, and both
 * ownership checks compare ids exactly - accepting the short form `docker ps`
 * prints would validate and then always fail those comparisons.
 */
export const ContainerIdSchema = z.string().regex(/^[0-9a-f]{64}$/, "Invalid container id");

/**
 * Runs `fn` under the app's lock, surfacing a contended lock as CONFLICT rather
 * than queueing the request behind a compose command that may run for minutes.
 */
async function withAppLockOrBusy<T>(appId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await appsService.withAppLockOrBusy(appId, fn);
  } catch (error) {
    if (error instanceof appsService.AppBusyError) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "Another operation is already running for this app. Try again shortly.",
        cause: error,
      });
    }
    throw error;
  }
}

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
      //
      // Caution for that follow-up: this branch costs one `listContainers`,
      // whereas assertContainerInStack calls getStackContainers, which inspects
      // every container in the stack. ContainerTable polls per running container
      // every 5s, so requiring appId without an ownership-only fast path (or a
      // short-TTL cache) would turn that into N x (1 list + N inspects).
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

  // Every container-mutating compose invocation below runs inside the per-app
  // lock: two clicks on Start would otherwise run two concurrent `compose up`
  // against the same project, and a delete landing mid-start would pull the
  // compose file out from under a running command. These use the fail-fast
  // variant so a queued click is told the app is busy instead of hanging behind
  // a compose command that may run for minutes.
  start: protectedProcedure
    .input(z.object({ appId: AppIdSchema }))
    .mutation(async ({ input }) => {
      await withAppLockOrBusy(input.appId, async () => {
        await assertAppExists(input.appId);
        await dockerService.startStack(input.appId);
      });
      return { success: true };
    }),

  stop: protectedProcedure
    .input(z.object({ appId: AppIdSchema }))
    .mutation(async ({ input }) => {
      await withAppLockOrBusy(input.appId, async () => {
        await assertAppExists(input.appId);
        await dockerService.stopStack(input.appId);
      });
      return { success: true };
    }),

  restart: protectedProcedure
    .input(z.object({ appId: AppIdSchema }))
    .mutation(async ({ input }) => {
      await withAppLockOrBusy(input.appId, async () => {
        await assertAppExists(input.appId);
        await dockerService.restartStack(input.appId);
      });
      return { success: true };
    }),

  removeContainer: protectedProcedure
    .input(z.object({ appId: AppIdSchema, containerId: ContainerIdSchema }))
    .mutation(async ({ input }) => {
      await withAppLockOrBusy(input.appId, async () => {
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

  // Deliberately NOT lock-held. `compose pull` only downloads images - it
  // creates no containers - and it can run for many minutes, which is the same
  // reason pullJobs.startPullJob stays outside the lock. Holding it here would
  // block start/stop/delete for the duration. A delete landing mid-pull makes
  // the pull fail with a compose error, which is self-correcting.
  pull: protectedProcedure
    .input(z.object({ appId: AppIdSchema }))
    .mutation(async ({ input }) => {
      await assertAppExists(input.appId);
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
