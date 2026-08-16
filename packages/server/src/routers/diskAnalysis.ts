import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  DiskAnalysisCancelScanInputSchema,
  DiskAnalysisMountIdentitySchema,
  DiskAnalysisMountStateSchema,
  DiskAnalysisSnapshotEnvelopeSchema,
  DiskAnalysisStartScanInputSchema,
  DiskAnalysisStartScanResultSchema,
} from "@deckos/contracts";
import { protectedProcedure, router } from "../trpc/trpc.js";
import { mapDiskAnalysisError } from "../lib/diskAnalysisErrors.js";
import * as diskAnalysisService from "../services/diskAnalysis.js";

function toTrpcError(error: unknown, fallbackMessage: string): TRPCError {
  const mapped = mapDiskAnalysisError(error, fallbackMessage);
  return new TRPCError({
    code: mapped.trpcCode,
    message: mapped.message,
  });
}

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
      try {
        return await diskAnalysisService.startScan(input.mount);
      } catch (error) {
        throw toTrpcError(error, "Failed to start disk analysis scan");
      }
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
