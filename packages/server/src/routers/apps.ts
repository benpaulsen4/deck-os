import { router, publicProcedure } from "../trpc/trpc.js";
import { z } from "zod";
import * as appsService from "../services/apps.js";
import * as dockerService from "../services/docker.js";
import {
  AppIdSchema,
  OptionalUrlOrPathSchema,
  OptionalUrlSchema,
  UrlOrEmptySchema,
} from "../lib/schema.js";
import { AppNotFoundError, getErrorMessage } from "../lib/errors.js";

export const appsRouter = router({
  list: publicProcedure.query(async () => {
    return await appsService.listApps();
  }),

  get: publicProcedure.input(z.object({ id: AppIdSchema })).query(async ({ input }) => {
    const app = await appsService.getApp(input.id);
    if (!app) {
      throw new AppNotFoundError(input.id);
    }
    return app;
  }),

  validateCompose: publicProcedure
    .input(z.object({ composeYaml: z.string() }))
    .mutation(async ({ input }) => {
      try {
        const { parse } = await import("yaml");
        const { ComposeFileSchema } = await import("../lib/schema.js");

        const parsed = parse(input.composeYaml);
        ComposeFileSchema.parse(parsed);

        return { valid: true, message: "Compose YAML is valid" };
      } catch (error: unknown) {
        return {
          valid: false,
          message: getErrorMessage(error),
        };
      }
    }),

  create: publicProcedure
    .input(
      z.object({
        name: z.string().min(1),
        description: z.string().optional().default(""),
        icon: OptionalUrlOrPathSchema,
        url: OptionalUrlSchema,
        composeYaml: z.string().min(1),
      })
    )
    .mutation(async ({ input }) => {
      return await appsService.createApp(
        input.name,
        input.description,
        input.icon,
        input.url,
        input.composeYaml
      );
    }),

  update: publicProcedure
    .input(
      z.object({
        id: AppIdSchema,
        name: z.string().optional(),
        description: z.string().optional(),
        icon: z.union([UrlOrEmptySchema, z.string().startsWith("/")]).optional(),
        url: UrlOrEmptySchema.optional(),
      })
    )
    .mutation(async ({ input }) => {
      const updates: Record<string, string> = {};
      if (input.name !== undefined) updates.name = input.name;
      if (input.description !== undefined) updates.description = input.description;
      if (input.icon !== undefined) updates.icon = input.icon;
      if (input.url !== undefined) updates.url = input.url;

      const app = await appsService.updateApp(input.id, updates);
      if (!app) {
        throw new AppNotFoundError(input.id);
      }
      return app;
    }),

  updateCompose: publicProcedure
    .input(
      z.object({
        id: AppIdSchema,
        composeYaml: z.string().min(1),
      })
    )
    .mutation(async ({ input }) => {
      const app = await appsService.updateCompose(input.id, input.composeYaml);
      if (!app) {
        throw new AppNotFoundError(input.id);
      }
      return app;
    }),

  delete: publicProcedure
    .input(z.object({ id: AppIdSchema }))
    .mutation(async ({ input }) => {
      try {
        await dockerService.stopStack(input.id);
      } catch {
        // Ignore stop errors during delete
      }
      const deleted = await appsService.deleteApp(input.id);
      if (!deleted) {
        throw new AppNotFoundError(input.id);
      }
      return { success: true };
    }),

  reorder: publicProcedure
    .input(z.object({ orderedIds: z.array(AppIdSchema) }))
    .mutation(async ({ input }) => {
      await appsService.reorderApps(input.orderedIds);
      return { success: true };
    }),
});
