import { router, protectedProcedure } from "../trpc/trpc.js";
import { z } from "zod";
import {
  StorageAnalysisStartResponseSchema,
  StorageAnalysisResponseSchema,
  StorageAnalysisMountSchema,
} from "../lib/schema.js";
import {
  getStorageAnalysis,
  startStorageAnalysis,
  refreshStorageAnalysis,
} from "../services/storageAnalysis.js";

const StorageAnalysisInputSchema = StorageAnalysisMountSchema.pick({
  mount: true,
  fs: true,
});

const StorageAnalysisStartInputSchema = StorageAnalysisInputSchema.extend({
  force: z.boolean().optional().default(false),
});

export const storageRouter = router({
  getAnalysis: protectedProcedure
    .input(StorageAnalysisInputSchema)
    .output(StorageAnalysisResponseSchema)
    .query(async ({ input }) => {
      return await getStorageAnalysis(input);
    }),
  startAnalysis: protectedProcedure
    .input(StorageAnalysisStartInputSchema)
    .output(StorageAnalysisStartResponseSchema)
    .mutation(async ({ input }) => {
      return await startStorageAnalysis(input, undefined, input.force);
    }),
  refreshAnalysis: protectedProcedure
    .input(StorageAnalysisInputSchema)
    .output(StorageAnalysisResponseSchema)
    .mutation(async ({ input }) => {
      return await refreshStorageAnalysis(input);
    }),
});
