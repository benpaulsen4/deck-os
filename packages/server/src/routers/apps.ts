import { router, publicProcedure } from "../trpc/trpc.js";
import { z } from "zod";
import * as appsService from "../services/apps.js";

export const appsRouter = router({
  list: publicProcedure.query(async () => {
    return await appsService.listApps();
  }),

  get: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const app = await appsService.getApp(input.id);
      if (!app) {
        throw new Error("App not found");
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
      } catch (error: any) {
        return { valid: false, message: error.message || "Invalid compose YAML" };
      }
    }),

  create: publicProcedure
    .input(
      z.object({
        name: z.string().min(1),
        description: z.string().optional().default(""),
        icon: z.string().url().optional().default(""),
        url: z.string().url().optional().default(""),
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
        id: z.string(),
        name: z.string().optional(),
        description: z.string().optional(),
        icon: z.string().optional(),
        url: z.string().optional(),
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
        throw new Error("App not found");
      }
      return app;
    }),

  updateCompose: publicProcedure
    .input(
      z.object({
        id: z.string(),
        composeYaml: z.string().min(1),
      })
    )
    .mutation(async ({ input }) => {
      const app = await appsService.updateCompose(input.id, input.composeYaml);
      if (!app) {
        throw new Error("App not found");
      }
      return app;
    }),

  delete: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const deleted = await appsService.deleteApp(input.id);
      if (!deleted) {
        throw new Error("App not found");
      }
      return { success: true };
    }),

  reorder: publicProcedure
    .input(z.object({ orderedIds: z.array(z.string()) }))
    .mutation(async ({ input }) => {
      await appsService.reorderApps(input.orderedIds);
      return { success: true };
    }),
});