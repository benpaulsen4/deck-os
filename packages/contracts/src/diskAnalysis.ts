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
  "nested-mount-skipped",
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
  // Bounded to a display-sized cap by the service (currently 100 entries),
  // independent of how many problems the scan actually encountered -- see
  // `issueCount`. Progress events in particular carry this empty; the
  // populated array belongs on status/snapshot events.
  issues: z.array(DiskAnalysisIssueSchema).default([]),
  // Total problems encountered, not issue objects retained: many occurrences
  // (e.g. symlinks skipped under one directory) can aggregate into a single
  // issue object, so this can exceed `issues.length` once the array is
  // capped. This is the number the UI shows -- "how much did the scan miss".
  // `.default(0)`, not bare -- z.infer's *output* type for a defaulted field
  // is still required (see `issues` two lines up: every consumer supplies
  // it), so this keeps consumers seeing a plain `number` while still
  // parsing input that predates this field.
  issueCount: z.number().int().nonnegative().default(0),
  // Finding 2, final whole-branch review: `issueCount` above is the total
  // across every issue code, including `symlink-skipped`, which B1/B5
  // deliberately excluded from partiality (see `PARTIAL_RESULT_CODES` in the
  // service) because a dropped symlink is not a lower bound on the totals.
  // On an unprivileged scan of a real filesystem, symlinks routinely
  // outnumber the permission-denied directories that actually made the scan
  // partial by one to three orders of magnitude, so the "totals are a lower
  // bound" banner needs a count scoped to the codes that actually mean that
  // -- this is that count. `.default(0)` for the same reason `issueCount`
  // carries it: a snapshot or job state from before this field existed must
  // still parse.
  partialIssueCount: z.number().int().nonnegative().default(0),
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
  // Same cap-independent count as DiskAnalysisJobStateSchema.issueCount --
  // once a job is pruned (FINISHED_JOB_TTL), the cached snapshot is the only
  // surviving record of a scan, and `issues.length` alone under-reports a
  // truncated array with no indication it was truncated.
  //
  // `.default(0)` is load-bearing here, not just symmetry with the job-state
  // field above: this schema is parsed on the cache *read* path
  // (`readPersistedCache`) against a JSON file that may have been written by
  // an older version of this service -- a snapshot from before this field
  // existed (including this branch's own prior commit) has no
  // `snapshot.issueCount` at all. A bare (non-defaulted) field would fail
  // that parse, and the catch quarantines the file as `.corrupt-<epoch>`,
  // discarding a perfectly good cache entry on every upgrade.
  issueCount: z.number().int().nonnegative().default(0),
  // Same cap-independent, code-scoped count as
  // `DiskAnalysisJobStateSchema.partialIssueCount` -- see the comment there.
  // `.default(0)` is load-bearing here for the same reason it is on
  // `issueCount` two lines up: this schema is parsed on the cache *read*
  // path against a JSON file that may predate this field.
  partialIssueCount: z.number().int().nonnegative().default(0),
  // Whether these totals are a lower bound -- the same fact the job reports as
  // `phase: "partial"`, recorded where it can outlive the job.
  //
  // `DiskAnalysisMountStateSchema.activeJob` only ever carries a queued or
  // scanning job (the service filters on `isActivePhase`), so a job in the
  // terminal `"partial"` phase is visible *only* to the client that watched it
  // get there over SSE. Without this flag the "totals are a lower bound"
  // warning vanished on the next page load, which is most of the times anyone
  // looks at a scan.
  //
  // `.default(false)` for exactly the reason `issueCount` above is
  // `.default(0)`: this schema is parsed on the cache read path against files
  // older versions of the service wrote.
  partial: z.boolean().default(false),
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
