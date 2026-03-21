import { router, protectedProcedure } from "../trpc/trpc.js";
import { z } from "zod";
import * as templatesService from "../services/templates.js";
import { OptionalUrlOrPathSchema, OptionalUrlSchema } from "../lib/schema.js";

const TemplateParameterSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(["string", "number", "boolean", "port", "path", "enum"]),
  defaultValue: z.string().optional(),
  description: z.string().optional(),
  required: z.boolean().optional().default(false),
  options: z.array(z.string()).optional(),
});

const TemplateSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().default(""),
  categories: z.array(z.string()).default([]),
  icon: OptionalUrlOrPathSchema,
});

const TemplateDetailSchema = TemplateSummarySchema.extend({
  composeTemplate: z.string(),
  webUrlTemplate: z.string().optional().default(""),
  parameters: z.array(TemplateParameterSchema).default([]),
});

export const templatesRouter = router({
  list: protectedProcedure
    .input(
      z
        .object({
          query: z.string().optional().default(""),
          category: z.string().optional().default(""),
          page: z.number().int().min(1).optional().default(1),
          pageSize: z.number().int().min(1).max(100).optional().default(24),
        })
        .optional()
        .default({})
    )
    .query(async ({ input }) => {
      const result = await templatesService.listTemplates({
        query: input.query,
        category: input.category,
        page: input.page,
        pageSize: input.pageSize,
      });
      return {
        items: z.array(TemplateSummarySchema).parse(result.items),
        total: result.total,
        categories: result.categories,
      };
    }),

  get: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const tpl = await templatesService.getTemplate(input.id);
    return TemplateDetailSchema.parse(tpl);
  }),

  deploy: protectedProcedure
    .input(
      z.object({
        templateId: z.string(),
        name: z.string().min(1),
        description: z.string().optional().default(""),
        icon: OptionalUrlOrPathSchema,
        url: OptionalUrlSchema,
        parameters: z.record(z.string()).optional().default({}),
        composeOverride: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      return await templatesService.deployTemplate({
        templateId: input.templateId,
        name: input.name,
        description: input.description,
        icon: input.icon,
        url: input.url,
        parameters: input.parameters,
        composeOverride: input.composeOverride,
      });
    }),
});
