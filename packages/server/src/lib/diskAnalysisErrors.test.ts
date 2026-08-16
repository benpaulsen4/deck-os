import { test, expect } from "vitest";
import {
  DiskAnalysisMountUnavailableError,
  DiskAnalysisScanBusyError,
  DiskAnalysisScanRefusedError,
} from "../services/diskAnalysis.js";
import { mapDiskAnalysisError } from "./diskAnalysisErrors.js";

test("mapDiskAnalysisError separates a refused path from a busy scanner", () => {
  // These are different answers to the user: a refused path will never scan,
  // so retrying is pointless, while a busy scanner is worth retrying in a
  // moment. Sharing one code (or falling through to a raw 500, which is what
  // happened before this mapping existed) collapses that distinction.
  expect(
    mapDiskAnalysisError(
      new DiskAnalysisScanRefusedError("/proc", "Disk analysis refuses to scan /proc"),
      "fallback"
    )
  ).toEqual({
    status: 403,
    trpcCode: "FORBIDDEN",
    message: "Disk analysis refuses to scan /proc",
  });

  expect(
    mapDiskAnalysisError(
      new DiskAnalysisScanBusyError("/data", "A previous scan of /data is still winding down"),
      "fallback"
    )
  ).toEqual({
    status: 409,
    trpcCode: "CONFLICT",
    message: "A previous scan of /data is still winding down",
  });
});

test("mapDiskAnalysisError maps an unavailable mount and falls back for anything else", () => {
  expect(
    mapDiskAnalysisError(
      new DiskAnalysisMountUnavailableError("/mnt/gone", "Disk analysis mount is unavailable: /mnt/gone"),
      "fallback"
    )
  ).toEqual({
    status: 404,
    trpcCode: "NOT_FOUND",
    message: "Disk analysis mount is unavailable: /mnt/gone",
  });

  expect(mapDiskAnalysisError(new Error("raw internal"), "Disk analysis scan failed")).toEqual({
    status: 500,
    trpcCode: "INTERNAL_SERVER_ERROR",
    message: "Disk analysis scan failed",
  });
});
