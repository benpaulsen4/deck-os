import { TRPCError } from "@trpc/server";
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

function notImplemented(): never {
  throw new TRPCError({
    code: "NOT_IMPLEMENTED",
    message: "Disk analysis scan execution is not implemented yet.",
  });
}

export const diskAnalysisRouter = router({
  getMountState: protectedProcedure
    .input(DiskAnalysisMountIdentitySchema)
    .output(DiskAnalysisMountStateSchema.nullable())
    .query(() => notImplemented()),
  getSnapshot: protectedProcedure
    .input(DiskAnalysisMountIdentitySchema)
    .output(DiskAnalysisSnapshotEnvelopeSchema.nullable())
    .query(() => notImplemented()),
  startScan: protectedProcedure
    .input(DiskAnalysisStartScanInputSchema)
    .output(DiskAnalysisStartScanResultSchema)
    .mutation(() => notImplemented()),
  cancelScan: protectedProcedure
    .input(DiskAnalysisCancelScanInputSchema)
    .output(z.object({ success: z.boolean() }))
    .mutation(() => notImplemented()),
});
