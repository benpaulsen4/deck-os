import * as diskAnalysisService from "../services/diskAnalysis.js";

export type DiskAnalysisHttpStatusCode = 403 | 404 | 409 | 500;
export type DiskAnalysisTrpcErrorCode =
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INTERNAL_SERVER_ERROR";

/**
 * Map the disk-analysis service's domain errors onto codes the browser can act
 * on, following the same shape as `mapFilesError`.
 *
 * B6 introduced two refusals that `startScan` raises on the request path, and
 * with no mapping here they reached the client as raw tRPC 500s -- user
 * reachable through the Scan button, and indistinguishable from a genuine
 * server fault. They deliberately land on different codes:
 *
 *  - `DiskAnalysisScanRefusedError` (denylisted root, or a pseudo-filesystem
 *    the mount table exposed) is `FORBIDDEN`. This path will never scan;
 *    retrying is pointless.
 *  - `DiskAnalysisScanBusyError` (concurrency cap reached, or this mount's
 *    previous job has not finished unwinding) is `CONFLICT`, matching the
 *    "busy, try again" meaning the app lifecycle procedures already give that
 *    code. It clears on its own.
 *
 * `DiskAnalysisMountUnavailableError` is mapped alongside them for the same
 * reason -- a mount that has gone away is a `NOT_FOUND`, not an internal
 * error. Anything else keeps the fallback message rather than leaking an
 * internal one.
 */
export function mapDiskAnalysisError(
  error: unknown,
  fallbackMessage: string
): {
  status: DiskAnalysisHttpStatusCode;
  trpcCode: DiskAnalysisTrpcErrorCode;
  message: string;
} {
  if (error instanceof diskAnalysisService.DiskAnalysisScanRefusedError) {
    return { status: 403, trpcCode: "FORBIDDEN", message: error.message };
  }
  if (error instanceof diskAnalysisService.DiskAnalysisScanBusyError) {
    return { status: 409, trpcCode: "CONFLICT", message: error.message };
  }
  if (error instanceof diskAnalysisService.DiskAnalysisMountUnavailableError) {
    return { status: 404, trpcCode: "NOT_FOUND", message: error.message };
  }
  return {
    status: 500,
    trpcCode: "INTERNAL_SERVER_ERROR",
    message: fallbackMessage,
  };
}
