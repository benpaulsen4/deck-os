import { z } from "zod";
import { AbsolutePathSchema, IsoTimestampSchema, MountFsSchema } from "./common.js";

const DiskAnalysisRouteSearchSchema = z.object({
  mount: AbsolutePathSchema,
  fs: MountFsSchema.optional(),
});

const DiskAnalysisMountIdentitySchema = z.object({
  mount: AbsolutePathSchema,
  fs: MountFsSchema,
});

const DiskAnalysisScanPhaseSchema = z.enum([
  "queued",
  "scanning",
  "completed",
  "failed",
  "cancelled",
  "partial",
]);

const DiskAnalysisIssueCodeSchema = z.enum([
  "permission-denied",
  "path-inaccessible",
  "path-not-found",
  "symlink-skipped",
  "partial-scan",
  "unknown",
]);

const DiskAnalysisIssueSchema = z.object({
  code: DiskAnalysisIssueCodeSchema,
  path: AbsolutePathSchema,
  message: z.string().min(1).max(2048),
  recoverable: z.boolean().default(true),
});

const DiskAnalysisResourceLimitsSchema = z.object({
  maxWorkers: z.number().int().positive(),
  maxPendingDirectories: z.number().int().positive(),
  maxIndexedNodes: z.number().int().positive(),
});

type DiskAnalysisTreemapNode = {
  path: string;
  name: string;
  type: "directory" | "file";
  size: number;
  recursiveSize: number;
  extension?: string | null;
  childCount: number;
  descendantsScanned: number;
  truncated: boolean;
  issues: z.infer<typeof DiskAnalysisIssueSchema>[];
  children: DiskAnalysisTreemapNode[];
};

type DiskAnalysisTreemapNodeInput = {
  path: string;
  name: string;
  type: "directory" | "file";
  size: number;
  recursiveSize: number;
  extension?: string | null;
  childCount: number;
  descendantsScanned: number;
  truncated?: boolean;
  issues?: z.input<typeof DiskAnalysisIssueSchema>[];
  children?: DiskAnalysisTreemapNodeInput[];
};

const DiskAnalysisTreemapNodeSchema: z.ZodType<
  DiskAnalysisTreemapNode,
  z.ZodTypeDef,
  DiskAnalysisTreemapNodeInput
> = z.lazy(
  (): z.ZodType<DiskAnalysisTreemapNode, z.ZodTypeDef, DiskAnalysisTreemapNodeInput> =>
    z.object({
      path: AbsolutePathSchema,
      name: z.string().min(1).max(1024),
      type: z.enum(["directory", "file"]),
      size: z.number().nonnegative(),
      recursiveSize: z.number().nonnegative(),
      extension: z.string().min(1).max(64).nullable().optional(),
      childCount: z.number().int().nonnegative(),
      descendantsScanned: z.number().int().nonnegative(),
      truncated: z.boolean().default(false),
      issues: z.array(DiskAnalysisIssueSchema).default([]),
      children: z.array(DiskAnalysisTreemapNodeSchema).default([]),
    })
);

const DiskAnalysisCacheStateSchema = z.enum(["missing", "fresh", "stale"]);

const DiskAnalysisCacheMetadataSchema = z.object({
  state: DiskAnalysisCacheStateSchema,
  generatedAt: IsoTimestampSchema.optional(),
  staleAt: IsoTimestampSchema.optional(),
});

const DiskAnalysisProgressSchema = z.object({
  directoriesDiscovered: z.number().int().nonnegative(),
  directoriesCompleted: z.number().int().nonnegative(),
  filesDiscovered: z.number().int().nonnegative(),
  bytesProcessed: z.number().nonnegative(),
});

const DiskAnalysisJobStateSchema = z.object({
  jobId: z.string().uuid(),
  mount: DiskAnalysisMountIdentitySchema,
  phase: DiskAnalysisScanPhaseSchema,
  startedAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  progress: DiskAnalysisProgressSchema,
  issues: z.array(DiskAnalysisIssueSchema).default([]),
  limits: DiskAnalysisResourceLimitsSchema,
});

const DiskAnalysisSnapshotSchema = z.object({
  mount: DiskAnalysisMountIdentitySchema,
  generatedAt: IsoTimestampSchema,
  root: DiskAnalysisTreemapNodeSchema,
  extensionLegend: z.array(
    z.object({
      extension: z.string().min(1).max(64),
      colorToken: z.string().min(1).max(64),
      count: z.number().int().nonnegative(),
      totalBytes: z.number().nonnegative().default(0),
    })
  ),
  totals: z.object({
    totalBytes: z.number().nonnegative(),
    totalFiles: z.number().int().nonnegative(),
    totalDirectories: z.number().int().nonnegative(),
  }),
  issues: z.array(DiskAnalysisIssueSchema).default([]),
});

