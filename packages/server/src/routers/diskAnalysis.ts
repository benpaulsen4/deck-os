import { z } from "zod";
import {
  DiskAnalysisCancelScanInputSchema,
  DiskAnalysisMountIdentitySchema,
  DiskAnalysisMountStateSchema,
  DiskAnalysisSnapshotEnvelopeSchema,
  DiskAnalysisStartScanInputSchema,
  DiskAnalysisStartScanResultSchema,
} from "../lib/diskAnalysisContract.js";
import { protectedProcedure, router } from "../trpc/trpc.js";
import * as diskAnalysisService from "../services/diskAnalysis.js";

export const diskAnalysisRouter = router({
  getMountState: protectedProcedure
    .input(DiskAnalysisMountIdentitySchema)
    .output(DiskAnalysisMountStateSchema.nullable())
    .query(async ({ input }) => {
      return await diskAnalysisService.getMountState(input);
    }),
  getSnapshot: protectedProcedure
    .input(DiskAnalysisMountIdentitySchema)
    .output(DiskAnalysisSnapshotEnvelopeSchema.nullable())
    .query(async ({ input }) => {
      return await diskAnalysisService.getCachedSnapshot(input);
    }),
  startScan: protectedProcedure
    .input(DiskAnalysisStartScanInputSchema)
    .output(DiskAnalysisStartScanResultSchema)
    .mutation(async ({ input }) => {
      return await diskAnalysisService.startScan(input.mount);
    }),
  cancelScan: protectedProcedure
    .input(DiskAnalysisCancelScanInputSchema)
    .output(z.object({ success: z.boolean() }))
    .mutation(({ input }) => {
      return {
        success: diskAnalysisService.cancelScan(input.mount, input.jobId),
      };
    }),
});
