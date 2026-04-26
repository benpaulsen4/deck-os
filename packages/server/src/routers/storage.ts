import { router, protectedProcedure } from "../trpc/trpc.js";
import {
  StorageAnalysisResponseSchema,
  StorageAnalysisMountSchema,
} from "../lib/schema.js";
import {
  getStorageAnalysis,
  refreshStorageAnalysis,
} from "../services/storageAnalysis.js";

const StorageAnalysisInputSchema = StorageAnalysisMountSchema.pick({
  mount: true,
  fs: true,
});

export const storageRouter = router({
  getAnalysis: protectedProcedure
    .input(StorageAnalysisInputSchema)
    .output(StorageAnalysisResponseSchema)
    .query(async ({ input }) => {
      return await getStorageAnalysis(input);
    }),
  refreshAnalysis: protectedProcedure
    .input(StorageAnalysisInputSchema)
    .output(StorageAnalysisResponseSchema)
    .mutation(async ({ input }) => {
      return await refreshStorageAnalysis(input);
    }),
});