const DiskAnalysisSnapshotEnvelopeSchema = z.object({
  mount: DiskAnalysisMountIdentitySchema,
  cache: DiskAnalysisCacheMetadataSchema,
  snapshot: DiskAnalysisSnapshotSchema,
});

const DiskAnalysisMountStateSchema = z.object({
  mount: DiskAnalysisMountIdentitySchema,
  cache: DiskAnalysisCacheMetadataSchema,
  activeJob: DiskAnalysisJobStateSchema.nullable(),
});

const DiskAnalysisStartScanInputSchema = z.object({
  mount: DiskAnalysisMountIdentitySchema,
});

const DiskAnalysisStartScanResultSchema = z.object({
  jobId: z.string().uuid(),
  phase: DiskAnalysisScanPhaseSchema,
  streamPath: z.string().startsWith("/"),
});

const DiskAnalysisCancelScanInputSchema = z.object({
  mount: DiskAnalysisMountIdentitySchema,
  jobId: z.string().uuid(),
});

const DiskAnalysisScanEventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("snapshot"),
    job: DiskAnalysisJobStateSchema,
    snapshot: DiskAnalysisSnapshotSchema,
  }),
  z.object({
    event: z.literal("progress"),
    job: DiskAnalysisJobStateSchema,
  }),
  z.object({
    event: z.literal("branch"),
    jobId: z.string().uuid(),
    mount: DiskAnalysisMountIdentitySchema,
    branch: DiskAnalysisTreemapNodeSchema,
  }),
  z.object({
    event: z.literal("status"),
    job: DiskAnalysisJobStateSchema,
  }),
  z.object({
    event: z.literal("keepalive"),
    jobId: z.string().uuid(),
  }),
]);

type DiskAnalysisRouteSearch = z.infer<typeof DiskAnalysisRouteSearchSchema>;
type DiskAnalysisMountIdentity = z.infer<typeof DiskAnalysisMountIdentitySchema>;
type DiskAnalysisIssue = z.infer<typeof DiskAnalysisIssueSchema>;
type DiskAnalysisResourceLimits = z.infer<typeof DiskAnalysisResourceLimitsSchema>;
type DiskAnalysisCacheMetadata = z.infer<typeof DiskAnalysisCacheMetadataSchema>;
type DiskAnalysisProgress = z.infer<typeof DiskAnalysisProgressSchema>;
type DiskAnalysisJobState = z.infer<typeof DiskAnalysisJobStateSchema>;
type DiskAnalysisSnapshot = z.infer<typeof DiskAnalysisSnapshotSchema>;
type DiskAnalysisSnapshotEnvelope = z.infer<typeof DiskAnalysisSnapshotEnvelopeSchema>;
type DiskAnalysisMountState = z.infer<typeof DiskAnalysisMountStateSchema>;
type DiskAnalysisStartScanInput = z.infer<typeof DiskAnalysisStartScanInputSchema>;
type DiskAnalysisStartScanResult = z.infer<typeof DiskAnalysisStartScanResultSchema>;
type DiskAnalysisCancelScanInput = z.infer<typeof DiskAnalysisCancelScanInputSchema>;
type DiskAnalysisScanEvent = z.infer<typeof DiskAnalysisScanEventSchema>;

export {
  DiskAnalysisCacheMetadataSchema,
  DiskAnalysisCacheStateSchema,
  DiskAnalysisCancelScanInputSchema,
  DiskAnalysisIssueCodeSchema,
  DiskAnalysisIssueSchema,
  DiskAnalysisJobStateSchema,
  DiskAnalysisMountIdentitySchema,
  DiskAnalysisMountStateSchema,
  DiskAnalysisProgressSchema,
  DiskAnalysisResourceLimitsSchema,
  DiskAnalysisRouteSearchSchema,
  DiskAnalysisScanEventSchema,
  DiskAnalysisScanPhaseSchema,
  DiskAnalysisSnapshotEnvelopeSchema,
  DiskAnalysisSnapshotSchema,
  DiskAnalysisStartScanInputSchema,
  DiskAnalysisStartScanResultSchema,
  DiskAnalysisTreemapNodeSchema,
};

export type {
  DiskAnalysisCacheMetadata,
  DiskAnalysisCancelScanInput,
  DiskAnalysisIssue,
  DiskAnalysisJobState,
  DiskAnalysisMountIdentity,
  DiskAnalysisMountState,
  DiskAnalysisProgress,
  DiskAnalysisResourceLimits,
  DiskAnalysisRouteSearch,
  DiskAnalysisScanEvent,
  DiskAnalysisSnapshot,
  DiskAnalysisSnapshotEnvelope,
  DiskAnalysisStartScanInput,
  DiskAnalysisStartScanResult,
  DiskAnalysisTreemapNode,
};
